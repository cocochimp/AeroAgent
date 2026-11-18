import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createInspector, renderRetrieval } from "./web/components/inspector.js";

const RESULTS = [
  { intent: "CHANGE", text: "直接子诉求", funnel: [{ stage: "inject", count: 1, items: [{ id: "RULE-DIRECT", title: "直接规则", score: 0.9 }] }] },
  { intent: "REFUND", text: "嵌套子诉求", retrieval: { backend: "hybrid", funnel: [
    { stage: "rerank", count: 1, k: 5, items: [{ id: "RULE-NESTED", title: "嵌套规则", score: 0.8 }] },
  ] } },
];

function withDom(callback) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try { return callback(dom.window.document); }
  finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    dom.window.close();
  }
}

test("retrieval renders direct and nested funnels with independent subrequest selection", () => withDom((document) => {
  let selected = null;
  let highlighted = null;
  const view = renderRetrieval(RESULTS, { selected: 0, onSelect: (index) => { selected = index; }, onRule: (id) => { highlighted = id; } });
  document.body.append(view);
  const choices = view.querySelectorAll("[aria-label='选择子诉求'] button");
  assert.equal(choices.length, 2);
  choices[1].click();
  assert.equal(selected, 1);

  const nested = renderRetrieval(RESULTS, { selected: 1, onRule: (id) => { highlighted = id; } });
  assert.match(nested.textContent, /嵌套子诉求/);
  assert.match(nested.textContent, /RULE-NESTED/);
  assert.doesNotMatch(nested.textContent, /RULE-DIRECT/);
  nested.querySelector(".aa-candidates button").click();
  assert.equal(highlighted, "RULE-NESTED");
}));

test("inspector showRule finds a nested funnel and highlights its owning subrequest", () => withDom((document) => {
  const host = document.createElement("div");
  document.body.append(host);
  const inspector = createInspector(host);
  inspector.update({ case_id: "case_nested", status: "PROPOSED", result: { results: RESULTS }, quotes: [] });
  inspector.showRule("RULE-NESTED");
  const selected = host.querySelector("[aria-label='选择子诉求'] button[aria-pressed='true']");
  assert.match(selected.textContent, /退票/);
  assert.match(host.textContent, /嵌套子诉求/);
  assert.equal(host.querySelector(".aa-rule-highlight code").textContent, "RULE-NESTED");
}));
