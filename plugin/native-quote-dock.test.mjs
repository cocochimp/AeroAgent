import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const { nativeActionableQuotes, nativeCasePhase, nativeOperationSummary } = globalThis.AeroAgentClient || {};

const QUOTE = { quote_id: "q1", action: "CHANGE", amount: 522, status: "OFFERED", currency: "CNY" };

test("only offered change/refund quotes are actionable", () => {
  assert.deepEqual(nativeActionableQuotes({
    quotes: [QUOTE, { ...QUOTE, quote_id: "q2", status: "CONFIRMED" },
      { ...QUOTE, quote_id: "q3", action: "POLICY" }],
  }).map((quote) => quote.quote_id), ["q1"]);
  assert.deepEqual(nativeActionableQuotes(null), []);
});

test("maps case status to the confirmation dock phase", () => {
  assert.equal(nativeCasePhase(null), "idle");
  assert.equal(nativeCasePhase({ status: "PROPOSED", quotes: [] }), "idle");
  assert.equal(nativeCasePhase({ status: "WAITING_CONFIRMATION", quotes: [QUOTE] }), "confirm");
  assert.equal(nativeCasePhase({ status: "WAITING_CONFIRMATION", quotes: [] }), "idle");
  assert.equal(nativeCasePhase({ status: "PROCESSING", quotes: [QUOTE] }), "processing");
  assert.equal(nativeCasePhase({ status: "COMPLETED", quotes: [QUOTE] }), "done");
});

test("summarises the executed operation by business outcome", () => {
  assert.equal(nativeOperationSummary({ result: { operation: { status: "CHANGED", ticket_no: "781-1" } } }),
    "改签完成 · 新票号 781-1");
  assert.equal(nativeOperationSummary({ result: { operation: { status: "REFUNDED", customer_amount: 630 } } }),
    "退票完成 · 退款 ¥630");
  assert.equal(nativeOperationSummary({ result: {} }), null);
});