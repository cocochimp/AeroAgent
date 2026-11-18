import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mount } from "./web/pages/chat.js";
import { createStore } from "./web/store.js";

const ORDER = { order_id: "ORD1", user_id: "u_zhang", passenger: "张三", flight_no: "MU5101", date: "2026-12-01",
  status: "ISSUED", fare: 800, flight: { origin: "SHA", dest: "CAN", status: "scheduled", delay_min: 0 } };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

async function setup(post, prepare = () => {}) {
  const dom = new JSDOM("<!doctype html><body><main id=\"outlet\"></main></body>", { url: "http://127.0.0.1:3080" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const store = createStore({ storage: storage() });
  store.selectOrder("ORD1");
  prepare(store);
  const controller = new AbortController();
  const outlet = document.getElementById("outlet");
  const api = {
    get: async (path) => { if (path === "/orders") return { orders: [ORDER] }; throw new Error(`unexpected GET ${path}`); },
    post,
    stream: async () => "",
  };
  const cleanup = await mount({ outlet, api, store, signal: controller.signal, isCurrent: () => true });
  function submit(text) {
    const input = outlet.querySelector(".aa-composer-input");
    input.value = text;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    outlet.querySelector(".aa-composer-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  }
  return { dom, store, outlet, submit, cleanup: () => {
    cleanup(); controller.abort();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    dom.window.close();
  } };
}

test("failed send restores one draft and a successful retry stores exactly one user message", async () => {
  let attempts = 0;
  const context = await setup(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return { case_id: "case_retry", status: "OPEN" };
  });
  try {
    context.submit("帮我改签");
    await flush();
    assert.equal(attempts, 1);
    assert.equal(context.store.getSession().messages.filter((message) => message.role === "user" && message.text === "帮我改签").length, 0);
    assert.equal(context.store.getSession().draft, "帮我改签");
    context.submit("帮我改签");
    await flush();
    assert.equal(attempts, 2);
    assert.equal(context.store.getSession().messages.filter((message) => message.role === "user" && message.text === "帮我改签").length, 1);
    assert.equal(context.store.getSession().draft, "");
  } finally { context.cleanup(); }
});

test("deferred case creation cannot mutate either user after a user switch", async () => {
  const response = deferred();
  const context = await setup(() => response.promise);
  try {
    context.submit("张三的延迟请求");
    await flush();
    context.store.switchUser("u_wang");
    response.resolve({ case_id: "case_zhang_late", status: "OPEN" });
    await flush();
    assert.equal(context.store.getSession("u_zhang").caseId, null);
    assert.equal(context.store.getSession("u_zhang").messages.some((message) => message.text === "张三的延迟请求"), false);
    assert.equal(context.store.getSession("u_wang").caseId, null);
    assert.equal(context.store.getSession("u_wang").messages.length, 0);
  } finally { context.cleanup(); }
});

test("deferred case creation cannot populate a newly created conversation", async () => {
  const response = deferred();
  const context = await setup(() => response.promise);
  try {
    context.submit("新建会话前的请求");
    await flush();
    context.store.newSession();
    response.resolve({ case_id: "case_stale_new", status: "OPEN" });
    await flush();
    assert.equal(context.store.getSession().caseId, null);
    assert.equal(context.store.getSession().messages.length, 0);
    assert.equal(context.store.getHistory().some((entry) => entry.caseId === "case_stale_new" || entry.messages.some((message) => message.text === "新建会话前的请求")), false);
  } finally { context.cleanup(); }
});

test("deferred case creation cannot contaminate a restored history generation", async () => {
  const response = deferred();
  const context = await setup(() => response.promise, (store) => {
    store.patchSession({ caseId: "case_history" });
    store.appendMessage({ role: "user", text: "历史消息" });
    store.newSession();
    store.selectOrder("ORD1");
  });
  try {
    context.submit("恢复历史前的请求");
    await flush();
    context.store.restoreHistory("case_history");
    response.resolve({ case_id: "case_stale_history", status: "OPEN" });
    await flush();
    assert.equal(context.store.getSession().caseId, "case_history");
    assert.deepEqual(context.store.getSession().messages.map((message) => message.text), ["历史消息"]);
    assert.equal(context.store.getHistory().some((entry) => entry.caseId === "case_stale_history" || entry.messages.some((message) => message.text === "恢复历史前的请求")), false);
  } finally { context.cleanup(); }
});

test("owned mutations reject stale generations, including session ABA restoration", () => {
  const store = createStore({ storage: storage() });
  store.patchSession({ caseId: "case_A" });
  store.newSession();
  const stale = store.captureOwner();
  store.restoreHistory("case_A");
  assert.equal(store.isOwnerCurrent(stale), false);
  assert.equal(store.patchSessionFor(stale, { caseId: "case_contamination" }), null);
  assert.equal(store.getSession().caseId, "case_A");
  store.switchUser("u_wang");
  store.switchUser("u_zhang");
  const restoredOwner = store.captureOwner();
  store.newSession();
  store.restoreHistory("case_A");
  assert.equal(store.isOwnerCurrent(restoredOwner), false);
});
