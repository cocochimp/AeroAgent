import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { el } from "./web/components.js";
import { buildFeeComparisons, verificationState } from "./web/components/inspector.js";

class FakeNode {
  constructor(tagName, text = null) {
    this.tagName = tagName;
    this.text = text;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.nodeType = text === null ? 1 : 3;
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
  get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(""); }
}

test("DOM builder treats remote strings as text, never markup", () => {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeNode("#text", String(text)),
  };
  try {
    const hostile = '<img src=x onerror="globalThis.compromised=true">';
    const node = el("div", { class: "message" }, hostile);
    assert.equal(node.children.length, 1);
    assert.equal(node.children[0].nodeType, 3);
    assert.equal(node.textContent, hostile);
    assert.equal(node.attributes.class, "message");
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("verification without a result stays pending and fee rows compare against engine facts", () => {
  assert.equal(verificationState({}).kind, "pending");
  assert.equal(verificationState({ passed: true }).kind, "success");
  assert.equal(verificationState({ passed: false }).kind, "failure");
  const rows = buildFeeComparisons({
    final: { options: [{ type: "CHANGE", fee_items: [{ name: "改期费", amount: 100 }, { name: "票面差价", amount: 50 }], total: 150 }] },
    results: [{ fee: { allowed: true, change_fee: 100, fare_diff: 50, total: 150 } }],
  });
  assert.deepEqual(rows.map((row) => [row.actual, row.expected, row.matched]), [[100, 100, true], [50, 50, true], [150, 150, true]]);
});

test("native browser modules contain no untrusted HTML rendering sinks", async () => {
  const directory = new URL("./web/", import.meta.url);
  const files = [];
  async function collect(url) {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const child = new URL(entry.name, url);
      if (entry.isDirectory()) await collect(new URL(`${entry.name}/`, url));
      else if (entry.name.endsWith(".js")) files.push(child);
    }
  }
  await collect(directory);
  assert.ok(files.length >= 12);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|\beval\s*\(/, file.pathname);
  }
});
