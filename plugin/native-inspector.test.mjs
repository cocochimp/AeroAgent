import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";
import { rpcFetch } from "./tests/rpc-fetch.mjs";

const {
  fetchNativeCase, fetchNativeLatestCase, nativeRetrievalResults, nativeFeeComparisons,
  nativeVerificationState, nativeExecutionTabs,
} = globalThis.AeroAgentClient;

test("loads an owned case through the host RPC gateway", async () => {
  const rpc = rpcFetch({ "cases.get": async () => ({ case_id: "case_1", status: "PROCESSING" }) });
  const record = await fetchNativeCase({ caseId: "case_1", userId: "u_li", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.params("cases.get"), { case_id: "case_1" });
  assert.equal(record.status, "PROCESSING");
  const failing = rpcFetch({ "cases.get": async () => {
    const error = new Error("案件不存在"); error.code = "NOT_FOUND"; error.status = 404; throw error;
  } });
  await assert.rejects(fetchNativeCase({ caseId: "case_404", fetchImpl: failing.fetchImpl }), /案件不存在/);
});

test("falls back to the current user's latest case", async () => {
  const rpc = rpcFetch({ "cases.latest": async () => ({ case_id: "case_latest", status: "PROPOSED" }) });
  const latest = await fetchNativeLatestCase({ userId: "u_zhang", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.methods(), ["cases.latest"]);
  assert.equal(latest.case_id, "case_latest");
  const empty = rpcFetch({ "cases.latest": async () => {
    const error = new Error("当前用户尚无案件"); error.code = "NOT_FOUND"; error.status = 404; throw error;
  } });
  assert.equal(await fetchNativeLatestCase({ fetchImpl: empty.fetchImpl }), null);
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
});

test("keeps missing verification pending rather than successful", () => {
  assert.equal(nativeVerificationState({}).kind, "pending");
  assert.equal(nativeVerificationState({ passed: true }).kind, "success");
  assert.equal(nativeVerificationState({ passed: false }).kind, "failure");
  assert.deepEqual(nativeExecutionTabs.map(([id]) => id), ["flow", "retrieval", "memory", "verify", "receipt"]);
});
