import test from "node:test";
import assert from "node:assert/strict";
import { applyHost } from "../src/host/index.js";
import { resolveConfig } from "../src/host/config.js";

process.env.DSH_PROFILE = "web";

function fakeContext() {
  const tools = [];
  const routes = [];
  const prompts = [];
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === "function") dispose(); }; },
    inject(names, callback) {
      const scope = {
        ...ctx,
        systemPrompt: { section(section) { prompts.push(section); return () => {}; } },
        connection: { fetch: { register(route) { routes.push(route); return async () => {}; } } },
      };
      callback(scope);
    },
  };
  return { ctx, tools, routes, prompts };
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

test("registers business tools but never confirm or pay tools", () => {
  const { ctx, tools, prompts } = fakeContext();
  applyHost(ctx, { backendUrl: "http://backend.test" });
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["aeroagent_booking", "aeroagent_flights", "aeroagent_knowledge",
    "aeroagent_orders", "aeroagent_servicing", "aeroagent_watch"]);
  assert.ok(!names.some((name) => /confirm|pay/.test(name)));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /must NOT confirm|user-only/);
});

test("tools call the backend with demo identity and return presentation metadata", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ orders: [{ order_id: "ORD1" }] });
  };
  try {
    const { ctx, tools } = fakeContext();
    applyHost(ctx, { backendUrl: "http://backend.test", demoUserId: "u_li" });
    const orders = tools.find((tool) => tool.name === "aeroagent_orders");
    const value = await orders.execute({ action: "list" });
    assert.equal(calls[0].url, "http://backend.test/api/v1/orders?page_size=20");
    assert.equal(calls[0].init.headers.Authorization, "Bearer demo:u_li");
    assert.equal(value.orders[0].order_id, "ORD1");
    assert.deepEqual(orders.output.presentationMeta({}, value), value);
    assert.match(orders.output.render({}, value)[0].text, /订单 1 张/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("rpc route enforces method allowlist and wraps values", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ case_id: "case_1", status: "WAITING_CONFIRMATION" });
  try {
    const { ctx, routes } = fakeContext();
    applyHost(ctx, { backendUrl: "http://backend.test" });
    const rpc = routes.find((route) => route.path === "/api/aeroagent/rpc");
    assert.ok(rpc);
    const ok = await rpc.fetch(new Request("http://dsh.test/api/aeroagent/rpc", {
      method: "POST", body: JSON.stringify({ method: "cases.get", params: { case_id: "case_1" } }),
    }));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).value.case_id, "case_1");
    const denied = await rpc.fetch(new Request("http://dsh.test/api/aeroagent/rpc", {
      method: "POST", body: JSON.stringify({ method: "quotes.confirmByAgent", params: {} }),
    }));
    assert.equal(denied.status, 400);
  } finally {
    globalThis.fetch = previous;
  }
});

test("config rejects unsafe values and clamps timeouts", () => {
  assert.throws(() => resolveConfig({ backendUrl: "file:///tmp" }), /http/);
  assert.throws(() => resolveConfig({ identityMode: "anonymous" }), /identityMode/);
  assert.equal(resolveConfig({ requestTimeoutMs: 1 }).requestTimeoutMs, 1000);
});

test("skips non-web profiles so Desktop stays untouched", () => {
  process.env.DSH_PROFILE = "desktop";
  try {
    const { ctx, tools, prompts, routes } = fakeContext();
    const result = applyHost(ctx, { backendUrl: "http://backend.test" });
    assert.equal(result.skipped, true);
    assert.equal(tools.length, 0);
    assert.equal(prompts.length, 0);
    assert.equal(routes.length, 0);
  } finally {
    process.env.DSH_PROFILE = "web";
  }
});
