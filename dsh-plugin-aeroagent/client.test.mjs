import test from "node:test";
import assert from "node:assert/strict";
import { parseAeroAgentQuote, orderView, requestKeys } from "./client.js";

test("parses only valid AeroAgent quote JSON", () => {
  assert.equal(parseAeroAgentQuote("ordinary text"), null);
  assert.equal(parseAeroAgentQuote('{"quote_id":"q1"'), null);
  assert.equal(parseAeroAgentQuote('{"quote_id":"q1","case_id":"case_1","action":"REFUND"}').quote_id, "q1");
});

test("maps the real nested order response", () => {
  const view = orderView({ order_id: "ORD1", flight_no: "MU5101", status: "ISSUED",
    flight: { origin: "SHA", dest: "CAN", status: "cancelled", delay_min: 0 } });
  assert.deepEqual([view.route, view.flightStatus], ["SHA → CAN", "cancelled"]);
});

test("reuses confirmation and idempotency keys for one quote", () => {
  assert.deepEqual(requestKeys("q_stable"), requestKeys("q_stable"));
});
