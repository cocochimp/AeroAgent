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

function nativeOrderBindingStatus(caseId) {
  return caseId ? `客票已绑定；案件 ${caseId} 已创建，等待后续对话与确认。` : "已绑定客票；尚未创建案件或发送对话。";
}

function parseNativeCompletion(content) {
  if (typeof content !== "string") throw new Error("DeepSeek 响应格式不正确");
  const quotes = [];
  let caseId = null;
  const withoutQuotes = content.replace(/```aeroagent-quote\s*(\{[\s\S]*?\})\s*```/g, (_match, raw) => {
    const quote = parseAeroAgentQuote(raw);
    if (quote) quotes.push(quote);
    return "";
  });
  const text = withoutQuotes.replace(/```aeroagent-case\s*(\{[\s\S]*?\})\s*```/g, (_match, raw) => {
    const parsed = parseAeroAgentCase(raw);
    if (parsed) caseId = parsed;
    return "";
  }).trim();
  return { text, caseId, quotes };
}

async function fetchNativeChat({ backend = BACKEND, message, orderId = null, caseId = null,
  userId = "u_zhang", signal, fetchImpl = globalThis.fetch } = {}) {
  const messages = [];
  if (caseId) messages.push({ role: "assistant", content: `\`\`\`aeroagent-case\n${JSON.stringify({ case_id: caseId, user_id: userId })}\n\`\`\`` });
  messages.push({ role: "user", content: message });
  let response;
  try {
    response = await fetchImpl(`${String(backend).replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "aeroagent-deepseek", messages, stream: false,
        metadata: { user_id: userId, ...(orderId ? { selected_order_id: orderId } : {}) } }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const failure = new Error("无法连接 AeroAgent 服务，请检查连接后重试");
    failure.code = "NETWORK_ERROR"; failure.retryable = true; failure.caseId = caseId;
    throw failure;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.detail;
    const details = detail?.details || payload?.error?.details || {};
    const failure = new Error(detail?.message || payload?.error?.message ||
      (typeof detail === "string" ? detail : `DeepSeek 请求失败 (${response.status})`));
    failure.code = detail?.code || payload?.error?.code || `HTTP_${response.status}`;
    failure.retryable = details.retryable === true;
    failure.caseId = details.case_id || caseId;
    throw failure;
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("DeepSeek 响应格式不正确");
  return parseNativeCompletion(content);
}

/** Per-user native conversation snapshots with retry-safe adjacent message deduplication. */
function createNativeConversationStore({ storage = globalThis.localStorage } = {}) {
  const values = new Map();
  const listeners = new Set();
  const keyFor = (userId) => `aeroagent-native-chat:${userId}`;
  const blank = () => ({ caseId: null, messages: [], draft: "", quotes: [] });
  function get(userId) {
    if (values.has(userId)) return values.get(userId);
    let value = blank();
    try {
      const restored = JSON.parse(storage?.getItem(keyFor(userId)) || "null");
      if (restored && typeof restored === "object") value = {
        caseId: typeof restored.caseId === "string" ? restored.caseId : null,
        draft: typeof restored.draft === "string" ? restored.draft : "",
        messages: Array.isArray(restored.messages) ? restored.messages.filter((item) => item &&
          ["user", "assistant", "system"].includes(item.role) && typeof item.text === "string").slice(-100) : [],
        quotes: Array.isArray(restored.quotes) ? restored.quotes.filter((item) => item &&
          typeof item.quote_id === "string" && ["CHANGE", "REFUND"].includes(item.action)).slice(-10) : [],
      };
    } catch { value = blank(); }
    values.set(userId, value);
    return value;
  }
  function commit(userId, value) {
    values.set(userId, value);
    try { storage?.setItem(keyFor(userId), JSON.stringify(value)); } catch { /* Memory remains authoritative. */ }
    listeners.forEach((listener) => listener(userId));
    return value;
  }
  function patch(userId, patch) {
    const current = get(userId);
    const next = { ...current };
    if (Object.hasOwn(patch, "caseId")) next.caseId = typeof patch.caseId === "string" ? patch.caseId : null;
    if (Object.hasOwn(patch, "draft")) next.draft = String(patch.draft || "");
    if (Object.hasOwn(patch, "quotes")) next.quotes = Array.isArray(patch.quotes) ? patch.quotes.slice(-10) : [];
    return commit(userId, next);
  }
  function append(userId, message) {
    if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.text !== "string") return get(userId);
    const current = get(userId);
    const previous = current.messages.at(-1);
    if (previous?.role === message.role && previous.text === message.text) return current;
    return commit(userId, { ...current, messages: [...current.messages, message].slice(-100) });
  }
  function reset(userId) { return commit(userId, blank()); }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  return { get, patch, append, reset, subscribe };
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
  const conversations = createNativeConversationStore();
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
    send: ["M4 12 20 4l-6 16-3-6-7-2Z", "m11 14 4-4"],
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
  function NativeSelectedOrder({ caseId = null } = {}) {
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
        fontSize: 12 } }, nativeOrderBindingStatus(caseId)));
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

  function useConversation() {
    return React.useSyncExternalStore(conversations.subscribe, () => conversations.get(userId), () => conversations.get(userId));
  }
  function NativeChatPage() {
    const selectedOrder = useSelectedOrder();
    const conversation = useConversation();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const mounted = React.useRef(true);
    const activeRequest = React.useRef(null);
    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; activeRequest.current?.abort(); };
    }, []);
    async function sendMessage(raw) {
      const current = conversations.get(userId);
      const text = String(raw ?? current.draft).trim();
      if (!text || busy) return;
      const requestCaseId = current.caseId;
      const orderId = selection.get(userId)?.order_id || null;
      if (!requestCaseId && !orderId) {
        setError({ code: "ORDER_REQUIRED", message: "请先从「我的订单」选择一张客票。", retryable: false });
        return;
      }
      conversations.append(userId, { role: "user", text });
      conversations.patch(userId, { draft: "" });
      setError(null); setBusy(true);
      const controller = new AbortController();
      activeRequest.current = controller;
      try {
        const result = await fetchNativeChat({ message: text, orderId, caseId: requestCaseId, userId,
          signal: controller.signal });
        if (!mounted.current) return;
        conversations.patch(userId, { caseId: result.caseId || requestCaseId, quotes: result.quotes });
        if (result.text) conversations.append(userId, { role: "assistant", text: result.text });
      } catch (failure) {
        if (!mounted.current || failure?.name === "AbortError") return;
        conversations.patch(userId, { caseId: failure.caseId || requestCaseId, draft: text });
        setError({ code: failure.code || "REQUEST_FAILED", message: failure.message,
          retryable: failure.retryable === true });
      } finally {
        if (mounted.current) { setBusy(false); activeRequest.current = null; }
      }
    }
    const noOrder = !conversation.caseId && !selectedOrder;
    const quickActions = [
      { id: "orders", label: "查询订单", action: () => ctx.layout.selectPanel("aeroagent-orders") },
      { id: "change", label: "生成改签方案", prompt: "帮我改签到后天，请生成可选方案，并说明差价和手续费。" },
      { id: "refund", label: "退票", prompt: "航班取消了，请按当前票规计算退票费和最终退款。" },
      { id: "compare", label: "改签 + 退票", prompt: "请分别给出改签和退票方案，比较费用后再由我选择。" },
    ];
    const messageView = (message, index) => h("article", { key: `${message.role}-${index}`,
      "data-native-message": message.role, style: { alignSelf: message.role === "user" ? "flex-end" : "flex-start",
        maxWidth: "78%", color: "var(--dsw-alias-label-primary)" } },
      h("small", { style: { display: "block", margin: "0 4px 5px", color: "var(--dsw-alias-label-tertiary)",
        fontSize: 11 } }, message.role === "user" ? "张三" : message.role === "assistant" ? "AeroAgent · DeepSeek" : "系统"),
      h("div", { style: { padding: "10px 13px", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10,
        background: message.role === "user" ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-bg-layer-1)",
        fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, message.text));
    const quoteView = (quote) => {
      const target = typeof quote.target === "string" ? quote.target : [quote.target?.date || quote.target?.flight_date,
        quote.target?.flight_no, quote.target?.dep_time].filter(Boolean).join(" · ");
      return h("article", { key: quote.quote_id, "data-native-quote": quote.quote_id, style: { padding: "14px 0",
        borderTop: "1px solid var(--dsw-alias-border-l1)" } },
        h("header", { style: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" } },
          h("h3", { style: { margin: 0, fontSize: 15 } }, quote.action === "REFUND" ? "退票方案" : "改签方案"),
          h("strong", { style: { fontSize: 20, fontVariantNumeric: "tabular-nums" } },
            `${quote.currency === "CNY" ? "¥" : ""}${Number(quote.amount || 0).toLocaleString("zh-CN")}`)),
        target ? h("p", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 13 } }, target) : null,
        quote.rule_refs?.length ? h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } },
          `规则依据：${quote.rule_refs.join("、")}`) : null,
        h("p", { style: { margin: "8px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } },
          "报价仅供核对，确认办理将在后续切片开放；当前不会自动交易。"));
    };
    return h("main", { "data-aeroagent-native-page": "chat", style: { boxSizing: "border-box", height: "100%",
      display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-primary)", font: "inherit" } },
      h("header", { style: { flex: "0 0 auto", padding: "24px clamp(20px, 3vw, 36px) 0" } },
        h("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 } },
          h("div", null,
            h("h1", { style: { margin: "0 0 7px", fontSize: 23, lineHeight: 1.3, fontWeight: 600 } }, "机票退改签"),
            h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 13 } },
              "DeepSeek 生成候选与理由；票规和最终金额由服务端校验。")),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" } },
            h("span", { style: { padding: "3px 8px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6,
              color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, "aeroagent-deepseek"),
            h("button", { type: "button", onClick: () => ctx.layout.selectPanel(null), style: secondaryButton }, "打开 DSH 原生对话"),
            h("button", { type: "button", disabled: busy, onClick: () => { conversations.reset(userId); setError(null); },
              style: { ...secondaryButton, opacity: busy ? .45 : 1 } }, "新建退改对话"))),
        h(NativeSelectedOrder, { caseId: conversation.caseId })),
      h("section", { "aria-label": "退改对话记录", "aria-live": "polite", style: { flex: "1 1 auto", minHeight: 150,
        display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", padding: "20px clamp(20px, 3vw, 36px)" } },
        conversation.messages.length ? conversation.messages.map(messageView) : h("div", { style: { margin: "auto",
          maxWidth: 520, padding: "30px 0", textAlign: "center", color: "var(--dsw-alias-label-secondary)" } },
          h("div", { style: { display: "flex", justifyContent: "center", marginBottom: 12,
            color: "var(--dsw-alias-label-primary)" } }, h(NativeIcon, { name: "plane", size: 30 })),
          h("h2", { style: { margin: "0 0 8px", color: "var(--dsw-alias-label-primary)", fontSize: 18 } }, "你好，张三"),
          h("p", { style: { margin: 0, fontSize: 13, lineHeight: 1.7 } },
            noOrder ? "请先从「我的订单」选择客票，再描述退改需求。" : "客票已绑定。描述你的退改需求，或选择下方快捷操作。")),
        conversation.quotes.length ? h("section", { "aria-label": "待核对报价" }, conversation.quotes.map(quoteView)) : null,
        busy ? h("p", { role: "status", style: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 13 } },
          "DeepSeek 正在理解诉求、检索票规并核对费用…") : null,
        error ? h("div", { role: "alert", style: { padding: 12, border: "1px solid var(--dsw-alias-state-error-primary)",
          borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)" } },
          h("strong", { style: { display: "block", marginBottom: 5, fontSize: 13 } }, `请求未完成 · ${error.code}`),
          h("p", { style: { margin: "0 0 10px", color: "var(--dsw-alias-label-secondary)", fontSize: 13 } },
            `${error.message}。草稿已保留，可检查后重试。`),
          h("button", { type: "button", disabled: busy, onClick: () => void sendMessage(conversations.get(userId).draft),
            style: secondaryButton }, "重试")) : null),
      h("footer", { style: { flex: "0 0 auto", padding: "12px clamp(20px, 3vw, 36px) 16px",
        borderTop: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-base)" } },
        h("div", { "aria-label": "快捷操作", style: { display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 } },
          quickActions.map((action) => h("button", { key: action.id, type: "button",
            disabled: busy || (action.prompt && noOrder),
            onClick: () => action.prompt ? void sendMessage(action.prompt) : action.action(),
            style: { ...secondaryButton, padding: "4px 9px", fontSize: 11,
              opacity: busy || (action.prompt && noOrder) ? .45 : 1 } }, action.label))),
        h("form", { onSubmit: (event) => { event.preventDefault(); void sendMessage(); },
          style: { display: "flex", alignItems: "flex-end", gap: 9, padding: 7,
            border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)" } },
          h("textarea", { value: conversation.draft, rows: 2, maxLength: 2000, disabled: busy,
            "aria-label": "描述退改需求", placeholder: noOrder ? "请先选择客票" : "描述你的退改需求… Enter 发送，Shift + Enter 换行",
            onChange: (event) => conversations.patch(userId, { draft: event.target.value }),
            onKeyDown: (event) => { if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault(); if (conversation.draft.trim() && !busy && !noOrder) void sendMessage();
            } },
            style: { flex: 1, minWidth: 0, minHeight: 42, maxHeight: 120, resize: "vertical", padding: 7,
              border: 0, outline: 0, background: "transparent", color: "var(--dsw-alias-label-primary)",
              font: "inherit", fontSize: 13, lineHeight: 1.55 } }),
          h("button", { type: "submit", "aria-label": "发送退改需求",
            disabled: busy || noOrder || !conversation.draft.trim(),
            style: { ...primaryButton, display: "inline-grid", placeItems: "center", width: 36, height: 36,
              padding: 0, borderRadius: 8, opacity: busy || noOrder || !conversation.draft.trim() ? .45 : 1 } },
            h(NativeIcon, { name: "send", size: 18 }))),
        h("div", { style: { display: "flex", justifyContent: "space-between", gap: 16, marginTop: 7,
          color: "var(--dsw-alias-label-tertiary)", fontSize: 10 } },
          h("span", null, "报价只有在明确确认后才会进入交易流程"),
          h("span", null, conversation.caseId ? `案件 ${conversation.caseId}` : "未创建案件"))));
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
      page.id === "orders" ? NativeOrdersPage : page.id === "chat" ? NativeChatPage : NativePage));
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
    fetchNativeOrders, createNativeOrderSelection, parseNativeCompletion, fetchNativeChat, createNativeConversationStore,
    nativeOrderBindingStatus });
if (typeof window !== "undefined" && window.__ModuleLoader__ && !globalThis.__AERO_DSH_MODULE_REGISTERED) {
  window.__ModuleLoader__.load({ id: "dsh-plugin-aeroagent", factory: (require) => ({
    inject,
    apply(ctx) { nativeSlotsApply(ctx, require("react")); },
  }) });
  globalThis.__AERO_DSH_MODULE_REGISTERED = true;
}
})();
