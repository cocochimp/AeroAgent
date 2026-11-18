import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mount } from "./web/pages/eval.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((res) => { resolve = res; }); return { promise, resolve }; };

async function setup({ startRun, detail }) {
  const dom = new JSDOM("<!doctype html><body><main id=\"outlet\"></main></body>", { url: "http://127.0.0.1:3080" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const store = { getUserId: () => "u_zhang" };
  const controller = new AbortController();
  let starts = 0;
  const api = {
    get: async (path) => {
      if (path === "/admin/evaluations?view=cases") return { version: "v1", cases: [{ id: "case_1", question: "退票", expect: {} }] };
      if (path === "/admin/evaluations?view=runs") return { runs: [] };
      if (path.includes("view=run&run_id=run_new")) return detail.promise;
      throw new Error(`unexpected GET ${path}`);
    },
    put: async () => ({ version: "v2", count: 1 }),
    post: async () => { starts += 1; return startRun(); },
  };
  const outlet = document.getElementById("outlet");
  const cleanup = await mount({ outlet, api, store, signal: controller.signal, isCurrent: () => true });
  const button = [...outlet.querySelectorAll("button")].find((node) => node.textContent === "保存并运行");
  return { dom, button, get starts() { return starts; }, cleanup: () => {
    cleanup(); controller.abort();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    dom.window.close();
  } };
}

test("queued run prevents duplicate submissions until its terminal snapshot", async () => {
  const detail = deferred();
  const context = await setup({ startRun: () => ({ run_id: "run_new", status: "QUEUED" }), detail });
  try {
    context.button.click();
    await flush();
    assert.equal(context.starts, 1);
    assert.equal(context.button.disabled, true);
    context.button.click();
    await flush();
    assert.equal(context.starts, 1);
    detail.resolve({ run_id: "run_new", status: "SUCCEEDED", mode: "offline", progress: { completed: 1, total: 1 }, report: {} });
    await flush();
    assert.equal(context.button.disabled, false);
  } finally { context.cleanup(); }
});

test("startup failure releases the run action without creating a duplicate", async () => {
  const detail = deferred();
  const context = await setup({ startRun: () => { throw new Error("startup failed"); }, detail });
  try {
    context.button.click();
    await flush();
    assert.equal(context.starts, 1);
    assert.equal(context.button.disabled, false);
    assert.match(document.querySelector("#outlet").textContent, /startup failed/);
  } finally { context.cleanup(); }
});
