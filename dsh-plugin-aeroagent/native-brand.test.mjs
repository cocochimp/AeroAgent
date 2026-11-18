import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "./client.js";

const { installNativeBrandSkin } = globalThis.AeroAgentClient || {};

test("skins the host brand slot with the AeroAgent plane and name", () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>",
    { url: "http://127.0.0.1:3080" });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const dispose = installNativeBrandSkin();
    const style = dom.window.document.getElementById("aeroagent-brand-skin");
    assert.ok(style, "a brand style element is installed");
    assert.match(style.textContent, /\[data-slot="sidebar\.brand\.mark"\]/);
    assert.match(style.textContent, /content:"AeroAgent"/);
    assert.match(style.textContent, /data:image\/svg\+xml/);
    assert.equal(installNativeBrandSkin(), undefined, "installing twice is a no-op");
    dispose?.();
    assert.equal(dom.window.document.getElementById("aeroagent-brand-skin"), null);
  } finally {
    globalThis.document = previousDocument;
  }
});