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

/** Inject versioned native assets once; repeated combo evaluation is harmless. */
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

const inject = [];
function apply() { bootstrapDshUI(); }

globalThis.AeroAgentClient = Object.assign(globalThis.AeroAgentClient || {},
  { parseAeroAgentQuote, parseAeroAgentCase, orderView, requestKeys, caseView, shouldStopFollowing,
    quoteStateAfter, followAction, traceEventKey, verificationView, quoteCardState, bootstrapDshUI });
if (typeof window !== "undefined" && window.__ModuleLoader__ && !globalThis.__AERO_DSH_MODULE_REGISTERED) {
  window.__ModuleLoader__.load({ id: "dsh-plugin-aeroagent", factory: () => ({ inject, apply }) });
  globalThis.__AERO_DSH_MODULE_REGISTERED = true;
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => bootstrapDshUI(), { once: true });
  else bootstrapDshUI();
}
})();
