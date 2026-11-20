import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";
import { rpcFetch } from "./tests/rpc-fetch.mjs";

const { fetchNativeOrders, createNativeOrderSelection } = globalThis.AeroAgentClient;

test("loads orders through the host RPC gateway", async () => {
  const rpc = rpcFetch({ "orders.list": async () => ({ orders: [{ order_id: "ORD1", flight_no: "MU5101" }] }) });
  const orders = await fetchNativeOrders({ userId: "u_li", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.methods(), ["orders.list"]);
  assert.deepEqual(rpc.params("orders.list"), { page_size: 20 });
  assert.equal(orders[0].order_id, "ORD1");
});

test("surfaces gateway errors and rejects malformed payloads", async () => {
  const failing = rpcFetch({ "orders.list": async () => {
    const error = new Error("订单服务暂不可用"); error.code = "UPSTREAM"; error.status = 503; throw error;
  } });
  await assert.rejects(fetchNativeOrders({ fetchImpl: failing.fetchImpl }), /订单服务暂不可用/);
  const malformed = rpcFetch({ "orders.list": async () => ({ orders: null }) });
  await assert.rejects(fetchNativeOrders({ fetchImpl: malformed.fetchImpl }), /订单响应格式不正确/);
});

test("keeps native order selections isolated per user and persists only selection", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
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
