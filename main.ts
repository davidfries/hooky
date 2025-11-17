// Deno client CLI for Hooky
// Commands:
//   create [ttlSeconds]   -> creates a new temporary webhook endpoint
//   events <id>           -> lists captured events for the endpoint
//   tail <id> [--compact] [--no-color] -> live stream events (SSE)
//   ping <id> [payload]   -> convenience: send a test POST to the endpoint (local only)
//   list                  -> list active endpoints
//   server [--port <port>] [--redis <redisUrl>] -> launch built-in backend server
//   server start [--port <port>] [--redis <redisUrl>] -> launch backend in background
//   server stop -> stop background backend
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
import * as colors from "@std/fmt/colors";

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

type TailFlags = { compact: boolean; color: boolean };
function parseTailFlags(args: string[]): { id?: string; flags: TailFlags } {
    const flags: TailFlags = { compact: false, color: true };
    let id: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--compact" || a === "-c") flags.compact = true;
        else if (a === "--no-color") flags.color = false;
        else if (!id) id = a;
    }
    // Respect NO_COLOR environment if set
    if (Deno.env.get("NO_COLOR")) flags.color = false;
    return { id, flags };
}

async function cmdTail(rawId?: string, ...rest: string[]) {
    // Allow either tail <id> [flags] or tail [flags] <id>
    const idArg = rawId;
    const { id, flags } = parseTailFlags(idArg ? [idArg, ...rest] : rest);
    const endpointId = id;
    if (!endpointId) throw new Error("Usage: tail <id> [--compact] [--no-color]");
    const streamUrl = `${BASE_URL}/api/endpoints/${endpointId}/stream`;

    let stop = false;
    const ac = new AbortController();
    const onSig = () => { stop = true; ac.abort("SIGINT"); };
    Deno.addSignalListener("SIGINT", onSig);

    let attempt = 0;
    console.log(`Streaming events from ${streamUrl} (Ctrl-C to stop)`);
    while (!stop) {
        attempt++;
        const backoffMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
        try {
            const res = await fetch(streamUrl, { headers: { Accept: "text/event-stream" }, signal: ac.signal });
            if (!res.ok || !res.body) {
                throw new Error(`Stream failed ${res.status}`);
            }
            if (attempt > 1) console.log("Reconnected.");
            attempt = 0; // reset after successful connect

            const reader = res.body
                .pipeThrough(new TextDecoderStream())
                .getReader();
            let buf = "";
            while (!stop) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) buf += value;
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                    const chunk = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    handleSSEChunk(chunk, flags);
                }
            }
        } catch (e) {
            if (stop) break;
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Stream error: ${msg}`);
            console.log(`Reconnecting in ${Math.round(backoffMs / 1000)}s...`);
            await delay(backoffMs);
            continue;
        }
        if (!stop) {
            console.log("Disconnected. Reconnecting...");
            await delay(500);
        }
    }
    Deno.removeSignalListener("SIGINT", onSig);
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function handleSSEChunk(block: string, flags: TailFlags) {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
        if (line.startsWith(":")) continue; // comment
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        // ignore id:/retry: for now
    }
    const dataText = dataLines.join("\n");
    if (!dataText) return;
    if (event !== "webhook") return; // ignore others
    try {
        const obj = JSON.parse(dataText) as StoredEvent;
        printEvent(obj, flags);
    } catch (_e) {
        console.log(dataText);
    }
}

function printEvent(evt: StoredEvent, flags: TailFlags) {
    const ts = new Date(evt.timestamp).toISOString();
    const method = pad(evt.method.toUpperCase(), 6);
    const path = evt.path;
    const header = `${fmt(ts, "dim", flags)} ${fmt(method, methodColor(evt.method), flags)} ${path}`;
    console.log("\n" + header);
    if (flags.compact) {
        const bodyStr = typeof evt.body === "string" ? evt.body : JSON.stringify(evt.body);
        console.log(bodyStr);
        return;
    }
    console.log(fmt("headers:", "bold", flags), evt.headers);
    console.log(fmt("query:", "bold", flags), evt.query);
    console.log(fmt("body:", "bold", flags), typeof evt.body === "string" ? evt.body : JSON.stringify(evt.body, null, 2));
}

function methodColor(m: string): "green" | "yellow" | "red" | "blue" | "magenta" | "cyan" | "white" {
    const up = m.toUpperCase();
    if (up === "GET") return "green";
    if (up === "POST") return "cyan";
    if (up === "PUT") return "yellow";
    if (up === "PATCH") return "magenta";
    if (up === "DELETE") return "red";
    return "blue";
}

function pad(s: string, n: number) { return s.length >= n ? s : s + " ".repeat(n - s.length); }

function fmt(text: string, style: string, flags: TailFlags): string {
    if (!flags.color) return text;
    switch (style) {
        case "bold": return colors.bold(text);
        case "dim": return colors.dim(text);
        case "green": return colors.green(text);
        case "yellow": return colors.yellow(text);
        case "red": return colors.red(text);
        case "blue": return colors.blue(text);
        case "magenta": return colors.magenta(text);
        case "cyan": return colors.cyan(text);
        case "white": return colors.white(text);
        default: return text;
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

async function cmdServer(args: string[]) {
    // Subcommand handling: start/stop/background management
    const sub = args[0];
    if (sub === "start") {
        await cmdServerStart(args.slice(1));
        return;
    } else if (sub === "stop") {
        await cmdServerStop();
        return;
    } else if (sub === "status") {
        await cmdServerStatus();
        return;
    }
    // Foreground legacy behavior
    const flags = args;
    let port: number | undefined; let redisUrl: string | undefined;
    for (let i = 0; i < flags.length; i++) {
        const a = flags[i];
        if ((a === "--port" || a === "-p") && flags[i + 1]) port = Number(flags[++i]);
        else if (a === "--redis" && flags[i + 1]) redisUrl = flags[++i];
    }
    if (port) Deno.env.set("PORT", String(port));
    if (redisUrl) Deno.env.set("REDIS_URL", redisUrl);
    console.log("Starting Hooky backend server (foreground)...\n  PORT=", Deno.env.get("PORT") || "3000", "\n  REDIS_URL=", Deno.env.get("REDIS_URL") || "(in-memory fallback if unreachable)");
    await import("./server/index.ts");
}

function getStateDir(): string {
    const override = Deno.env.get("HOOKY_STATE_DIR");
    if (override) return override;
    const home = Deno.env.get("HOME") || Deno.cwd();
    return `${home}/.hooky`;
}
function pidFile(): string { return `${getStateDir()}/server.pid`; }
function metaFile(): string { return `${getStateDir()}/server.meta.json`; }

async function cmdServerStart(flags: string[]) {
    // Parse flags for port/redis/force/log
    let port: number | undefined; let redisUrl: string | undefined; let force = false; let logPathFlag: string | null = null;
    for (let i = 0; i < flags.length; i++) {
        const a = flags[i];
        if ((a === "--port" || a === "-p") && flags[i + 1]) port = Number(flags[++i]);
        else if (a === "--redis" && flags[i + 1]) redisUrl = flags[++i];
        else if (a === "--force") force = true;
        else if (a === "--log") {
            const next = flags[i + 1];
            if (next && !next.startsWith("--")) { logPathFlag = next; i++; } else logPathFlag = "default";
        }
    }
    const dir = getStateDir();
    try { await Deno.mkdir(dir, { recursive: true }); } catch (_e) { /* directory likely exists */ }
    // Check existing PID
    let existingPid: number | undefined;
    try {
        existingPid = Number((await Deno.readTextFile(pidFile())).trim());
    } catch (_e) { /* no pid file */ }
    if (existingPid && !force) {
        // Try a light probe: send signal 0 (not supported in Deno) fallback just inform user.
        console.error(`Server appears to already be running (pid ${existingPid}). Use --force to overwrite or run 'hooky server stop'.`);
        return;
    }
    const exe = Deno.execPath();
    const isDeno = exe.toLowerCase().includes("deno");
    const scriptPath = new URL(import.meta.url).pathname;
    const args: string[] = isDeno ? ["run", "-A", scriptPath, "server"] : ["server"];
    if (port) args.push("--port", String(port));
    if (redisUrl) args.push("--redis", redisUrl);
    // Spawn background-ish process. Drop stdout/stderr to avoid blocking.
    const logPath = logPathFlag ? (logPathFlag === "default" ? `${dir}/server.log` : logPathFlag) : "";
    // Use a wrapper shell command to detach fully (POSIX). On Windows we rely on direct spawn.
    let childPid: number;
    if (Deno.build.os !== "windows") {
        const portVal = port ? String(port) : (Deno.env.get("PORT") || "3000");
        const redisPart = redisUrl ? `REDIS_URL=${redisUrl}` : "";
        const envAssign = `PORT=${portVal} ${redisPart}`.trim();
        // nohup ensures it keeps running after terminal closes; echo $! captures PID.
    const redirect = logPath ? `>"${logPath}" 2>&1` : `>/dev/null 2>&1`;
    const shellCmd = `${envAssign ? envAssign + ' ' : ''}nohup ${exe} ${args.map(a=>JSON.stringify(a)).join(' ')} ${redirect} & echo $!`;
        const out = await new Deno.Command("/bin/bash", { args: ["-c", shellCmd] }).output();
        childPid = Number(new TextDecoder().decode(out.stdout).trim());
    } else {
        // Windows: use PowerShell Start-Process -WindowStyle Hidden -PassThru to get PID
        const portVal = port ? String(port) : (Deno.env.get("PORT") || "3000");
        // When compiled, exe may not include 'deno'; if running via deno, args already reflect run -A main.ts server
        // We'll construct a command invoking the current executable with args we built.
        const psCmd = `Start-Process -WindowStyle Hidden -PassThru -FilePath '${exe}' -ArgumentList ${args.map(a=>`'${a.replace(/'/g,"''")}'`).join(",")} -NoNewWindow`;
    const redirect = logPath ? ` -RedirectStandardOutput '${logPath}' -RedirectStandardError '${logPath}'` : "";
    const fullCmd = `powershell -NoProfile -Command "$env:PORT='${portVal}';${redisUrl?` $env:REDIS_URL='${redisUrl}';`:""} ${psCmd}${redirect} | Select-Object -ExpandProperty Id"`;
        const out = await new Deno.Command("cmd", { args: ["/C", fullCmd] }).output();
        childPid = Number(new TextDecoder().decode(out.stdout).trim());
    }
    await Deno.writeTextFile(pidFile(), String(childPid));
    const meta = {
        pid: childPid,
        port: port ? port : Number(Deno.env.get("PORT") || 3000),
        redis: redisUrl || Deno.env.get("REDIS_URL") || null,
        startedAt: new Date().toISOString(),
        log: logPath || null,
        platform: Deno.build.os,
        deno: Deno.version.deno,
    };
    try { await Deno.writeTextFile(metaFile(), JSON.stringify(meta, null, 2)); } catch(_e) { /* meta write failed */ }
    console.log(`Hooky server started in background (pid ${childPid})${logPath?` log=${logPath}`:""}`);
}

async function cmdServerStop() {
    let pid: number | undefined;
    try { pid = Number((await Deno.readTextFile(pidFile())).trim()); } catch (_e) { /* missing pid */ }
    if (!pid) {
        console.error("No PID file found; server not running?");
        return;
    }
    let killed = false;
    if (Deno.build.os !== "windows") {
        try { Deno.kill(pid, "SIGTERM"); killed = true; } catch (e) { console.warn("Kill failed", e); }
    } else {
        try {
            await new Deno.Command("taskkill", { args: ["/PID", String(pid), "/T", "/F"] }).spawn().status; killed = true;
        } catch (e) { console.warn("taskkill failed", e); }
    }
    if (killed) {
        try { await Deno.remove(pidFile()); } catch (_e) { /* ignore */ }
        try { await Deno.remove(metaFile()); } catch (_e) { /* ignore */ }
        console.log(`Sent termination signal to Hooky server (pid ${pid}).`);
    } else {
        console.error(`Failed to kill process ${pid}. You may need to terminate it manually.`);
    }
}
interface ServerMeta { pid: number; port: number; redis: string | null; startedAt: string; log: string | null; platform: string; deno: string; }
async function cmdServerStatus() {
    let pid: number | undefined; try { pid = Number((await Deno.readTextFile(pidFile())).trim()); } catch(_e) { /* no pid file */ }
    let meta: ServerMeta | null = null; try { meta = JSON.parse(await Deno.readTextFile(metaFile())) as ServerMeta; } catch(_e) { /* no meta */ }
    if (!pid) { console.log("Server: not running (no PID file)" ); return; }
    let alive = false;
    if (Deno.build.os !== "windows") {
        try {
            const ps = await new Deno.Command("/bin/bash", { args: ["-c", `ps -p ${pid} -o pid=`] }).output();
            const txt = new TextDecoder().decode(ps.stdout).trim(); alive = !!txt;
        } catch(_e) { /* ps failed */ }
    } else {
        try {
            const out = await new Deno.Command("cmd", { args: ["/C", `tasklist /FI \"PID eq ${pid}\" | findstr ${pid}`] }).output();
            alive = out.stdout.length > 0;
        } catch(_e) { /* tasklist failed */ }
    }
    console.log(`Server status:\n  pid: ${pid}\n  alive: ${alive}\n  port: ${meta?.port ?? 'unknown'}\n  redis: ${meta?.redis ?? 'none'}\n  startedAt: ${meta?.startedAt ?? 'unknown'}\n  log: ${meta?.log ?? 'none'}`);
    if (!alive) console.log("Note: PID file exists but process not alive. Use 'hooky server start --force' to restart.");
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
                case "tail":
                    await cmdTail(args[0], ...args.slice(1));
                    break;
                case "ping":
                    await cmdPing(args[0], args[1]);
                    break;
                case "server":
                    await cmdServer(args);
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
                console.log("Hooky client usage:\n  create [ttlSeconds]\n  list\n  events <id>\n  tail <id> [--compact] [--no-color]\n  ping <id> [json]\n  server [--port <n>] [--redis <url>]  (foreground)\n  server start [--port <n>] [--redis <url>] [--force] [--log [path]]\n  server stop\n  server status\n  version | --version | -v");
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


