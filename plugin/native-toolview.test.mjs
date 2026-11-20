import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const { nativeSlotsApply } = globalThis.AeroAgentClient;

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
};

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.props?.children || []).flat(Infinity).map(textOf).join("");
}

function components() {
  const calls = [];
  const ctx = {
    slots: {
      inject(_name, factory) { factory(); },
      register(options, component) { calls.push({ ...options, component }); },
    },
    sidebarRightTabs: { register() {} },
    sidebarRight: { openTab() {} },
    layout: { selectPanel() {} },
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === "function") dispose(); }; },
  };
  nativeSlotsApply(ctx, React, { storage: null });
  return (key) => calls.find((call) => call.name === "tool.call.toolview" && call.key === key)?.component;
}

test("renders an offered quote card with confirm and cancel actions", () => {
  const servicing = components()("aeroagent_servicing");
  const block = { meta: { case_id: "case_1", status: "WAITING_CONFIRMATION", quotes: [{
    quote_id: "q1", action: "CHANGE", amount: 522, status: "OFFERED",
    details: [{ title: "改签至 2026-09-28 MU5121", fee_items: [{ name: "改期费", amount: 100 },
      { name: "票面差价", amount: 422 }], rule_refs: ["R1"] }],
  }] } };
  const text = textOf(servicing({ block, phase: "result" }));
  assert.match(text, /改签至 2026-09-28 MU5121/);
  assert.match(text, /¥522/);
  assert.match(text, /依据：R1/);
  assert.match(text, /确认办理/);
  assert.match(text, /暂不办理/);
});

test("renders clarify options without auto-confirming", () => {
  const servicing = components()("aeroagent_servicing");
  const block = { meta: { case_id: "case_1", status: "NEEDS_INFORMATION", result: {
    interrupt: { kind: "clarify", question: "想改签到哪一天？", options: [{ label: "2026-09-28（周一）", value: "2026-09-28" }] },
  } } };
  const text = textOf(servicing({ block, phase: "result" }));
  assert.match(text, /想改签到哪一天/);
  assert.match(text, /2026-09-28/);
  assert.doesNotMatch(text, /确认办理/);
});

test("renders order lists with eligibility hints", () => {
  const orders = components()("aeroagent_orders");
  const tree = orders({ block: { meta: { orders: [{ order_id: "ORD1", flight_no: "MU5101",
    date: "2026-09-28", status: "ISSUED", eligibility: { change: { allowed: true } } }] } }, phase: "result" });
  const text = textOf(tree);
  assert.match(text, /ORD1/);
  assert.match(text, /可改签/);
});
