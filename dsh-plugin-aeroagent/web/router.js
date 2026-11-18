export const BUSINESS_NAV = Object.freeze([
  { id: "chat", label: "退改对话", icon: "◉" },
  { id: "orders", label: "我的订单", icon: "▤" },
  { id: "listing", label: "Listing", icon: "⌕" },
  { id: "monitor", label: "低价监控", icon: "◌" },
  { id: "more", label: "More", icon: "⋯", action: true },
]);

export const LEARNING_NAV = Object.freeze([
  { id: "eval", label: "评测", icon: "◎" },
  { id: "rules", label: "规则", icon: "▤" },
  { id: "data", label: "数据", icon: "▦" },
]);

export const PAGE_LOADERS = {
  chat: () => import("./pages/chat.js"),
  orders: () => import("./pages/orders.js"),
  listing: () => import("./pages/listing.js"),
  monitor: () => import("./pages/monitor.js"),
  eval: () => import("./pages/eval.js"),
  rules: () => import("./pages/rules.js"),
  data: () => import("./pages/data.js"),
};

/** Own one AbortController and cleanup callback per mounted page. */
export function createRouter({ loaders = PAGE_LOADERS, createContext = () => ({}),
  onChange = () => {}, onError = () => {} } = {}) {
  let generation = 0;
  let controller = new AbortController();
  let cleanup = null;
  let pageId = null;

  function currentView() {
    const ownGeneration = generation;
    return { pageId, signal: controller.signal, isCurrent: () => ownGeneration === generation && !controller.signal.aborted };
  }

  async function navigate(nextPage, { force = false } = {}) {
    if (!loaders[nextPage]) return false;
    if (pageId === nextPage && !force) return true;
    cleanup?.();
    cleanup = null;
    controller.abort();
    controller = new AbortController();
    pageId = nextPage;
    const ownGeneration = ++generation;
    const ownController = controller;
    const isCurrent = () => ownGeneration === generation && !ownController.signal.aborted;
    const context = { ...createContext(nextPage), signal: ownController.signal, isCurrent, navigate, refresh: () => navigate(pageId, { force: true }) };
    onChange({ pageId: nextPage, status: "loading" });
    try {
      const page = await loaders[nextPage]();
      if (!isCurrent()) return false;
      if (typeof page.mount !== "function") throw new TypeError(`页面 ${nextPage} 缺少 mount()`);
      const dispose = await page.mount(context);
      if (!isCurrent()) {
        if (typeof dispose === "function") dispose();
        return false;
      }
      cleanup = typeof dispose === "function" ? dispose : null;
      onChange({ pageId: nextPage, status: "ready" });
      return true;
    } catch (error) {
      if (!isCurrent() || ownController.signal.aborted || error?.name === "AbortError") return false;
      onChange({ pageId: nextPage, status: "error", error });
      onError(error, context);
      return false;
    }
  }

  return {
    navigate,
    refresh: () => pageId && navigate(pageId, { force: true }),
    get current() { return currentView(); },
    destroy() {
      generation += 1;
      controller.abort();
      cleanup?.();
      cleanup = null;
      pageId = null;
    },
  };
}
