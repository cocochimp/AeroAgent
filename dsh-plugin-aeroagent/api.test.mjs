import test from "node:test";
import assert from "node:assert/strict";
import { createApi, parseSSEBlock } from "./web/api.js";

test("parses JSON and text SSE blocks with their cursor and event type", () => {
  assert.deepEqual(parseSSEBlock("id: 4-1\nevent: case.trace\ndata: {\"node\":\"verify\"}"), {
    id: "4-1", type: "case.trace", data: { node: "verify" },
  });
  assert.deepEqual(parseSSEBlock("data: first\ndata: second"), {
    id: "", type: "message", data: { message: "first\nsecond" },
  });
  assert.equal(parseSSEBlock(": keep-alive"), null);
});

test("uses current /api/v1 endpoints and the selected demo identity", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const api = createApi({ baseUrl: "http://agent.test/", fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ orders: [] }) };
  } });
  await api.get("/orders", { userId: "u_wang", admin: true, signal });
  assert.equal(calls[0].url, "http://agent.test/api/v1/orders");
  assert.equal(calls[0].init.headers.Authorization, "Bearer demo-admin:u_wang");
  assert.equal(calls[0].init.signal, signal);
});

test("surfaces structured server errors with response details", async () => {
  const api = createApi({ baseUrl: "http://agent.test", fetchImpl: async () => ({
    ok: false, status: 409,
    json: async () => ({ error: { message: "需要重新报价", details: { quote_id: "q2" } } }),
  }) });
  await assert.rejects(api.post("/quotes/q1/confirm", { confirmation_id: "confirm-1" }, { userId: "u_zhang" }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.message, "需要重新报价");
    assert.equal(error.body.error.details.quote_id, "q2");
    return true;
  });
});
