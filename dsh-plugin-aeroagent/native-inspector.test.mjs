import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const {
  fetchNativeCase,
  nativeRetrievalResults,
  nativeFeeComparisons,
  nativeVerificationState,
  nativeExecutionTabs,
} = globalThis.AeroAgentClient || {};

test("loads an owned case through the existing authenticated case API", async () => {
  const requests = [];
  const record = await fetchNativeCase({ caseId: "case_1", userId: "u_li", fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ case_id: "case_1", status: "PROCESSING" }) };
  } });
  assert.equal(requests[0].url, "http://127.0.0.1:8000/api/v1/cases/case_1");
  assert.equal(requests[0].options.headers.Authorization, "Bearer demo:u_li");
  assert.equal(record.status, "PROCESSING");
  await assert.rejects(fetchNativeCase({ caseId: "case_404", fetchImpl: async () => ({
    ok: false, status: 404, json: async () => ({ detail: { message: "案件不存在" } }),
  }) }), /案件不存在/);
});

test("normalizes direct and nested retrieval funnels per subrequest", () => {
  const results = [
    { intent: "CHANGE", text: "直接", funnel: [{ stage: "inject", count: 1 }] },
    { intent: "REFUND", text: "嵌套", retrieval: { funnel: [{ stage: "rerank", count: 2 }] } },
    { intent: "STATUS", text: "无漏斗", funnel: [] },
  ];
  const normalized = nativeRetrievalResults(results);
  assert.deepEqual(normalized.map((item) => item.intent), ["CHANGE", "REFUND"]);
  assert.equal(normalized[1].funnel[0].stage, "rerank");
});

test("compares displayed option fees with deterministic engine values", () => {
  const comparisons = nativeFeeComparisons({
    final: { options: [{ type: "REFUND", total: 729, fee_items: [{ name: "退票费", amount: 291 }] }] },
    results: [{ fee: { refund_fee: 291, tax: 50, refund_amount: 729 } }],
  });
  assert.equal(comparisons.length, 2);
  assert.deepEqual(comparisons.map((row) => row.matched), [true, true]);
  assert.equal(nativeFeeComparisons({ results: [{ fee: { refund_fee: 300 } }],
    final: { options: [{ type: "REFUND", total: 729, fee_items: [{ name: "退票费", amount: 291 }] }] } })[0].matched, false);
});

test("keeps missing verification pending rather than successful", () => {
  assert.equal(nativeVerificationState({}).kind, "pending");
  assert.equal(nativeVerificationState({ passed: true }).kind, "success");
  assert.equal(nativeVerificationState({ passed: false }).kind, "failure");
  assert.deepEqual(nativeExecutionTabs.map(([id]) => id), ["flow", "retrieval", "memory", "verify"]);
});