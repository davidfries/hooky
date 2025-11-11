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

## API

- `POST /api/endpoints` body `{ ttlSeconds? }` -> `{ id, url, ttlSeconds, expiresAt }`
- `GET /api/endpoints` -> `{ endpoints: [{ id, url, ttlSeconds, expiresAt, eventCount }] }`
- `GET /api/endpoints/:id/events` -> `{ events: HookEvent[] }`
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
