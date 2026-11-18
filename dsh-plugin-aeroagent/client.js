// AeroAgent DSH bootstrap: classic script only; native modules are served by FastAPI.
(() => {
const BACKEND = globalThis.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000";
const keyCache = new Map();

function parseAeroAgentQuote(text) {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value.quote_id === "string" && typeof value.case_id === "string" &&
      ["CHANGE", "REFUND"].includes(value.action) ? value : null;
  } catch { return null; }
}

function parseAeroAgentCase(text) {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value.case_id === "string" && value.case_id.startsWith("case_") && !value.quote_id
      ? value.case_id : null;
  } catch { return null; }
}

function orderView(order) {
  const flight = order.flight || {};
  return { ...order, route: `${flight.origin || "—"} → ${flight.dest || "—"}`,
    flightStatus: flight.status || "unknown", delayMinutes: flight.delay_min || 0 };
}

function requestKeys(quoteId) {
  if (!keyCache.has(quoteId)) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    keyCache.set(quoteId, { confirmationId: `confirm-${id}`, idempotencyKey: `ticket-${id}` });
  }
  return keyCache.get(quoteId);
}

function caseView(record) {
  const result = record.result || {};
  return { caseId: record.case_id, status: record.status || "UNKNOWN", orderId: record.order_id || null,
    quotes: record.quotes || [], trace: result.trace || [], results: result.results || [],
    context: result.context || {}, memory: result.memory || {}, verify: result.verify || {},
    final: result.final || {} };
}

function shouldStopFollowing(record) {
  return ["COMPLETED", "CANCELLED", "HUMAN_REVIEW", "RESULT_UNKNOWN"].includes(record.status);
}

function quoteStateAfter(_current, result) {
  const status = result.status;
  if (status === "ACCEPTED" || status === "PROCESSING") return "processing";
  if (status === "COMPLETED") return "completed";
  if (status === "CANCELLED") return "cancelled";
  if (status === "REQUOTE_REQUIRED" || status === "WAITING_CONFIRMATION") return "requote";
  if (status === "RESULT_UNKNOWN") return "unknown";
  if (["FAILED", "HUMAN_REVIEW"].includes(status)) return "failed";
  return "confirming";
}

function followAction(_type, record) {
  if (record.status === "WAITING_CONFIRMATION" &&
      (record.quotes || []).some((quote) => quote.status === "OFFERED")) return "requote";
  return shouldStopFollowing(record) ? "stop" : "continue";
}

function quoteCardState(record, quote) {
  if (record.status === "RESULT_UNKNOWN") return "unknown";
  if (["HUMAN_REVIEW", "FAILED"].includes(record.status)) return "failed";
  if (record.status === "CANCELLED" || quote.status === "CANCELLED") return "cancelled";
  if (record.status === "COMPLETED" || quote.status === "EXECUTED") {
    return quote.status === "EXECUTED" ? "completed" : "cancelled";
  }
  if (quote.status === "REQUOTE_REQUIRED") return "requote";
  if (record.status === "PROCESSING" || quote.status === "CONFIRMED") return "processing";
  if (record.status === "WAITING_CONFIRMATION" && quote.status === "OFFERED") return "offered";
  return "failed";
}

function traceEventKey(event) {
  return JSON.stringify([event.node || "", event.at || "", event.status || ""]);
}

function verificationView(verify) {
  if (verify.passed === true) return { kind: "success", label: "✓ 本轮结果校验通过" };
  if (verify.passed === false) return { kind: "failure", label: "本轮结果校验未通过" };
  return { kind: "pending", label: "暂无校验结果" };
}

async function fetchNativeOrders({ backend = BACKEND, userId = "u_zhang", signal,
  fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`${String(backend).replace(/\/+$/, "")}/api/v1/orders`, {
    signal,
    headers: { Authorization: `Bearer demo:${userId}`, "Content-Type": "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.detail?.message ||
      (typeof payload?.detail === "string" ? payload.detail : `订单加载失败 (${response.status})`);
    throw new Error(message);
  }
  if (!Array.isArray(payload?.orders)) throw new Error("订单响应格式不正确");
  return payload.orders;
}

/** Session-local selected order snapshots; selecting never calls chat or paid APIs. */
function createNativeOrderSelection({ storage = globalThis.localStorage } = {}) {
  const values = new Map();
  const listeners = new Set();
  const keyFor = (userId) => `aeroagent-native-order:${userId}`;
  function get(userId) {
    if (values.has(userId)) return values.get(userId);
    let value = null;
    try {
      const restored = JSON.parse(storage?.getItem(keyFor(userId)) || "null");
      if (restored && typeof restored.order_id === "string") value = restored;
    } catch { value = null; }
    values.set(userId, value);
    return value;
  }
  function select(userId, order) {
    const value = order && typeof order.order_id === "string" ? order : null;
    values.set(userId, value);
    try {
      if (value) storage?.setItem(keyFor(userId), JSON.stringify(value));
      else storage?.removeItem?.(keyFor(userId));
    } catch { /* In-memory selection remains available in private mode. */ }
    listeners.forEach((listener) => listener(userId));
  }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  return { get, select, subscribe };
}

const NATIVE_PAGES = [
  { id: "chat", label: "退改对话", icon: "chat", order: -30,
    description: "在 DSH 原生工作台中处理订单查询、退票与改签。" },
  { id: "orders", label: "我的订单", icon: "orders", order: -20,
    description: "在 DSH 原生主面板中查看和选择客票。" },
  { id: "listing", label: "Listing", icon: "search", order: -10,
    description: "按航线和日期检索可预订航班。" },
  { id: "monitor", label: "低价监控", icon: "monitor", order: -5,
    description: "在 DSH 中管理低价监控和提醒。" },
];

/** Contribute AeroAgent without replacing, moving, or hiding any DSH host UI. */
function nativeSlotsApply(ctx, React) {
  const h = React?.createElement || ((type, props, ...children) => ({ type, props: { ...props, children } }));
  const userId = "u_zhang";
  const selection = createNativeOrderSelection();
  const primaryButton = { padding: "7px 14px", border: 0, borderRadius: 7,
    background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)",
    font: "inherit", fontSize: 13, cursor: "pointer" };
  const secondaryButton = { padding: "6px 11px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 7,
    background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
    font: "inherit", fontSize: 12, cursor: "pointer" };
  const paths = {
    plane: ["M3 11.5 21 3l-6.5 18-3.2-7.3L3 11.5Z", "m11.3 13.7 4.2-4.2"],
    chat: ["M4 5.5h16v11H9l-5 4v-15Z", "M8 10h8M8 13h5"],
    orders: ["M6 3.5h12v17H6z", "M9 8h6M9 12h6M9 16h4"],
    search: ["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z", "m15.5 15.5 5 5"],
    monitor: ["M4 18V6M4 18h16", "m7 14 4-4 3 2 5-6"],
    observe: ["M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
  };
  function NativeIcon({ name, size = 20 }) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": "true", style: { display: "block" } },
      ...(paths[name] || paths.chat).map((d) => h("path", { d, key: d })));
  }
  function BrandName() {
    return h("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 600,
      fontSize: 14, letterSpacing: ".01em" } }, "AeroAgent");
  }
  function InspectorPage() {
    const row = (label) => h("div", { key: label, style: { display: "flex", justifyContent: "space-between",
      gap: 16, padding: "12px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)", fontSize: 13 } },
      h("span", null, label), h("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, "等待数据"));
    return h("section", { "aria-label": "AeroAgent 执行观测", style: { boxSizing: "border-box", height: "100%",
      overflow: "auto", padding: 20, color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)" } },
      h("h2", { style: { margin: "0 0 8px", fontSize: 18, fontWeight: 600 } }, "执行观测"),
      h("p", { style: { margin: "0 0 20px", maxWidth: "42ch", color: "var(--dsw-alias-label-secondary)",
        fontSize: 13, lineHeight: 1.65 } }, "DSH 原生右侧标签已接入。业务对话恢复后，这里将展示本轮真实运行数据。"),
      ["流程", "检索", "记忆", "校验"].map(row));
  }
  function InspectorButton() {
    return h("button", { type: "button", title: "AeroAgent 执行观测", "aria-label": "AeroAgent 执行观测",
      onClick: () => ctx.sidebarRight.openTab("aeroagent-inspector"), style: { display: "inline-grid", placeItems: "center",
        width: 30, height: 30, padding: 0, border: 0, borderRadius: 6, background: "transparent",
        color: "inherit", cursor: "pointer" } }, h(NativeIcon, { name: "observe", size: 18 }));
  }
  function useSelectedOrder() {
    return React.useSyncExternalStore(selection.subscribe, () => selection.get(userId), () => null);
  }
  function NativeSelectedOrder() {
    const order = useSelectedOrder();
    if (!order) return h("section", { "data-native-selected-order": "empty", style: { marginTop: 26,
      paddingTop: 20, borderTop: "1px solid var(--dsw-alias-border-l1)" } },
      h("h2", { style: { margin: "0 0 8px", fontSize: 16, fontWeight: 600 } }, "尚未选择客票"),
      h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 13,
        lineHeight: 1.7 } }, "请从「我的订单」选择客票。选择只绑定订单，不会自动发送消息或创建案件。"));
    const flight = order.flight || {};
    const detail = (label, value) => h("div", { key: label, style: { display: "flex", gap: 20,
      padding: "7px 0", fontSize: 13 } }, h("dt", { style: { width: 88, flex: "0 0 auto",
      color: "var(--dsw-alias-label-tertiary)" } }, label), h("dd", { style: { margin: 0 } }, value));
    return h("section", { "data-native-selected-order": order.order_id, style: { marginTop: 26,
      paddingTop: 20, borderTop: "1px solid var(--dsw-alias-border-l1)" } },
      h("h2", { style: { margin: "0 0 12px", fontSize: 16, fontWeight: 600 } }, "当前退改客票"),
      h("dl", { style: { margin: 0 } },
        detail("订单", `${order.order_id} · ${order.passenger || ""}`),
        detail("航班", `${order.flight_no || "—"} · ${flight.origin_city || flight.origin || "—"} → ${flight.dest_city || flight.dest || "—"}`),
        detail("出发", `${order.date || "—"} ${flight.dep_time || ""}`),
        detail("状态", order.status || "—")),
      h("p", { role: "status", style: { margin: "12px 0 0", color: "var(--dsw-alias-state-success-primary)",
        fontSize: 12 } }, "已绑定客票；尚未创建案件或发送对话。"));
  }
  function NativeOrdersPage() {
    const [reload, setReload] = React.useState(0);
    const [state, setState] = React.useState({ status: "loading", orders: [], error: "" });
    const selectedOrder = useSelectedOrder();
    React.useEffect(() => {
      let active = true;
      const controller = new AbortController();
      setState((current) => ({ ...current, status: "loading", error: "" }));
      fetchNativeOrders({ signal: controller.signal }).then((orders) => {
        if (active) setState({ status: "ready", orders, error: "" });
      }).catch((error) => {
        if (active && error?.name !== "AbortError") setState({ status: "error", orders: [], error: error.message });
      });
      return () => { active = false; controller.abort(); };
    }, [reload]);
    const header = h("header", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between",
      gap: 24, paddingBottom: 24, borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
      h("div", null,
        h("h1", { style: { margin: "0 0 8px", fontSize: 24, lineHeight: 1.3, fontWeight: 600 } }, "我的订单"),
        h("p", { style: { margin: 0, maxWidth: "66ch", color: "var(--dsw-alias-label-secondary)",
          fontSize: 14, lineHeight: 1.6 } }, "订单来自 AeroAgent 后端。选择只绑定退改对话，不会自动发送消息或触发付费调用。")),
      h("button", { type: "button", disabled: state.status === "loading", onClick: () => setReload((value) => value + 1),
        style: { ...secondaryButton, flex: "0 0 auto", opacity: state.status === "loading" ? .55 : 1 } }, "刷新"));
    let content;
    if (state.status === "loading") content = h("p", { role: "status", style: { padding: "32px 0",
      color: "var(--dsw-alias-label-secondary)" } }, "正在读取订单…");
    else if (state.status === "error") content = h("div", { role: "alert", style: { paddingTop: 28 } },
      h("h2", { style: { margin: "0 0 8px", fontSize: 16 } }, "订单加载失败"),
      h("p", { style: { color: "var(--dsw-alias-state-error-primary)" } }, state.error),
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), style: secondaryButton }, "重试"));
    else if (!state.orders.length) content = h("p", { style: { padding: "32px 0",
      color: "var(--dsw-alias-label-secondary)" } }, "当前用户没有订单。");
    else {
      const cell = { padding: "14px 12px", borderBottom: "1px solid var(--dsw-alias-border-l1)",
        textAlign: "left", verticalAlign: "middle", fontSize: 12, whiteSpace: "nowrap" };
      content = h("div", { style: { overflowX: "auto", paddingTop: 18 } },
        h("table", { style: { width: "100%", minWidth: 850, borderCollapse: "collapse" } },
          h("thead", null, h("tr", null, ["订单 / 乘客", "航班与航线", "出发", "金额", "状态", "操作"].map((label) =>
            h("th", { key: label, style: { ...cell, color: "var(--dsw-alias-label-tertiary)", fontWeight: 500 } }, label)))),
          h("tbody", null, state.orders.map((order) => {
            const flight = order.flight || {};
            const selected = selectedOrder?.order_id === order.order_id;
            return h("tr", { key: order.order_id, "data-native-order-row": order.order_id },
              h("td", { style: cell }, h("div", { style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11 } }, order.order_id), h("div", { style: { marginTop: 4,
                color: "var(--dsw-alias-label-secondary)" } }, order.passenger)),
              h("td", { style: cell }, h("strong", { style: { fontSize: 13 } }, order.flight_no),
                h("div", { style: { marginTop: 4, color: "var(--dsw-alias-label-secondary)" } },
                  `${flight.origin_city || flight.origin || "—"} → ${flight.dest_city || flight.dest || "—"}`)),
              h("td", { style: cell }, `${order.date} ${flight.dep_time || ""}`),
              h("td", { style: { ...cell, fontVariantNumeric: "tabular-nums" } }, `¥${Number((order.fare || 0) + (order.tax || 0)).toLocaleString("zh-CN")}`),
              h("td", { style: cell }, h("span", { style: { display: "inline-block", padding: "2px 7px",
                border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 5, fontSize: 11 } }, order.status)),
              h("td", { style: cell }, h("button", { type: "button", "aria-pressed": selected,
                "aria-label": `${selected ? "继续" : "选择"}${order.flight_no}退改对话`,
                onClick: () => { selection.select(userId, order); ctx.layout.selectPanel("aeroagent-chat"); },
                style: selected ? primaryButton : secondaryButton }, selected ? "继续对话" : "选择并对话")));
          }))));
    }
    return h("main", { "data-aeroagent-native-page": "orders", style: { boxSizing: "border-box", height: "100%",
      overflow: "auto", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit" } },
      h("div", { style: { boxSizing: "border-box", maxWidth: 1180, margin: "0 auto",
        padding: "32px clamp(24px, 4vw, 48px) 48px" } }, header, content));
  }

  ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({
    name: "sidebar.brand.mark", id: "dsh-plugin-aeroagent",
  }, ({ size = 28 }) => h(NativeIcon, { name: "plane", size })));
  ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({
    name: "sidebar.brand.name", id: "dsh-plugin-aeroagent",
  }, BrandName));

  for (const page of NATIVE_PAGES) {
    const panelId = `aeroagent-${page.id}`;
    function NativePage() {
      return h("main", { "data-aeroagent-native-page": page.id, style: { boxSizing: "border-box", height: "100%",
        overflow: "auto", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit" } },
        h("div", { style: { boxSizing: "border-box", maxWidth: 960, margin: "0 auto",
          padding: "32px clamp(24px, 4vw, 48px) 48px" } },
          h("header", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between",
            gap: 24, paddingBottom: 24, borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
            h("div", null,
              h("h1", { style: { margin: "0 0 8px", fontSize: 24, lineHeight: 1.3, fontWeight: 600,
                letterSpacing: "-.01em" } }, page.id === "chat" ? "机票退改签" : page.label),
              h("p", { style: { margin: 0, maxWidth: "62ch", color: "var(--dsw-alias-label-secondary)",
                fontSize: 14, lineHeight: 1.6 } }, page.description)),
            h("span", { style: { flex: "0 0 auto", padding: "3px 8px", border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, "原生集成预览")),
          h("section", { style: { paddingTop: 28 } },
            h("h2", { style: { margin: "0 0 10px", fontSize: 16, fontWeight: 600 } }, "DSH 宿主保持不变"),
            h("p", { style: { margin: "0 0 20px", maxWidth: "68ch", color: "var(--dsw-alias-label-secondary)",
              fontSize: 14, lineHeight: 1.75 } }, page.id === "chat"
              ? "左侧工作区、会话、More 和设置继续由 DSH 承载。选择客票只会绑定后续退改对话，不会自动发送消息或创建案件。"
              : "左侧工作区、会话、More、设置和原生对话均继续由 DSH 承载。当前模块仅确认原生集成方式，业务操作将在后续切片接入。"),
            h("ul", { style: { margin: 0, paddingLeft: 20, color: "var(--dsw-alias-label-secondary)",
              fontSize: 13, lineHeight: 2 } },
              h("li", null, "AeroAgent 导航和页面使用 DSH 官方 slots"),
              h("li", null, "没有 iframe、独立应用框架或隐藏宿主侧栏"),
              h("li", null, "执行观测入口位于 DSH 原生对话顶部")),
            page.id === "chat" ? h(NativeSelectedOrder) : null,
            page.id === "chat" ? h("button", { type: "button", onClick: () => ctx.layout.selectPanel(null),
              style: { ...primaryButton, marginTop: 24 } }, "打开 DSH 原生对话") : null)));
    }
    ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: panelId },
      page.id === "orders" ? NativeOrdersPage : NativePage));
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
      name: "sidebar.panellist", id: panelId, order: page.order, label: () => page.label,
    }, ({ size = 20 }) => h(NativeIcon, { name: page.icon, size })));
  }

  const registerInspector = () => ctx.sidebarRightTabs.register({
    id: "dsh-plugin-aeroagent", kind: "aeroagent-inspector", title: () => "执行观测",
    guide: [{ id: "open", order: 20, title: () => "AeroAgent 执行观测",
      description: () => "查看流程、检索、记忆与校验。" }],
  });
  if (typeof ctx.effect === "function") ctx.effect(registerInspector, "aeroagent: native inspector tab");
  else registerInspector();
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab", key: "dsh-plugin-aeroagent",
  }, InspectorPage));
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities", id: "aeroagent-inspector", order: 20,
  }, InspectorButton));
  if (typeof window !== "undefined") window.__AERO_CLIENT_LOADED = true;
}

/** Inject versioned native assets once; retained for legacy module tests, not auto-mounted. */
function bootstrapDshUI({ document: doc = globalThis.document, backend = BACKEND } = {}) {
  if (!doc?.head) return null;
  const base = String(backend).replace(/\/+$/, "");
  let style = doc.getElementById("aeroagent-dsh-styles");
  if (!style) {
    style = doc.createElement("link");
    style.id = "aeroagent-dsh-styles";
    style.rel = "stylesheet";
    style.href = `${base}/dsh-ui/styles.css`;
    doc.head.append(style);
  }
  let script = doc.getElementById("aeroagent-dsh-module");
  if (!script) {
    script = doc.createElement("script");
    script.id = "aeroagent-dsh-module";
    script.type = "module";
    script.src = `${base}/dsh-ui/main.js`;
    doc.head.append(script);
  }
  return { style, script };
}

const inject = ["slots", "layout", "sidebarRight", "sidebarRightTabs"];

globalThis.AeroAgentClient = Object.assign(globalThis.AeroAgentClient || {},
  { parseAeroAgentQuote, parseAeroAgentCase, orderView, requestKeys, caseView, shouldStopFollowing,
    quoteStateAfter, followAction, traceEventKey, verificationView, quoteCardState, bootstrapDshUI, nativeSlotsApply,
    fetchNativeOrders, createNativeOrderSelection });
if (typeof window !== "undefined" && window.__ModuleLoader__ && !globalThis.__AERO_DSH_MODULE_REGISTERED) {
  window.__ModuleLoader__.load({ id: "dsh-plugin-aeroagent", factory: (require) => ({
    inject,
    apply(ctx) { nativeSlotsApply(ctx, require("react")); },
  }) });
  globalThis.__AERO_DSH_MODULE_REGISTERED = true;
}
})();
