import { assertEquals, assert } from "@std/assert";
import { buildApp } from "./app.ts";
import supertest from "supertest";
// (no-op) types previously used for streaming via supertest
import type { IncomingMessage as _IncomingMessage } from "node:http";
import type { Response as _SupertestResponse } from "supertest";

// Force in-memory mode
Deno.env.set("HOOKY_FORCE_MEMORY", "1");

const app = buildApp();
// Create a server instance so supertest doesn't attempt a network connect
const server = app.listen();
const request = supertest(server);

Deno.test("create endpoint and list", async () => {
  const create = await request.post("/api/endpoints").send({ ttlSeconds: 5 }).expect(200);
  assert(create.body.id, "id present");
  const id = create.body.id as string;
  const list = await request.get("/api/endpoints").expect(200);
  interface Ep { id: string; expiresAt: number; ttlSeconds: number; url: string; eventCount: number }
  const endpoints: Ep[] = list.body.endpoints;
  const found = endpoints.find((e) => e.id === id);
  assert(found, "endpoint should appear in list");
});

Deno.test("post event and retrieve", async () => {
  const { body: create } = await request.post("/api/endpoints").send({ ttlSeconds: 5 }).expect(200);
  const id = create.id;
  await request.post(`/hook/${id}`).send({ alpha: 1 }).expect(200);
  const eventsResp = await request.get(`/api/endpoints/${id}/events`).expect(200);
  assert(Array.isArray(eventsResp.body.events));
  assertEquals(eventsResp.body.events.length, 1);
  const evt = eventsResp.body.events[0];
  assertEquals(evt.method, "POST");
  assertEquals(evt.body.alpha, 1);
});

Deno.test("endpoint expiry returns 410", async () => {
  const { body: create } = await request.post("/api/endpoints").send({ ttlSeconds: 1 }).expect(200);
  const id = create.id;
  // Wait for expiry
  await new Promise(r => setTimeout(r, 1200));
  const hookResp = await request.post(`/hook/${id}`).send({ test: true });
  assertEquals(hookResp.status, 410);
});

Deno.test("delete endpoint removes endpoint and events", async () => {
  // Create endpoint
  const { body: create } = await request.post("/api/endpoints").send({ ttlSeconds: 30 }).expect(200);
  const id = create.id;
  
  // Add some events
  await request.post(`/hook/${id}`).send({ event: 1 }).expect(200);
  await request.post(`/hook/${id}`).send({ event: 2 }).expect(200);
  
  // Verify events exist
  const eventsResp = await request.get(`/api/endpoints/${id}/events`).expect(200);
  assertEquals(eventsResp.body.events.length, 2);
  
  // Delete endpoint
  const deleteResp = await request.delete(`/api/endpoints/${id}`).expect(200);
  assertEquals(deleteResp.body.deleted, id);
  
  // Verify endpoint no longer exists
  await request.get(`/api/endpoints/${id}`).expect(404);
  
  // Verify events are gone
  await request.get(`/api/endpoints/${id}/events`).expect(404);
  
  // Verify endpoint not in list
  const listResp = await request.get("/api/endpoints").expect(200);
  const found = listResp.body.endpoints.find((e: { id: string }) => e.id === id);
  assertEquals(found, undefined);
  
  // Verify hook receiver returns 404
  await request.post(`/hook/${id}`).send({ test: true }).expect(404);
});

Deno.test("test streaming", async () => {
  const { body: create } = await request.post("/api/endpoints").send({ ttlSeconds: 10 }).expect(200);
  const id = create.id as string;

  // Start SSE request via fetch (read until first message then abort)
  const addr = server.address() as { address?: string; port?: number };
  const port = addr?.port ?? 0;
  const controller = new AbortController();
  const ssePromise: Promise<string> = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/endpoints/${id}/stream`, {
      headers: { "Accept": "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("\n\n")) {
          controller.abort();
          return buf;
        }
      }
    }
    return buf;
  })();

  // Give the stream a moment to initialize
  await new Promise((r) => setTimeout(r, 50));

  // Post an event to trigger SSE
  await request.post(`/hook/${id}`).send({ streamTest: true }).expect(200);

  const receivedData = await ssePromise;
  assert(receivedData.includes('"streamTest":true'), "Should receive streamed event data");
});

Deno.test("delete non-existent endpoint returns 404", async () => {
  await request.delete("/api/endpoints/nonexistent").expect(404);
});

Deno.test({ name: "close server", sanitizeResources: false, sanitizeOps: false }, () => {
  server.close();
});
