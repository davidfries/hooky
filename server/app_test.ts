import { assertEquals, assert } from "@std/assert";
import { buildApp } from "./app.ts";
import supertest from "supertest";

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

Deno.test("delete non-existent endpoint returns 404", async () => {
  await request.delete("/api/endpoints/nonexistent").expect(404);
});

Deno.test({ name: "close server", sanitizeResources: false, sanitizeOps: false }, () => {
  server.close();
});
