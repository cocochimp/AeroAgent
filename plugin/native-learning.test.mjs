import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";
import { rpcFetch } from "./tests/rpc-fetch.mjs";

const {
  fetchNativeAdmin, fetchNativeRules, fetchNativeEvaluation, startNativeEvaluation,
  fetchNativeDemoData, filterNativeEvaluationCases, isNativeEvaluationTerminal, nativeSlotsApply,
} = globalThis.AeroAgentClient;

function childrenOf(node) {
  if (!node || typeof node !== "object") return [];
  const children = node.props?.children;
  return Array.isArray(children) ? children.flat(Infinity) : children ? [children] : [];
}
function findNodes(node, predicate, matches = []) {
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  for (const child of childrenOf(node)) findNodes(child, predicate, matches);
  return matches;
}
function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return childrenOf(node).map(textOf).join("");
}
function nativeContext(calls, selections = []) {
  return {
    slots: {
      inject(name, factory) { calls.push({ type: "inject", name }); factory(); },
      register(options, component) { calls.push({ type: "register", ...options, component }); },
    },
    sidebarRightTabs: { register() {} },
    sidebarRight: { openTab() {} },
    layout: { selectPanel(id) { selections.push(id); } },
  };
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
};

test("routes admin reads through the host RPC gateway", async () => {
  const rpc = rpcFetch({ "admin.rules": async () => ({ rules: [] }) });
  await fetchNativeAdmin({ path: "/rules?debug=true", userId: "u_wang", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.params("admin.rules"), { debug: "true" });
  const failing = rpcFetch({ "admin.evaluations": async () => {
    const error = new Error("学习服务暂不可用"); error.code = "UPSTREAM"; error.status = 503; throw error;
  } });
  await assert.rejects(fetchNativeAdmin({ path: "/evaluations?view=cases", fetchImpl: failing.fetchImpl }),
    /学习服务暂不可用/);
});

test("builds rule searches from existing filters", async () => {
  const rpc = rpcFetch({ "admin.rules": async () => ({ rules: [{ id: "R1" }], debug: { result_count: 1 } }) });
  const result = await fetchNativeRules({ query: "航班 取消", airline: "MU", scenario: "CANCEL",
    userId: "u_li", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.params("admin.rules"), { debug: "true", q: "航班 取消", airline: "MU", scenario: "CANCEL" });
  assert.equal(result.rules[0].id, "R1");
  const malformed = rpcFetch({ "admin.rules": async () => ({ rules: null }) });
  await assert.rejects(fetchNativeRules({ fetchImpl: malformed.fetchImpl }), /规则响应格式不正确/);
});

test("reads evaluation cases, history, and details", async () => {
  const rpc = rpcFetch({ "admin.evaluations": async (params) => params.view === "cases" ? { version: "v1", cases: [] }
    : params.view === "runs" ? { runs: [] } : { run_id: "run_1", status: "RUNNING", report: {} } });
  await fetchNativeEvaluation({ view: "cases", fetchImpl: rpc.fetchImpl });
  await fetchNativeEvaluation({ view: "runs", fetchImpl: rpc.fetchImpl });
  const detail = await fetchNativeEvaluation({ view: "run", runId: "run_1", fetchImpl: rpc.fetchImpl });
  assert.equal(detail.run_id, "run_1");
  assert.deepEqual(rpc.calls.filter((call) => call.method === "admin.evaluations").map((call) => call.params),
    [{ view: "cases" }, { view: "runs" }, { view: "run", run_id: "run_1" }]);
  await assert.rejects(fetchNativeEvaluation({ view: "run", fetchImpl: rpc.fetchImpl }), /run_id/);
});

test("starts only real offline or DeepSeek evaluations", async () => {
  const rpc = rpcFetch({ "admin.startEvaluation": async () => ({ run_id: "run_2", status: "QUEUED" }) });
  const started = await startNativeEvaluation({ mode: "offline", caseIds: ["case_2"], userId: "u_zhao",
    fetchImpl: rpc.fetchImpl });
  assert.equal(started.run_id, "run_2");
  assert.deepEqual(rpc.params("admin.startEvaluation"), { mode: "offline", case_ids: ["case_2"] });
  await assert.rejects(startNativeEvaluation({ mode: "mock", fetchImpl: rpc.fetchImpl }), /评测模式/);
});

test("loads all demo orders and profiles for admin data view", async () => {
  const rpc = rpcFetch({ "orders.list": async () => ({ orders: [], users: [], profiles: [] }) });
  const data = await fetchNativeDemoData({ userId: "u_li", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.methods(), ["orders.list"]);
  assert.deepEqual(data.profiles, []);
  const malformed = rpcFetch({ "orders.list": async () => ({ orders: null }) });
  await assert.rejects(fetchNativeDemoData({ fetchImpl: malformed.fetchImpl }), /演示数据响应格式不正确/);
});

test("filters evaluation cases locally and recognizes only terminal execution states", () => {
  const cases = [
    { id: "case_change", title: "自愿改签", question: "如何改签" },
    { id: "case_refund", title: "取消退票", question: "航班取消怎么办" },
  ];
  assert.deepEqual(filterNativeEvaluationCases(cases, "取消").map((item) => item.id), ["case_refund"]);
  assert.deepEqual(filterNativeEvaluationCases(cases, "CASE_CHANGE").map((item) => item.id), ["case_change"]);
  for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"]) assert.equal(isNativeEvaluationTerminal(status), true);
  for (const status of ["QUEUED", "RUNNING", "PENDING", undefined]) assert.equal(isNativeEvaluationTerminal(status), false);
});

test("registers learning navigation and main pages only through native DSH slots", () => {
  const calls = [];
  const selections = [];
  nativeSlotsApply(nativeContext(calls, selections), React, { storage: null });
  for (const id of ["evaluation", "rules", "data"]) {
    assert.ok(calls.some((call) => call.name === "main" && call.key === `aeroagent-${id}`));
  }
  const toolviews = calls.filter((call) => call.type === "register" && call.name === "tool.call.toolview").map((call) => call.key).sort();
  assert.deepEqual(toolviews, ["aeroagent_booking", "aeroagent_flights", "aeroagent_knowledge",
    "aeroagent_orders", "aeroagent_servicing", "aeroagent_watch"]);
  const footer = calls.find((call) => call.name === "sidebar.footer.action" && call.id === "aeroagent-footer");
  assert.ok(footer);
  const tree = footer.component();
  const [learning] = findNodes(tree, (node) => node.props?.["data-aeroagent-learning-nav"] === "");
  assert.ok(learning);
  const buttons = findNodes(tree, (node) => node.type === "button");
  assert.deepEqual(buttons.map((button) => textOf(button)), ["评测", "规则", "数据"]);
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  buttons[2].props.onClick();
  assert.deepEqual(selections, ["aeroagent-evaluation", "aeroagent-rules", "aeroagent-data"]);
});

test("native learning pages render honest initial loading states", () => {
  const calls = [];
  nativeSlotsApply(nativeContext(calls), React, { storage: null });
  for (const [id, label] of [["evaluation", "评测"], ["rules", "规则"], ["data", "订单与用户"]]) {
    const page = calls.find((call) => call.name === "main" && call.key === `aeroagent-${id}`);
    const tree = page.component();
    assert.equal(tree.props["data-aeroagent-native-page"], id);
    assert.match(textOf(tree), new RegExp(label));
    assert.match(textOf(tree), /正在读取|正在加载/);
  }
});
