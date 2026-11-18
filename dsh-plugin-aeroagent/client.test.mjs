import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "./client.js";

const { parseAeroAgentQuote, parseAeroAgentCase, orderView, requestKeys, caseView, shouldStopFollowing, quoteStateAfter } =
  globalThis.AeroAgentClient || {};

test("parses only valid AeroAgent quote JSON", () => {
  assert.equal(parseAeroAgentQuote("ordinary text"), null);
  assert.equal(parseAeroAgentQuote('{"quote_id":"q1"'), null);
  assert.equal(parseAeroAgentQuote('{"quote_id":"q1","case_id":"case_1","action":"REFUND"}').quote_id, "q1");
});

test("parses raw case metadata left by host markdown rendering", () => {
  assert.equal(parseAeroAgentCase('{"case_id":"case_1"}'), "case_1");
  assert.equal(parseAeroAgentCase('{"case_id":"case_1","quote_id":"q1"}'), null);
  assert.equal(parseAeroAgentCase("ordinary text"), null);
});

test("maps the real nested order response", () => {
  const view = orderView({ order_id: "ORD1", flight_no: "MU5101", status: "ISSUED",
    flight: { origin: "SHA", dest: "CAN", status: "cancelled", delay_min: 0 } });
  assert.deepEqual([view.route, view.flightStatus], ["SHA → CAN", "cancelled"]);
});

test("reuses confirmation and idempotency keys for one quote", () => {
  assert.deepEqual(requestKeys("q_stable"), requestKeys("q_stable"));
});

test("maps real case observability fields", () => {
  const view = caseView({ case_id: "case_1", order_id: "ORD1", status: "COMPLETED",
    result: { trace: [{ node: "verify" }], results: [{ intent: "REFUND" }],
      context: { budget: 3000 }, memory: { turns: 2 }, verify: { passed: true } }, quotes: [] });
  assert.equal(view.orderId, "ORD1");
  assert.equal(view.trace[0].node, "verify");
  assert.equal(view.verify.passed, true);
});

test("stops only at explicit terminal or review states", () => {
  assert.equal(shouldStopFollowing({ status: "PROCESSING" }), false);
  assert.equal(shouldStopFollowing({ status: "COMPLETED" }), true);
  assert.equal(shouldStopFollowing({ status: "RESULT_UNKNOWN" }), true);
});

test("accepted confirmation is processing, not success", () => {
  assert.equal(quoteStateAfter("confirming", { status: "ACCEPTED" }), "processing");
  assert.equal(quoteStateAfter("processing", { status: "COMPLETED" }), "completed");
  assert.equal(quoteStateAfter("processing", { status: "RESULT_UNKNOWN" }), "unknown");
  assert.equal(quoteStateAfter("offered", { status: "CANCELLED" }), "cancelled");
});

test("contains no module syntax rejected by the DSH classic-script bundle", async () => {
  const source = await readFile(new URL("./client.js", import.meta.url), "utf8");
  assert.equal(/^\s*export\s/m.test(source), false);
  assert.equal(/^\s*import\s/m.test(source), false);
});

test("supports repeated combo and standalone evaluation without duplicate registration", async () => {
  const previousWindow = globalThis.window;
  delete globalThis.__AERO_DSH_MODULE_REGISTERED;
  const registrations = [];
  globalThis.window = { __ModuleLoader__: { load: (entry) => registrations.push(entry) } };
  try {
    await import(`./client.js?repeat=one-${Date.now()}`);
    await import(`./client.js?repeat=two-${Date.now()}`);
    assert.equal(registrations.length, 1);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("registers the browser module with the DSH combo loader", async () => {
  const previousWindow = globalThis.window;
  delete globalThis.__AERO_DSH_MODULE_REGISTERED;
  const registrations = [];
  globalThis.window = { __ModuleLoader__: { load: (entry) => registrations.push(entry) } };
  try {
    await import(`./client.js?dsh-registration=${Date.now()}`);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, "dsh-plugin-aeroagent");
    assert.deepEqual(registrations[0].factory().inject, []);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
