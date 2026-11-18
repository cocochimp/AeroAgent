import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

function findButton(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "button") return node;
  for (const child of node.props?.children || []) {
    const match = findButton(child);
    if (match) return match;
  }
  return null;
}

test("registers AeroAgent through native DSH slots instead of replacing the host shell", () => {
  assert.equal(typeof globalThis.AeroAgentClient.nativeSlotsApply, "function");
  const calls = [];
  const ctx = {
    slots: {
      inject(name, factory) { calls.push({ type: "inject", name }); factory(); },
      register(options, component) { calls.push({ type: "register", name: options.name, id: options.id, key: options.key, component }); },
    },
    sidebarRightTabs: {
      register(definition) { calls.push({ type: "right-tab", id: definition.id, kind: definition.kind }); },
    },
    layout: { selectPanel() {} },
  };
  globalThis.AeroAgentClient.nativeSlotsApply(ctx);
  assert.ok(calls.some((call) => call.name === "sidebar.brand.mark"));
  assert.ok(calls.some((call) => call.name === "sidebar.brand.name"));
  for (const page of ["chat", "orders", "listing", "monitor"]) {
    assert.ok(calls.some((call) => call.name === "sidebar.panellist" && call.id === `aeroagent-${page}`));
    assert.ok(calls.some((call) => call.name === "main" && call.key === `aeroagent-${page}`));
  }
  assert.ok(calls.some((call) => call.type === "right-tab" && call.kind === "aeroagent-inspector"));
  assert.ok(calls.some((call) => call.name === "sidebar.right.pane.tab" && call.key === "dsh-plugin-aeroagent"));
  assert.ok(calls.some((call) => call.name === "conversation.session.header.utilities" && call.id === "aeroagent-inspector"));
});

test("returns to the real DSH conversation panel so its session rightbar stays mounted", () => {
  const calls = [];
  const selections = [];
  const ctx = {
    slots: {
      inject(_name, factory) { factory(); },
      register(options, component) { calls.push({ ...options, component }); },
    },
    sidebarRightTabs: { register() {} },
    sidebarRight: { openTab() {} },
    layout: { selectPanel(id) { selections.push(id); } },
  };
  globalThis.AeroAgentClient.nativeSlotsApply(ctx);
  const chat = calls.find((call) => call.name === "main" && call.key === "aeroagent-chat");
  const button = findButton(chat.component());
  assert.ok(button);
  button.props.onClick();
  assert.deepEqual(selections, [null]);
});
