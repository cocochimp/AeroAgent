// AeroAgent DSH 客户端：零 import/export，兼容宿主普通脚本组合加载与 ModuleLoader 注册。
(() => {
const BACKEND = globalThis.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000";
const TOKEN = "demo:u_zhang";
const ADMIN_TOKEN = "demo-admin:u_zhang";
const keyCache = new Map();

function parseAeroAgentQuote(text) {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value.quote_id === "string" && typeof value.case_id === "string" &&
      ["CHANGE", "REFUND"].includes(value.action) ? value : null;
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

const css = `
:root{--aero-bg:#0b111c;--aero-panel:#111927;--aero-card:#151f30;--aero-line:#2a3549;--aero-text:#e8edf6;--aero-muted:#8c99ae;--aero-purple:#7e6df2;--aero-green:#42d392;--aero-amber:#f0b45b;--aero-red:#fa7286}
#root{transition:padding-right .18s ease;box-sizing:border-box}.aero-ui,.aero-ui *{box-sizing:border-box}.aero-ui{font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:var(--aero-text)}
.aero-nav{margin:4px 8px 8px;padding:7px 0;border-top:1px solid var(--aero-line)}.aero-nav-label{padding:3px 9px;color:var(--aero-muted);font-size:9px;letter-spacing:1.2px}.aero-nav-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}.aero-nav button{border:0;background:transparent;color:#aab6c8;border-radius:7px;padding:6px 7px;text-align:left;cursor:pointer;font-size:11px}.aero-nav button:hover{background:#7e6df21a;color:#d7ceff}.aero-nav button span{display:inline-block;width:18px;color:#a99aff}
.aero-dock-wrap{margin:0 0 8px}.aero-dock-title{display:flex;align-items:center;color:var(--aero-muted);font-size:10px;margin:0 2px 6px}.aero-dock-title b{color:#c6cfdf;font-weight:500;margin-right:7px}.aero-dock-title span:last-child{margin-left:auto}.aero-dock{display:flex;gap:8px;overflow-x:auto;padding:1px 1px 5px;scrollbar-width:thin;scrollbar-color:#354159 transparent}.aero-card{flex:0 0 148px;border:1px solid var(--aero-line);border-radius:10px;padding:8px 10px;background:var(--aero-card);cursor:pointer;color:var(--aero-text);text-align:left}.aero-card:hover{border-color:#53617b}.aero-card.on{border-color:var(--aero-purple);box-shadow:0 0 0 1px #7e6df244;background:#1c1c35}.aero-card .fno{font-weight:700;font-family:ui-monospace,Menlo,monospace}.aero-card-top{display:flex;align-items:center;justify-content:space-between;gap:5px}.aero-route{margin:4px 0 2px}.aero-chip{font-size:9px;padding:1px 6px;border-radius:6px;border:1px solid;white-space:nowrap}.aero-chip.cancel{color:var(--aero-red);border-color:#64303a;background:#fa728510}.aero-chip.delay{color:var(--aero-amber);border-color:#60502c;background:#f0b45b10}.aero-chip.ok{color:var(--aero-green);border-color:#285b45;background:#42d39210}.aero-note{font-size:10px;color:var(--aero-muted)}.aero-quick{display:flex;gap:6px;margin-top:5px;overflow:auto}.aero-quick button{border:1px solid var(--aero-line);background:#111a28;color:#9eabc0;border-radius:99px;padding:4px 9px;cursor:pointer;font-size:9px;white-space:nowrap}.aero-quick button:hover{border-color:#6e61bb;color:#d5ccff}
.aero-quote{border:1px solid #344159;border-radius:13px;background:linear-gradient(150deg,#162033,#101722);padding:0;margin:9px 0;color:var(--aero-text);max-width:510px;overflow:hidden;box-shadow:0 12px 30px #0003}.aero-quote-head{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--aero-line)}.aero-quote-icon{width:29px;height:29px;border-radius:8px;background:#7e6df21c;color:#b9adff;display:grid;place-items:center}.aero-quote-title small{display:block;color:var(--aero-muted);font-size:9px}.aero-quote-state{margin-left:auto;color:var(--aero-green);border:1px solid #285943;border-radius:99px;padding:3px 7px;font-size:9px}.aero-quote-body{padding:9px 13px}.aero-quote .row{display:flex;justify-content:space-between;padding:4px 0;color:#b8c3d4}.aero-total{border-top:1px dashed #3a465d;margin-top:5px;padding-top:8px;display:flex;justify-content:space-between;align-items:end}.aero-total strong{font-size:24px;font-family:ui-monospace,Menlo,monospace}.aero-rule{color:var(--aero-muted);font-size:9px;margin-top:8px}.aero-rule b{color:#ae9fff}.aero-quote-actions{display:flex;align-items:center;gap:8px;padding:10px 13px;background:#0e1521}.aero-quote button{border:0;border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit}.aero-confirm{background:var(--aero-purple);color:#fff}.aero-confirm:disabled{opacity:.6;cursor:wait}.aero-cancel{background:transparent;color:#a4b0c2;border:1px solid #3a465c!important}.aero-quote-actions small{margin-left:auto;color:#68768d;font-size:8px}.aero-message{padding:8px 12px;font-size:10px}.aero-message.ok{color:var(--aero-green);background:#10251d}.aero-message.error{color:var(--aero-red);background:#2a151c}
.aero-panel{position:fixed;top:0;right:0;width:var(--aero-inspector,340px);bottom:0;background:var(--aero-bg);border-left:1px solid var(--aero-line);z-index:60;overflow:hidden;color:var(--aero-text)}.aero-inspect-head{padding:17px 14px 11px}.aero-eyebrow{font-size:9px;color:#8878d7;letter-spacing:1.4px}.aero-inspect-head h3{margin:3px 0 0;font-size:15px}.aero-case-id{font:9px ui-monospace,Menlo,monospace;color:var(--aero-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis}.aero-case-summary{margin:0 12px 11px;padding:9px 10px;border:1px solid var(--aero-line);border-radius:9px;background:var(--aero-panel);display:grid;grid-template-columns:1fr 1fr;gap:8px}.aero-case-summary small{display:block;color:#728198;font-size:8px}.aero-case-summary span{font-size:10px}.aero-case-state{color:var(--aero-green)!important}.aero-tabs{display:grid;grid-template-columns:repeat(4,1fr);padding:0 10px;border-bottom:1px solid var(--aero-line)}.aero-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:#8492a8;padding:8px 2px;cursor:pointer}.aero-tab.on{color:#c5b9ff;border-bottom-color:var(--aero-purple)}.aero-inspect-body{height:calc(100vh - 181px);overflow:auto;padding:12px;scrollbar-width:thin;scrollbar-color:#354159 transparent}.aero-empty{color:var(--aero-muted);font-size:11px;padding:14px 4px}.aero-mini{border:1px solid var(--aero-line);background:var(--aero-panel);border-radius:9px;padding:10px;margin-bottom:9px}.aero-mini h4{font-size:10px;margin:0 0 7px}.aero-kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0;color:#9eacc0;font-size:10px}.aero-kv span:last-child{color:#d7dfeb;text-align:right;word-break:break-word}.aero-timeline{list-style:none;margin:0;padding:0}.aero-step{position:relative;padding:0 0 13px 22px}.aero-step:before{content:"";position:absolute;left:5px;top:14px;bottom:0;width:1px;background:#2c3850}.aero-step:last-child:before{display:none}.aero-dot{position:absolute;left:0;top:2px;width:12px;height:12px;border:2px solid var(--aero-green);border-radius:50%;color:var(--aero-green);font-size:7px;display:grid;place-items:center}.aero-step.error .aero-dot{border-color:var(--aero-red)}.aero-step b{font-size:10px}.aero-step small{display:block;color:#728198;font-size:8px}.aero-step p,.aero-json{background:#111a28;border:1px solid #233047;border-radius:7px;padding:7px;color:#9facbf;font-size:9px;margin:4px 0 0;white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:230px}.aero-bar{height:6px;border-radius:99px;background:#243047;margin:4px 0 7px;overflow:hidden}.aero-bar i{display:block;height:100%;background:linear-gradient(90deg,#6758d5,#a18fff)}.aero-verify{padding:12px;text-align:center;border:1px solid #285943;border-radius:9px;background:#10251d;color:#77dfab;margin-bottom:9px}.aero-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px}.aero-metrics div{background:var(--aero-panel);border:1px solid var(--aero-line);border-radius:8px;padding:8px}.aero-metrics small{display:block;color:var(--aero-muted);font-size:8px}.aero-metrics b{font-size:13px}
.aero-learning{position:fixed;top:0;bottom:0;right:var(--aero-inspector,340px);z-index:55;background:radial-gradient(circle at 40% 0,#211e3d55,transparent 36%),var(--aero-bg);padding:25px;overflow:auto;display:none}.aero-learning.on{display:block}.aero-learning-head{display:flex;align-items:start;margin-bottom:18px}.aero-learning-head h2{margin:0;font-size:19px}.aero-learning-head p{margin:4px 0 0;color:var(--aero-muted);font-size:11px}.aero-learning-close{margin-left:auto;border:1px solid var(--aero-line);background:var(--aero-panel);color:#b6c1d2;border-radius:8px;padding:6px 10px;cursor:pointer}.aero-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;margin-bottom:14px}.aero-stat{border:1px solid var(--aero-line);background:var(--aero-panel);border-radius:11px;padding:14px}.aero-stat small{color:var(--aero-muted)}.aero-stat b{display:block;font-size:22px;margin-top:4px}.aero-table-wrap{border:1px solid var(--aero-line);background:var(--aero-panel);border-radius:11px;padding:13px;overflow:auto}.aero-table{width:100%;border-collapse:collapse;font-size:10px}.aero-table th,.aero-table td{text-align:left;padding:10px;border-bottom:1px solid var(--aero-line)}.aero-table th{color:var(--aero-muted);font-weight:500}.aero-ok{color:var(--aero-green)}.aero-error-text{color:var(--aero-red)}
@media(max-width:1100px){.aero-card{flex-basis:140px}}
`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "class") node.className = value;
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    node.append(child?.nodeType ? child : document.createTextNode(String(child ?? "")));
  }
  return node;
}

async function api(path, token = TOKEN, options = {}) {
  const response = await fetch(`${BACKEND}${path}`, { ...options,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.detail?.message || `${path} -> ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, body });
  }
  return body;
}

let selectedOrder = null;
let lastCaseId = null;
let activeCase = null;
let activeTab = "flow";
let panel = null;
let dockBuilding = false;
let followController = null;
let learning = null;

function composerInput() {
  return document.querySelector("[data-composer-input='true'], textarea");
}

function setComposerText(text, { prefix = false } = {}) {
  const input = composerInput();
  if (!input) return false;
  if (input.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(input, prefix ? `${text}${input.value}` : text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    input.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    if (prefix) range.collapse(true);
    selection.addRange(range);
    if (!document.execCommand("insertText", false, text)) {
      input.textContent = prefix ? `${text}${input.textContent || ""}` : text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }
  input.focus();
  return true;
}

function selectedPrompt(action) {
  const order = selectedOrder ? `@${selectedOrder} ` : "";
  if (action === "orders") return "查询我的订单";
  if (action === "change") return `${order}帮我改签到后天，差价和手续费分别是多少？`;
  return `${order}航班取消了，帮我办理退票`;
}

function closeModalNavigation() {
  const dialog = document.querySelector("nav.hHd-Xa_panelList")?.closest("[role='dialog']");
  if (dialog) dialog.querySelector("button[aria-label='收起侧边栏']")?.click();
}

function navButton(action, icon, label) {
  return el("button", { type: "button", "data-aero-action": action,
    onclick: () => {
      if (action === "conversation") {
        learning?.classList.remove("on");
        composerInput()?.focus();
      } else if (["evaluation", "rules", "data"].includes(action)) showLearning(action);
      else setComposerText(selectedPrompt(action));
      closeModalNavigation();
    } }, el("span", null, icon), label);
}

function directChild(root, node) {
  let current = node;
  while (current && current.parentElement !== root) current = current.parentElement;
  return current;
}

function mountNavigation() {
  const globalNav = document.querySelector("nav.hHd-Xa_panelList") ||
    document.querySelector("button[aria-label='插件']")?.closest("nav");
  if (globalNav && !document.getElementById("aero-business-nav")) {
    const nav = el("nav", { id: "aero-business-nav", class: "aero-nav aero-ui" },
      el("div", { class: "aero-nav-label" }, "AEROAGENT · 业务办理"),
      el("div", { class: "aero-nav-grid" }, navButton("orders", "⌕", "查询订单"),
        navButton("change", "⇄", "改签报价"), navButton("refund", "↩", "退票报价"),
        navButton("conversation", "◫", "退改对话")));
    globalNav.parentElement.insertBefore(nav, globalNav);
  }
  const account = document.querySelector("button[aria-label='账号菜单']");
  const sidebar = globalNav?.parentElement;
  if (sidebar && account && sidebar.contains(account) && !document.getElementById("aero-learning-nav")) {
    const nav = el("nav", { id: "aero-learning-nav", class: "aero-nav aero-ui" },
      el("div", { class: "aero-nav-label" }, "业务学习"),
      el("div", { class: "aero-nav-grid" }, navButton("evaluation", "◎", "评测"),
        navButton("rules", "▤", "规则"), navButton("data", "▦", "数据")));
    sidebar.insertBefore(nav, directChild(sidebar, account));
  }
}

function orderCard(raw, dock) {
  const order = orderView(raw);
  const kind = order.flightStatus === "cancelled" ? "cancel" : order.flightStatus === "delayed" ? "delay" : "ok";
  const flightLabel = order.flightStatus === "cancelled" ? "已取消" :
    order.flightStatus === "delayed" ? `延误 ${order.delayMinutes} 分` : "正常";
  const card = el("button", { type: "button", class: `aero-card${selectedOrder === order.order_id ? " on" : ""}`,
    onclick: () => {
      selectedOrder = order.order_id;
      dock.querySelectorAll(".aero-card").forEach((node) => node.classList.remove("on"));
      card.classList.add("on");
      setComposerText(`@${order.order_id} `, { prefix: true });
    } },
    el("div", { class: "aero-card-top" }, el("span", { class: "fno" }, order.flight_no),
      el("span", { class: `aero-chip ${kind}` }, flightLabel)),
    el("div", { class: "aero-route" }, order.route),
    el("div", { class: "aero-note" }, `${order.date || ""} · ${order.status}`));
  return card;
}

async function buildDock() {
  const dock = el("div", { class: "aero-dock" });
  const wrap = el("section", { id: "aero-dock", class: "aero-dock-wrap aero-ui" },
    el("div", { class: "aero-dock-title" }, el("b", null, "我的订单"),
      el("span", null, "点击关联到当前操作"), el("span", null, "零 Key · 演示数据")), dock);
  try {
    const data = await api("/api/v1/orders");
    const orders = data.orders || [];
    if (!selectedOrder && orders[0]) selectedOrder = orders[0].order_id;
    if (!orders.length) dock.append(el("div", { class: "aero-note" }, "暂无订单"));
    for (const order of orders.slice(0, 10)) dock.append(orderCard(order, dock));
  } catch (error) {
    dock.append(el("div", { class: "aero-error-text" }, `订单加载失败：${error.message}`));
  }
  wrap.append(el("div", { class: "aero-quick" },
    el("button", { type: "button", onclick: () => setComposerText(selectedPrompt("orders")) }, "⚡ 查询订单"),
    el("button", { type: "button", onclick: () => setComposerText(selectedPrompt("change")) }, "⚡ 改签差价"),
    el("button", { type: "button", onclick: () => setComposerText(selectedPrompt("refund")) }, "⚡ 航班取消退票"),
    el("button", { type: "button", onclick: () => setComposerText("那回程那张呢？") }, "⚡ 指代追问")));
  return wrap;
}

async function mountDock() {
  const input = composerInput();
  if (!input || document.getElementById("aero-dock") || dockBuilding) return;
  const card = input.tagName === "TEXTAREA" ? input.closest("div")?.parentElement :
    input.parentElement?.parentElement?.parentElement;
  if (!card?.parentElement) return;
  dockBuilding = true;
  try {
    const dock = await buildDock();
    if (!document.getElementById("aero-dock")) card.parentElement.insertBefore(dock, card);
  } finally { dockBuilding = false; }
}

async function refreshDock() {
  const old = document.getElementById("aero-dock");
  if (!old) return mountDock();
  const fresh = await buildDock();
  old.replaceWith(fresh);
}

function quoteCard(payload, host) {
  const isRefund = payload.action === "REFUND";
  const target = payload.target || {};
  const card = el("article", { class: "aero-quote aero-ui", "data-quote-id": payload.quote_id },
    el("div", { class: "aero-quote-head" }, el("span", { class: "aero-quote-icon" }, isRefund ? "↩" : "⇄"),
      el("div", { class: "aero-quote-title" }, el("b", null, isRefund ? "退票方案" : "改签方案"),
        el("small", null, `${payload.order_id || ""}${target.flight_no ? ` · ${target.flight_no} ${target.date || ""}` : ""}`)),
      el("span", { class: "aero-quote-state" }, "✓ 可办理")),
    el("div", { class: "aero-quote-body" },
      (payload.fee_items || []).map((fee) => el("div", { class: "row" },
        el("span", null, fee.name), el("span", null, `¥${fee.amount}`))),
      el("div", { class: "aero-total" }, el("span", null, isRefund ? "预计退款" : "应付合计"),
        el("strong", null, `¥${payload.amount}`)),
      el("div", { class: "aero-rule" }, "依据 ", el("b", null, (payload.rule_refs || []).join(", ") || "运价引擎"),
        ` · 案件 ${payload.case_id}`)));
  const confirm = el("button", { class: "aero-confirm", type: "button" }, isRefund ? "✓ 确认退票" : "✓ 确认改签");
  const decline = el("button", { class: "aero-cancel", type: "button", onclick: () => card.remove() }, "暂不办理");
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    confirm.textContent = "办理中…";
    try {
      const keys = requestKeys(payload.quote_id);
      const result = await api(`/api/v1/quotes/${payload.quote_id}/confirm`, TOKEN, { method: "POST",
        body: JSON.stringify({ confirmation_id: keys.confirmationId, idempotency_key: keys.idempotencyKey }) });
      card.append(el("div", { class: "aero-message ok" }, `已受理：operation ${result.operation_id || result.status}`));
      await refreshPanel(payload.case_id);
    } catch (error) {
      confirm.disabled = false;
      confirm.textContent = isRefund ? "✓ 确认退票" : "✓ 确认改签";
      card.append(el("div", { class: "aero-message error" }, `确认失败：${error.message}`));
    }
  });
  card.append(el("div", { class: "aero-quote-actions" }, confirm, decline,
    el("small", null, "确认后才会写入订单")));
  host.replaceWith(card);
}

function upgradeMessageFences(root) {
  const codes = [...root.querySelectorAll("code")];
  for (const code of codes) {
    if (code.__aeroDone) continue;
    const text = code.textContent || "";
    const caseMatch = text.match(/```aeroagent-case\s*([\s\S]*?)```/);
    if (caseMatch) {
      code.__aeroDone = true;
      try {
        const metadata = JSON.parse(caseMatch[1]);
        if (metadata.case_id) {
          lastCaseId = metadata.case_id;
          (code.closest("pre") || code).style.display = "none";
          refreshPanel(lastCaseId);
        }
      } catch { /* 非案件块保持宿主原样 */ }
      continue;
    }
    const quoteMatch = text.match(/```aeroagent-quote\s*([\s\S]*?)```/) ||
      (text.trim().startsWith("{") && text.includes("quote_id") ? [null, text] : null);
    if (!quoteMatch) continue;
    const payload = parseAeroAgentQuote(quoteMatch[1]);
    if (payload) {
      code.__aeroDone = true;
      lastCaseId = payload.case_id;
      quoteCard(payload, code.closest("pre") || code);
      refreshPanel(payload.case_id);
    }
  }
}

function kv(label, value) {
  return el("div", { class: "aero-kv" }, el("span", null, label), el("span", null,
    typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")));
}

function jsonBlock(value) {
  return el("pre", { class: "aero-json" }, JSON.stringify(value ?? {}, null, 2));
}

function inspectorBody() {
  return panel?.querySelector(".aero-inspect-body") || null;
}

function renderInspector() {
  const body = inspectorBody();
  if (!body) return;
  body.replaceChildren();
  if (!activeCase) {
    body.append(el("div", { class: "aero-empty" }, "发起一次退改诉求后，这里展示真实的流程、检索、记忆与校验。"));
    return;
  }
  const view = caseView(activeCase);
  if (activeTab === "flow") {
    if (!view.trace.length) body.append(el("div", { class: "aero-empty" }, "本轮暂无流程轨迹"));
    const timeline = el("ol", { class: "aero-timeline" });
    for (const event of view.trace) {
      timeline.append(el("li", { class: `aero-step ${event.status === "error" ? "error" : ""}` },
        el("i", { class: "aero-dot" }, event.status === "error" ? "!" : "✓"),
        el("b", null, event.node || "Agent 节点"),
        el("small", null, `${event.status || "ok"}${event.ms != null ? ` · ${event.ms} ms` : ""}`),
        event.note ? el("p", null, event.note) : null,
        (event.input || event.output) ? jsonBlock({ input: event.input, output: event.output }) : null));
    }
    body.append(timeline);
  } else if (activeTab === "retrieval") {
    if (!view.results.length) body.append(el("div", { class: "aero-empty" }, "本轮暂无检索结果"));
    for (const [index, result] of view.results.entries()) {
      const mini = el("section", { class: "aero-mini" }, el("h4", null,
        `${index + 1}. ${result.intent || "规则检索"} · ${result.text || "子诉求"}`));
      const funnel = result.funnel || result.retrieval?.funnel || [];
      for (const stage of funnel) {
        mini.append(kv(stage.label || stage.stage, `${stage.count ?? 0} 条`),
          el("div", { class: "aero-bar" }, el("i", { style: `width:${Math.min(100, Number(stage.count) || 0)}%` })));
      }
      if (!funnel.length) mini.append(jsonBlock(result));
      body.append(mini);
    }
  } else if (activeTab === "memory") {
    body.append(el("section", { class: "aero-mini" }, el("h4", null, "上下文 Token 分块"),
      jsonBlock(view.context)), el("section", { class: "aero-mini" }, el("h4", null, "会话记忆"),
      Object.keys(view.memory).length ? Object.entries(view.memory).map(([key, value]) => kv(key, value)) :
        el("div", { class: "aero-empty" }, "暂无记忆快照")));
  } else {
    const passed = view.verify.passed;
    body.append(el("div", { class: "aero-verify" }, passed === false ? "未通过本轮校验" : "✓ 本轮结果校验通过"),
      el("div", { class: "aero-metrics" },
        el("div", null, el("small", null, "答案置信度"), el("b", null, view.verify.confidence ?? "—")),
        el("div", null, el("small", null, "规则支持度"), el("b", null, view.verify.support_ratio ?? "—")),
        el("div", null, el("small", null, "校验门槛"), el("b", null, view.verify.threshold ?? "—")),
        el("div", null, el("small", null, "重试次数"), el("b", null, activeCase.result?.retries ?? 0))),
      el("section", { class: "aero-mini", style: "margin-top:9px" }, el("h4", null, "校验明细"), jsonBlock(view.verify)));
  }
}

async function refreshPanel(caseId) {
  if (!panel) return;
  if (!caseId) { activeCase = null; renderInspector(); return; }
  try {
    const record = await api(`/api/v1/cases/${caseId}`);
    if (lastCaseId !== caseId && lastCaseId !== record.case_id) return;
    activeCase = record;
    lastCaseId = record.case_id;
    panel.querySelector(".aero-case-id").textContent = record.case_id;
    panel.querySelector(".aero-case-order").textContent = record.order_id || "未关联";
    const state = panel.querySelector(".aero-case-state");
    state.textContent = record.status;
    state.className = `aero-case-state${["RESULT_UNKNOWN", "HUMAN_REVIEW"].includes(record.status) ? " aero-error-text" : ""}`;
    renderInspector();
    return record;
  } catch (error) {
    const body = inspectorBody();
    if (body) body.replaceChildren(el("div", { class: "aero-error-text" }, `案件加载失败：${error.message}`));
  }
}

function syncLayout() {
  const width = window.innerWidth <= 1100 ? 300 : 340;
  document.documentElement.style.setProperty("--aero-inspector", `${width}px`);
  const root = document.getElementById("root");
  if (root) {
    root.style.setProperty("width", "100%");
    root.style.setProperty("margin-right", "0");
    root.style.setProperty("padding-right", `var(--aero-inspector, ${width}px)`);
    root.style.setProperty("box-sizing", "border-box");
  }
}

function mountPanel() {
  panel = el("aside", { class: "aero-panel aero-ui", "aria-label": "AeroAgent 执行观测" },
    el("div", { class: "aero-inspect-head" }, el("div", { class: "aero-eyebrow" }, "RUN OBSERVABILITY"),
      el("h3", null, "AeroAgent 执行观测"), el("div", { class: "aero-case-id" }, "等待案件")),
    el("div", { class: "aero-case-summary" }, el("div", null, el("small", null, "关联订单"),
      el("span", { class: "aero-case-order" }, "未关联")), el("div", null, el("small", null, "当前状态"),
      el("span", { class: "aero-case-state" }, "READY"))),
    el("div", { class: "aero-tabs", role: "tablist" },
      ...[["flow", "⌘ 流程"], ["retrieval", "▽ 检索"], ["memory", "◉ 记忆"], ["verify", "◌ 校验"]].map(
        ([id, label]) => el("button", { class: `aero-tab${activeTab === id ? " on" : ""}`, "data-aero-tab": id,
          onclick: () => {
            activeTab = id;
            panel.querySelectorAll(".aero-tab").forEach((node) => node.classList.toggle("on", node.dataset.aeroTab === id));
            renderInspector();
          } }, label))),
    el("div", { class: "aero-inspect-body" }));
  document.body.append(panel);
  syncLayout();
  renderInspector();
}

function terminalEvent(type) {
  return ["case.proposed", "case.failed", "case.cancelled", "quote.revised", "fulfillment.completed",
    "fulfillment.rejected", "fulfillment.result_unknown"].includes(type);
}

async function followCase(caseId) {
  followController?.abort();
  const controller = new AbortController();
  followController = controller;
  let cursor = "";
  while (!controller.signal.aborted) {
    try {
      const response = await fetch(`${BACKEND}/api/v1/cases/${caseId}/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
        { headers: { Authorization: `Bearer ${TOKEN}` }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`案件事件连接失败：${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          let type = "message";
          const dataLines = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("id:")) cursor = line.slice(3).trim();
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (!dataLines.length) continue;
          let data = {};
          try { data = JSON.parse(dataLines.join("\n")); } catch { data = { message: dataLines.join("\n") }; }
          if (type === "case.trace" && activeCase) {
            activeCase.result = activeCase.result || {};
            activeCase.result.trace = [...(activeCase.result.trace || []), data];
            if (activeTab === "flow") renderInspector();
          }
          if (terminalEvent(type)) {
            const record = await refreshPanel(caseId);
            if (type === "fulfillment.completed") await refreshDock();
            if (record && shouldStopFollowing(record)) return;
          }
        }
      }
      const record = await refreshPanel(caseId);
      if (record && shouldStopFollowing(record)) return;
    } catch (error) {
      if (controller.signal.aborted) return;
      const body = inspectorBody();
      if (body) body.append(el("div", { class: "aero-note" }, `事件连接重试：${error.message}`));
    }
    if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

function learningLayout(title, subtitle) {
  learning.replaceChildren(el("div", { class: "aero-learning-head" }, el("div", null,
    el("h2", null, title), el("p", null, subtitle)),
    el("button", { class: "aero-learning-close", onclick: () => learning.classList.remove("on") }, "返回对话")));
}

function learningTable(headers, rows) {
  return el("div", { class: "aero-table-wrap" }, el("table", { class: "aero-table" },
    el("tr", null, headers.map((header) => el("th", null, header))),
    rows.map((row) => el("tr", null, row.map((cell) => el("td", null, cell))))));
}

async function showLearning(kind) {
  if (!learning) return;
  const sidebar = document.querySelector("nav.hHd-Xa_panelList")?.parentElement;
  learning.style.left = `${sidebar?.getBoundingClientRect().right || 250}px`;
  learning.classList.add("on");
  try {
    if (kind === "evaluation") {
      learningLayout("评测中心", "观察回答正确性、工具调用准确率与真实回归结果");
      learning.append(el("div", { class: "aero-note" }, "正在读取评测运行…"));
      const data = await api("/api/v1/admin/evaluations?view=runs", ADMIN_TOKEN);
      const runs = data.runs || [];
      const latest = runs[0];
      learning.querySelector(".aero-note")?.remove();
      learning.append(el("div", { class: "aero-stats" },
        el("div", { class: "aero-stat" }, el("small", null, "运行数量"), el("b", null, runs.length)),
        el("div", { class: "aero-stat" }, el("small", null, "最新状态"), el("b", null, latest?.status || "暂无")),
        el("div", { class: "aero-stat" }, el("small", null, "最新用例"), el("b", null,
          latest?.progress?.total ?? latest?.total ?? "—"))));
      learning.append(learningTable(["运行", "用例集", "状态", "完成时间"], runs.map((run) =>
        [run.run_id, run.case_set_id || run.case_set_version || "—", run.status, run.finished_at || run.updated_at || "—"])));
    } else if (kind === "rules") {
      learningLayout("票规检索与维护", "查看当前生效的退改规则与检索依据");
      const data = await api("/api/v1/admin/rules", ADMIN_TOKEN);
      const rules = data.rules || [];
      learning.append(el("div", { class: "aero-stats" },
        el("div", { class: "aero-stat" }, el("small", null, "规则数量"), el("b", null, rules.length)),
        el("div", { class: "aero-stat" }, el("small", null, "检索后端"), el("b", null, data.debug?.retrieval?.backend || "hybrid")),
        el("div", { class: "aero-stat" }, el("small", null, "启用状态"), el("b", { class: "aero-ok" }, "实时"))));
      learning.append(learningTable(["规则", "场景", "航司 / 票种", "版本"], rules.map((rule) =>
        [rule.id, rule.scenario || rule.title || "—", `${rule.airline || "*"} / ${rule.fare_product || "*"}`, rule.version ?? 1])));
    } else {
      learningLayout("演示数据", "查看订单、航班状态和退改场景；业务数据只来自 AeroAgent 后端");
      const data = await api("/api/v1/orders");
      const orders = data.orders || [];
      learning.append(el("div", { class: "aero-stats" },
        el("div", { class: "aero-stat" }, el("small", null, "演示订单"), el("b", null, orders.length)),
        el("div", { class: "aero-stat" }, el("small", null, "取消航班"), el("b", null,
          orders.filter((order) => order.flight?.status === "cancelled").length)),
        el("div", { class: "aero-stat" }, el("small", null, "延误航班"), el("b", null,
          orders.filter((order) => order.flight?.status === "delayed").length))));
      learning.append(learningTable(["订单", "航班", "航线", "航班状态", "订单状态"], orders.map((order) =>
        [order.order_id, order.flight_no, orderView(order).route, order.flight?.status || "—", order.status])));
    }
  } catch (error) {
    learning.append(el("div", { class: "aero-error-text" }, `数据加载失败：${error.message}`));
  }
}

function mount() {
  if (document.getElementById("aero-style")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "aero-style", textContent: css }));
  mountPanel();
  learning = el("section", { class: "aero-learning aero-ui", "aria-label": "AeroAgent 业务学习" });
  document.body.append(learning);
  const tryShell = () => { mountNavigation(); mountDock(); upgradeMessageFences(document); };
  tryShell();
  new MutationObserver(tryShell).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", syncLayout);
  window.__AERO_CLIENT_LOADED = true;
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
}

const inject = [];
function apply() { /* 客户端以 DOM 注入方式工作，无需服务端注册 */ }

globalThis.AeroAgentClient = Object.assign(globalThis.AeroAgentClient || {},
  { parseAeroAgentQuote, orderView, requestKeys, caseView, shouldStopFollowing });
if (typeof window !== "undefined" && window.__ModuleLoader__ && !globalThis.__AERO_DSH_MODULE_REGISTERED) {
  window.__ModuleLoader__.load({ id: "dsh-plugin-aeroagent", factory: () => ({ inject, apply }) });
  globalThis.__AERO_DSH_MODULE_REGISTERED = true;
}
})();
