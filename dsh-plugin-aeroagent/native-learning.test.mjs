import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const {
  fetchNativeAdmin,
  fetchNativeRules,
  fetchNativeEvaluation,
  startNativeEvaluation,
  fetchNativeDemoData,
  filterNativeEvaluationCases,
  isNativeEvaluationTerminal,
  nativeSlotsApply,
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

test("uses admin demo auth for existing learning APIs and surfaces structured errors", async () => {
  const requests = [];
  await fetchNativeAdmin({ path: "/rules?debug=true", userId: "u_wang", fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ rules: [] }) };
  } });
  assert.equal(requests[0].url, "http://127.0.0.1:8000/api/v1/admin/rules?debug=true");
  assert.equal(requests[0].options.headers.Authorization, "Bearer demo-admin:u_wang");
  await assert.rejects(fetchNativeAdmin({ path: "/evaluations?view=cases", fetchImpl: async () => ({
    ok: false, status: 503, json: async () => ({ detail: { message: "学习服务暂不可用" } }),
  }) }), /学习服务暂不可用/);
});

test("builds rule searches from existing filters and rejects malformed responses", async () => {
  const requests = [];
  const result = await fetchNativeRules({ query: "航班 取消", airline: "MU", scenario: "CANCEL", userId: "u_li",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ rules: [{ id: "R1" }], debug: { result_count: 1 } }) };
    } });
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/api/v1/admin/rules");
  assert.equal(url.searchParams.get("debug"), "true");
  assert.equal(url.searchParams.get("q"), "航班 取消");
  assert.equal(url.searchParams.get("airline"), "MU");
  assert.equal(url.searchParams.get("scenario"), "CANCEL");
  assert.equal(requests[0].options.headers.Authorization, "Bearer demo-admin:u_li");
  assert.equal(result.rules[0].id, "R1");
  await assert.rejects(fetchNativeRules({ fetchImpl: async () => ({ ok: true, json: async () => ({ rules: null }) }) }),
    /规则响应格式不正确/);
});

test("reads evaluation cases, history, and details through the existing view contract", async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(String(url));
    const parsed = new URL(url);
    const view = parsed.searchParams.get("view");
    return { ok: true, json: async () => view === "cases" ? { version: "v1", cases: [] }
      : view === "runs" ? { runs: [] } : { run_id: "run_1", status: "RUNNING", report: {} } };
  };
  await fetchNativeEvaluation({ view: "cases", fetchImpl });
  await fetchNativeEvaluation({ view: "runs", fetchImpl });
  const detail = await fetchNativeEvaluation({ view: "run", runId: "run_1", fetchImpl });
  assert.equal(detail.run_id, "run_1");
  assert.deepEqual(paths.map((path) => path.replace("http://127.0.0.1:8000", "")), [
    "/api/v1/admin/evaluations?view=cases",
    "/api/v1/admin/evaluations?view=runs",
    "/api/v1/admin/evaluations?view=run&run_id=run_1",
  ]);
  await assert.rejects(fetchNativeEvaluation({ view: "run", fetchImpl }), /run_id/);
});

test("starts only real offline or DeepSeek evaluations with optional selected cases", async () => {
  const requests = [];
  const started = await startNativeEvaluation({ mode: "offline", caseIds: ["case_2"], userId: "u_zhao",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 202, json: async () => ({ run_id: "run_2", status: "QUEUED" }) };
    } });
  assert.equal(started.run_id, "run_2");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer demo-admin:u_zhao");
  assert.deepEqual(JSON.parse(requests[0].options.body), { mode: "offline", case_ids: ["case_2"] });
  await assert.rejects(startNativeEvaluation({ mode: "mock", fetchImpl: async () => { throw new Error("must not fetch"); } }),
    /评测模式/);
});

test("loads all demo orders and profiles with admin identity, not passenger-only data", async () => {
  const requests = [];
  const data = await fetchNativeDemoData({ userId: "u_li", fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ orders: [], users: [], profiles: [] }) };
  } });
  assert.equal(requests[0].url, "http://127.0.0.1:8000/api/v1/orders");
  assert.equal(requests[0].options.headers.Authorization, "Bearer demo-admin:u_li");
  assert.deepEqual(data.profiles, []);
  await assert.rejects(fetchNativeDemoData({ fetchImpl: async () => ({ ok: true, json: async () => ({ orders: null }) }) }),
    /演示数据响应格式不正确/);
});

test("filters evaluation cases locally and recognizes only terminal execution states", () => {
  const cases = [
    { id: "case_change", title: "自愿改签", question: "如何改签" },
    { id: "case_refund", title: "取消退票", question: "航班取消怎么办" },
  ];
  assert.deepEqual(filterNativeEvaluationCases(cases, "取消").map((item) => item.id), ["case_refund"]);
  assert.deepEqual(filterNativeEvaluationCases(cases, "CASE_CHANGE").map((item) => item.id), ["case_change"]);
  assert.deepEqual(filterNativeEvaluationCases(cases, "不存在"), []);
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
  const footer = calls.find((call) => call.name === "sidebar.footer.action" && call.id === "aeroagent-footer");
  assert.ok(footer);
  const tree = footer.component();
  const [learning] = findNodes(tree, (node) => node.props?.["data-aeroagent-learning-nav"] === "");
  assert.ok(learning, "learning navigation must be a full-width row group");
  assert.equal(learning.props.style.gridTemplateColumns, undefined);
  const buttons = findNodes(tree, (node) => node.type === "button");
  assert.deepEqual(buttons.map((button) => textOf(button)), ["评测", "规则", "数据"]);
  for (const button of buttons) assert.equal(button.props.style.width, "100%");
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
