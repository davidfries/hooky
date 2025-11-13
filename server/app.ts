import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createClient } from "redis";
import process from "node:process";

export interface HookEvent {
  id: string; timestamp: string; method: string; path: string;
  query: Record<string, string | string[]>; headers: Record<string, string | string[]>; body: unknown;
}
export interface EndpointRecord { id: string; createdAt: number; expiresAt: number; }

let redis: ReturnType<typeof createClient> | null = null;
let useRedis = false;
async function initRedis() {
  if (redis || useRedis) return; // already attempted
  const forceMemory = process.env.HOOKY_FORCE_MEMORY === "1";
  if (forceMemory) { useRedis = false; return; }
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  try {
    redis = createClient({ url: redisUrl });
    await redis.connect();
    useRedis = true;
  } catch (_err) {
    useRedis = false; redis = null;
  }
}

const memoryEndpoints: Map<string, (EndpointRecord & { events: HookEvent[] })> = new Map();
const channelEmitters: Map<string, EventEmitter> = new Map();
const getEmitter = (id: string) => channelEmitters.get(id) || channelEmitters.set(id, new EventEmitter()).get(id)!;

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
    const raw = await redis.get(`endpoint:${id}`); return raw ? JSON.parse(raw) as EndpointRecord : undefined;
  }
  const rec = memoryEndpoints.get(id); return rec ? { id: rec.id, createdAt: rec.createdAt, expiresAt: rec.expiresAt } : undefined;
}
async function listEndpoints(): Promise<EndpointRecord[]> {
  if (useRedis && redis) {
    const ids = await redis.sMembers("endpoints");
    const out: EndpointRecord[] = [];
    for (const id of ids) { const r = await getEndpoint(id); if (r) out.push(r); else await redis.sRem("endpoints", id); }
    return out;
  }
  return Array.from(memoryEndpoints.values()).map(r => ({ id: r.id, createdAt: r.createdAt, expiresAt: r.expiresAt }));
}
async function pushEvent(id: string, evt: HookEvent) {
  if (useRedis && redis) {
    await redis.lPush(`events:${id}`, JSON.stringify(evt));
    await redis.lTrim(`events:${id}`, 0, 99);
  } else {
    const rec = memoryEndpoints.get(id); if (rec) { rec.events.unshift(evt); if (rec.events.length > 100) rec.events.length = 100; getEmitter(id).emit("event", evt); }
  }
}
async function listEvents(id: string): Promise<HookEvent[]> {
  if (useRedis && redis) {
    const rows = await redis.lRange(`events:${id}`, 0, 99); return rows.map(r => JSON.parse(r));
  }
  const rec = memoryEndpoints.get(id); return rec ? rec.events : [];
}

async function deleteEndpoint(id: string): Promise<boolean> {
  if (useRedis && redis) {
    const rec = await getEndpoint(id);
    if (!rec) return false;
    await redis.del(`endpoint:${id}`);
    await redis.del(`events:${id}`);
    await redis.sRem("endpoints", id);
    return true;
  } else {
    const existed = memoryEndpoints.has(id);
    memoryEndpoints.delete(id);
    channelEmitters.delete(id);
    return existed;
  }
}

export function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  // Lazy redis init (fire and forget)
  void initRedis();

  app.post("/api/endpoints", async (req: Request, res: Response) => {
    const id = randomUUID().slice(0, 8);
    const ttlRaw = req.body?.ttlSeconds; let ttl = typeof ttlRaw === "number" ? ttlRaw : Number(ttlRaw); if (!ttl || ttl < 1) ttl = 3600;
    const now = Date.now(); const rec: EndpointRecord = { id, createdAt: now, expiresAt: now + ttl * 1000 };
    await saveEndpoint(rec, ttl);
    res.json({ id, url: `${req.protocol}://${req.get("host")}/hook/${id}`, ttlSeconds: ttl, expiresAt: rec.expiresAt });
  });

  app.get("/api/endpoints", async (req: Request, res: Response) => {
    const now = Date.now(); const eps = await listEndpoints();
    const host = req.get("host"); const proto = req.protocol;
    const list: { id: string; expiresAt: number; ttlSeconds: number; url: string; eventCount: number }[] = [];
    for (const r of eps) {
      list.push({ id: r.id, expiresAt: r.expiresAt, ttlSeconds: Math.max(0, Math.round((r.expiresAt - now)/1000)), url: `${proto}://${host}/hook/${r.id}`, eventCount: (useRedis && redis) ? await redis!.lLen(`events:${r.id}`) : (memoryEndpoints.get(r.id)?.events.length || 0) });
    }
    res.json({ endpoints: list });
  });

  app.get("/api/endpoints/:id/events", async (req: Request, res: Response) => {
    const rec = await getEndpoint(req.params.id); if (!rec) return res.status(404).json({ error: "not found" });
    res.json({ events: await listEvents(rec.id) });
  });

  app.delete("/api/endpoints/:id", async (req: Request, res: Response) => {
    const deleted = await deleteEndpoint(req.params.id);
    if (!deleted) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, deleted: req.params.id });
  });

  app.all("/hook/:id", async (req: Request, res: Response) => {
    const rec = await getEndpoint(req.params.id); if (!rec) return res.status(404).json({ error: "endpoint not found" });
    if (Date.now() > rec.expiresAt) return res.status(410).json({ error: "endpoint expired" });
  const headers: Record<string, string | string[]> = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, v as (string | string[])]));
  const query: Record<string, string | string[]> = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, v as (string | string[])]));
  const evt: HookEvent = { id: randomUUID(), timestamp: new Date().toISOString(), method: req.method, path: req.originalUrl, query, headers, body: req.body };
    await pushEvent(rec.id, evt);
    res.json({ ok: true, received: { id: evt.id } });
  });

  return app;
}

export const _internal = { useRedisFlag: () => useRedis, initRedis };
