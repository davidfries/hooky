// Deno client CLI for Hooky
// Commands:
//   create [ttlSeconds]   -> creates a new temporary webhook endpoint
//   events <id>           -> lists captured events for the endpoint
//   ping <id> [payload]   -> convenience: send a test POST to the endpoint (local only)
//   list                  -> list active endpoints
//
// Configure backend via env HOOKY_SERVER (default http://localhost:3000)

// Keep a tiny export for the existing unit test
export function add(a: number, b: number): number {
    return a + b;
}

type CreateEndpointResponse = {
    id: string;
    url: string;
    ttlSeconds: number;
    expiresAt: number;
};

type StoredEvent = {
    id: string;
    timestamp: string;
    method: string;
    path: string;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    body: unknown;
};

const BASE_URL = Deno.env.get("HOOKY_SERVER") ?? "http://localhost:3000";
import { VERSION } from "./version.ts";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            "content-type": "application/json",
            ...(init?.headers ?? {}),
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Request failed ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
}

async function cmdCreate(ttlArg?: string) {
    let ttlSeconds: number | undefined;
    if (ttlArg) {
        const n = Number(ttlArg);
        if (!Number.isNaN(n) && n > 0) ttlSeconds = n;
    }
    const data = await api<CreateEndpointResponse>("/api/endpoints", {
        method: "POST",
        body: JSON.stringify(ttlSeconds ? { ttlSeconds } : {}),
    });
    console.log("Endpoint created:\n", JSON.stringify(data, null, 2));
}
async function cmdList() {
    const data = await api<{ endpoints: { id: string; url: string; ttlSeconds: number; expiresAt: number; eventCount: number }[] }>("/api/endpoints");
    if (!data.endpoints.length) {
        console.log("No active endpoints.");
        return;
    }
    for (const ep of data.endpoints) {
        const remaining = Math.max(0, Math.round((ep.expiresAt - Date.now()) / 1000));
        console.log(`${ep.id}  events=${ep.eventCount}  ttlRemaining=${remaining}s  ${ep.url}`);
    }
}

async function cmdEvents(id?: string) {
    if (!id) throw new Error("Usage: events <id>");
    const data = await api<{ events: StoredEvent[] }>(`/api/endpoints/${id}/events`);
    if (!data.events.length) {
        console.log("No events yet. Send a webhook to:");
            console.log(`${BASE_URL}/hook/${id}`);
        return;
    }
    for (const evt of data.events) {
        console.log("-----");
        console.log(`${evt.timestamp} ${evt.method} ${evt.path}`);
        console.log("headers:", evt.headers);
        console.log("query:", evt.query);
        console.log("body:", typeof evt.body === "string" ? evt.body : JSON.stringify(evt.body, null, 2));
    }
}

async function cmdPing(id?: string, payloadArg?: string) {
    if (!id) throw new Error("Usage: ping <id> [payload]");
    const url = `${BASE_URL}/hook/${id}`;
    const payload = payloadArg ? JSON.parse(payloadArg) : { hello: "world" };
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    console.log("Ping status:", res.status);
    const text = await res.text();
    if (text) console.log(text);
}

if (import.meta.main) {
    const [cmd, ...args] = Deno.args;
    (async () => {
        try {
            switch (cmd) {
                        case "create":
                            await cmdCreate(args[0]);
                    break;
                case "events":
                    await cmdEvents(args[0]);
                    break;
                case "ping":
                    await cmdPing(args[0], args[1]);
                    break;
                case "version":
                case "--version":
                case "-v":
                    console.log(VERSION);
                    break;
                        case "list":
                            await cmdList();
                            break;
                case undefined:
                console.log("Hooky client usage:\n  create [ttlSeconds]\n  list\n  events <id>\n  ping <id> [json]\n  version | --version | -v");
                    break;
                default:
                    console.error(`Unknown command: ${cmd}`);
                    Deno.exit(1);
            }
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            Deno.exit(1);
        }
    })();
}


