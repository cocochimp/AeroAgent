import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { QUICK_ACTIONS, quickActionPrompt } from "./web/pages/chat.js";
import { filterAndSortOrders } from "./web/pages/orders.js";
import { buildFlightListing } from "./web/pages/listing.js";
import { validateEvaluationCases } from "./web/pages/eval.js";
import { rulePayload } from "./web/pages/rules.js";

const orders = [
  { order_id: "ORD2", user_id: "u_zhang", passenger: "张三", flight_no: "MU2", date: "2026-12-02", status: "ISSUED", airline: "MU", cabin: "Y", fare: 900,
    flight: { origin: "SHA", dest: "CAN", origin_city: "上海", dest_city: "广州", dep_time: "10:00", status: "scheduled" } },
  { order_id: "ORD1", user_id: "u_zhang", passenger: "张三", flight_no: "CA1", date: "2026-12-01", status: "REFUNDED", airline: "CA", cabin: "C", fare: 1200,
    flight: { origin: "SHA", dest: "CAN", origin_city: "上海", dest_city: "广州", dep_time: "08:00", status: "cancelled" } },
  { order_id: "ORD3", user_id: "u_zhang", passenger: "张三", flight_no: "MU2", date: "2026-12-02", status: "ISSUED", airline: "MU", cabin: "Y", fare: 880,
    flight: { origin: "SHA", dest: "CAN", origin_city: "上海", dest_city: "广州", dep_time: "10:00", status: "scheduled" } },
];

test("chat quick actions cover orders, change, refund, and comparison", () => {
  assert.deepEqual(QUICK_ACTIONS.map((action) => action.id), ["orders", "change", "refund", "compare"]);
  assert.equal(quickActionPrompt("orders", "ORD1"), "查询我的订单");
  assert.match(quickActionPrompt("change", "ORD1"), /@ORD1/);
  assert.match(quickActionPrompt("refund", "ORD1"), /退票/);
  assert.match(quickActionPrompt("compare", "ORD1"), /改签.*退票|退票.*改签/);
});

test("orders filter locally without writes and support deterministic departure sorting", () => {
  const result = filterAndSortOrders(orders, { query: "ca1", status: "REFUNDED", sort: "departure-desc" });
  assert.deepEqual(result.map((order) => order.order_id), ["ORD1"]);
  assert.deepEqual(filterAndSortOrders(orders, { sort: "departure-asc" }).map((order) => order.order_id), ["ORD1", "ORD2", "ORD3"]);
});

test("Listing deduplicates flight snapshots and preserves cancelled status", () => {
  const listing = buildFlightListing(orders);
  assert.equal(listing.length, 2);
  assert.equal(listing.find((flight) => flight.flight_no === "MU2").fare, 880);
  assert.equal(listing.find((flight) => flight.flight_no === "CA1").flight.status, "cancelled");
});

test("evaluation drafts reject duplicate IDs and require expected results", () => {
  const valid = [{ id: "case_1", question: "如何退票", expect: { outcome: "ANSWER" } }];
  assert.deepEqual(validateEvaluationCases(JSON.stringify(valid)), valid);
  assert.throws(() => validateEvaluationCases(JSON.stringify([...valid, ...valid])), /不能重复/);
  assert.throws(() => validateEvaluationCases('[{"id":"case_1","question":"缺少期望"}]'), /expect/);
});

test("rule writes use the existing versioned API payload without client rule logic", () => {
  assert.deepEqual(rulePayload({ id: "R1", version: 9, updated_at: "today", airline: "MU", cabin: "Y", fare_product: "FLEX",
    scenario: "CANCEL", title: "取消", content: "规则", active: true }), {
    airline: "MU", cabin: "Y", fare_product: "FLEX", scenario: "CANCEL", title: "取消", content: "规则", active: true,
  });
});

test("Listing and monitor explicitly mark unavailable writes instead of calling new APIs", async () => {
  for (const name of ["listing", "monitor"]) {
    const source = await readFile(new URL(`./web/pages/${name}.js`, import.meta.url), "utf8");
    assert.match(source, /尚未|后续/);
    assert.doesNotMatch(source, /\/bookings|\/watches|\/flights\//);
  }
});

test("shell includes the approved brand, history, flexible space, learning area, and sticky chat layout", async () => {
  const main = await readFile(new URL("./web/main.js", import.meta.url), "utf8");
  assert.match(main, /✈/);
  assert.match(main, /AeroAgent/);
  assert.match(main, /会话历史/);
  assert.match(main, /aa-sidebar-spacer/);
  assert.match(main, /画像.*推荐.*费用|费用.*画像.*推荐/);
  const styles = await readFile(new URL("./web/styles.css", import.meta.url), "utf8");
  assert.match(styles, /aa-chat-heading[^}]*position:\s*sticky/s);
  assert.match(styles, /aa-composer[^}]*position:\s*sticky[^}]*bottom:/s);
});
