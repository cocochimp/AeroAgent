// AeroAgent DSH 客户端插件：零裸依赖的浏览器 ESM，以 DOM 注入方式把退改签业务面板嵌入宿主。
const BACKEND = window.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000";
const TOKEN = "demo:u_zhang";
const ADMIN_TOKEN = "demo-admin:u_zhang";

const css = `
.aero-dock{display:flex;gap:8px;overflow-x:auto;padding:8px 2px}
.aero-card{flex:0 0 176px;border:1px solid #2a3242;border-radius:10px;padding:8px 10px;background:#151a24;cursor:pointer;color:#e8ecf3}
.aero-card.on{border-color:#6c5ce7;box-shadow:0 0 0 1px #6c5ce7}
.aero-card .fno{font-weight:700;font-family:ui-monospace,Menlo,monospace}
.aero-chip{font-size:11px;padding:1px 8px;border-radius:6px;border:1px solid}
.aero-chip.cancel{color:#ef4444;border-color:#5a2020}.aero-chip.delay{color:#f59e0b;border-color:#5b4a1f}.aero-chip.ok{color:#22c55e;border-color:#1d4a2c}
.aero-quote{border:1px solid #2a3242;border-radius:12px;background:#151a24;padding:12px 14px;margin:8px 0;color:#e8ecf3;max-width:560px}
.aero-quote .row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed #2a3242;font-size:13px}
.aero-quote .total{font-size:22px;font-weight:800;font-family:ui-monospace,Menlo,monospace}
.aero-quote button{border:none;border-radius:8px;padding:7px 14px;margin-right:8px;cursor:pointer;font:inherit}
.aero-confirm{background:#6c5ce7;color:#fff}.aero-cancel{background:transparent;color:#8b94a7;border:1px solid #2a3242 !important}
.aero-panel{position:fixed;top:56px;right:0;width:380px;bottom:0;background:#151a24;border-left:1px solid #2a3242;z-index:60;overflow-y:auto;padding:12px;color:#e8ecf3;display:none}
.aero-panel.on{display:block}
.aero-panel h4{font-size:12px;color:#8b94a7;margin:10px 0 6px}
.aero-panel table{width:100%;border-collapse:collapse;font-size:12px}
.aero-panel td,.aero-panel th{padding:4px 6px;border-bottom:1px solid #2a3242;text-align:left}
.aero-fab{position:fixed;right:14px;bottom:96px;z-index:61;background:#6c5ce7;color:#fff;border:none;border-radius:999px;padding:8px 14px;cursor:pointer;font:inherit}
.aero-note{font-size:12px;color:#8b94a7;padding:2px}
`;

async function api(path, token = TOKEN, options = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child?.nodeType ? child : document.createTextNode(String(child ?? "")));
  return node;
}

let selectedOrder = null;

function setComposerPrefix(orderId) {
  const ta = document.querySelector("textarea");
  if (!ta) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, `@${orderId} `);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

async function buildDock() {
  const dock = el("div", { class: "aero-dock" });
  const wrap = el("div", {}, el("div", { class: "aero-note" }, "AeroAgent 订单上下文（点选后自动填入 @订单号）"), dock);
  try {
    const data = await api("/api/v1/orders");
    for (const o of (data.orders || []).slice(0, 8)) {
      const kind = o.flight_status === "cancelled" ? "cancel" : o.flight_status === "delayed" ? "delay" : "ok";
      const card = el("div", {
        class: "aero-card",
        onclick: () => {
          selectedOrder = o.order_id;
          dock.querySelectorAll(".aero-card").forEach((n) => n.classList.remove("on"));
          card.classList.add("on");
          setComposerPrefix(o.order_id);
        },
      },
        el("div", { style: "display:flex;justify-content:space-between" },
          el("span", { class: "fno" }, o.flight_no),
          el("span", { class: `aero-chip ${kind}` }, o.flight_status_label || o.flight_status || "")),
        el("div", { style: "font-size:13px;margin:2px 0" }, `${o.origin} → ${o.dest}`),
        el("div", { class: "aero-note" }, `${o.order_id} · ${o.status_label || o.status}`));
      dock.append(card);
    }
  } catch (e) {
    dock.append(el("div", { class: "aero-note" }, `订单加载失败：${e.message}`));
  }
  return wrap;
}

function quoteCard(payload, host) {
  const card = el("div", { class: "aero-quote" },
    el("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:6px" },
      el("b", null, payload.action === "REFUND" ? "退票方案" : "改签方案"),
      el("span", { class: "aero-chip ok" }, "可办理")),
    ...(payload.fee_items || []).map((f) => el("div", { class: "row" }, el("span", null, f.name), el("span", null, `¥${f.amount}`))),
    el("div", { class: "row", style: "border:none" }, el("span", null, "预计金额"), el("span", { class: "total" }, `¥${payload.amount}`)),
    el("div", { class: "aero-note" }, `依据 ${(payload.rule_refs || []).join(", ") || "运价引擎"} · 案件 ${payload.case_id || ""}`));
  const confirm = el("button", {
    class: "aero-confirm",
    onclick: async () => {
      confirm.disabled = true;
      confirm.textContent = "办理中…";
      try {
        const key = `dsh-${Date.now()}`;
        const res = await api(`/api/v1/quotes/${payload.quote_id}/confirm`, TOKEN, {
          method: "POST",
          body: JSON.stringify({ confirmation_id: key, idempotency_key: key }),
        });
        card.append(el("div", { class: "aero-note" }, `已受理：operation ${res.operation_id || res.status}`));
        refreshPanel(payload.case_id);
      } catch (e) {
        confirm.disabled = false;
        confirm.textContent = "确认办理";
        card.append(el("div", { class: "aero-note" }, `确认失败：${e.message}`));
      }
    },
  }, "确认办理");
  card.append(el("div", { style: "margin-top:8px" }, confirm,
    el("button", { class: "aero-cancel", onclick: () => card.remove() }, "暂不办理")));
  host.replaceWith(card);
}

function upgradeQuoteFences(root) {
  for (const code of root.querySelectorAll("code, pre")) {
    const text = code.textContent || "";
    const match = text.match(/```aeroagent-quote\s*([\s\S]*?)```/) || (text.trim().startsWith("{") && text.includes("quote_id") ? [null, text] : null);
    if (!match || code.__aeroDone) continue;
    code.__aeroDone = true;
    try {
      quoteCard(JSON.parse(match[1]), code.closest("pre") || code);
    } catch { /* 非报价块忽略 */ }
  }
}

const panel = el("div", { class: "aero-panel" });
async function refreshPanel(caseId) {
  panel.replaceChildren(el("h4", null, "AeroAgent 业务面板"));
  if (!caseId) { panel.append(el("div", { class: "aero-note" }, "先在对话中发起一次退改诉求，面板会展示该案件的流程/检索/记忆/校验。")); return; }
  try {
    const c = await api(`/api/v1/cases/${caseId}`);
    panel.append(el("h4", null, `案件 ${c.status}`),
      el("table", null, el("tr", null, el("th", null, "报价"), el("th", null, "动作"), el("th", null, "金额"), el("th", null, "状态")),
        ...(c.quotes || []).map((q) => el("tr", null, el("td", null, q.quote_id.slice(0, 10)), el("td", null, q.action), el("td", null, `¥${q.amount}`), el("td", null, q.status)))));
    const events = await api(`/api/v1/cases/${caseId}/events?after=0-0`).catch(() => null);
    panel.append(el("h4", null, "流程轨迹"), el("div", { class: "aero-note" }, events ? "事件流见对话轨迹；此处展示案件快照。" : "暂无事件"));
  } catch (e) {
    panel.append(el("div", { class: "aero-note" }, `面板加载失败：${e.message}`));
  }
}

let lastCaseId = null;
function mount() {
  if (document.getElementById("aero-style")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "aero-style", textContent: css }));
  const fab = el("button", { class: "aero-fab", onclick: () => { panel.classList.toggle("on"); refreshPanel(lastCaseId); } }, "AeroAgent 面板");
  document.body.append(panel, fab);
  refreshPanel(null);

  const tryDock = async () => {
    const ta = document.querySelector("textarea");
    if (!ta || document.getElementById("aero-dock")) return;
    const dock = await buildDock();
    dock.id = "aero-dock";
    ta.closest("div")?.parentElement?.insertBefore(dock, ta.closest("div").parentElement.firstChild || ta.closest("div"));
  };
  tryDock();

  new MutationObserver(() => {
    upgradeQuoteFences(document);
    for (const node of document.querySelectorAll("pre, code")) {
      const m = (node.textContent || "").match(/"case_id":\s*"(case_[a-f0-9]+)"/);
      if (m) lastCaseId = m[1];
    }
    tryDock();
  }).observe(document.body, { childList: true, subtree: true });
  window.__AERO_CLIENT_LOADED = true;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();

export const inject = [];
export function apply() { /* 客户端插件以 DOM 注入方式工作，无需服务端注册 */ }
