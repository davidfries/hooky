# Hooky

Ephemeral webhook endpoint service for local testing.

## Overview

Hooky lets you instantly create ephemeral webhook endpoints, capture and stream incoming requests live (via SSE), diff and filter payloads in a built‑in UI, and manage everything from a lightweight Deno CLI or Docker image—optionally persisting events in Redis.

Hooky consists of:

- Deno TypeScript CLI (`main.ts`) to create endpoints, list events, and send test pings.
- Express-based server (`server/index.ts`) that provisions temporary endpoints and stores received webhook payloads (Redis or in-memory fallback).
- Browser UI (`public/index.html`) for listing endpoints and streaming incoming webhook events live (SSE).

## Running

Start Redis locally (default) or set `REDIS_URL` env var, then start the server (default port 3000):

```bash
deno task server
```

In another terminal use the CLI:

```bash
# Create a new endpoint (1 hour default)
deno run -A main.ts create

# Create endpoint with 5 minute TTL
deno run -A main.ts create 300
# Sample output:
# { "id": "a1b2c3d4", "url": "http://localhost:3000/hook/a1b2c3d4" }

# Send a test ping (optional convenience)
deno run -A main.ts ping a1b2c3d4 '{"demo":123}'

# List active endpoints
deno run -A main.ts list

# List events for one endpoint
deno run -A main.ts events a1b2c3d4
```

Open the UI at <http://localhost:3000> (lists active endpoints and streams events live via SSE).

Or using tasks shorthand:

```bash
HOOKY_SERVER=http://localhost:3000 deno task dev create
```

## Configuration (Environment Variables)

These environment variables customize binding, storage, and URL generation.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Port the server listens on. |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` restricts to local machine; `::` for IPv6). |
| `REDIS_URL` | `redis://10.100.100.53:6379` | Redis connection; falls back to in‑memory if unreachable. |
| `PUBLIC_BASE_URL` | request-derived (`protocol://host`) | Overrides base used to build endpoint URLs (`{base}/hook/{id}`); set for public hosting behind proxies. Trailing slashes trimmed. |
| `HOOKY_FORCE_MEMORY` | unset | Force in‑memory mode (useful for tests). |

Example (public domain + custom port + Docker Redis):

```bash
PUBLIC_BASE_URL="https://hooks.example.com" \
PORT=8080 HOST=0.0.0.0 \
REDIS_URL=redis://redis:6379 \
deno task server
```

Bind only to loopback (local only):

```bash
HOST=127.0.0.1 deno task server
```

When `PUBLIC_BASE_URL` is set every response containing a `url` field uses it, independent of reverse proxy headers.

## API

- `POST /api/endpoints` body `{ ttlSeconds? }` -> `{ id, url, ttlSeconds, expiresAt }`
- `GET /api/endpoints` -> `{ endpoints: [{ id, url, ttlSeconds, expiresAt, eventCount }] }`
- `GET /api/endpoints/:id/events` -> `{ events: HookEvent[] }`
- `DELETE /api/endpoints/:id` -> `{ ok: true, deleted: id }` (removes endpoint and all events)
- Receive webhook: any method `/hook/:id` storing body + metadata.
- `GET /api/endpoints/:id/stream` -> SSE events (one JSON object per line-delimited message).

## Notes / Roadmap

- Redis persistence (endpoints + events TTL, capped at 100 events per endpoint).
- Automatic cleanup of expired endpoints.
- Filtering & search in UI (implemented).
- Diff view & colorization (implemented).
- JSON tree viewer & theme toggle (implemented).
- Potential: authentication, rate limiting, replay events, signed delivery helpers.

## Testing

```bash
deno task test
```

Backend tests (`server/app_test.ts`) run entirely in memory by setting `HOOKY_FORCE_MEMORY=1`.

Test helper pattern:

```ts
import { buildApp } from "./server/app.ts";
import supertest from "supertest";

export function buildTestServer() {
  const app = buildApp();
  const server = app.listen();
  return { server, request: supertest(server) };
}
```

## License

MIT © 2025 David Fries
