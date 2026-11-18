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

test("moves actual DSH plugin/automation actions into More and hides the duplicate host sidebar root", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <aside id="host-sidebar" class="hHd-Xa_root" style="display:flex" data-left-navigation>
      <div class="hHd-Xa_sidebarContent">
        <nav class="hHd-Xa_panelList" aria-label="宿主导航">
          <button id="native-plugin" aria-label="插件">插件</button>
          <button id="native-automation" aria-label="自动化任务">自动化任务</button>
          <button id="native-more" aria-label="更多">更多</button>
          <button id="native-workspace" aria-label="工作区">工作区</button>
        </nav>
        <nav id="host-history" aria-label="会话历史"><button>宿主历史</button></nav>
      </div>
    </aside>
    <main id="root"><textarea data-composer-input="true"></textarea><button id="host-send">发送</button></main>
    <div id="aeroagent-dsh-root"><aside id="aeroagent-sidebar" data-left-navigation>
      <nav id="aeroagent-business" aria-label="业务导航"></nav>
      <div id="aero-more" class="aa-more-menu"></div>
    </aside></div>`, { url: "http://127.0.0.1:3080" });
  const { document } = dom.window;
  const moreMenu = document.getElementById("aero-more");
  const hostRoot = document.querySelector(".hHd-Xa_root");
  const isRendered = (node) => {
    for (let current = node; current; current = current.parentElement) {
      if (current.hidden || current.style.display === "none") return false;
    }
    return true;
  };
  let pluginClicks = 0;
  let automationClicks = 0;
  let hostSends = 0;
  document.getElementById("native-plugin").addEventListener("click", () => { pluginClicks += 1; });
  document.getElementById("native-automation").addEventListener("click", () => { automationClicks += 1; });
  document.getElementById("host-send").addEventListener("click", () => { hostSends += 1; });

  const integration = integrateDshHost({ document, moreMenu });
  integration.sync();
  const plugin = document.getElementById("native-plugin");
  const automation = document.getElementById("native-automation");
  assert.equal(plugin.closest(".aa-more-menu"), moreMenu);
  assert.equal(automation.closest(".aa-more-menu"), moreMenu);
  assert.equal(hostRoot.contains(plugin), false);
  assert.equal(hostRoot.contains(automation), false);
  assert.equal(hostRoot.hidden, true);
  assert.equal(hostRoot.style.display, "none");
  assert.equal(dom.window.getComputedStyle(hostRoot).display, "none");
  assert.equal(isRendered(document.getElementById("native-more")), false);
  assert.equal(isRendered(document.getElementById("native-workspace")), false);
  const visibleLeftNavigation = [...document.querySelectorAll("[data-left-navigation]")].filter(isRendered);
  assert.deepEqual(visibleLeftNavigation.map((node) => node.id), ["aeroagent-sidebar"]);
  assert.equal(document.getElementById("root").isConnected, true);
  assert.equal(isRendered(document.getElementById("root")), true);
  plugin.click(); automation.click(); document.getElementById("host-send").click();
  assert.equal(pluginClicks, 1);
  assert.equal(automationClicks, 1);
  assert.equal(hostSends, 1);
  assert.equal(moreMenu.querySelectorAll("#native-plugin, #native-automation").length, 2);
  assert.equal(hostRoot.querySelectorAll("#native-plugin, #native-automation").length, 0);

  integration.restore();
  assert.equal(document.querySelector("nav.hHd-Xa_panelList").contains(plugin), true);
  assert.equal(document.querySelector("nav.hHd-Xa_panelList").contains(automation), true);
  assert.equal(hostRoot.hidden, false);
  assert.equal(hostRoot.style.display, "flex");
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
