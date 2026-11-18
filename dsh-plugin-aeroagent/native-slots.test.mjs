import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const { openNativeAeroConversation } = globalThis.AeroAgentClient || {};

test("opens the native conversation so the session rightbar remains mounted", () => {
  const selections = [];
  openNativeAeroConversation({ layout: { selectPanel(id) { selections.push(id); } } });
  assert.deepEqual(selections, [null]);
});

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
  for (const page of ["orders", "listing", "monitor"]) {
    assert.ok(calls.some((call) => call.name === "sidebar.panellist" && call.id === `aeroagent-${page}`));
    assert.ok(calls.some((call) => call.name === "main" && call.key === `aeroagent-${page}`));
  }
  assert.equal(calls.some((call) => call.name === "sidebar.panellist" && call.id === "aeroagent-chat"), false,
    "conversation is opened through the workspace or New Session, not a duplicate business tab");
  assert.ok(calls.some((call) => call.name === "sidebar.panellist.actions" && call.id === "aeroagent-default-pins"));
  assert.ok(calls.some((call) => call.type === "right-tab" && call.kind === "aeroagent-inspector"));
  assert.ok(calls.some((call) => call.name === "sidebar.right.pane.tab" && call.key === "dsh-plugin-aeroagent"));
  assert.ok(calls.some((call) => call.name === "conversation.session.header.utilities" && call.id === "aeroagent-execution-inspector"));
  assert.ok(calls.some((call) => call.name === "conversation.input.dock" && call.id === "aeroagent-order-context-bar"));
});
