import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./web/store.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("isolates selected orders, cases, messages, and drafts by user", () => {
  const store = createStore({ storage: memoryStorage() });
  store.selectOrder("ORD-ZHANG");
  store.patchSession({ caseId: "case_zhang", draft: "改签" });
  store.appendMessage({ role: "user", text: "张三的问题" });
  store.switchUser("u_wang");
  store.selectOrder("ORD-WANG");
  store.patchSession({ caseId: "case_wang", draft: "退票" });
  store.appendMessage({ role: "user", text: "王五的问题" });

  assert.equal(store.getSession().selectedOrderId, "ORD-WANG");
  assert.equal(store.getSession().caseId, "case_wang");
  assert.deepEqual(store.getSession().messages.map((item) => item.text), ["王五的问题"]);
  store.switchUser("u_zhang");
  assert.equal(store.getSession().selectedOrderId, "ORD-ZHANG");
  assert.equal(store.getSession().caseId, "case_zhang");
  assert.equal(store.getSession().draft, "改签");
  assert.deepEqual(store.getSession().messages.map((item) => item.text), ["张三的问题"]);
});

test("switching users aborts only requests owned by the previous user", () => {
  const store = createStore({ storage: memoryStorage() });
  const zhangRequest = new AbortController();
  store.trackRequest(zhangRequest);
  store.switchUser("u_wang");
  const wangRequest = new AbortController();
  store.trackRequest(wangRequest);
  assert.equal(zhangRequest.signal.aborted, true);
  assert.equal(wangRequest.signal.aborted, false);
  store.switchUser("u_zhang");
  assert.equal(wangRequest.signal.aborted, true);
});

test("restores only the active user's persisted session", () => {
  const storage = memoryStorage();
  const first = createStore({ storage });
  first.patchSession({ caseId: "case_zhang", draft: "保留草稿" });
  first.switchUser("u_wang");
  first.patchSession({ caseId: "case_wang" });

  const restored = createStore({ storage });
  assert.equal(restored.getSession().caseId, "case_zhang");
  assert.equal(restored.getSession().draft, "保留草稿");
  restored.switchUser("u_wang");
  assert.equal(restored.getSession().caseId, "case_wang");
  assert.notEqual(restored.getSession().caseId, "case_zhang");
});

test("a new conversation clears case data but keeps the selected order", () => {
  const store = createStore({ storage: memoryStorage() });
  store.selectOrder("ORD1");
  store.patchSession({ caseId: "case_old", draft: "old" });
  store.appendMessage({ role: "user", text: "old" });
  store.newSession();
  assert.equal(store.getSession().caseId, null);
  assert.equal(store.getSession().draft, "");
  assert.deepEqual(store.getSession().messages, []);
  assert.equal(store.getSession().selectedOrderId, "ORD1");
});

test("archives completed conversation snapshots per user for sidebar history", () => {
  const store = createStore({ storage: memoryStorage() });
  store.patchSession({ caseId: "case_zhang_old" });
  store.appendMessage({ role: "user", text: "历史问题" });
  store.newSession();
  assert.deepEqual(store.getHistory().map((item) => item.caseId), ["case_zhang_old"]);
  store.patchSession({ caseId: "case_zhang_current" });
  store.appendMessage({ role: "user", text: "当前问题" });
  store.restoreHistory("case_zhang_old");
  assert.equal(store.getSession().caseId, "case_zhang_old");
  assert.equal(store.getSession().messages[0].text, "历史问题");
  assert.deepEqual(store.getHistory().map((item) => item.caseId), ["case_zhang_current"]);
  store.switchUser("u_wang");
  assert.deepEqual(store.getHistory(), []);
});
