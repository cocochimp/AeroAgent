import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const { fetchNativeOrders, createNativeOrderSelection } = globalThis.AeroAgentClient;

test("loads native orders through the existing authenticated v1 API", async () => {
  const requests = [];
  const orders = await fetchNativeOrders({
    backend: "http://agent.test/",
    userId: "u_li",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ orders: [{ order_id: "ORD1", flight_no: "MU5101" }] }) };
    },
  });
  assert.equal(requests[0].url, "http://agent.test/api/v1/orders");
  assert.equal(requests[0].options.headers.Authorization, "Bearer demo:u_li");
  assert.equal(orders[0].order_id, "ORD1");
});

test("surfaces native order API errors and rejects malformed payloads", async () => {
  await assert.rejects(fetchNativeOrders({ fetchImpl: async () => ({
    ok: false, status: 503, json: async () => ({ error: { message: "订单服务暂不可用" } }),
  }) }), /订单服务暂不可用/);
  await assert.rejects(fetchNativeOrders({ fetchImpl: async () => ({
    ok: true, json: async () => ({ orders: null }),
  }) }), /订单响应格式不正确/);
});

test("keeps native order selections isolated per user and persists only selection", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const selection = createNativeOrderSelection({ storage });
  const order = { order_id: "ORD1", flight_no: "MU5101", passenger: "张三" };
  let notifications = 0;
  const unsubscribe = selection.subscribe(() => { notifications += 1; });
  selection.select("u_zhang", order);
  assert.equal(selection.get("u_zhang"), order);
  assert.equal(selection.get("u_li"), null);
  assert.equal(notifications, 1);
  assert.match(values.get("aeroagent-native-order:u_zhang"), /ORD1/);
  unsubscribe();
  selection.select("u_zhang", null);
  assert.equal(notifications, 1);
});

test("restores a valid native selection and ignores corrupt storage", () => {
  const order = { order_id: "ORD1", flight_no: "MU5101" };
  const restored = createNativeOrderSelection({ storage: {
    getItem: (key) => key.endsWith("u_zhang") ? JSON.stringify(order) : "not-json",
    setItem() {},
  } });
  assert.deepEqual(restored.get("u_zhang"), order);
  assert.equal(restored.get("u_li"), null);
});
