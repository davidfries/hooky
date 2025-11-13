import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createClient } from "redis";
import { EventEmitter } from "node:events";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// In-memory store (dev/demo)
// id -> events
interface HookEvent {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
}

interface EndpointRecord {
  id: string;
  createdAt: number; // ms
  expiresAt: number; // ms
}

// Redis keys layout:
// endpoint:{id} -> JSON {id,createdAt,expiresAt}
// events:{id} -> LPUSH JSON events (cap 100)
// endpoints -> SET of all ids (for listing)

const redisUrl = process.env.REDIS_URL || "redis://10.100.100.53:6379";
let redis: ReturnType<typeof createClient> | null = null;
let useRedis = true;
try {
  redis = createClient({ url: redisUrl });
  redis.on("error", (err) => { if (useRedis) console.error("Redis error", err.message); });
  await redis.connect();
  console.log("Connected to Redis", redisUrl);
} catch (e) {
  useRedis = false;
  redis = null;
  console.warn(`Redis unavailable (${(e as Error).message}); using in-memory storage`);
}

// In-memory fallback
const memoryEndpoints: Map<string, (EndpointRecord & { events: HookEvent[] })> = new Map();
const channelEmitters: Map<string, EventEmitter> = new Map();
function getEmitter(id: string) {
  let em = channelEmitters.get(id);
  if (!em) { em = new EventEmitter(); channelEmitters.set(id, em); }
  return em;
}

async function saveEndpoint(rec: EndpointRecord, ttlSeconds: number) {
  if (useRedis && redis) {
    await redis.set(`endpoint:${rec.id}`, JSON.stringify(rec), { PX: ttlSeconds * 1000 });
    await redis.sAdd("endpoints", rec.id);
  } else {
    memoryEndpoints.set(rec.id, { ...rec, events: [] });
  }
}

async function getEndpoint(id: string): Promise<EndpointRecord | undefined> {
  if (useRedis && redis) {
    const raw = await redis.get(`endpoint:${id}`);
    return raw ? (JSON.parse(raw) as EndpointRecord) : undefined;
  }
  const rec = memoryEndpoints.get(id);
  return rec ? { id: rec.id, createdAt: rec.createdAt, expiresAt: rec.expiresAt } : undefined;
}

async function listEndpoints(): Promise<EndpointRecord[]> {
  if (useRedis && redis) {
    const ids = await redis.sMembers("endpoints");
    const result: EndpointRecord[] = [];
    for (const id of ids) {
      const rec = await getEndpoint(id);
      if (rec) result.push(rec); else await redis.sRem("endpoints", id);
    }
    return result;
  }
  return Array.from(memoryEndpoints.values()).map(r => ({ id: r.id, createdAt: r.createdAt, expiresAt: r.expiresAt }));
}

async function pushEvent(id: string, evt: HookEvent) {
  if (useRedis && redis) {
    await redis.lPush(`events:${id}`, JSON.stringify(evt));
    await redis.lTrim(`events:${id}`, 0, 99);
    await redis.publish(`pub:${id}`, JSON.stringify(evt));
  } else {
    const rec = memoryEndpoints.get(id);
    if (rec) {
      rec.events.unshift(evt);
      if (rec.events.length > 100) rec.events.length = 100;
      getEmitter(id).emit("event", evt);
    }
  }
}

async function listEvents(id: string): Promise<HookEvent[]> {
  if (useRedis && redis) {
    const eventsRaw = await redis.lRange(`events:${id}`, 0, 99);
    return eventsRaw.map(e => JSON.parse(e));
  }
  const rec = memoryEndpoints.get(id);
  return rec ? rec.events : [];
}

function computeBaseUrl(req: Request): string {
  const envBase = process.env.PUBLIC_BASE_URL?.trim();
  if (envBase && envBase.length) {
    // Normalize: remove trailing slashes
    return envBase.replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

// Create an endpoint
app.post("/api/endpoints", async (req: Request, res: Response) => {
  const id = randomUUID().slice(0, 8);
  const ttlSecRaw = (req.body && (req.body.ttlSeconds as unknown)) ?? undefined;
  let ttlSeconds = typeof ttlSecRaw === "number" ? ttlSecRaw : undefined;
  if (typeof ttlSecRaw === "string") {
    const parsed = Number(ttlSecRaw);
    if (!Number.isNaN(parsed)) ttlSeconds = parsed;
  }
  if (!ttlSeconds || ttlSeconds < 1) ttlSeconds = 3600;
  const now = Date.now();
  const rec: EndpointRecord = { id, createdAt: now, expiresAt: now + ttlSeconds * 1000 };
  await saveEndpoint(rec, ttlSeconds);
  const base = computeBaseUrl(req);
  const url = `${base}/hook/${id}`;
  res.json({ id, url, ttlSeconds, expiresAt: rec.expiresAt });
});

app.get("/", async (_req: Request, res: Response) => {
    
    const { resolve } = await import("node:path");
    res.sendFile(resolve("public", "index.html")
);
});

// Get endpoint metadata (simple)
app.get("/api/endpoints/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const rec = await getEndpoint(id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const remainingMs = rec.expiresAt - Date.now();
  const base = computeBaseUrl(req);
  const url = `${base}/hook/${id}`;
  res.json({ id, url, expiresAt: rec.expiresAt, ttlSeconds: Math.max(0, remainingMs / 1000) });
});

// List all active endpoints
app.get("/api/endpoints", async (req: Request, res: Response) => {
  const now = Date.now();
  const eps = await listEndpoints();
  const base = computeBaseUrl(req);
  const endpoints: { id: string; expiresAt: number; ttlSeconds: number; url: string; eventCount: number }[] = [];
  for (const rec of eps) {
    const ttlRemaining = Math.max(0, Math.round((rec.expiresAt - now) / 1000));
    const eventCount = useRedis && redis ? await redis.lLen(`events:${rec.id}`) : (memoryEndpoints.get(rec.id)?.events.length || 0);
    endpoints.push({
      id: rec.id,
      expiresAt: rec.expiresAt,
      ttlSeconds: ttlRemaining,
      url: `${base}/hook/${rec.id}`,
      eventCount,
    });
  }
  res.json({ endpoints });
});

// List events
app.get("/api/endpoints/:id/events", async (req: Request, res: Response) => {
  const { id } = req.params;
  const rec = await getEndpoint(id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const events = await listEvents(id);
  res.json({ events });
});

// Server-Sent Events stream for live events
app.get("/api/endpoints/:id/stream", async (req: Request, res: Response) => {
  const { id } = req.params;
  const rec = await getEndpoint(id);
  if (!rec) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  if (useRedis && redis) {
    const channel = `pub:${id}`;
    const sub = createClient({ url: redisUrl });
    await sub.connect();
    await sub.subscribe(channel, (message) => {
      res.write(`event: webhook\n`);
      res.write(`data: ${message}\n\n`);
    });
    req.on("close", async () => {
      await sub.unsubscribe(channel);
      await sub.quit();
    });
  } else {
    const emitter = getEmitter(id);
    const handler = (evt: HookEvent) => {
      res.write(`event: webhook\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    emitter.on("event", handler);
    req.on("close", () => emitter.off("event", handler));
  }
});

// The actual webhook receiver
app.all("/hook/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const rec = await getEndpoint(id);
  if (!rec) return res.status(404).json({ error: "endpoint not found" });
  if (Date.now() > rec.expiresAt) return res.status(410).json({ error: "endpoint expired" });
  const evt: HookEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    query: req.query,
    headers: req.headers,
    body: req.body,
  };
  await pushEvent(id, evt);
  res.json({ ok: true, received: { id: evt.id } });
});
const host = (process.env.HOST && process.env.HOST.trim().length) ? process.env.HOST.trim() : "0.0.0.0";
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, host, () => {
  console.log(`Hooky server listening on http://${host}:${port}`);
});

// Periodic pruning of expired endpoints from the set (Redis key expiry handles data removal)
if (useRedis && redis) {
  setInterval(async () => {
    const ids = await redis.sMembers("endpoints");
    for (const id of ids) {
      const raw = await redis.get(`endpoint:${id}`);
      if (!raw) await redis.sRem("endpoints", id);
    }
  }, 60_000);
} else {
  setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of memoryEndpoints.entries()) {
      if (now > rec.expiresAt) {
        memoryEndpoints.delete(id);
        channelEmitters.delete(id);
      }
    }
  }, 60_000);
}
