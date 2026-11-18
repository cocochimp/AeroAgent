import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { autoMountAeroAgent, integrateDshHost } from "./web/main.js";

test("auto-mount marks the client loaded only after the root mounts", () => {
  const root = { id: "aeroagent-dsh-root" };
  const document = { readyState: "complete", root: null, getElementById() { return this.root; } };
  const window = {};
  let mounts = 0;
  const mounted = autoMountAeroAgent({ document, window, mount: () => { mounts += 1; document.root = root; } });
  assert.equal(mounted, true);
  assert.equal(mounts, 1);
  assert.equal(window.__AERO_CLIENT_LOADED, true);

  const failedWindow = {};
  const failedDocument = { readyState: "complete", getElementById: () => null };
  assert.equal(autoMountAeroAgent({ document: failedDocument, window: failedWindow, mount: () => {} }), false);
  assert.equal(failedWindow.__AERO_CLIENT_LOADED, undefined);
  assert.throws(() => autoMountAeroAgent({ document: failedDocument, window: failedWindow, mount: () => { throw new Error("mount failed"); } }), /mount failed/);
  assert.equal(failedWindow.__AERO_CLIENT_LOADED, undefined);
});

test("auto-mount waits for DOMContentLoaded before marking readiness", () => {
  let ready;
  const root = { id: "aeroagent-dsh-root" };
  const document = { readyState: "loading", root: null,
    getElementById() { return this.root; },
    addEventListener(type, callback) { assert.equal(type, "DOMContentLoaded"); ready = callback; } };
  const window = {};
  assert.equal(autoMountAeroAgent({ document, window, mount: () => { document.root = root; } }), false);
  assert.equal(window.__AERO_CLIENT_LOADED, undefined);
  document.readyState = "complete";
  ready();
  assert.equal(window.__AERO_CLIENT_LOADED, true);
});

test("moves native DSH plugin/automation actions into More without duplicating host navigation", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <aside id="host-sidebar">
      <nav class="hHd-Xa_panelList" aria-label="宿主导航">
        <button id="native-plugin" aria-label="插件">插件</button>
        <button id="native-automation" aria-label="自动化">自动化</button>
        <button id="native-other" aria-label="其他">其他</button>
      </nav>
      <nav id="host-history" aria-label="会话历史"><button>宿主历史</button></nav>
    </aside>
    <main id="root"><textarea data-composer-input="true"></textarea></main>`, { url: "http://127.0.0.1:3080" });
  const { document } = dom.window;
  const moreMenu = document.createElement("div");
  moreMenu.className = "aa-more-menu";
  document.body.append(moreMenu);
  let pluginClicks = 0;
  let automationClicks = 0;
  document.getElementById("native-plugin").addEventListener("click", () => { pluginClicks += 1; });
  document.getElementById("native-automation").addEventListener("click", () => { automationClicks += 1; });

  const integration = integrateDshHost({ document, moreMenu });
  integration.sync();
  const plugin = document.getElementById("native-plugin");
  const automation = document.getElementById("native-automation");
  assert.equal(plugin.parentElement.closest(".aa-more-menu"), moreMenu);
  assert.equal(automation.parentElement.closest(".aa-more-menu"), moreMenu);
  assert.equal(document.querySelector("nav.hHd-Xa_panelList").hidden, true);
  assert.equal(document.getElementById("host-history").hidden, true);
  assert.equal(document.getElementById("root").isConnected, true);
  assert.equal(document.getElementById("root").hidden, false);
  plugin.click(); automation.click();
  assert.equal(pluginClicks, 1);
  assert.equal(automationClicks, 1);
  assert.equal(document.querySelectorAll("#native-plugin").length, 1);
  assert.equal(document.querySelectorAll("#native-automation").length, 1);

  integration.restore();
  assert.equal(document.querySelector("nav.hHd-Xa_panelList").contains(plugin), true);
  assert.equal(document.querySelector("nav.hHd-Xa_panelList").contains(automation), true);
  assert.equal(document.querySelector("nav.hHd-Xa_panelList").hidden, false);
  assert.equal(document.getElementById("host-history").hidden, false);
  dom.window.close();
});

test("uses DSH-native neutral surfaces, blue pill actions, and transparent navigation", async () => {
  const styles = await readFile(new URL("./web/styles.css", import.meta.url), "utf8");
  assert.match(styles, /body\s*\{[^}]*background:\s*rgb\(21,21,23\)/s);
  assert.match(styles, /--aa-text:\s*rgb\(249,250,251\)/);
  assert.match(styles, /aa-composer-form[^}]*background:\s*rgb\(44,44,46\)[^}]*border-radius:\s*28px/s);
  assert.match(styles, /aa-button-primary[^}]*background:\s*rgb\(122,170,255\)[^}]*border-radius:\s*999px/s);
  assert.match(styles, /aa-nav-item[^}]*background:\s*transparent[^}]*border-radius:\s*12px/s);
  assert.doesNotMatch(styles, /gradient|#8b7cf6|#6450cf|#7765df/i);
});
