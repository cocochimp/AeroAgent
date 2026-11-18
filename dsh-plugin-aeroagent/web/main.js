import { createApi } from "./api.js";
import { el, stateView } from "./components.js";
import { BUSINESS_NAV, LEARNING_NAV, PAGE_LOADERS, createRouter } from "./router.js";
import { createStore } from "./store.js";

export function mountAeroAgent({ backend = globalThis.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000" } = {}) {
  const existing = document.getElementById("aeroagent-dsh-root");
  if (existing) return existing.__aeroDestroy || (() => {});
  const store = createStore();
  const api = createApi({ baseUrl: backend });
  const outlet = el("main", { class: "aa-view", id: "aeroagent-view", tabindex: "-1" });
  const historyList = el("div", { class: "aa-history-list" });
  const userButton = el("button", { type: "button", class: "aa-user-button", "aria-haspopup": "menu", "aria-expanded": "false" });
  const userMenu = el("div", { class: "aa-user-menu", role: "menu", hidden: true });
  const moreMenu = el("div", { class: "aa-more-menu", hidden: true });
  let router;
  let currentPage = "chat";

  function go(pageId, force = false) {
    if (!PAGE_LOADERS[pageId]) return;
    moreMenu.hidden = true; userMenu.hidden = true; userButton.setAttribute("aria-expanded", "false");
    if (force || router.current.pageId === pageId) router.refresh();
    else router.navigate(pageId);
  }

  function navItem(item) {
    if (item.action) return el("button", { type: "button", class: "aa-nav-item", dataset: { page: item.id },
      "aria-expanded": "false", onclick: (event) => {
        moreMenu.hidden = !moreMenu.hidden; event.currentTarget.setAttribute("aria-expanded", String(!moreMenu.hidden));
      } }, el("span", { class: "aa-nav-icon", "aria-hidden": "true" }, item.icon), el("span", null, item.label));
    return el("button", { type: "button", class: "aa-nav-item", dataset: { page: item.id }, onclick: () => go(item.id) },
      el("span", { class: "aa-nav-icon", "aria-hidden": "true" }, item.icon), el("span", null, item.label));
  }

  function drawHistory() {
    const active = store.getSession();
    const archived = store.getHistory();
    const entries = [...(active.caseId || active.messages.length ? [{ ...active, active: true }] : []), ...archived];
    historyList.replaceChildren(entries.length ? entries.map((entry) => el("button", { type: "button",
      class: entry.active ? "aa-history-item active" : "aa-history-item",
      onclick: () => { if (!entry.active) store.restoreHistory(entry.caseId); go("chat", true); },
    }, el("span", null, entry.messages.find((message) => message.role === "user")?.text || "退改对话"),
      el("code", null, entry.caseId || "新会话"))) : el("p", { class: "aa-history-empty" }, "暂无会话记录"));
  }

  function drawUser() {
    const user = store.getUser();
    userButton.replaceChildren(el("span", { class: "aa-avatar", "aria-hidden": "true" }, user.name.slice(0, 1)),
      el("span", null, el("strong", null, user.name), el("small", null, user.tier)), el("span", { "aria-hidden": "true" }, "⌃"));
    userMenu.replaceChildren(el("p", { class: "aa-user-menu-label" }, "切换演示用户"),
      ...store.getUsers().map((item) => el("button", { type: "button", role: "menuitemradio", "aria-checked": item.user_id === store.getUserId(),
        onclick: () => { store.switchUser(item.user_id); go(currentPage, true); } },
        el("span", null, `${item.name} · ${item.tier}`), item.user_id === store.getUserId() ? el("b", null, "✓") : null)),
      el("p", { class: "aa-user-purpose" }, "画像只用于推荐与检索排序，不影响费用；切换用户会取消当前请求并恢复该用户会话。"));
  }

  userButton.addEventListener("click", () => {
    userMenu.hidden = !userMenu.hidden; moreMenu.hidden = true;
    userButton.setAttribute("aria-expanded", String(!userMenu.hidden));
  });
  moreMenu.replaceChildren(el("strong", null, "AeroAgent · 演示工作台"),
    el("p", null, "原生 ESM · 直接连接现有 /api/v1。订单、票价和交易结果均以服务端为准。"),
    el("button", { type: "button", onclick: () => go("chat") }, "打开退改对话"),
    el("button", { type: "button", onclick: () => go("rules") }, "检查票规检索"));

  const root = el("div", { class: "aa-app", id: "aeroagent-dsh-root" },
    el("aside", { class: "aa-sidebar" },
      el("div", { class: "aa-brand", "aria-label": "AeroAgent 工作台" }, el("span", { class: "aa-brand-plane", "aria-hidden": "true" }, "✈"),
        el("span", null, el("strong", null, "AeroAgent"), el("small", null, "AGENT WORKBENCH"))),
      el("nav", { class: "aa-business-nav", "aria-label": "业务导航" }, BUSINESS_NAV.map(navItem)), moreMenu,
      el("section", { class: "aa-history", "aria-label": "会话历史" },
        el("div", { class: "aa-sidebar-label" }, el("span", null, "会话历史"),
          el("button", { type: "button", "aria-label": "新建会话", title: "新建会话", onclick: () => { store.newSession(); go("chat", true); } }, "+")), historyList),
      el("div", { class: "aa-sidebar-spacer" }),
      el("nav", { class: "aa-learning-nav", "aria-label": "业务学习" }, el("p", { class: "aa-sidebar-label" }, "业务学习"), LEARNING_NAV.map(navItem)),
      el("div", { class: "aa-user-switcher" }, userButton, userMenu)), outlet);

  router = createRouter({
    createContext: () => ({ outlet, api, store }),
    onChange: ({ pageId, status }) => {
      currentPage = pageId;
      root.querySelectorAll("[data-page]").forEach((button) => {
        const active = button.dataset.page === pageId;
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
      });
      if (status === "loading") outlet.replaceChildren(stateView("loading", "正在加载工作区…"));
    },
    onError: (error, context) => {
      context.outlet.replaceChildren(stateView("error", "工作区加载失败", error.message),
        el("button", { type: "button", class: "aa-button", onclick: () => router.refresh() }, "重试"));
    },
  });
  const unsubscribe = store.subscribe(() => { drawHistory(); drawUser(); });
  drawHistory(); drawUser();
  document.body.append(root);
  router.navigate("chat");
  const destroy = () => { unsubscribe(); router.destroy(); root.remove(); delete root.__aeroDestroy; };
  root.__aeroDestroy = destroy;
  return destroy;
}

if (typeof document !== "undefined") {
  const start = () => mountAeroAgent();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
