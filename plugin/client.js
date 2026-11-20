// AeroAgent DSH bootstrap: classic script only; native modules are served by FastAPI.
(() => {
const BACKEND = globalThis.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000";
const RPC_PATH = globalThis.AEROAGENT_RPC_PATH || "/api/aeroagent/rpc";
const keyCache = new Map();

async function rpcCall(method, params = {}, { userId, signal, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(RPC_PATH, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params, ...(userId ? { userId } : {}) }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const failure = new Error("无法连接 AeroAgent 网关，请确认后端已启动");
    failure.code = "NETWORK_ERROR"; failure.retryable = true;
    throw failure;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const detail = payload.error || {};
    const failure = new Error(detail.message || `AeroAgent 请求失败 (${response.status})`);
    failure.code = detail.code || `HTTP_${response.status}`;
    failure.status = response.status;
    failure.details = detail.details || {};
    throw failure;
  }
  return payload.value;
}

function rpcMethodFor(path, method, body, admin) {
  const [pathname, queryString = ""] = String(path || "").split("?");
  const query = Object.fromEntries(new URLSearchParams(queryString));
  if (pathname === "/flights") return ["flights.search", query];
  if (pathname === "/bookings" && method === "POST") return ["bookings.create", body];
  let match = pathname.match(/^\/bookings\/([^/]+)\/pay$/);
  if (match) return ["bookings.pay", { booking_id: decodeURIComponent(match[1]), ...(body || {}) }];
  if (pathname === "/watches" && method === "GET") return ["watches.list", {}];
  if (pathname === "/watches" && method === "POST") return ["watches.create", body];
  if (pathname === "/watches/alerts") return ["watches.alerts", {}];
  match = pathname.match(/^\/watches\/([^/]+)\/evaluate$/);
  if (match) return ["watches.evaluate", { watch_id: decodeURIComponent(match[1]) }];
  if (pathname === "/orders") return ["orders.list", query];
  match = pathname.match(/^\/quotes\/([^/]+)\/confirm$/);
  if (match) return ["quotes.confirm", { quote_id: decodeURIComponent(match[1]), ...(body || {}) }];
  match = pathname.match(/^\/cases\/([^/]+)\/messages$/);
  if (match) return ["cases.continue", { case_id: decodeURIComponent(match[1]), ...(body || {}) }];
  match = pathname.match(/^\/cases\/([^/]+)\/cancel$/);
  if (match) return ["cases.cancel", { case_id: decodeURIComponent(match[1]) }];
  match = pathname.match(/^\/operations\/([^/]+)\/reconcile$/);
  if (match) return ["operations.reconcile", { operation_id: decodeURIComponent(match[1]) }];
  match = pathname.match(/^\/operations\/([^/]+)$/);
  if (match) return ["operations.get", { operation_id: decodeURIComponent(match[1]) }];
  if (pathname === "/admin/rules" && method === "GET") return ["admin.rules", query];
  match = pathname.match(/^\/admin\/rules\/([^/]+)$/);
  if (match) return ["admin.ruleUpsert", { rule_id: decodeURIComponent(match[1]), ...(body || {}) }];
  if (pathname === "/admin/evaluations" && method === "GET") return ["admin.evaluations", query];
  if (pathname === "/admin/evaluations/cases") return ["admin.evaluationCases", body];
  if (pathname === "/admin/evaluations/runs") return ["admin.startEvaluation", body];
  if (pathname === "/admin/config" && method === "GET") return ["admin.config", {}];
  if (pathname === "/admin/config") return ["admin.configUpdate", body];
  if (pathname === "/admin/mock/scenarios") return ["admin.mockScenarios", {}];
  if (pathname === "/admin/mock") return ["admin.mockSet", body];
  if (pathname === "/admin/orders") return ["admin.demoData", body];
  throw new Error(`未映射的 AeroAgent 路径：${method} ${pathname}`);
}

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

const NATIVE_DEMO_USERS = Object.freeze([
  Object.freeze({ user_id: "u_zhang", name: "张三", tier: "金卡" }),
  Object.freeze({ user_id: "u_li", name: "李四", tier: "银卡" }),
  Object.freeze({ user_id: "u_wang", name: "王五", tier: "普卡" }),
  Object.freeze({ user_id: "u_zhao", name: "赵六", tier: "黑钻" }),
]);

/** Own the active demo identity and invalidate every in-flight native request on change. */
function createNativeUserStore({ storage = globalThis.localStorage, initialUserId = "u_zhang" } = {}) {
  const listeners = new Set();
  const requests = new Set();
  let generation = 0;
  let userId = initialUserId;
  try {
    const restored = storage?.getItem("aeroagent-native-user");
    if (NATIVE_DEMO_USERS.some((user) => user.user_id === restored)) userId = restored;
  } catch { /* Use the initial identity when storage is unavailable. */ }
  if (!NATIVE_DEMO_USERS.some((user) => user.user_id === userId)) userId = "u_zhang";
  let snapshot = null;
  function updateSnapshot() {
    const user = NATIVE_DEMO_USERS.find((item) => item.user_id === userId);
    snapshot = Object.freeze({ userId, user, generation });
  }
  updateSnapshot();
  function captureOwner() { return { userId, generation }; }
  return {
    getSnapshot: () => snapshot,
    getUserId: () => userId,
    getUsers: () => NATIVE_DEMO_USERS,
    captureOwner,
    isOwnerCurrent(owner) {
      return Boolean(owner && owner.userId === userId && owner.generation === generation);
    },
    trackRequest(controller) {
      requests.add(controller);
      controller.signal.addEventListener("abort", () => requests.delete(controller), { once: true });
      return controller;
    },
    releaseRequest(controller) { requests.delete(controller); },
    switchUser(nextUserId) {
      if (nextUserId === userId) return snapshot;
      if (!NATIVE_DEMO_USERS.some((user) => user.user_id === nextUserId)) throw new Error("未知演示用户");
      for (const controller of [...requests]) controller.abort();
      requests.clear();
      generation += 1;
      userId = nextUserId;
      updateSnapshot();
      try { storage?.setItem("aeroagent-native-user", userId); } catch { /* Memory remains authoritative. */ }
      listeners.forEach((listener) => listener(snapshot));
      return snapshot;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** Session-local watch snapshots, keyed exactly like the other native user workspaces. */
function createNativeWatchStore({ storage = globalThis.localStorage } = {}) {
  const values = new Map();
  const listeners = new Set();
  const keyFor = (userId) => `aeroagent-native-watches:${userId}`;
  function get(userId) {
    if (values.has(userId)) return values.get(userId);
    let watches = [];
    try {
      const restored = JSON.parse(storage?.getItem(keyFor(userId)) || "[]");
      if (Array.isArray(restored)) watches = restored.filter((watch) => watch && typeof watch === "object").slice(0, 100);
    } catch { watches = []; }
    values.set(userId, watches);
    return watches;
  }
  function replace(userId, next) {
    const watches = Array.isArray(next) ? next.filter((watch) => watch && typeof watch === "object").slice(0, 100) : [];
    values.set(userId, watches);
    try {
      if (watches.length) storage?.setItem(keyFor(userId), JSON.stringify(watches));
      else storage?.removeItem?.(keyFor(userId));
    } catch { /* In-memory watch state remains available in private mode. */ }
    listeners.forEach((listener) => listener(userId));
    return watches;
  }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  return { get, replace, subscribe };
}

const nativeExecutionTabs = Object.freeze([
  ["flow", "流程"], ["retrieval", "检索"], ["memory", "记忆"], ["verify", "校验"], ["receipt", "回执"],
]);

async function fetchNativeLatestCase({ userId = "u_zhang", signal, fetchImpl = globalThis.fetch } = {}) {
  try {
    const payload = await rpcCall("cases.latest", {}, { userId, signal, fetchImpl });
    if (payload && typeof payload.case_id === "string") return payload;
    return null;
  } catch (error) {
    if (error?.status === 404 || error?.code === "NOT_FOUND") return null;
    throw error;
  }
}

async function fetchNativeCase({ caseId, userId = "u_zhang", signal, fetchImpl = globalThis.fetch } = {}) {
  const payload = await rpcCall("cases.get", { case_id: caseId }, { userId, signal, fetchImpl });
  if (!payload || typeof payload.case_id !== "string") throw new Error("案件响应格式不正确");
  return payload;
}

function nativeRetrievalResults(results = []) {
  return (Array.isArray(results) ? results : []).map((result) => ({
    ...result,
    funnel: Array.isArray(result?.funnel) ? result.funnel
      : Array.isArray(result?.retrieval?.funnel) ? result.retrieval.funnel : [],
  })).filter((result) => result.funnel.length);
}

function nativeFeeComparisons(result = {}) {
  const explicit = result?.verify?.fee_comparison;
  if (Array.isArray(explicit) && explicit.length) return explicit.map((row) => ({
    label: row.label || row.intent || "方案合计",
    actual: row.actual,
    expected: row.expected,
    matched: typeof row.actual === "number" && typeof row.expected === "number"
      ? row.actual === row.expected : null,
  }));
  const rows = [];
  (result?.final?.options || []).forEach((option, index) => {
    const fee = result?.results?.[index]?.fee;
    if (!fee || fee.allowed === false || !["CHANGE", "REFUND"].includes(option.type)) return;
    const engine = { "改期费": fee.change_fee, "票面差价": fee.fare_diff,
      "退票费": fee.refund_fee, "机场建设费退还": fee.tax };
    for (const item of option.fee_items || []) rows.push({
      label: `${option.type === "REFUND" ? "退票" : "改签"} · ${item.name}`,
      actual: item.amount,
      expected: engine[item.name],
      matched: typeof item.amount === "number" && typeof engine[item.name] === "number"
        ? item.amount === engine[item.name] : null,
    });
    const expected = option.type === "CHANGE" ? fee.total : fee.refund_amount;
    rows.push({ label: `${option.type === "REFUND" ? "退票" : "改签"} · 合计`, actual: option.total,
      expected, matched: typeof option.total === "number" && typeof expected === "number"
        ? option.total === expected : null });
  });
  return rows;
}

function nativeVerificationState(verify = {}) {
  if (verify?.passed === true) return { kind: "success", label: "校验通过" };
  if (verify?.passed === false) return { kind: "failure", label: "未通过校验" };
  return { kind: "pending", label: "暂无校验结果" };
}

async function fetchNativeOrders({ userId = "u_zhang", signal, fetchImpl = globalThis.fetch } = {}) {
  const payload = await rpcCall("orders.list", { page_size: 20 }, { userId, signal, fetchImpl });
  if (!Array.isArray(payload?.orders)) throw new Error("订单响应格式不正确");
  return payload.orders;
}

async function fetchNativeFlights({ query = {}, userId = "u_zhang", signal,
  fetchImpl = globalThis.fetch } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (String(value || "").trim()) params.set(key, String(value).trim());
  const suffix = params.toString();
  const payload = await fetchNativeV1({ path: `/flights${suffix ? `?${suffix}` : ""}`, userId, signal, fetchImpl });
  if (!Array.isArray(payload?.flights)) throw new Error("航班响应格式不正确");
  return payload.flights;
}

async function createNativeBooking({ flight, fareProduct, passenger, userId = "u_zhang",
  fetchImpl = globalThis.fetch } = {}) {
  return fetchNativeV1({ path: "/bookings", method: "POST", userId, fetchImpl,
    body: { flight_no: flight.flight_no, date: flight.date, fare_product: fareProduct,
      passenger: String(passenger || "").trim() } });
}

async function payNativeBooking({ bookingId, idempotencyKey, userId = "u_zhang",
  fetchImpl = globalThis.fetch } = {}) {
  return fetchNativeV1({ path: `/bookings/${encodeURIComponent(bookingId)}/pay`, method: "POST", userId, fetchImpl,
    body: { idempotency_key: idempotencyKey } });
}

async function fetchNativeWatches({ userId = "u_zhang", signal, fetchImpl = globalThis.fetch } = {}) {
  const payload = await fetchNativeV1({ path: "/watches", userId, signal, fetchImpl });
  if (!Array.isArray(payload?.watches)) throw new Error("监控响应格式不正确");
  return payload;
}

async function createNativeWatch({ watch, userId = "u_zhang", fetchImpl = globalThis.fetch } = {}) {
  return fetchNativeV1({ path: "/watches", method: "POST", userId, fetchImpl, body: watch });
}

async function evaluateNativeWatch({ watchId, userId = "u_zhang", fetchImpl = globalThis.fetch } = {}) {
  return fetchNativeV1({ path: `/watches/${encodeURIComponent(watchId)}/evaluate`, method: "POST", userId, fetchImpl });
}

async function fetchNativeAlerts({ userId = "u_zhang", signal, fetchImpl = globalThis.fetch } = {}) {
  const payload = await fetchNativeV1({ path: "/watches/alerts", userId, signal, fetchImpl });
  if (!Array.isArray(payload?.alerts)) throw new Error("提醒响应格式不正确");
  return payload;
}

async function fetchNativeV1({ path, method = "GET", body, userId = "u_zhang",
  admin = false, signal, fetchImpl = globalThis.fetch } = {}) {
  const [rpcMethod, params] = rpcMethodFor(path, method, body, admin);
  try {
    return await rpcCall(rpcMethod, params, { userId, signal, fetchImpl });
  } catch (error) {
    error.body = { error: { code: error.code, message: error.message, details: error.details } };
    throw error;
  }
}

function fetchNativeAdmin(options = {}) {
  return fetchNativeV1({ ...options, path: `/admin${options.path || ""}`, admin: true });
}

async function fetchNativeRules({ query = "", airline = "", scenario = "", ...options } = {}) {
  const params = new URLSearchParams({ debug: "true" });
  if (String(query).trim()) params.set("q", String(query).trim());
  if (String(airline).trim()) params.set("airline", String(airline).trim());
  if (scenario) params.set("scenario", scenario);
  const payload = await fetchNativeAdmin({ ...options, path: `/rules?${params}` });
  if (!Array.isArray(payload?.rules)) throw new Error("规则响应格式不正确");
  return payload;
}

async function fetchNativeEvaluation({ view = "cases", runId, ...options } = {}) {
  if (!["cases", "runs", "run"].includes(view)) throw new Error("评测视图不支持");
  if (view === "run" && !runId) throw new Error("查看评测运行需提供 run_id");
  const params = new URLSearchParams({ view });
  if (view === "run") params.set("run_id", runId);
  const payload = await fetchNativeAdmin({ ...options, path: `/evaluations?${params}` });
  if (view === "cases" && !Array.isArray(payload?.cases)) throw new Error("评测用例响应格式不正确");
  if (view === "runs" && !Array.isArray(payload?.runs)) throw new Error("评测历史响应格式不正确");
  if (view === "run" && (typeof payload?.run_id !== "string" || typeof payload?.status !== "string")) {
    throw new Error("评测运行响应格式不正确");
  }
  return payload;
}

async function startNativeEvaluation({ mode = "offline", caseIds = null, ...options } = {}) {
  if (!["offline", "deepseek"].includes(mode)) throw new Error("评测模式仅支持 offline 或 deepseek");
  if (caseIds !== null && (!Array.isArray(caseIds) || caseIds.some((id) => typeof id !== "string"))) {
    throw new Error("评测用例选择格式不正确");
  }
  const payload = await fetchNativeAdmin({ ...options, path: "/evaluations/runs", method: "POST",
    body: { mode, case_ids: caseIds } });
  if (typeof payload?.run_id !== "string" || typeof payload?.status !== "string") throw new Error("评测启动响应格式不正确");
  return payload;
}

async function fetchNativeDemoData(options = {}) {
  const payload = await fetchNativeV1({ ...options, path: "/orders", admin: true });
  if (!Array.isArray(payload?.orders) || !Array.isArray(payload?.profiles)) throw new Error("演示数据响应格式不正确");
  return payload;
}

function filterNativeEvaluationCases(cases, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return Array.isArray(cases) ? cases : [];
  return (Array.isArray(cases) ? cases : []).filter((item) =>
    [item?.id, item?.title, item?.question].some((value) => String(value || "").toLowerCase().includes(needle)));
}

function isNativeEvaluationTerminal(status) {
  return ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status);
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

function openNativeAeroConversation(ctx) {
  ctx?.layout?.selectPanel?.(null);
}

function nativeOrderBindingStatus(caseId) {
  return caseId ? `客票已绑定；案件 ${caseId} 已创建，等待后续对话与确认。` : "已绑定客票；尚未创建案件或发送对话。";
}

function scrollNativeChatToLatest(feed) {
  if (!feed) return;
  if (typeof feed.scrollTo === "function") feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  else feed.scrollTop = feed.scrollHeight;
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

async function fetchNativeChat({ message, orderId = null, caseId = null,
  userId = "u_zhang", signal, fetchImpl = globalThis.fetch } = {}) {
  const case_ = caseId
    ? await rpcCall("cases.continue", { case_id: caseId, message }, { userId, signal, fetchImpl })
    : await rpcCall("cases.start", { order_id: orderId, message }, { userId, signal, fetchImpl });
  const final = case_.result?.final || {};
  return { text: final.text || "", caseId: case_.case_id, quotes: case_.quotes || [],
    result: case_.result, status: case_.status };
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
  { id: "orders", label: "我的订单", icon: "orders", order: -20,
    description: "在 DSH 原生主面板中查看和选择客票。" },
  { id: "listing", label: "Listing", icon: "search", order: -10,
    description: "按航线和日期检索可预订航班。" },
  { id: "monitor", label: "低价监控", icon: "monitor", order: -5,
    description: "在 DSH 中管理低价监控和提醒。" },
  { id: "more", label: "更多功能", icon: "observe", order: 0,
    description: "插件与自动化任务等宿主能力入口。" },
];

function nativeActionableQuotes(record) {
  const quotes = Array.isArray(record?.quotes) ? record.quotes : [];
  return quotes.filter((quote) => quote && quote.status === "OFFERED" &&
    ["CHANGE", "REFUND"].includes(quote.action));
}

function nativeCasePhase(record) {
  if (!record) return "idle";
  if (record.status === "PROCESSING") return "processing";
  if (record.status === "WAITING_CONFIRMATION") return nativeActionableQuotes(record).length ? "confirm" : "idle";
  if (record.status === "COMPLETED") return "done";
  return "idle";
}

function nativeOperationSummary(record) {
  const operation = record?.result?.operation;
  if (!operation) return null;
  if (operation.status === "CHANGED") return `改签完成 · 新票号 ${operation.ticket_no || "—"}`;
  if (operation.status === "REFUNDED") return `退票完成 · 退款 ¥${operation.customer_amount ?? "—"}`;
  return `办理结束 · ${operation.status}`;
}

/** Contribute AeroAgent without replacing, moving, or hiding any DSH host UI. */
function nativeSlotsApply(ctx, React, { storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch } = {}) {
  const h = React?.createElement || ((type, props, ...children) => ({ type, props: { ...props, children } }));
  const users = createNativeUserStore({ storage });
  const selection = createNativeOrderSelection({ storage });
  const conversations = createNativeConversationStore({ storage });
  const watches = createNativeWatchStore({ storage });
  const primaryButton = { padding: "7px 14px", border: 0, borderRadius: 7,
    background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)",
    font: "inherit", fontSize: 13, cursor: "pointer" };
  const secondaryButton = { padding: "6px 11px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 7,
    background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
    font: "inherit", fontSize: 12, cursor: "pointer" };
  const orderContextBarFrame = { boxSizing: "border-box", width: "calc(100% - 32px)",
    maxWidth: "var(--dsh-chat-content-width, 760px)", margin: "0 auto 8px" };
  const paths = {
    plane: ["M3 11.5 21 3l-6.5 18-3.2-7.3L3 11.5Z", "m11.3 13.7 4.2-4.2"],
    chat: ["M4 5.5h16v11H9l-5 4v-15Z", "M8 10h8M8 13h5"],
    orders: ["M6 3.5h12v17H6z", "M9 8h6M9 12h6M9 16h4"],
    search: ["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z", "m15.5 15.5 5 5"],
    monitor: ["M4 18V6M4 18h16", "m7 14 4-4 3 2 5-6"],
    observe: ["M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
    evaluation: ["M4 20h16", "M7 17v-5M12 17V7M17 17v-9"],
    rules: ["M6 3.5h9l4 4v13H6z", "M15 3.5v4h4", "M9 12h7M9 16h7"],
    data: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z",
      "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
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
  function useNativeUser() {
    return React.useSyncExternalStore(users.subscribe, users.getSnapshot, users.getSnapshot);
  }
  const footerLabelStyle = { margin: "0 10px 4px", color: "var(--dsw-alias-label-tertiary)",
    fontSize: 11, fontWeight: 500, lineHeight: 1.4 };
  const footerRowStyle = { boxSizing: "border-box", display: "flex", alignItems: "center", gap: 9,
    width: "100%", padding: "7px 10px", border: "1px solid transparent", borderRadius: 8,
    background: "transparent", color: "var(--dsw-alias-label-secondary)", font: "inherit",
    fontSize: 12, lineHeight: 1.35, textAlign: "left", cursor: "pointer" };
  function NativeLearningNav() {
    const pages = [
      { id: "evaluation", label: "评测", icon: "evaluation" },
      { id: "rules", label: "规则", icon: "rules" },
      { id: "data", label: "数据", icon: "data" },
    ];
    return h("nav", { "data-aeroagent-learning-nav": "", "aria-label": "AeroAgent 业务学习导航",
      style: { boxSizing: "border-box", display: "grid", gap: 2, width: "100%" } },
      h("p", { style: footerLabelStyle }, "业务学习"),
      pages.map((page) => h("button", { key: page.id, type: "button",
        onClick: () => ctx.layout.selectPanel(`aeroagent-${page.id}`), style: footerRowStyle },
        h("span", { style: { display: "inline-grid", placeItems: "center", width: 18,
          color: "var(--dsw-alias-label-tertiary)" } }, h(NativeIcon, { name: page.icon, size: 15 })),
        h("span", null, page.label))));
  }
  function NativeUserSwitcher() {
    const { userId } = useNativeUser();
    React.useEffect(() => {
      // 用户切换后同步 Host 网关身份，避免工具调用沿用上一位乘客。
      void rpcCall("identity.setUser", { user_id: userId }).catch(() => {});
    }, [userId]);
    return h("section", { "data-native-user": userId, "aria-label": "AeroAgent 用户切换",
      style: { boxSizing: "border-box", width: "100%", paddingTop: 8, marginTop: 6,
        borderTop: "1px solid var(--dsw-alias-border-l1)" } },
      h("label", { htmlFor: "aeroagent-native-user-select", style: footerLabelStyle }, "当前用户"),
      h("select", { id: "aeroagent-native-user-select", "aria-label": "切换演示用户", value: userId,
        onChange: (event) => users.switchUser(event.target.value), style: { ...footerRowStyle,
          appearance: "auto", paddingRight: 8 } }, users.getUsers().map((item) => h("option",
          { key: item.user_id, value: item.user_id }, `${item.name} · ${item.tier}`))),
      h("p", { style: { margin: "4px 10px 0", color: "var(--dsw-alias-label-tertiary)",
        fontSize: 10, lineHeight: 1.5 } }, "画像仅影响推荐排序，不改变费用。"));
  }
  function NativeFooterNavigation() {
    return h("div", { "data-aeroagent-footer": "", style: { boxSizing: "border-box", width: "100%",
      display: "grid", padding: "8px 7px 0", marginTop: 6,
      borderTop: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-specific-sidebar-fill, transparent)" } },
      NativeLearningNav(), NativeUserSwitcher());
  }
  function NativeExtrasPage() {
    const { userId } = useNativeUser();
    const extras = [
      { id: "plugins", label: "插件", description: "管理已安装的 DSH 插件与扩展能力。" },
      { id: "schedules", label: "自动化任务", description: "查看和维护定时自动化任务。" },
    ];
    const [scenarios, setScenarios] = React.useState([]);
    const [scenario, setScenario] = React.useState("");
    const [notice, setNotice] = React.useState("");
    React.useEffect(() => {
      fetchNativeAdmin({ path: "/mock/scenarios", userId })
        .then((data) => { setScenarios(data.scenarios || []); setScenario(data.scenario || ""); })
        .catch((error) => setNotice(error.message));
    }, [userId]);
    async function switchScenario(id) {
      setNotice("正在切换场景…");
      try {
        await fetchNativeAdmin({ path: "/mock", method: "PUT", body: { scenario: id }, userId });
        setScenario(id);
        setNotice(`已切换到「${scenarios.find((item) => item.id === id)?.title || id}」，新案件生效。`);
      } catch (error) { setNotice(error.message); }
    }
    return h("main", { "data-aeroagent-native-page": "more", style: { boxSizing: "border-box", height: "100%",
      overflow: "auto", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" } },
      h("div", { style: { boxSizing: "border-box", maxWidth: 960, margin: "0 auto",
        padding: "32px clamp(24px, 4vw, 48px) 48px" } },
        h("h1", { style: { margin: "0 0 8px", fontSize: 24, lineHeight: 1.3, fontWeight: 600 } }, "更多功能"),
        h("p", { style: { margin: "0 0 24px", maxWidth: "62ch", color: "var(--dsw-alias-label-secondary)",
          fontSize: 14, lineHeight: 1.6 } }, "宿主能力入口与仿真场景保留在 DSH 原生面板中，不占用乘客主流程。"),
        h("div", { style: { display: "grid", gap: 12 } }, extras.map((item) => h("button", {
          key: item.id, type: "button", "data-aeroagent-extra-entry": item.id,
          onClick: () => ctx.layout.selectPanel(item.id),
          style: { boxSizing: "border-box", display: "grid", gap: 4, width: "100%", padding: "14px 16px",
            border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10, textAlign: "left",
            background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit",
            cursor: "pointer" } },
          h("strong", { style: { fontSize: 14, fontWeight: 600 } }, item.label),
          h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: 1.5 } },
            item.description)))),
        h("section", { "data-aeroagent-mock-console": "", style: { marginTop: 28, paddingTop: 20,
          borderTop: "1px solid var(--dsw-alias-border-l1)" } },
          h("h2", { style: { margin: "0 0 6px", fontSize: 16, fontWeight: 600 } }, "仿真航司"),
          h("p", { style: { margin: "0 0 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 13 } },
            "切换场景后只影响后续办理；已有案件不受影响。"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } }, scenarios.map((item) =>
            h("button", { key: item.id, type: "button", onClick: () => void switchScenario(item.id),
              style: item.id === scenario ? primaryButton : secondaryButton }, item.title || item.id))),
          notice ? h("p", { role: "status", style: { margin: "10px 0 0", color: "var(--dsw-alias-label-secondary)",
            fontSize: 12 } }, notice) : null)));
  }
  const inspectorMuted = { color: "var(--dsw-alias-label-secondary)", fontSize: 11, lineHeight: 1.6 };
  const inspectorFaint = { color: "var(--dsw-alias-label-tertiary)", fontSize: 10, lineHeight: 1.5 };
  const inspectorSectionStyle = { padding: "14px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" };
  const inspectorChipStyle = { display: "inline-flex", alignItems: "center", padding: "2px 6px",
    border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 4, color: "var(--dsw-alias-label-secondary)",
    fontSize: 10, lineHeight: 1.5 };
  const inspectorNodeLabels = { user_input: "接收诉求", memory_node: "加载记忆", order_align: "对齐订单",
    query_understand: "理解诉求", clarify: "追问乘客", agent_node: "决策下一步", schema_validate: "校验工具参数",
    checkpoint_gate: "规则门禁", tool_exec: "执行只读工具", step_back: "检索改写", sub_done: "完成子诉求",
    tool_scheme_gen: "生成退改方案", verify_node: "校验方案", retry_node: "自我修正", human_review: "转人工",
    finish: "结束本轮" };
  function inspectorJson(value) {
    return h("pre", { style: { boxSizing: "border-box", width: "100%", maxHeight: 180, overflow: "auto",
      margin: "5px 0 0", padding: 8, border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6,
      background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)",
      font: "10px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap",
      overflowWrap: "anywhere" } }, JSON.stringify(value ?? {}, null, 2));
  }
  function inspectorEmpty(title, detail) {
    return h("div", { style: { padding: "28px 4px", textAlign: "center" } },
      h("strong", { style: { display: "block", color: "var(--dsw-alias-label-primary)", fontSize: 13 } }, title),
      detail ? h("p", { style: { ...inspectorMuted, maxWidth: "34ch", margin: "6px auto 0" } }, detail) : null);
  }
  function inspectorSection(title, ...children) {
    return h("section", { style: inspectorSectionStyle },
      h("h3", { style: { margin: "0 0 9px", color: "var(--dsw-alias-label-primary)", fontSize: 12,
        fontWeight: 600 } }, title), ...children);
  }
  function NativeExecutionInspector() {
    const { userId } = useNativeUser();
    const conversation = useConversation(userId);
    const [tab, setTab] = React.useState("flow");
    const [selectedSubrequest, setSelectedSubrequest] = React.useState(0);
    const [highlight, setHighlight] = React.useState(null);
    const [record, setRecord] = React.useState(null);
    const [phase, setPhase] = React.useState(conversation.caseId ? "loading" : "idle");
    const [error, setError] = React.useState("");
    const [reload, setReload] = React.useState(0);
    // 原生 DSH 会话没有本地案件绑定，执行观测以服务端最新案件为准。
    const caseId = null;
    React.useEffect(() => {
      let active = true;
      let timer = null;
      let controller = null;
      async function load() {
        controller?.abort();
        controller = new AbortController();
        setPhase((current) => current === "ready" ? "refreshing" : "loading");
        try {
          const next = caseId
            ? await fetchNativeCase({ caseId, userId, signal: controller.signal, fetchImpl })
            : await fetchNativeLatestCase({ userId, signal: controller.signal, fetchImpl });
          if (!active) return;
          if (!next) {
            setRecord(null); setPhase("idle"); setError("");
            timer = setTimeout(load, 5000);
            return;
          }
          setRecord(next);
          setPhase("ready");
          setError("");
          if (!caseId) { timer = setTimeout(load, 4000); return; }
          if (["OPEN", "PROCESSING"].includes(next.status)) timer = setTimeout(load, 1200);
        } catch (failure) {
          if (!active || failure?.name === "AbortError") return;
          setPhase("error");
          setError(failure.message);
        }
      }
      load();
      return () => { active = false; if (timer) clearTimeout(timer); controller?.abort(); };
    }, [caseId, userId, reload]);
    const result = record?.result || {};
    const events = Array.isArray(result.trace) ? result.trace : [];
    const retrievalResults = nativeRetrievalResults(result.results || []);
    const context = result.context || {};
    const memory = result.memory || {};
    const verify = result.verify || result.final?.verify || null;
    const comparisons = nativeFeeComparisons(result);
    const verification = nativeVerificationState(verify || {});
    let body;
    if (!record && phase === "idle") body = inspectorEmpty("尚未产生案件", "从退改对话完成一轮需求后，这里会显示真实流程、检索、记忆与校验。");
    else if (phase === "loading" && !record) body = inspectorEmpty("正在读取案件运行数据…");
    else if (phase === "error" && !record) body = h("div", { role: "alert", style: { padding: "24px 2px" } },
      h("strong", { style: { display: "block", color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, "运行数据加载失败"),
      h("p", { style: inspectorMuted }, error),
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), style: secondaryButton }, "重试"));
    else if (tab === "flow") {
      body = events.length ? h("ol", { style: { listStyle: "none", margin: 0, padding: 0 } },
        events.map((event, index) => h("li", { key: `${event.node || "event"}-${index}`, style: { position: "relative",
          marginLeft: 3, padding: "0 0 2px 14px", borderLeft: "1px solid var(--dsw-alias-border-l2)" } },
          h("span", { "aria-hidden": "true", style: { position: "absolute", left: -3, top: 8, width: 5, height: 5,
            borderRadius: "50%", background: event.status === "error" ? "var(--dsw-alias-state-error-primary)"
              : "var(--dsw-alias-state-success-primary)" } }),
          h("details", { style: { padding: "3px 0 9px" } },
            h("summary", { style: { display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" } },
              h("span", { style: { flex: 1, minWidth: 0 } },
                h("strong", { style: { display: "block", fontSize: 12 } }, inspectorNodeLabels[event.node] ||
                  event.node || `Agent 节点 ${index + 1}`),
                h("small", { style: { display: "block", marginTop: 2, color: "var(--dsw-alias-label-secondary)",
                  fontSize: 10 } }, event.note || event.status || "—")),
              h("time", { style: inspectorFaint }, typeof event.ms === "number" ? `${event.ms} ms` : "耗时无数据")),
            h("div", { style: { display: "grid", gap: 8, marginTop: 7 } },
              h("div", null, h("h4", { style: { margin: 0, ...inspectorFaint } }, "输入"),
                event.input ? inspectorJson(event.input) : h("p", { style: inspectorFaint }, "本轮无数据")),
              h("div", null, h("h4", { style: { margin: 0, ...inspectorFaint } }, "输出"),
                event.output ? inspectorJson(event.output) : h("p", { style: inspectorFaint }, "本轮无数据")))))))
        : inspectorEmpty("本轮暂无流程轨迹", "发起退改对话后，这里展示按时间排列的 Agent 节点。");
    } else if (tab === "retrieval") {
      if (!retrievalResults.length) body = inspectorEmpty("本轮暂无检索数据", "完成包含票规检索的对话后，这里显示每个子诉求的召回与精排漏斗。");
      else {
        const currentIndex = Math.min(selectedSubrequest, retrievalResults.length - 1);
        const current = retrievalResults[currentIndex];
        const retrieval = current.retrieval || {};
        const meta = [retrieval.backend ? `${retrieval.backend}${retrieval.degraded ? " · 降级" : ""}` : null,
          current.rewrite?.type ? `改写：${current.rewrite.type}` : null].filter(Boolean);
        body = h("div", null,
          retrievalResults.length > 1 ? h("div", { role: "group", "aria-label": "选择子诉求",
            style: { display: "flex", gap: 5, marginBottom: 10 } }, retrievalResults.map((item, index) =>
            h("button", { key: `${item.intent}-${index}`, type: "button", "aria-pressed": index === currentIndex,
              onClick: () => { setSelectedSubrequest(index); setHighlight(null); },
              style: { flex: 1, padding: "5px 4px", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 5,
                background: index === currentIndex ? "var(--dsw-alias-interactive-bg-active)" : "transparent",
                color: index === currentIndex ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
                font: "inherit", fontSize: 11, cursor: "pointer" } },
              item.intent === "REFUND" ? "退票" : item.intent === "CHANGE" ? "改签"
                : item.intent === "POLICY" ? "规则" : item.intent || `子诉求 ${index + 1}`))) : null,
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 } },
            meta.map((label) => h("span", { key: label, style: inspectorChipStyle }, label))),
          current.text ? h("p", { style: { ...inspectorMuted, margin: "0 0 10px" } }, `当前子诉求：${current.text}`) : null,
          current.funnel.map((stage, stageIndex) => {
            const cap = typeof stage.k === "number" && stage.k > 0 ? stage.k : null;
            const count = typeof stage.count === "number" ? stage.count : null;
            const percent = cap && count !== null ? Math.min(100, Math.max(0, count / cap * 100)) : 0;
            const items = stage.items?.length ? h("ul", { style: { listStyle: "none", margin: "5px 0 0", padding: 0 } },
              stage.items.map((item, itemIndex) => h("li", { key: item.id || `${item.title}-${itemIndex}` },
                h("button", { type: "button", "aria-pressed": item.id === highlight,
                  onClick: () => setHighlight(item.id), style: { display: "grid", width: "100%", gap: 2,
                    gridTemplateColumns: "minmax(0, 1fr) auto", padding: "5px 6px", border: 0, borderRadius: 5,
                    background: item.id === highlight ? "var(--dsw-alias-interactive-bg-active)" : "transparent",
                    color: "var(--dsw-alias-label-primary)", textAlign: "left", font: "inherit", cursor: "pointer" } },
                h("code", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 10 } }, item.id || "无规则 ID"),
                h("b", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 9,
                  fontVariantNumeric: "tabular-nums" } }, typeof item.score === "number" ? item.score.toFixed(4) : "—"),
                h("span", { style: { gridColumn: "1 / -1", color: "var(--dsw-alias-label-secondary)",
                  fontSize: 10 } }, item.title || "无标题"))))) : null;
            return h("section", { key: `${stage.stage || stage.label}-${stageIndex}`, style: { padding: "9px 0",
              borderTop: "1px solid var(--dsw-alias-border-l1)" } },
              h("header", { style: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" } },
                h("strong", { style: { fontSize: 11 } }, stage.label || stage.stage || `阶段 ${stageIndex + 1}`),
                h("span", { style: inspectorFaint }, `${count ?? "本轮无数据"}${cap ? ` / ${cap}` : ""}`)),
              h("div", { "aria-hidden": "true", style: { height: 3, margin: "6px 0", borderRadius: 3,
                overflow: "hidden", background: "var(--dsw-alias-border-l1)" } },
                h("i", { style: { display: "block", width: `${percent}%`, height: "100%",
                  background: "var(--dsw-alias-brand-primary)" } })),
              items);
          }));
      }
    } else if (tab === "memory") {
      const hasContext = context && Object.keys(context).length;
      const hasMemory = memory && Object.keys(memory).length;
      if (!hasContext && !hasMemory) body = inspectorEmpty("本轮暂无记忆数据", "对话后显示订单栈、上下文预算与摘要。");
      else {
        const blocks = Object.entries(context.blocks || {});
        body = h("div", null,
          hasContext ? inspectorSection("上下文预算",
            h("div", { style: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 } },
              h("strong", { style: { fontSize: 12 } }, `${context.total ?? "—"} / ${context.budget ?? "—"} tokens`),
              h("span", { style: { color: "var(--dsw-alias-state-success-primary)", fontSize: 10 } },
                `节省 ${context.saved_pct ?? 0}%`)),
            blocks.length ? blocks.map(([name, block]) => {
              const percent = block.budget ? Math.min(100, Math.max(0, (block.tokens || 0) / block.budget * 100)) : 0;
              return h("details", { key: name, style: { padding: "7px 0",
                borderTop: "1px solid var(--dsw-alias-border-l1)" } },
                h("summary", { style: { display: "flex", gap: 7, alignItems: "baseline", cursor: "pointer", fontSize: 11 } },
                  h("span", { style: { flex: 1 } }, ({ system: "系统提示", order: "订单", rules: "规则",
                    history: "历史", profile: "画像" })[name] || name),
                  h("b", { style: { fontSize: 9, fontWeight: 500 } }, `${block.tokens ?? "—"} / ${block.budget ?? "—"}`),
                  h("em", { style: { color: block.truncated ? "var(--dsw-alias-state-warn-primary)"
                    : "var(--dsw-alias-label-tertiary)", fontSize: 9, fontStyle: "normal" } },
                  block.truncated ? "已截断" : "完整")),
                h("div", { "aria-hidden": "true", style: { height: 3, margin: "6px 0", borderRadius: 3,
                  overflow: "hidden", background: "var(--dsw-alias-border-l1)" } },
                  h("i", { style: { display: "block", width: `${percent}%`, height: "100%",
                    background: "var(--dsw-alias-brand-primary)" } })),
                block.text ? h("p", { style: inspectorMuted }, block.text) : h("p", { style: inspectorFaint }, "无注入文本"));
            }) : h("p", { style: inspectorFaint }, "上下文分块本轮无数据")) : null,
          hasMemory ? inspectorSection("会话记忆",
            memory.order_stack ? h("div", { style: { marginBottom: 8 } }, h("h4", { style: { margin: "0 0 5px",
              ...inspectorFaint } }, "订单栈"),
              memory.order_stack.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                memory.order_stack.map((order) => h("code", { key: order, style: inspectorChipStyle }, order)))
                : h("p", { style: inspectorFaint }, "空")) : null,
            h("dl", { style: { display: "grid", gap: 5, margin: "0 0 10px", fontSize: 11 } },
              h("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
                h("dt", { style: inspectorFaint }, "窗口轮数"),
                h("dd", { style: { margin: 0 } }, Array.isArray(memory.turns) ? memory.turns.length : memory.turns ?? 0)),
              h("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
                h("dt", { style: inspectorFaint }, "上一意图"),
                h("dd", { style: { margin: 0 } }, memory.last_intent === "REFUND" ? "退票"
                  : memory.last_intent === "CHANGE" ? "改签" : memory.last_intent || "—"))),
            h("h4", { style: { margin: "0 0 4px", ...inspectorFaint } }, "滑动窗口摘要"),
            h("p", { style: inspectorMuted }, memory.summary || "尚未产生摘要"),
            h("details", { style: { marginTop: 8 } }, h("summary", { style: { ...inspectorFaint, cursor: "pointer" } },
              "完整记忆快照"), inspectorJson(memory))) : null);
      }
    } else if (tab === "receipt") {
      const operation = record?.result?.operation || null;
      if (!operation) {
        body = inspectorEmpty("暂无航司回执", "完成一次确认办理后，这里显示航司受理结果与对账入口。");
      } else {
        const ticket = operation.ticket_no ? h("p", { style: { margin: "0 0 6px" } },
          h("strong", null, "票号 "), h("code", null, operation.ticket_no)) : null;
        const reconcile = operation.status === "RESULT_UNKNOWN" && operation.operation_id
          ? h("button", { type: "button", onClick: async () => {
              try {
                await fetchNativeV1({ path: `/operations/${encodeURIComponent(operation.operation_id)}/reconcile`,
                  method: "POST", userId });
                setReload((value) => value + 1);
              } catch (error) { setError(error.message); }
            }, style: secondaryButton }, "核对结果") : null;
        body = h("div", null,
          inspectorSection("航司回执",
            h("p", { style: inspectorMuted }, `状态 ${operation.status || "—"}${operation.code ? ` · ${operation.code}` : ""}`),
            operation.message ? h("p", { style: inspectorMuted }, operation.message) : null,
            ticket,
            operation.customer_amount != null ? h("p", { style: inspectorMuted },
              `金额 ¥${operation.customer_amount}`) : null,
            operation.supplier_reference ? h("p", { style: inspectorFaint },
              `航司参考号 ${operation.supplier_reference}`) : null,
            reconcile),
          inspectorSection("原始回执", inspectorJson(operation)));
      }
    } else if (!verify && !comparisons.length && !(result.results || []).length) {
      body = inspectorEmpty("本轮暂无校验结果", "方案生成后展示金额比对、规则引用与校验问题。");
    } else {
      const refs = verify?.references || verify?.rule_refs ||
        (result.final?.options || []).flatMap((option) => option.rule_refs || []);
      const issues = [...(verify?.errors || []), ...(result.results || []).map((item) => item.error).filter(Boolean)];
      const support = typeof verify?.support_ratio === "number" ? `${Math.round(verify.support_ratio * 100)}%` : undefined;
      const metric = (label, value) => h("div", { key: label, style: { padding: "8px 9px",
        border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, background: "var(--dsw-alias-bg-layer-1)" } },
        h("span", { style: { display: "block", ...inspectorFaint } }, label),
        h("strong", { style: { display: "block", marginTop: 3, fontSize: 12 } }, value ?? "本轮无数据"));
      body = h("div", null,
        h("p", { role: "status", style: { margin: "0 0 10px", padding: "7px 8px", borderRadius: 6, fontSize: 11,
          textAlign: "center", color: verification.kind === "success" ? "var(--dsw-alias-state-success-primary)"
            : verification.kind === "failure" ? "var(--dsw-alias-state-error-primary)"
            : "var(--dsw-alias-label-secondary)",
          background: verification.kind === "success" ? "color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)"
            : verification.kind === "failure" ? "color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)"
            : "var(--dsw-alias-bg-layer-1)" } }, verification.label),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, marginBottom: 10 } },
          metric("置信度", verify?.confidence), metric("校验门槛", verify?.threshold),
          metric("依据覆盖率", support), metric("自我修正", verify?.retries ?? result.retries)),
        inspectorSection("金额比对 · 方案 / 运价引擎", comparisons.length ? h("div", { style: { overflowX: "auto" } },
          h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 10 } },
            h("thead", null, h("tr", null, ["项目", "方案", "引擎", "结果"].map((label) =>
              h("th", { key: label, style: { padding: "5px 4px", textAlign: "left", color: "var(--dsw-alias-label-tertiary)",
                fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l1)" } }, label)))),
            h("tbody", null, comparisons.map((row, index) => h("tr", { key: `${row.label}-${index}` },
              [row.label, row.actual == null ? "—" : `¥${Number(row.actual).toLocaleString("zh-CN")}`,
                row.expected == null ? "—" : `¥${Number(row.expected).toLocaleString("zh-CN")}`,
                row.matched === true ? "一致" : row.matched === false ? "不一致" : "无数据"].map((cell, cellIndex) =>
                h("td", { key: cellIndex, style: { padding: "5px 4px", borderBottom: "1px solid var(--dsw-alias-border-l1)",
                  color: cellIndex === 3 && row.matched === false ? "var(--dsw-alias-state-error-primary)"
                    : "var(--dsw-alias-label-secondary)" } }, cell)))))))
          : inspectorEmpty("本轮没有可比对金额")),
        inspectorSection("论断与规则依据",
          refs.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
            refs.map((ref) => h("code", { key: ref, style: inspectorChipStyle }, String(ref))))
            : h("p", { style: inspectorFaint }, "本轮无引用依据"),
          verify?.unsupported_claims?.length ? h("ul", { style: { margin: "8px 0 0", paddingLeft: 17,
            color: "var(--dsw-alias-state-warn-primary)", fontSize: 11 } },
            verify.unsupported_claims.map((claim, index) => h("li", { key: index },
              typeof claim === "string" ? claim : JSON.stringify(claim)))) : null,
          verify?.bad_refs?.length ? h("p", { style: { color: "var(--dsw-alias-state-error-primary)",
            fontSize: 11 } }, `无效引用：${verify.bad_refs.join("、")}`) : null),
        issues.length ? inspectorSection("校验问题", h("ul", { style: { margin: 0, paddingLeft: 17,
          color: "var(--dsw-alias-state-warn-primary)", fontSize: 11 } }, issues.map((issue, index) =>
          h("li", { key: index }, String(issue))))) : null);
    }
    return h("section", { "data-aeroagent-execution-inspector": "", "aria-label": "AeroAgent 执行观测栏",
      style: { boxSizing: "border-box", height: "100%", display: "flex", flexDirection: "column",
        overflow: "hidden", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)" } },
      h("header", { style: { flex: "0 0 auto", padding: "14px 14px 10px", borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
        h("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 } },
          h("div", { style: { minWidth: 0 } },
            h("h2", { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, "运行详情"),
            h("code", { style: { display: "block", marginTop: 4, maxWidth: 230, overflow: "hidden",
              textOverflow: "ellipsis", color: "var(--dsw-alias-label-tertiary)", fontSize: 10 } },
            caseId || record?.case_id || "未绑定案件")),
          h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("span", { style: { color: record?.status === "RESULT_UNKNOWN" ? "var(--dsw-alias-state-error-primary)"
              : "var(--dsw-alias-label-secondary)", fontSize: 10 } }, record?.status || (phase === "loading" ? "读取中" : "READY")),
            h("button", { type: "button", disabled: (!caseId && !record) || phase === "loading" || phase === "refreshing",
              onClick: () => setReload((value) => value + 1), style: { ...secondaryButton, padding: "3px 7px", fontSize: 10 } },
            phase === "refreshing" ? "刷新中" : "刷新")))),
      h("div", { role: "tablist", "aria-label": "执行观测分区", style: { flex: "0 0 auto", display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)", padding: "0 10px", borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
        nativeExecutionTabs.map(([id, label]) => h("button", { key: id, type: "button", role: "tab", "aria-selected": tab === id,
          onClick: () => setTab(id), style: { padding: "8px 2px", border: 0,
            borderBottom: tab === id ? "2px solid var(--dsw-alias-brand-primary)" : "2px solid transparent",
            background: "transparent", color: tab === id ? "var(--dsw-alias-label-primary)"
              : "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: 11, cursor: "pointer" } }, label))),
      h("div", { role: "tabpanel", style: { flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "10px 14px 22px" } }, body));
  }
  function NativeExecutionInspectorButton() {
    return h("button", { type: "button", title: "打开 AeroAgent 执行观测栏", "aria-label": "打开 AeroAgent 执行观测栏",
      onClick: () => ctx.sidebarRight.openTab("aeroagent-inspector"), style: { display: "inline-grid", placeItems: "center",
        width: 30, height: 30, padding: 0, border: 0, borderRadius: 6, background: "transparent",
        color: "inherit", cursor: "pointer" } }, h(NativeIcon, { name: "observe", size: 18 }));
  }
  function useSelectedOrder(userId) {
    return React.useSyncExternalStore(selection.subscribe, () => selection.get(userId), () => null);
  }
  function NativeSelectedOrder({ userId, caseId = null } = {}) {
    const order = useSelectedOrder(userId);
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
    const { userId } = useNativeUser();
    const [reload, setReload] = React.useState(0);
    const [state, setState] = React.useState({ status: "loading", orders: [], error: "" });
    const selectedOrder = useSelectedOrder(userId);
    React.useEffect(() => {
      let active = true;
      const owner = users.captureOwner();
      const controller = users.trackRequest(new AbortController());
      setState({ status: "loading", orders: [], error: "" });
      fetchNativeOrders({ userId, signal: controller.signal, fetchImpl }).then((orders) => {
        if (active && users.isOwnerCurrent(owner)) setState({ status: "ready", orders, error: "" });
      }).catch((error) => {
        if (active && users.isOwnerCurrent(owner) && error?.name !== "AbortError") {
          setState({ status: "error", orders: [], error: error.message });
        }
      }).finally(() => users.releaseRequest(controller));
      return () => { active = false; controller.abort(); users.releaseRequest(controller); };
    }, [reload, userId]);
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
                onClick: () => { selection.select(userId, order); openNativeAeroConversation(ctx); },
                style: selected ? primaryButton : secondaryButton }, selected ? "继续对话" : "选择并对话")));
          }))));
    }
    return h("main", { "data-aeroagent-native-page": "orders", style: { boxSizing: "border-box", height: "100%",
      overflow: "auto", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit" } },
      h("div", { style: { boxSizing: "border-box", maxWidth: 1180, margin: "0 auto",
        padding: "32px clamp(24px, 4vw, 48px) 48px" } }, header, content));
  }

  function useConversation(userId) {
    return React.useSyncExternalStore(conversations.subscribe, () => conversations.get(userId), () => conversations.get(userId));
  }
  function NativeChatPage() {
    const { userId, user } = useNativeUser();
    const selectedOrder = useSelectedOrder(userId);
    const conversation = useConversation(userId);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const mounted = React.useRef(true);
    const activeRequest = React.useRef(null);
    const feedRef = React.useRef(null);
    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; activeRequest.current?.controller.abort(); };
    }, []);
    React.useEffect(() => {
      setBusy(false);
      setError(null);
      activeRequest.current = null;
    }, [userId]);
    React.useEffect(() => {
      scrollNativeChatToLatest(feedRef.current);
    }, [userId, conversation.messages.length, conversation.quotes.length]);
    async function sendMessage(raw) {
      const requestUserId = userId;
      const owner = users.captureOwner();
      const current = conversations.get(requestUserId);
      const text = String(raw ?? current.draft).trim();
      if (!text || busy) return;
      const requestCaseId = current.caseId;
      const orderId = selection.get(requestUserId)?.order_id || null;
      if (!requestCaseId && !orderId) {
        setError({ code: "ORDER_REQUIRED", message: "请先从「我的订单」选择一张客票。", retryable: false });
        return;
      }
      conversations.append(requestUserId, { role: "user", text });
      conversations.patch(requestUserId, { draft: "" });
      setError(null); setBusy(true);
      const controller = users.trackRequest(new AbortController());
      activeRequest.current = { controller, owner };
      try {
        const result = await fetchNativeChat({ message: text, orderId, caseId: requestCaseId,
          userId: requestUserId, signal: controller.signal, fetchImpl });
        if (!mounted.current || !users.isOwnerCurrent(owner)) return;
        conversations.patch(requestUserId, { caseId: result.caseId || requestCaseId, quotes: result.quotes });
        if (result.text) conversations.append(requestUserId, { role: "assistant", text: result.text });
      } catch (failure) {
        if (!mounted.current || !users.isOwnerCurrent(owner) || failure?.name === "AbortError") return;
        conversations.patch(requestUserId, { caseId: failure.caseId || requestCaseId, draft: text });
        setError({ code: failure.code || "REQUEST_FAILED", message: failure.message,
          retryable: failure.retryable === true });
      } finally {
        users.releaseRequest(controller);
        if (mounted.current && users.isOwnerCurrent(owner) && activeRequest.current?.controller === controller) {
          setBusy(false); activeRequest.current = null;
        }
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
        fontSize: 11 } }, message.role === "user" ? user.name : message.role === "assistant" ? "AeroAgent · DeepSeek" : "系统"),
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
        h(NativeSelectedOrder, { userId, caseId: conversation.caseId })),
      h("section", { ref: feedRef, "aria-label": "退改对话记录", "aria-live": "polite", style: { flex: "1 1 auto", minHeight: 150,
        display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", padding: "20px clamp(20px, 3vw, 36px)" } },
        conversation.messages.length ? conversation.messages.map(messageView) : h("div", { style: { margin: "auto",
          maxWidth: 520, padding: "30px 0", textAlign: "center", color: "var(--dsw-alias-label-secondary)" } },
          h("div", { style: { display: "flex", justifyContent: "center", marginBottom: 12,
            color: "var(--dsw-alias-label-primary)" } }, h(NativeIcon, { name: "plane", size: 30 })),
          h("h2", { style: { margin: "0 0 8px", color: "var(--dsw-alias-label-primary)", fontSize: 18 } }, `你好，${user.name}`),
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

  function NativeChatRedirect() {
    React.useEffect(() => { openNativeAeroConversation(ctx); }, []);
    return h("main", { "data-aeroagent-native-page": "chat-redirect", style: { boxSizing: "border-box",
      display: "grid", placeItems: "center", height: "100%", background: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: 13 } }, "正在打开 DSH 原生退改会话…");
  }
  function NativeOrderContextBar({ inputActions } = {}) {
    const { userId, user } = useNativeUser();
    const order = useSelectedOrder(userId);
    React.useEffect(() => {
      try { ctx.sidebarRight?.openTab?.("aeroagent-inspector"); } catch { /* 右侧栏折叠时由页头按钮打开。 */ }
    }, []);
    React.useEffect(() => {
      let disposed = false;
      if (!order) return undefined;
      // 演示数据可能被重置：本地留存的客票已不存在时立即清空，避免把死订单号发进对话。
      Promise.resolve(fetchNativeOrders({ userId, fetchImpl }))
        .then((result) => {
          if (disposed) return;
          const list = Array.isArray(result) ? result : (result?.orders || []);
          const exists = list.some((item) => item.order_id === order.order_id);
          if (!exists) selection.select(userId, null);
        })
        .catch(() => { /* 后端不可达时保留选择，由发送时报错并提示重试。 */ });
      return () => { disposed = true; };
    }, [userId, order?.order_id]);
    if (!order) {
      return h("section", { "data-aeroagent-order-context-bar": "empty", "aria-label": "AeroAgent 客票上下文条",
        style: { ...orderContextBarFrame, display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, padding: "7px 10px", border: "1px solid var(--dsw-alias-border-l1)",
          borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)",
          fontSize: 12 } },
        h("span", null, `${user.name} · 尚未绑定退改客票`),
        h("button", { type: "button", onClick: () => ctx.layout.selectPanel("aeroagent-orders"),
          style: { ...secondaryButton, padding: "4px 9px", fontSize: 11 } }, "选择客票"));
    }
    const flight = order.flight || {};
    const fill = (prompt) => inputActions?.setDraft?.(`@${order.order_id} ${prompt}`);
    const chip = { ...secondaryButton, padding: "2px 7px", fontSize: 10, lineHeight: 1.5 };
    return h("section", { "data-aeroagent-order-context-bar": order.order_id, "aria-label": "AeroAgent 客票上下文条",
      style: { ...orderContextBarFrame, padding: "6px 10px", border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
        fontSize: 12 } },
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
        h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 8px", minWidth: 0 } },
          h("strong", { style: { fontSize: 12, fontWeight: 600 } },
            `${order.flight_no} · ${flight.origin_city || flight.origin || "—"} → ${flight.dest_city || flight.dest || "—"}`),
          h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11 } },
            `${order.date || "—"} ${flight.dep_time || ""} · ${order.status} · ${order.order_id}`)),
        h("button", { type: "button", onClick: () => ctx.layout.selectPanel("aeroagent-orders"),
          style: { ...chip, flex: "0 0 auto" } }, "更换客票")),
      h("div", { "aria-label": "退改快捷操作", title: "仅填入输入框，不会自动发送或创建案件",
        style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 } },
        h("button", { type: "button", onClick: () => fill("帮我改签到后天，请生成可选方案，并说明差价和手续费。"),
          style: chip }, "生成改签方案"),
        h("button", { type: "button", onClick: () => fill("航班取消了，请按当前票规计算退票费和最终退款。"),
          style: chip }, "退票"),
        h("button", { type: "button", onClick: () => fill("请分别给出改签和退票方案，比较费用后再由我选择。"),
          style: chip }, "改签 + 退票")));
  }
  function NativeQuoteDock() {
    const { userId } = useNativeUser();
    const [record, setRecord] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState("");
    const [index, setIndex] = React.useState(0);
    const [armed, setArmed] = React.useState("");
    const [closed, setClosed] = React.useState("");
    const [reload, setReload] = React.useState(0);
    React.useEffect(() => {
      let active = true;
      let timer = null;
      let controller = null;
      async function load() {
        controller?.abort();
        controller = new AbortController();
        let next = null;
        try {
          next = await fetchNativeLatestCase({ userId, signal: controller.signal, fetchImpl });
          if (active) setRecord(next);
        } catch { /* 保留上一份快照，避免办理中的状态闪断。 */ }
        if (!active) return;
        const phase = nativeCasePhase(next);
        timer = setTimeout(load, phase === "processing" || phase === "confirm" ? 2000 : 8000);
      }
      load();
      return () => { active = false; if (timer) clearTimeout(timer); controller?.abort(); };
    }, [userId, reload]);
    const phase = nativeCasePhase(record);
    const quotes = nativeActionableQuotes(record);
    const quote = quotes[Math.min(index, Math.max(quotes.length - 1, 0))];
    const operation = nativeOperationSummary(record);
    async function confirmQuote(target) {
      if (!target) return;
      setBusy(true);
      setNotice("正在复核价格并提交办理…");
      const keys = requestKeys(target.quote_id);
      try {
        await fetchNativeV1({ path: `/quotes/${encodeURIComponent(target.quote_id)}/confirm`, method: "POST",
          body: { confirmation_id: keys.confirmationId, idempotency_key: keys.idempotencyKey }, userId, fetchImpl });
        setNotice("已受理，正在等待航司最终状态…");
      } catch (failure) {
        const code = failure?.body?.error?.code;
        setNotice(code === "REQUOTE_REQUIRED"
          ? "价格已更新，请核对最新方案后再确认。"
          : `${failure.message}；可直接重试，重复提交不会重复扣款。`);
      } finally {
        setBusy(false);
        setArmed("");
        setReload((value) => value + 1);
      }
    }
    async function declineAll(caseId) {
      setBusy(true);
      setNotice("正在取消本次报价…");
      try {
        await fetchNativeV1({ path: `/cases/${encodeURIComponent(caseId)}/messages`, method: "POST",
          body: { message: "暂不办理" }, userId, fetchImpl });
        setNotice("已取消本次报价，订单未发生变化。");
      } catch (failure) {
        setNotice(`取消失败：${failure.message}`);
      } finally {
        setBusy(false);
        setArmed("");
        setReload((value) => value + 1);
      }
    }
    if (phase === "idle" && !notice) return null;
    if (closed && closed === record?.case_id) return null;
    const label = quote?.action === "REFUND" ? "退票方案" : "改签方案";
    const totalLabel = quote?.action === "REFUND" ? "预计退款" : "应付合计";
    const chip = { ...secondaryButton, padding: "4px 10px", fontSize: 11 };
    const summary = phase === "processing" ? "正在办理 · 已提交航司，等待最终状态…"
      : phase === "done" ? (operation || "办理已完成")
      : quote ? `${label} · ${totalLabel} ¥${Number(quote.amount || 0).toLocaleString("zh-CN")}`
      : "方案处理中…";
    return h("section", { "data-aeroagent-quote-dock": phase, "aria-label": "AeroAgent 方案确认",
      style: { ...orderContextBarFrame, padding: "7px 10px", border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
        fontSize: 12 } },
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" } },
          h("strong", { style: { fontSize: 12, fontWeight: 600 } }, summary),
          phase === "confirm" && quotes.length > 1 ? h("select", { "aria-label": "选择方案",
            value: index, onChange: (event) => { setIndex(Number(event.target.value)); setArmed(""); }, style: chip },
            quotes.map((item, position) => h("option", { key: item.quote_id, value: position },
              `方案 ${position + 1}/${quotes.length}`))) : null,
          phase === "confirm" && quote ? h("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 10 } },
            (quote.details?.[0]?.rule_refs || []).join("、")) : null),
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" } },
          phase === "confirm" && armed === quote?.quote_id ? h(React.Fragment, null,
            h("button", { type: "button", disabled: busy, onClick: () => confirmQuote(quote), style: { ...chip,
              borderColor: "var(--dsw-alias-state-business-primary)" } },
            busy ? "提交中…" : `确认提交 ¥${Number(quote.amount || 0).toLocaleString("zh-CN")}`),
            h("button", { type: "button", disabled: busy, onClick: () => setArmed(""), style: chip }, "返回")) : null,
          phase === "confirm" && armed !== quote?.quote_id ? h(React.Fragment, null,
            h("button", { type: "button", disabled: busy, onClick: () => setArmed(quote?.quote_id || ""),
              style: { ...chip, borderColor: "var(--dsw-alias-border-l3)" } }, "确认办理"),
            h("button", { type: "button", disabled: busy, onClick: () => declineAll(record?.case_id), style: chip },
            "暂不办理")) : null,
          phase === "processing" ? h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11 } },
            "办理中") : null,
          phase === "done" ? h("button", { type: "button", onClick: () => setClosed(record?.case_id),
            style: chip }, "完成") : null)),
      notice && phase !== "done"
        ? h("p", { role: "status", style: { margin: "5px 0 0", color: "var(--dsw-alias-label-secondary)",
          fontSize: 11, lineHeight: 1.5 } }, notice)
        : null);
  }
  const depotCell = { padding: "10px 12px", borderBottom: "1px solid var(--dsw-alias-border-l1)",
    fontSize: 12, verticalAlign: "middle", textAlign: "left" };
  const depotHead = { ...depotCell, color: "var(--dsw-alias-label-tertiary)", fontSize: 10,
    fontWeight: 500, letterSpacing: ".04em" };
  const depotNote = { margin: "0 0 16px", color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: 1.6 };
  function depotFrame(page, title, description, ...content) {
    return h("main", { "data-aeroagent-native-page": page, style: { boxSizing: "border-box", height: "100%",
      overflow: "auto", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" } },
      h("div", { style: { boxSizing: "border-box", maxWidth: 1080, margin: "0 auto",
        padding: "28px clamp(20px, 4vw, 40px) 48px" } },
        h("header", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          gap: 20, paddingBottom: 18, borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
          h("div", null, h("h1", { style: { margin: "0 0 6px", fontSize: 22, fontWeight: 600 } }, title),
            h("p", { style: { ...depotNote, margin: 0, maxWidth: "60ch" } }, description)),
          h("span", { style: { flex: "0 0 auto", padding: "3px 8px", border: "1px solid var(--dsw-alias-border-l2)",
            borderRadius: 6, color: "var(--dsw-alias-label-tertiary)", fontSize: 10 } }, "本地 SQL 快照")),
        ...content));
  }
  function NativeListingPage() {
    const { userId, user } = useNativeUser();
    const [origin, setOrigin] = React.useState("");
    const [dest, setDest] = React.useState("");
    const [date, setDate] = React.useState("");
    const [passenger, setPassenger] = React.useState(user?.name || "");
    const [flights, setFlights] = React.useState([]);
    const [state, setState] = React.useState({ status: "loading", error: "" });
    const [choice, setChoice] = React.useState({});
    const [booking, setBooking] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState(null);
    const [reload, setReload] = React.useState(0);
    React.useEffect(() => { setPassenger(user?.name || ""); }, [userId]);
    React.useEffect(() => {
      let active = true;
      const controller = new AbortController();
      setState((current) => ({ ...current, status: "loading", error: "" }));
      fetchNativeFlights({ query: { origin, dest, date }, userId, signal: controller.signal, fetchImpl })
        .then((rows) => { if (active) { setFlights(rows); setState({ status: "ready", error: "" }); } })
        .catch((failure) => { if (active && failure?.name !== "AbortError") setState({ status: "error", error: failure.message }); });
      return () => { active = false; controller.abort(); };
    }, [userId, origin, dest, date, reload]);
    async function reserve(flight) {
      const fare = choice[`${flight.flight_no}:${flight.date}`] || (flight.fares.find((item) => item.available) || {}).fare_product;
      if (!fare) { setNotice({ kind: "error", text: "该航班没有可预订的票价产品。" }); return; }
      if (!passenger.trim()) { setNotice({ kind: "error", text: "请填写乘客姓名。" }); return; }
      setBusy(true); setNotice(null);
      try {
        const created = await createNativeBooking({ flight, fareProduct: fare, passenger, userId, fetchImpl });
        setBooking({ ...created, idempotencyKey: `pay-${Date.now()}-${Math.random().toString(16).slice(2, 10)}` });
        setNotice({ kind: "info", text: "已创建待支付订单；模拟支付后才会出票。" });
      } catch (failure) {
        setNotice({ kind: "error", text: failure.message });
      } finally { setBusy(false); }
    }
    async function pay() {
      if (!booking) return;
      setBusy(true);
      try {
        const paid = await payNativeBooking({ bookingId: booking.booking_id,
          idempotencyKey: booking.idempotencyKey, userId, fetchImpl });
        setBooking({ ...booking, ...paid });
        setNotice({ kind: "success", text: `已出票：${paid.ticket_no}（模拟支付，不涉及真实资金）` });
      } catch (failure) {
        setNotice({ kind: "error", text: failure.message });
      } finally { setBusy(false); }
    }
    let body;
    if (state.status === "loading" && !flights.length) body = learningState("loading", "正在读取航班快照…");
    else if (state.status === "error") body = learningState("error", "航班加载失败", state.error,
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), style: secondaryButton }, "重试"));
    else if (!flights.length) body = learningState("empty", "没有匹配航班", "调整航线或日期后重新查询。");
    else body = h("table", { style: { width: "100%", borderCollapse: "collapse", marginTop: 4 } },
      h("thead", null, h("tr", null, ["航班", "航线", "日期 / 时间", "票价产品", "总价", "状态", ""].map((label) =>
        h("th", { key: label, style: depotHead }, label)))),
      h("tbody", null, flights.map((flight) => {
        const key = `${flight.flight_no}:${flight.date}`;
        const fares = flight.fares || [];
        const selectedFare = choice[key] || (fares.find((fare) => fare.available) || fares[0] || {}).fare_product;
        const current = fares.find((fare) => fare.fare_product === selectedFare) || {};
        return h("tr", { key, "data-native-flight-row": flight.flight_no },
          h("td", { style: depotCell }, h("strong", null, flight.flight_no),
            h("div", { style: { marginTop: 3, color: "var(--dsw-alias-label-tertiary)", fontSize: 10 } },
              flight.airline || "—")),
          h("td", { style: depotCell }, `${flight.origin_city || flight.origin} → ${flight.dest_city || flight.dest}`),
          h("td", { style: depotCell }, `${flight.date} ${flight.dep_time || ""}`),
          h("td", { style: depotCell }, h("select", { "aria-label": `选择${flight.flight_no}票价产品`, value: selectedFare,
            onChange: (event) => setChoice({ ...choice, [key]: event.target.value }),
            style: { ...nativeInputStyle, padding: "4px 7px" } }, fares.map((fare) =>
            h("option", { key: fare.fare_product, value: fare.fare_product, disabled: !fare.available },
              `${fare.fare_product} · ¥${fare.total}`)))),
          h("td", { style: { ...depotCell, fontVariantNumeric: "tabular-nums" } }, current.total ? `¥${current.total}` : "—"),
          h("td", { style: depotCell }, flight.available
            ? h("span", { style: { color: "var(--dsw-alias-state-success-primary)" } }, "可预订")
            : h("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, flight.unavailable_reason || "不可预订")),
          h("td", { style: depotCell }, h("button", { type: "button", disabled: busy || !flight.available,
            onClick: () => reserve(flight), style: { ...secondaryButton, padding: "4px 9px", fontSize: 11 } }, "预订")));
      })));
    return depotFrame("listing", "Listing", "按航线、日期检索本地航班快照；预订后先进入待支付，模拟支付成功才出票。",
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, padding: "16px 0" } },
        h("input", { "aria-label": "出发地", placeholder: "出发地代码，如 HGH", value: origin,
          onChange: (event) => setOrigin(event.target.value.toUpperCase()), style: { ...nativeInputStyle, flex: "1 1 120px" } }),
        h("input", { "aria-label": "目的地", placeholder: "目的地代码，如 PEK", value: dest,
          onChange: (event) => setDest(event.target.value.toUpperCase()), style: { ...nativeInputStyle, flex: "1 1 120px" } }),
        h("input", { "aria-label": "航班日期", type: "date", value: date,
          onChange: (event) => setDate(event.target.value), style: { ...nativeInputStyle, flex: "0 1 160px" } }),
        h("input", { "aria-label": "乘客姓名", placeholder: "乘客姓名", value: passenger,
          onChange: (event) => setPassenger(event.target.value), style: { ...nativeInputStyle, flex: "1 1 140px" } }),
        h("button", { type: "button", onClick: () => setReload((value) => value + 1), style: primaryButton }, "查询")),
      notice ? h("p", { role: notice.kind === "error" ? "alert" : "status", style: { margin: "0 0 12px",
        color: notice.kind === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)",
        fontSize: 12 } }, notice.text) : null,
      booking ? h("div", { "data-native-booking": booking.status, style: { display: "flex", flexWrap: "wrap",
        alignItems: "center", gap: 12, padding: "12px 14px", marginBottom: 14, border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)", fontSize: 12 } },
        h("strong", null, booking.status === "ISSUED" ? `已出票 ${booking.ticket_no}` : `待支付 ¥${booking.total}`),
        h("span", { style: { color: "var(--dsw-alias-label-secondary)" } },
          `${booking.flight_no} ${booking.date} · ${booking.passenger}`),
        booking.status === "PENDING_PAYMENT" ? h("button", { type: "button", disabled: busy, onClick: pay,
          style: { ...primaryButton, padding: "5px 12px", fontSize: 12 } }, busy ? "支付中…" : "模拟支付") : null,
        h("button", { type: "button", onClick: () => { setBooking(null); setNotice(null); },
          style: { ...secondaryButton, padding: "5px 10px", fontSize: 11 } }, "关闭")) : null,
      body);
  }
  function NativeMonitorPage() {
    const { userId } = useNativeUser();
    const [form, setForm] = React.useState({ flight_no: "", date: "", fare_product: "Y", target_total: "", percentage_threshold: "" });
    const [watches, setWatches] = React.useState([]);
    const [alerts, setAlerts] = React.useState([]);
    const [state, setState] = React.useState({ status: "loading", error: "" });
    const [notice, setNotice] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [reload, setReload] = React.useState(0);
    React.useEffect(() => {
      let active = true;
      const controller = new AbortController();
      setState({ status: "loading", error: "" });
      Promise.all([fetchNativeWatches({ userId, signal: controller.signal, fetchImpl }),
        fetchNativeAlerts({ userId, signal: controller.signal, fetchImpl })])
        .then(([watchData, alertData]) => {
          if (!active) return;
          setWatches(watchData.watches || []);
          setAlerts(alertData.alerts || []);
          setState({ status: "ready", error: "" });
        })
        .catch((failure) => { if (active && failure?.name !== "AbortError") setState({ status: "error", error: failure.message }); });
      return () => { active = false; controller.abort(); };
    }, [userId, reload]);
    async function submit() {
      const payload = { flight_no: form.flight_no.trim().toUpperCase(), date: form.date.trim(),
        fare_product: form.fare_product.trim() };
      if (form.target_total) payload.target_total = Number(form.target_total);
      if (form.percentage_threshold) payload.percentage_threshold = Number(form.percentage_threshold);
      if (!payload.target_total && !payload.percentage_threshold) {
        setNotice({ kind: "error", text: "目标总价和降幅百分比至少填写一项。" }); return;
      }
      setBusy(true); setNotice(null);
      try {
        await createNativeWatch({ watch: payload, userId, fetchImpl });
        setNotice({ kind: "success", text: "监控已创建，基线取当前服务端票价。" });
        setForm({ ...form, flight_no: "", date: "", target_total: "", percentage_threshold: "" });
        setReload((value) => value + 1);
      } catch (failure) {
        setNotice({ kind: "error", text: failure.message });
      } finally { setBusy(false); }
    }
    async function evaluate(watchId) {
      setBusy(true);
      try {
        const result = await evaluateNativeWatch({ watchId, userId, fetchImpl });
        setNotice({ kind: "success", text: result.alert ? "已命中阈值，提醒已写入站内历史。"
          : result.deduplicated_alert_id ? "价格已命中，重复提醒已去重。" : "已评估，当前价格未达到阈值。" });
        setReload((value) => value + 1);
      } catch (failure) {
        setNotice({ kind: "error", text: failure.message });
      } finally { setBusy(false); }
    }
    return depotFrame("monitor", "低价监控", "监控保存在服务端 SQL；定时评估命中后只写入 DSH 站内提醒，不发送外部通知。",
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, padding: "16px 0" } },
        h("input", { "aria-label": "监控航班号", placeholder: "航班号 MU5101", value: form.flight_no,
          onChange: (event) => setForm({ ...form, flight_no: event.target.value.toUpperCase() }), style: { ...nativeInputStyle, flex: "1 1 120px" } }),
        h("input", { "aria-label": "监控日期", type: "date", value: form.date,
          onChange: (event) => setForm({ ...form, date: event.target.value }), style: { ...nativeInputStyle, flex: "0 1 150px" } }),
        h("select", { "aria-label": "监控票价产品", value: form.fare_product,
          onChange: (event) => setForm({ ...form, fare_product: event.target.value }), style: { ...nativeInputStyle, flex: "0 1 150px" } },
          ["Y", "Y_DISCOUNT", "SPECIAL", "C", "F", "GROUP"].map((value) => h("option", { key: value, value }, value))),
        h("input", { "aria-label": "目标总价", inputMode: "numeric", placeholder: "目标总价", value: form.target_total,
          onChange: (event) => setForm({ ...form, target_total: event.target.value }), style: { ...nativeInputStyle, flex: "1 1 110px" } }),
        h("input", { "aria-label": "降幅百分比", inputMode: "numeric", placeholder: "降幅 %", value: form.percentage_threshold,
          onChange: (event) => setForm({ ...form, percentage_threshold: event.target.value }), style: { ...nativeInputStyle, flex: "1 1 100px" } }),
        h("button", { type: "button", disabled: busy, onClick: submit, style: primaryButton }, "创建监控")),
      notice ? h("p", { role: notice.kind === "error" ? "alert" : "status", style: { margin: "0 0 12px",
        color: notice.kind === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)",
        fontSize: 12 } }, notice.text) : null,
      state.status === "error" ? learningState("error", "监控加载失败", state.error,
        h("button", { type: "button", onClick: () => setReload((value) => value + 1), style: secondaryButton }, "重试"))
        : state.status === "loading" ? learningState("loading", "正在读取监控…")
        : h(React.Fragment, null,
          learningSection("我的监控", watches.length ? h("table", { style: { width: "100%", borderCollapse: "collapse" } },
            h("thead", null, h("tr", null, ["航班", "日期", "票种", "基线", "阈值", "最近评估", ""].map((label) =>
              h("th", { key: label, style: depotHead }, label)))),
            h("tbody", null, watches.map((watch) => h("tr", { key: watch.watch_id, "data-native-watch-row": watch.watch_id },
              h("td", { style: depotCell }, watch.flight_no),
              h("td", { style: depotCell }, watch.date),
              h("td", { style: depotCell }, watch.fare_product),
              h("td", { style: depotCell }, `¥${watch.baseline_total}`),
              h("td", { style: depotCell }, [watch.target_total ? `≤¥${watch.target_total}` : null,
                watch.percentage_threshold ? `降${watch.percentage_threshold}%` : null].filter(Boolean).join(" / ")),
              h("td", { style: depotCell }, watch.last_evaluated_at ? new Date(watch.last_evaluated_at).toLocaleString("zh-CN") : "尚未评估"),
              h("td", { style: depotCell }, h("button", { type: "button", disabled: busy,
                onClick: () => evaluate(watch.watch_id), style: { ...secondaryButton, padding: "4px 9px", fontSize: 11 } }, "立即评估"))))))
            : learningState("empty", "还没有监控", "填写航班、日期和目标价即可创建。")),
          learningSection("站内提醒", alerts.length
            ? h("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 } },
              alerts.slice(0, 20).map((alert) => h("li", { key: alert.alert_id,
                "data-native-alert": alert.alert_id, style: { padding: "10px 12px",
                  border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 7,
                  background: "var(--dsw-alias-bg-layer-1)", fontSize: 12 } },
                h("strong", null, alert.message || `${alert.flight_no} 达到目标价`),
                h("div", { style: { marginTop: 3, color: "var(--dsw-alias-label-tertiary)", fontSize: 10 } },
                  new Date(alert.created_at).toLocaleString("zh-CN")))))
            : learningState("empty", "暂无提醒", "评估命中阈值后会在这里显示，同一价格只提醒一次。"))));
  }
  function learningPage(id, title, description, actions, ...content) {
    return h("main", { "data-aeroagent-native-page": id, style: { boxSizing: "border-box", height: "100%",
      overflow: "auto", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit" } },
      h("div", { style: { boxSizing: "border-box", maxWidth: 1180, margin: "0 auto",
        padding: "30px clamp(22px, 4vw, 46px) 48px" } },
        h("header", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20,
          paddingBottom: 22, borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
          h("div", null, h("h1", { style: { margin: "0 0 8px", fontSize: 24, lineHeight: 1.3, fontWeight: 600 } }, title),
            h("p", { style: { margin: 0, maxWidth: "70ch", color: "var(--dsw-alias-label-secondary)",
              fontSize: 13, lineHeight: 1.65 } }, description)),
          actions ? h("div", { style: { display: "flex", gap: 8, flex: "0 0 auto" } }, actions) : null),
        ...content));
  }
  function learningState(kind, title, detail = "", action = null) {
    return h("div", { role: kind === "error" ? "alert" : "status", style: { padding: "24px 0",
      color: kind === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)",
      fontSize: 13, lineHeight: 1.65 } },
      h("strong", { style: { display: "block", marginBottom: detail || action ? 5 : 0,
        color: kind === "error" ? "inherit" : "var(--dsw-alias-label-primary)" } }, title),
      detail ? h("p", { style: { margin: "0 0 10px" } }, detail) : null,
      action);
  }
  function learningSection(title, ...content) {
    return h("section", { style: { boxSizing: "border-box", minWidth: 0, padding: "18px 0" } },
      h("h2", { style: { margin: "0 0 12px", fontSize: 16, fontWeight: 600 } }, title), ...content);
  }
  const nativeJsonStyle = { boxSizing: "border-box", width: "100%", maxHeight: 360, overflow: "auto", margin: 0,
    padding: 12, border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 7,
    background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)",
    font: "11px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
  const nativeInputStyle = { boxSizing: "border-box", minWidth: 0, padding: "7px 9px",
    border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 7, background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: 12 };

  function NativeRulesPage() {
    const { userId } = useNativeUser();
    const [reload, setReload] = React.useState(0);
    const [query, setQuery] = React.useState("");
    const [airline, setAirline] = React.useState("");
    const [scenario, setScenario] = React.useState("");
    const [selectedId, setSelectedId] = React.useState("");
    const [state, setState] = React.useState({ status: "loading", rules: [], debug: null, error: "" });
    React.useEffect(() => {
      let active = true;
      const owner = users.captureOwner();
      const controller = users.trackRequest(new AbortController());
      setState({ status: "loading", rules: [], debug: null, error: "" });
      fetchNativeRules({ query, airline, scenario, userId, signal: controller.signal, fetchImpl }).then((payload) => {
        if (!active || !users.isOwnerCurrent(owner)) return;
        setState({ status: "ready", rules: payload.rules, debug: payload.debug || null, error: "" });
        setSelectedId((current) => payload.rules.some((rule) => rule.id === current) ? current : payload.rules[0]?.id || "");
      }).catch((error) => {
        if (active && users.isOwnerCurrent(owner) && error?.name !== "AbortError") {
          setState({ status: "error", rules: [], debug: null, error: error.message });
        }
      }).finally(() => users.releaseRequest(controller));
      return () => { active = false; controller.abort(); users.releaseRequest(controller); };
    }, [userId, reload]);
    const selected = state.rules.find((rule) => rule.id === selectedId);
    const search = h("form", { onSubmit: (event) => { event.preventDefault(); setReload((value) => value + 1); },
      style: { display: "grid", gridTemplateColumns: "minmax(180px, 1fr) 110px 190px auto", gap: 8, padding: "18px 0 0" } },
      h("input", { type: "search", "aria-label": "搜索规则", placeholder: "规则标题或正文", value: query,
        onChange: (event) => setQuery(event.target.value), style: nativeInputStyle }),
      h("input", { "aria-label": "筛选航司", placeholder: "航司 MU", value: airline, maxLength: 4,
        onChange: (event) => setAirline(event.target.value), style: nativeInputStyle }),
      h("select", { "aria-label": "筛选场景", value: scenario, onChange: (event) => setScenario(event.target.value),
        style: nativeInputStyle }, ["", "VOLUNTARY_CHANGE", "VOLUNTARY_REFUND", "CANCEL", "DELAY", "NO_SHOW", "FARE_DIFF"].map((value) =>
          h("option", { key: value || "all", value }, value || "全部场景"))),
      h("button", { type: "submit", disabled: state.status === "loading", style: primaryButton }, "检索规则"));
    let list;
    if (state.status === "loading") list = learningState("loading", "正在读取规则…");
    else if (state.status === "error") list = learningState("error", "规则加载失败", state.error,
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), style: secondaryButton }, "重试"));
    else if (!state.rules.length) list = learningState("empty", "没有匹配规则", "调整关键词、航司或场景后重新检索。");
    else list = h("div", { role: "list", style: { display: "grid", gap: 6 } }, state.rules.map((rule) =>
      h("button", { key: rule.id, type: "button", "aria-pressed": selectedId === rule.id,
        onClick: () => setSelectedId(rule.id), style: { ...secondaryButton, display: "grid", gap: 4, padding: 11,
          textAlign: "left", borderColor: selectedId === rule.id ? "var(--dsw-alias-border-l3)" : "var(--dsw-alias-border-l1)" } },
        h("span", { style: { display: "flex", justifyContent: "space-between", gap: 12 } },
          h("strong", null, rule.title || rule.id), h("code", null, rule.id)),
        h("small", { style: { color: "var(--dsw-alias-label-secondary)" } },
          `${rule.airline} · ${rule.cabin} · ${rule.fare_product} · ${rule.scenario}`),
        h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } }, `v${rule.version} · ${rule.active ? "启用" : "停用"}`))));
    const detail = selected ? h("article", { "data-native-rule": selected.id },
      h("header", { style: { display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 12 } },
        h("div", null, h("h3", { style: { margin: "0 0 5px", fontSize: 16 } }, selected.title),
          h("code", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, selected.id)),
        h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, `版本 ${selected.version}`)),
      h("dl", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, margin: "0 0 14px",
        color: "var(--dsw-alias-label-secondary)", fontSize: 12 } },
        [["航司", selected.airline], ["舱位", selected.cabin], ["票价产品", selected.fare_product], ["场景", selected.scenario]].map(([label, value]) =>
          h("div", { key: label }, h("dt", { style: { color: "var(--dsw-alias-label-tertiary)" } }, label), h("dd", { style: { margin: "3px 0 0" } }, value)))),
      h("pre", { style: nativeJsonStyle }, selected.content),
      h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } },
        "当前为只读核对视图；规则资格与费用始终由服务端引擎决定。"))
      : learningState("empty", "请选择一条规则", "检索后可查看版本、适用场景与完整正文。");
    const debug = state.debug ? h("details", { style: { padding: "14px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" } },
      h("summary", { style: { cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } },
        `检索调试 · 服务端命中 ${state.debug.result_count ?? state.rules.length} 条`),
      h("pre", { style: { ...nativeJsonStyle, marginTop: 10 } }, JSON.stringify(state.debug, null, 2))) : null;
    return learningPage("rules", "票规检索", "通过现有管理员 API 搜索真实规则并查看版本与检索调试；不会在前端计算票规或费用。",
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), disabled: state.status === "loading",
        style: secondaryButton }, "刷新"), search, debug,
      h("div", { style: { display: "grid", gridTemplateColumns: "minmax(250px, .8fr) minmax(320px, 1.2fr)", gap: 28 } },
        learningSection("规则清单", list), learningSection("规则详情", detail)));
  }

  function NativeDataPage() {
    const { userId } = useNativeUser();
    const [reload, setReload] = React.useState(0);
    const [query, setQuery] = React.useState("");
    const [state, setState] = React.useState({ status: "loading", orders: [], profiles: [], error: "" });
    React.useEffect(() => {
      let active = true;
      const owner = users.captureOwner();
      const controller = users.trackRequest(new AbortController());
      setState({ status: "loading", orders: [], profiles: [], error: "" });
      fetchNativeDemoData({ userId, signal: controller.signal, fetchImpl }).then((payload) => {
        if (active && users.isOwnerCurrent(owner)) {
          setState({ status: "ready", orders: payload.orders, profiles: payload.profiles, error: "" });
        }
      }).catch((error) => {
        if (active && users.isOwnerCurrent(owner) && error?.name !== "AbortError") {
          setState({ status: "error", orders: [], profiles: [], error: error.message });
        }
      }).finally(() => users.releaseRequest(controller));
      return () => { active = false; controller.abort(); users.releaseRequest(controller); };
    }, [userId, reload]);
    let content;
    if (state.status === "loading") content = learningState("loading", "正在读取订单与用户画像…");
    else if (state.status === "error") content = learningState("error", "演示数据加载失败", state.error,
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), style: secondaryButton }, "重试"));
    else {
      const needle = query.trim().toLowerCase();
      const orders = state.orders.filter((order) => [order.order_id, order.passenger, order.flight_no]
        .some((value) => String(value || "").toLowerCase().includes(needle)));
      const cell = { padding: "11px 10px", borderBottom: "1px solid var(--dsw-alias-border-l1)", textAlign: "left",
        fontSize: 12, whiteSpace: "nowrap" };
      const orderContent = !state.orders.length ? learningState("empty", "没有演示订单")
        : !orders.length ? learningState("empty", "没有匹配订单", "尝试订单号、乘客或航班号。")
        : h("div", { style: { overflowX: "auto" } }, h("table", { style: { width: "100%", minWidth: 720,
          borderCollapse: "collapse" } }, h("thead", null, h("tr", null, ["订单 / 乘客", "航班", "日期", "航线", "状态"].map((label) =>
            h("th", { key: label, style: { ...cell, color: "var(--dsw-alias-label-tertiary)", fontWeight: 500 } }, label)))),
          h("tbody", null, orders.map((order) => h("tr", { key: order.order_id },
            h("td", { style: cell }, h("code", null, order.order_id), h("div", { style: { marginTop: 3,
              color: "var(--dsw-alias-label-secondary)" } }, order.passenger)),
            h("td", { style: cell }, order.flight_no), h("td", { style: cell }, order.date),
            h("td", { style: cell }, `${order.flight?.origin_city || order.flight?.origin || "—"} → ${order.flight?.dest_city || order.flight?.dest || "—"}`),
            h("td", { style: cell }, `${order.status} · ${order.flight?.status || "unknown"}`))))));
      const profiles = state.profiles.length ? h("div", { style: { display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 } }, state.profiles.map((profile) =>
        h("article", { key: profile.user_id, "data-native-profile": profile.user_id, style: { padding: 13,
          border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)" } },
          h("header", { style: { display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 10 } },
            h("strong", null, profile.name), h("span", { style: { fontSize: 11,
              color: "var(--dsw-alias-label-secondary)" } }, profile.tier)),
          h("code", { style: { display: "block", marginBottom: 10, fontSize: 11,
            color: "var(--dsw-alias-label-tertiary)" } }, profile.user_id),
          h("pre", { style: { ...nativeJsonStyle, maxHeight: 190 } }, JSON.stringify(profile.data || {}, null, 2)))))
        : learningState("empty", "没有用户画像", "管理员订单接口未返回画像数据。");
      content = h("div", null,
        h("input", { type: "search", "aria-label": "搜索演示订单", placeholder: "订单号 / 乘客 / 航班号", value: query,
          onChange: (event) => setQuery(event.target.value), style: { ...nativeInputStyle, width: "min(100%, 360px)", margin: "18px 0 0" } }),
        learningSection("演示客票", orderContent), learningSection("会员画像", profiles),
        h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: 1.65 } },
          "画像仅用于推荐与检索排序，不改变退改费用。当前页面为只读视图，不会修改航班、画像或种子数据。"));
    }
    return learningPage("data", "订单与用户", "使用现有管理员订单接口查看全部虚构客票和画像，理解排序信号与费用计算的边界。",
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), disabled: state.status === "loading",
        style: secondaryButton }, "刷新"), content);
  }

  function NativeEvaluationPage() {
    const { userId } = useNativeUser();
    const [reload, setReload] = React.useState(0);
    const [query, setQuery] = React.useState("");
    const [mode, setMode] = React.useState("offline");
    const [selectedIds, setSelectedIds] = React.useState([]);
    const [viewedCaseId, setViewedCaseId] = React.useState("");
    const [starting, setStarting] = React.useState(false);
    const [notice, setNotice] = React.useState(null);
    const [pollRetry, setPollRetry] = React.useState(0);
    const [state, setState] = React.useState({ status: "loading", cases: [], runs: [], version: "", caseError: "", historyError: "" });
    const [active, setActive] = React.useState({ status: "idle", runId: null, run: null, error: "" });
    const viewGeneration = React.useRef(0);
    React.useEffect(() => {
      let activeRequest = true;
      const owner = users.captureOwner();
      const controller = users.trackRequest(new AbortController());
      setState({ status: "loading", cases: [], runs: [], version: "", caseError: "", historyError: "" });
      Promise.allSettled([
        fetchNativeEvaluation({ view: "cases", userId, signal: controller.signal, fetchImpl }),
        fetchNativeEvaluation({ view: "runs", userId, signal: controller.signal, fetchImpl }),
      ]).then(([caseResult, historyResult]) => {
        if (!activeRequest || !users.isOwnerCurrent(owner)) return;
        setState({
          status: "ready",
          cases: caseResult.status === "fulfilled" ? caseResult.value.cases : [],
          runs: historyResult.status === "fulfilled" ? historyResult.value.runs : [],
          version: caseResult.status === "fulfilled" ? caseResult.value.version || "seed" : "",
          caseError: caseResult.status === "rejected" ? caseResult.reason.message : "",
          historyError: historyResult.status === "rejected" ? historyResult.reason.message : "",
        });
      }).finally(() => users.releaseRequest(controller));
      return () => { activeRequest = false; controller.abort(); users.releaseRequest(controller); };
    }, [userId, reload]);
    React.useEffect(() => {
      viewGeneration.current += 1;
      setSelectedIds([]); setViewedCaseId(""); setStarting(false); setNotice(null);
      setActive({ status: "idle", runId: null, run: null, error: "" });
    }, [userId]);
    async function openRun(runId) {
      const ownView = ++viewGeneration.current;
      const owner = users.captureOwner();
      const controller = users.trackRequest(new AbortController());
      setNotice(null); setActive({ status: "loading", runId, run: null, error: "" });
      try {
        const run = await fetchNativeEvaluation({ view: "run", runId, userId, signal: controller.signal, fetchImpl });
        if (ownView === viewGeneration.current && users.isOwnerCurrent(owner)) {
          setActive({ status: "ready", runId, run, error: "" });
        }
      } catch (error) {
        if (ownView === viewGeneration.current && users.isOwnerCurrent(owner) && error?.name !== "AbortError") {
          setActive({ status: "error", runId, run: null, error: error.message });
        }
      } finally { users.releaseRequest(controller); }
    }
    React.useEffect(() => {
      const run = active.run;
      if (active.status !== "ready" || !run || isNativeEvaluationTerminal(run.status)) return;
      let current = true;
      const owner = users.captureOwner();
      const controller = users.trackRequest(new AbortController());
      const timer = setTimeout(async () => {
        try {
          const next = await fetchNativeEvaluation({ view: "run", runId: run.run_id, userId,
            signal: controller.signal, fetchImpl });
          if (!current || !users.isOwnerCurrent(owner)) return;
          setActive({ status: "ready", runId: run.run_id, run: next, error: "" });
          setState((previous) => ({ ...previous, runs: [next, ...previous.runs.filter((item) => item.run_id !== next.run_id)] }));
        } catch (error) {
          if (current && users.isOwnerCurrent(owner) && error?.name !== "AbortError") {
            setActive((previous) => ({ ...previous, error: error.message }));
          }
        } finally { users.releaseRequest(controller); }
      }, 900);
      return () => { current = false; clearTimeout(timer); controller.abort(); users.releaseRequest(controller); };
    }, [userId, active.status, active.run?.run_id, active.run?.status, pollRetry]);
    async function startRun() {
      const running = active.run && !isNativeEvaluationTerminal(active.run.status);
      if (starting || running || !state.cases.length) return;
      const owner = users.captureOwner();
      const controller = users.trackRequest(new AbortController());
      setStarting(true); setNotice(null);
      try {
        const started = await startNativeEvaluation({ mode, caseIds: selectedIds.length ? selectedIds : null,
          userId, signal: controller.signal, fetchImpl });
        if (!users.isOwnerCurrent(owner)) return;
        const run = { ...started, mode, progress: { completed: 0, total: selectedIds.length || state.cases.length }, report: {} };
        setActive({ status: "ready", runId: run.run_id, run, error: "" });
        setState((previous) => ({ ...previous, runs: [run, ...previous.runs.filter((item) => item.run_id !== run.run_id)] }));
        setNotice({ kind: "info", text: `评测已排队：${run.run_id}；等待服务端执行，尚未完成。` });
      } catch (error) {
        if (users.isOwnerCurrent(owner) && error?.name !== "AbortError") setNotice({ kind: "error", text: error.message });
      } finally {
        users.releaseRequest(controller);
        if (users.isOwnerCurrent(owner)) setStarting(false);
      }
    }
    const filteredCases = filterNativeEvaluationCases(state.cases, query);
    const viewedCase = state.cases.find((item) => item.id === viewedCaseId);
    let caseContent;
    if (state.status === "loading") caseContent = learningState("loading", "正在读取评测用例…");
    else if (state.caseError) caseContent = learningState("error", "评测用例加载失败", state.caseError);
    else if (!state.cases.length) caseContent = learningState("empty", "评测集为空", "当前服务端版本没有可运行用例。");
    else if (!filteredCases.length) caseContent = learningState("empty", "没有匹配用例", "按 ID、标题或问题搜索。");
    else caseContent = h("div", { style: { display: "grid", gap: 7 } }, filteredCases.map((item) => {
      const checked = selectedIds.includes(item.id);
      return h("div", { key: item.id, style: { display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 9,
        alignItems: "start", padding: 10, border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 7 } },
        h("input", { type: "checkbox", checked, "aria-label": `选择评测用例 ${item.id}`, onChange: () => {
          setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]);
        } }),
        h("div", null, h("code", { style: { fontSize: 11 } }, item.id),
          h("div", { style: { margin: "3px 0", fontSize: 13, fontWeight: 600 } }, item.title || item.question),
          h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, item.question)),
        h("button", { type: "button", onClick: () => setViewedCaseId(item.id), style: secondaryButton }, "查看"));
    }));
    let runContent;
    if (active.status === "idle") runContent = learningState("empty", "尚未选择运行", "从运行历史查看报告，或运行当前服务端用例。");
    else if (active.status === "loading") runContent = learningState("loading", "正在读取运行详情…");
    else if (active.status === "error") runContent = learningState("error", "运行详情加载失败", active.error,
      h("button", { type: "button", onClick: () => openRun(active.runId), style: secondaryButton }, "重试"));
    else {
      const run = active.run;
      const summary = run.report?.summary || {};
      const results = Array.isArray(run.report?.results) ? run.report.results : [];
      runContent = h("article", { "data-native-evaluation-run": run.run_id },
        h("header", { style: { display: "flex", justifyContent: "space-between", gap: 14, marginBottom: 12 } },
          h("code", null, run.run_id), h("strong", null, `${run.status} · ${run.progress?.completed ?? 0}/${run.progress?.total ?? 0}`)),
        Object.keys(summary).length ? h("dl", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 8 } }, Object.entries(summary).filter(([, value]) => typeof value === "number").map(([key, value]) =>
            h("div", { key: key, style: { padding: 9, background: "var(--dsw-alias-bg-layer-1)", borderRadius: 6 } },
              h("dt", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 10 } }, key),
              h("dd", { style: { margin: "4px 0 0", fontWeight: 600 } }, value)))) :
          h("p", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, "本次运行尚未返回汇总指标。"),
        results.length ? h("div", { style: { marginTop: 12 } }, results.map((item) => h("details", { key: item.case_id,
          style: { padding: "8px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" } },
          h("summary", { style: { cursor: "pointer", fontSize: 12 } }, `${item.case_id} · ${item.passed ? "通过" : "失败"}`),
          h("pre", { style: { ...nativeJsonStyle, marginTop: 8 } }, JSON.stringify(item, null, 2))))) : null,
        active.error ? learningState("error", "轮询暂时失败", active.error,
          h("button", { type: "button", onClick: () => setPollRetry((value) => value + 1), style: secondaryButton }, "重试轮询")) : null);
    }
    let history;
    if (state.status === "loading") history = learningState("loading", "正在读取运行历史…");
    else if (state.historyError) history = learningState("error", "运行历史加载失败", state.historyError);
    else if (!state.runs.length) history = learningState("empty", "还没有运行记录");
    else history = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 7 } }, state.runs.map((run) =>
      h("button", { key: run.run_id, type: "button", onClick: () => openRun(run.run_id),
        style: active.runId === run.run_id ? primaryButton : secondaryButton },
        `${run.run_id} · ${run.mode || mode} · ${run.status}`)));
    const running = active.run && !isNativeEvaluationTerminal(active.run.status);
    return learningPage("evaluation", "评测中心", "搜索并查看当前服务端用例，提交真实 offline / DeepSeek 评测，再轮询进度与历史报告。",
      h("button", { type: "button", onClick: () => setReload((value) => value + 1), disabled: state.status === "loading",
        style: secondaryButton }, "刷新"),
      notice ? h("div", { role: notice.kind === "error" ? "alert" : "status", style: { padding: "12px 0",
        color: notice.kind === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)",
        fontSize: 12 } }, notice.text) : null,
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, padding: "18px 0 0" } },
        h("input", { type: "search", "aria-label": "搜索评测用例", placeholder: "ID / 标题 / 问题", value: query,
          onChange: (event) => setQuery(event.target.value), style: { ...nativeInputStyle, flex: "1 1 220px" } }),
        h("select", { "aria-label": "评测模式", value: mode, onChange: (event) => setMode(event.target.value), style: nativeInputStyle },
          h("option", { value: "offline" }, "规则离线模式"), h("option", { value: "deepseek" }, "DeepSeek 模式")),
        h("button", { type: "button", disabled: starting || running || state.status !== "ready" || !state.cases.length || Boolean(state.caseError),
          onClick: startRun, style: primaryButton }, starting ? "正在提交…" : running ? "评测运行中" : selectedIds.length ? `运行已选 ${selectedIds.length} 条` : "运行全部用例"),
        h("span", { style: { alignSelf: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } },
          state.version ? `版本 ${state.version} · ${state.cases.length} 条` : "版本读取中")),
      h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } },
        "运行使用服务端已保存用例，不会静默保存或覆盖草稿。DeepSeek 配置失败会明确显示，不会回退为 Mock。"),
      h("div", { style: { display: "grid", gridTemplateColumns: "minmax(300px, 1fr) minmax(280px, .8fr)", gap: 28 } },
        learningSection("评测用例", caseContent), learningSection("用例详情", viewedCase ?
          h("pre", { style: nativeJsonStyle }, JSON.stringify(viewedCase, null, 2)) : learningState("empty", "请选择用例"))),
      learningSection("运行历史", history), learningSection("运行结果", runContent));
  }


  // ---------------- 工具卡：DSH 原生会话里的业务结果 ----------------
  const toolCard = { boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10,
    background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", padding: "12px 14px",
    font: "inherit", fontSize: 13, lineHeight: 1.55 };
  const toolMuted = { color: "var(--dsw-alias-label-secondary)", fontSize: 11, lineHeight: 1.6 };
  const toolFaint = { color: "var(--dsw-alias-label-tertiary)", fontSize: 10, lineHeight: 1.5 };
  const toolPrimary = { padding: "6px 12px", border: 0, borderRadius: 7, cursor: "pointer",
    background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)",
    font: "inherit", fontSize: 12 };
  const toolSecondary = { padding: "5px 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 7,
    cursor: "pointer", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)",
    font: "inherit", fontSize: 12 };
  function toolMeta(block) {
    return block && typeof block === "object" && block.meta && typeof block.meta === "object" ? block.meta : null;
  }
  function toolShell(title, subtitle, children) {
    return h("section", { style: toolCard, "aria-label": title },
      h("header", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
        marginBottom: 8 } },
        h("strong", { style: { fontSize: 13, fontWeight: 600 } }, title),
        subtitle ? h("span", { style: toolFaint }, subtitle) : null),
      ...children);
  }
  function toolEmpty(text) {
    return h("p", { style: { ...toolMuted, margin: 0 } }, text);
  }
  function NativeOrdersToolView({ block, phase }) {
    const value = toolMeta(block);
    if (phase !== "result" || !value) return toolShell("订单", "读取中…", [toolEmpty("正在读取订单…")]);
    if (Array.isArray(value.orders)) {
      return toolShell("订单", `${value.orders.length} 张`, value.orders.length ? value.orders.slice(0, 8).map((order) =>
        h("div", { key: order.order_id, style: { display: "flex", justifyContent: "space-between", gap: 12,
          padding: "6px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" } },
          h("span", null, h("strong", null, order.flight_no || "—"), ` ${order.date || ""}`,
            h("span", { style: toolMuted }, ` · ${order.order_id}`)),
          h("span", { style: toolMuted }, `${order.status}${order.eligibility?.change?.allowed ? " · 可改签" : ""}`))) :
        [toolEmpty("暂无订单")]);
    }
    const eligibility = value.eligibility || {};
    return toolShell(`订单 ${value.order_id}`, value.status, [
      h("p", { style: { margin: "0 0 6px" } }, `${value.flight_no || "—"} ${value.date || ""} · ${value.passenger || ""}`),
      h("p", { style: toolMuted }, `改签：${eligibility.change?.allowed ? "可办理" : "不可办理"}；退票：${eligibility.refund?.allowed ? "可办理" : "不可办理"}`),
    ]);
  }
  function NativeFlightsToolView({ block, phase }) {
    const value = toolMeta(block);
    if (phase !== "result" || !value) return toolShell("航班", "查询中…", [toolEmpty("正在查询航班…")]);
    const flights = Array.isArray(value.flights) ? value.flights : [];
    return toolShell("航班", `${flights.length} 个`, flights.length ? flights.slice(0, 8).map((flight) =>
      h("div", { key: `${flight.flight_no}-${flight.date}`, style: { padding: "6px 0",
        borderTop: "1px solid var(--dsw-alias-border-l1)" } },
        h("strong", null, flight.flight_no), ` ${flight.origin_city || flight.origin} → ${flight.dest_city || flight.dest}`,
        h("span", { style: toolMuted }, ` · ${flight.date} ${flight.dep_time} · ${flight.status}`))) :
      [toolEmpty("没有匹配航班")]);
  }
  function NativeServicingToolView({ block, phase }) {
    const { userId } = useNativeUser();
    const initial = toolMeta(block);
    const [record, setRecord] = React.useState(initial);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState("");
    React.useEffect(() => { setRecord(initial); }, [block]);
    if (phase !== "result" || !record) {
      return toolShell("退改办理", "处理中…", [toolEmpty("正在生成方案，请稍候…")]);
    }
    const options = record.quotes || [];
    const interrupt = record.result?.interrupt || {};
    async function refresh() {
      if (!record.case_id) return;
      const next = await fetchNativeCase({ caseId: record.case_id, userId });
      setRecord(next);
    }
    async function confirm(quote) {
      setBusy(true); setNotice("");
      try {
        const keys = requestKeys(quote.quote_id);
        await fetchNativeV1({ path: `/quotes/${encodeURIComponent(quote.quote_id)}/confirm`, method: "POST",
          userId, body: { confirmation_id: keys.confirmationId, idempotency_key: keys.idempotencyKey } });
        setNotice("已受理，正在办理…");
        for (let i = 0; i < 20; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          const next = await fetchNativeCase({ caseId: record.case_id, userId });
          setRecord(next);
          if (["COMPLETED", "CANCELLED", "HUMAN_REVIEW", "RESULT_UNKNOWN"].includes(next.status)) break;
        }
      } catch (error) {
        setNotice(error.code === "REQUOTE_REQUIRED" ? "价格发生变化，已生成新报价，请重新确认。" : error.message);
        await refresh().catch(() => {});
      } finally { setBusy(false); }
    }
    async function cancel() {
      setBusy(true); setNotice("");
      try {
        await fetchNativeV1({ path: `/cases/${encodeURIComponent(record.case_id)}/cancel`, method: "POST", userId });
        await refresh();
        setNotice("已取消本次办理。");
      } catch (error) { setNotice(error.message); } finally { setBusy(false); }
    }
    async function reconcile() {
      const operationId = record.result?.operation?.operation_id;
      if (!operationId) { setNotice("缺少办理单号，请到执行观测核对。"); return; }
      setBusy(true); setNotice("正在向航司核对结果…");
      try {
        await fetchNativeV1({ path: `/operations/${encodeURIComponent(operationId)}/reconcile`, method: "POST", userId });
        await refresh();
        setNotice("已发起对账，请查看最新状态。");
      } catch (error) { setNotice(error.message); } finally { setBusy(false); }
    }
    function copy(value) {
      const text = String(value || "");
      if (globalThis.navigator?.clipboard?.writeText) void globalThis.navigator.clipboard.writeText(text);
      setNotice(`已复制「${text}」，请在输入框粘贴发送。`);
    }
    const statusText = { WAITING_CONFIRMATION: "等待确认", PROCESSING: "办理中", COMPLETED: "已办结",
      NEEDS_INFORMATION: "需要补充信息", HUMAN_REVIEW: "转人工", RESULT_UNKNOWN: "结果待核对",
      CANCELLED: "已取消" }[record.status] || record.status;
    const children = [];
    children.push(h("p", { style: { ...toolMuted, margin: "0 0 8px" } },
      `案件 ${record.case_id || "—"} · ${statusText}`));
    if (notice) children.push(h("p", { role: "status", style: { margin: "0 0 8px",
      color: "var(--dsw-alias-state-info-primary)", fontSize: 12 } }, notice));
    if (record.status === "COMPLETED" && record.result?.operation) {
      const op = record.result.operation;
      children.push(h("div", { style: { padding: "8px 10px", borderRadius: 7,
        background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l1)" } },
        h("strong", null, op.status === "CHANGED" ? "改签完成" : op.status === "REFUNDED" ? "退票完成" : "办理完成"),
        h("p", { style: { ...toolMuted, margin: "4px 0 0" } },
          op.ticket_no ? `新票号 ${op.ticket_no}` : "", op.customer_amount != null ? ` · 金额 ¥${op.customer_amount}` : "")));
    }
    if (interrupt.kind === "clarify") {
      children.push(h("p", { style: { margin: "0 0 6px", fontWeight: 600 } }, interrupt.question || "请补充信息"));
      children.push(h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        (interrupt.options || []).map((option) => h("button", { key: option.value, type: "button",
          onClick: () => copy(option.value), style: toolSecondary }, option.label || option.value))));
    }
    if (options.length) {
      children.push(h("div", { style: { display: "grid", gap: 8 } }, options.map((quote) => {
        const detail = quote.details?.[0] || {};
        const feeItems = detail.fee_items || [];
        const actionable = record.status === "WAITING_CONFIRMATION" && quote.status === "OFFERED";
        return h("article", { key: quote.quote_id, style: { padding: "10px 12px", borderRadius: 8,
          border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)" } },
          h("div", { style: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" } },
            h("strong", null, detail.title || (quote.action === "REFUND" ? "退票方案" : "改签方案")),
            h("strong", { style: { fontSize: 15 } }, `¥${quote.amount ?? "—"}`)),
          feeItems.length ? h("dl", { style: { margin: "8px 0 0", display: "grid", gap: 2 } },
            feeItems.map((item) => h("div", { key: item.name, style: { display: "flex",
              justifyContent: "space-between", ...toolMuted } },
              h("dt", null, item.name), h("dd", { style: { margin: 0 } }, `¥${item.amount ?? 0}`)))) : null,
          detail.rule_refs?.length ? h("p", { style: { ...toolFaint, margin: "6px 0 0" } },
            `依据：${detail.rule_refs.join("、")}`) : null,
          actionable ? h("div", { style: { display: "flex", gap: 8, marginTop: 10 } },
            h("button", { type: "button", disabled: busy, onClick: () => void confirm(quote), style: toolPrimary },
              busy ? "办理中…" : "确认办理"),
            h("button", { type: "button", disabled: busy, onClick: () => void cancel(), style: toolSecondary },
              "暂不办理")) : null);
      })));
    }
    if (!options.length && record.status === "NEEDS_INFORMATION") {
      children.push(h("p", { style: toolMuted }, "请补充信息后继续。"));
    }
    if (record.status === "RESULT_UNKNOWN") {
      children.push(h("div", { style: { display: "grid", gap: 6, marginTop: 8 } },
        h("p", { style: { ...toolMuted, margin: 0 } }, "航司结果待核对，不会自动重试。"),
        h("button", { type: "button", disabled: busy, onClick: () => void reconcile(), style: toolPrimary },
          busy ? "核对中…" : "核对结果")));
    }
    return toolShell("退改办理", statusText, children);
  }
  function NativeBookingToolView({ block, phase }) {
    const value = toolMeta(block);
    if (phase !== "result" || !value) return toolShell("预订", "处理中…", [toolEmpty("正在创建预订…")]);
    return toolShell("预订", value.status || "", [
      h("p", { style: { margin: 0 } }, `${value.flight_no || ""} ${value.date || ""} · ${value.passenger || ""}`),
      h("p", { style: toolMuted }, `订单 ${value.order_id || "—"} · ¥${value.total ?? "—"}`),
      value.status === "PENDING_PAYMENT" ? h("p", { style: { ...toolMuted, margin: "6px 0 0" } },
        "请在「航班预订」页完成支付；Agent 不会代付。") : null,
    ]);
  }
  function NativeWatchToolView({ block, phase }) {
    const value = toolMeta(block);
    if (phase !== "result" || !value) return toolShell("低价监控", "处理中…", [toolEmpty("正在读取监控…")]);
    const watches = value.watches || (value.watch_id ? [value] : []);
    return toolShell("低价监控", `${watches.length} 条`, watches.length ? watches.slice(0, 8).map((watch) =>
      h("div", { key: watch.watch_id || watch.id, style: { padding: "6px 0",
        borderTop: "1px solid var(--dsw-alias-border-l1)", ...toolMuted } },
        `${watch.watch_id || watch.id} · 目标 ¥${watch.target_total ?? "—"} · ${watch.status || ""}`)) :
      [toolEmpty("暂无监控")]);
  }
  function NativeKnowledgeToolView({ block, phase }) {
    const value = toolMeta(block);
    if (phase !== "result" || !value) return toolShell("规则与评测", "读取中…", [toolEmpty("正在读取…")]);
    if (Array.isArray(value.rules)) {
      return toolShell("政策规则", `${value.rules.length} 条`, value.rules.slice(0, 8).map((rule) =>
        h("div", { key: rule.id, style: { padding: "6px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" } },
          h("strong", null, rule.id), h("span", { style: toolMuted }, ` · ${rule.title || ""}`))));
    }
    const runs = value.runs || [];
    return toolShell("评测", `${runs.length} 次`, runs.slice(0, 8).map((run) =>
      h("div", { key: run.run_id, style: { padding: "6px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" } },
        `${run.run_id} · ${run.status} · ${run.mode}`)));
  }
  for (const [key, component] of Object.entries({
    aeroagent_orders: NativeOrdersToolView,
    aeroagent_flights: NativeFlightsToolView,
    aeroagent_servicing: NativeServicingToolView,
    aeroagent_booking: NativeBookingToolView,
    aeroagent_watch: NativeWatchToolView,
    aeroagent_knowledge: NativeKnowledgeToolView,
  })) {
    ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
      name: "tool.call.toolview", key,
    }, component));
  }

  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action", id: "aeroagent-footer", order: -20,
  }, NativeFooterNavigation));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock", id: "aeroagent-order-context-bar", order: 10,
  }, NativeOrderContextBar));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock", id: "aeroagent-quote-dock", order: 20,
  }, NativeQuoteDock));

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
      page.id === "orders" ? NativeOrdersPage
        : page.id === "listing" ? NativeListingPage
        : page.id === "monitor" ? NativeMonitorPage
        : page.id === "more" ? NativeExtrasPage
        : page.id === "chat" ? NativeChatRedirect : NativePage));
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
      name: "sidebar.panellist", id: panelId, order: page.order, label: () => page.label,
    }, ({ size = 20 }) => h(NativeIcon, { name: page.icon, size })));
  }

  for (const [id, component] of [["evaluation", NativeEvaluationPage], ["rules", NativeRulesPage], ["data", NativeDataPage]]) {
    ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: `aeroagent-${id}` }, component));
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
  }, NativeExecutionInspector));
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
    name: "conversation.session.header.utilities", id: "aeroagent-execution-inspector", order: 20,
  }, NativeExecutionInspectorButton));
  if (typeof window !== "undefined") window.__AERO_CLIENT_LOADED = true;
  return { users, selection, conversations, watches };
}

const inject = ["slots", "layout", "sidebarRight", "sidebarRightTabs"];

globalThis.AeroAgentClient = Object.assign(globalThis.AeroAgentClient || {},
  { parseAeroAgentQuote, parseAeroAgentCase, orderView, requestKeys, caseView, shouldStopFollowing,
    quoteStateAfter, followAction, traceEventKey, verificationView, quoteCardState, nativeSlotsApply,
    fetchNativeOrders, createNativeOrderSelection, fetchNativeCase, fetchNativeLatestCase, nativeExecutionTabs, nativeRetrievalResults,
    nativeFeeComparisons, nativeVerificationState, parseNativeCompletion, fetchNativeChat, createNativeConversationStore,
    nativeOrderBindingStatus, openNativeAeroConversation, NATIVE_DEMO_USERS, createNativeUserStore, createNativeWatchStore, scrollNativeChatToLatest,
    fetchNativeAdmin, fetchNativeRules, fetchNativeEvaluation, startNativeEvaluation, fetchNativeDemoData,
    filterNativeEvaluationCases, isNativeEvaluationTerminal,
    nativeActionableQuotes, nativeCasePhase, nativeOperationSummary, fetchNativeFlights, createNativeBooking,
    payNativeBooking, fetchNativeWatches, createNativeWatch, evaluateNativeWatch, fetchNativeAlerts });
if (typeof window !== "undefined" && window.__ModuleLoader__ && !globalThis.__AERO_DSH_MODULE_REGISTERED
    && globalThis.__AEROAGENT_ENABLED__ !== false) {
  window.__ModuleLoader__.load({ id: "dsh-plugin-aeroagent", factory: (require) => ({
    inject,
    apply(ctx) { nativeSlotsApply(ctx, require("react")); },
  }) });
  globalThis.__AERO_DSH_MODULE_REGISTERED = true;
}
})();
