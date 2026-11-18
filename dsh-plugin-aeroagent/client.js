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
              fontSize: 14, lineHeight: 1.75 } }, "左侧工作区、会话、More、设置和原生对话均继续由 DSH 承载。当前切片只确认集成方式与视觉方向，尚未接回业务操作。"),
            h("ul", { style: { margin: 0, paddingLeft: 20, color: "var(--dsw-alias-label-secondary)",
              fontSize: 13, lineHeight: 2 } },
              h("li", null, "AeroAgent 导航和页面使用 DSH 官方 slots"),
              h("li", null, "没有 iframe、独立应用框架或隐藏宿主侧栏"),
              h("li", null, "执行观测入口位于 DSH 原生对话顶部")),
            page.id === "chat" ? h("button", { type: "button", onClick: () => ctx.layout.selectPanel(null),
              style: { marginTop: 24, padding: "7px 14px", border: 0, borderRadius: 7,
                background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)",
                font: "inherit", fontSize: 13, cursor: "pointer" } }, "打开 DSH 原生对话") : null)));
    }
    ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: panelId }, NativePage));
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
    quoteStateAfter, followAction, traceEventKey, verificationView, quoteCardState, bootstrapDshUI, nativeSlotsApply });
if (typeof window !== "undefined" && window.__ModuleLoader__ && !globalThis.__AERO_DSH_MODULE_REGISTERED) {
  window.__ModuleLoader__.load({ id: "dsh-plugin-aeroagent", factory: (require) => ({
    inject,
    apply(ctx) { nativeSlotsApply(ctx, require("react")); },
  }) });
  globalThis.__AERO_DSH_MODULE_REGISTERED = true;
}
})();
