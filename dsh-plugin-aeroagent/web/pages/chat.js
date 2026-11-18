import { dataTable, el, flightStatus, isAbort, money, notice, routeOf, stateView } from "../components.js";
import { createInspector } from "../components/inspector.js";
import { openModal } from "../components/modal.js";
import { createQuoteCard } from "../components/quote-card.js";
import { newRequestId } from "../api.js";

export const QUICK_ACTIONS = Object.freeze([
  { id: "orders", label: "查询订单" },
  { id: "change", label: "生成改签方案" },
  { id: "refund", label: "退票" },
  { id: "compare", label: "改签 + 退票" },
]);

export function quickActionPrompt(action, orderId) {
  const order = orderId ? `@${orderId} ` : "";
  if (action === "orders") return "查询我的订单";
  if (action === "change") return `${order}帮我改签到后天，请生成可选方案，并说明差价和手续费。`;
  if (action === "refund") return `${order}航班取消了，请按当前票规计算退票费和最终退款。`;
  return `${order}请分别给出改签和退票方案，比较费用后再由我选择。`;
}

const terminalEvents = new Set(["case.proposed", "case.failed", "case.cancelled", "quote.revised",
  "fulfillment.completed", "fulfillment.rejected", "fulfillment.result_unknown"]);

export function shouldFollowConfirmation(status) { return ["ACCEPTED", "PROCESSING"].includes(status); }

export function confirmationRecoveryAction(record) {
  if (record?.status === "COMPLETED") return "refresh";
  if (record?.status === "PROCESSING" || (record?.quotes || []).some((quote) => quote.status === "CONFIRMED")) return "follow";
  return "snapshot";
}

export async function mount({ outlet, api, store, signal, isCurrent }) {
  const userId = store.getUserId();
  const auth = { userId, signal };
  let orders = [];
  let activeCase = null;
  let activeCaseId = store.getSession().caseId;
  let busy = false;
  let orderGeneration = 0;
  let caseGeneration = 0;
  let followController = null;
  let cursor = "";
  const confirmationKeys = new Map();

  const orderStrip = el("div", { class: "aa-order-strip", role: "group", "aria-label": "选择订单" }, stateView("loading", "正在读取订单…"));
  const feed = el("div", { class: "aa-chat-feed", "aria-live": "polite", "aria-label": "对话记录" });
  const inspectorHost = el("div", { class: "aa-chat-inspector" });
  const noticeHost = el("div", { class: "aa-chat-notice" });
  const input = el("textarea", { class: "aa-composer-input", rows: "1", maxlength: "2000", "aria-label": "描述退改需求",
    placeholder: "描述你的退改需求… Enter 发送，Shift + Enter 换行" });
  input.value = store.getSession().draft;
  const sendButton = el("button", { type: "submit", class: "aa-send-button", "aria-label": "发送" }, "↑");
  const quick = el("div", { class: "aa-quick-actions", "aria-label": "快捷操作" }, QUICK_ACTIONS.map((action) =>
    el("button", { type: "button", dataset: { quick: action.id }, onclick: () => sendMessage(quickActionPrompt(action.id, store.getSession().selectedOrderId)) }, "↗ ", action.label)));
  const form = el("form", { class: "aa-composer-form" }, input, sendButton);
  const composer = el("div", { class: "aa-composer" }, quick, form,
    el("div", { class: "aa-composer-foot" }, el("span", null, "票规与金额由服务端计算；确认报价后才会办理。"),
      el("span", { class: "aa-active-case" }, activeCaseId ? `案件 ${activeCaseId}` : "未创建案件")));
  const heading = el("header", { class: "aa-chat-heading" }, el("div", { class: "aa-chat-title" },
    el("div", null, el("p", { class: "aa-eyebrow" }, "AEROAGENT SERVICE"), el("h1", null, "机票退改签对话")),
    el("span", { class: "aa-run-state" }, "就绪")), orderStrip);
  const root = el("section", { class: "aa-chat-page" }, heading,
    el("div", { class: "aa-chat-layout" }, el("section", { class: "aa-conversation", "aria-label": "退改对话" },
      feed, noticeHost, composer), inspectorHost));
  outlet.replaceChildren(root);
  const inspector = createInspector(inspectorHost);

  function setNotice(message, kind = "info") { noticeHost.replaceChildren(message ? notice(message, kind) : ""); }
  function setBusy(value) {
    busy = value;
    sendButton.disabled = value || !input.value.trim();
    input.disabled = value;
    quick.querySelectorAll("button").forEach((button) => { button.disabled = value || (!orders.length && !activeCaseId); });
    heading.querySelector(".aa-run-state").textContent = value ? "Agent 运行中" : activeCase?.status || "就绪";
  }

  function drawOrders() {
    if (!orders.length) { orderStrip.replaceChildren(el("p", { class: "aa-muted" }, "当前用户没有订单；仍可通过历史案件查看已有对话。 ")); return; }
    const selectedId = store.getSession().selectedOrderId;
    orderStrip.replaceChildren(...orders.map((order) => el("button", { type: "button",
      class: order.order_id === selectedId ? "aa-order-card selected" : "aa-order-card", "aria-pressed": order.order_id === selectedId,
      onclick: () => { store.selectOrder(order.order_id); drawOrders(); },
    }, el("span", { class: "aa-order-card-top" }, el("strong", null, order.flight_no),
      el("span", { class: `aa-flight-${order.flight?.status || "unknown"}` }, flightStatus(order))),
      el("span", null, routeOf(order)), el("small", null, `${order.date} · ${order.status}`))));
  }

  function syncAssistant(record) {
    const text = record?.result?.final?.text;
    if (!text) return;
    const session = store.getSession();
    if (session.messages.at(-1)?.role === "assistant" && session.messages.at(-1)?.text === text) return;
    store.appendMessage({ role: "assistant", text });
  }

  function drawConversation() {
    const session = store.getSession();
    const children = [];
    if (!session.messages.length && !activeCase) children.push(el("div", { class: "aa-chat-welcome" },
      el("span", { "aria-hidden": "true" }, "✈"), el("h2", null, `你好，${store.getUser().name}`),
      el("p", null, "选择上方客票，再描述退改需求。报价只有在明确确认后才会进入交易流程。")));
    for (const message of session.messages) children.push(el("div", { class: `aa-message aa-message-${message.role}` },
      el("small", null, message.role === "user" ? store.getUser().name : message.role === "assistant" ? "AeroAgent" : "系统"),
      el("p", null, message.text)));
    if (activeCase?.status === "HUMAN_REVIEW") children.push(stateView("error", "已转人工处理", "规则依据不足，系统不会自动办理。 "));
    if (activeCase?.status === "RESULT_UNKNOWN") children.push(stateView("error", "结果待核对", "航司暂未返回明确结果，请核对订单且不要重复提交。 "));
    if (activeCase?.status === "COMPLETED") children.push(stateView("empty", "办理完成", "演示订单已由 TransactionAgent 更新。 "));
    for (const quote of activeCase?.quotes || []) children.push(createQuoteCard(activeCase, quote, {
      busy, onConfirm: confirmQuote, onDecline: declineQuotes,
    }));
    if (busy) children.push(el("div", { class: "aa-processing", role: "status" }, el("span", { class: "aa-spinner" }), "主 Agent 正在理解诉求、检索票规并核对费用…"));
    feed.replaceChildren(...children);
    composer.querySelector(".aa-active-case").textContent = activeCaseId ? `案件 ${activeCaseId}` : "未创建案件";
    feed.scrollTop = feed.scrollHeight;
  }

  async function loadOrders() {
    const own = ++orderGeneration;
    orderStrip.replaceChildren(stateView("loading", "正在读取订单…"));
    try {
      const data = await api.get("/orders", auth);
      if (!isCurrent() || own !== orderGeneration) return;
      orders = data.orders || [];
      if (data.users) store.setUsers(data.users);
      const selected = store.getSession().selectedOrderId;
      if (!orders.some((order) => order.order_id === selected)) store.selectOrder(orders[0]?.order_id || null);
      drawOrders(); setBusy(busy);
    } catch (error) {
      if (isAbort(error, signal) || !isCurrent() || own !== orderGeneration) return;
      orderStrip.replaceChildren(stateView("error", "订单加载失败", error.message),
        el("button", { type: "button", class: "aa-button", onclick: () => loadOrders() }, "重试"));
    }
  }

  async function loadCase(caseId, requestSignal = signal) {
    const own = ++caseGeneration;
    const record = await api.get(`/cases/${encodeURIComponent(caseId)}`, { ...auth, signal: requestSignal });
    if (!isCurrent() || own !== caseGeneration || (activeCaseId && activeCaseId !== caseId)) return null;
    activeCase = record; activeCaseId = record.case_id;
    store.patchSession({ caseId: record.case_id });
    syncAssistant(record); inspector.update(record); drawConversation();
    return record;
  }

  async function followCase(caseId) {
    followController?.abort();
    const controller = new AbortController();
    followController = controller;
    store.trackRequest(controller);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    setBusy(true);
    try {
      cursor = await api.stream(`/cases/${encodeURIComponent(caseId)}/events`, { ...auth, signal: controller.signal, cursor,
        onEvent: async (type, data, id) => {
          if (id) cursor = id;
          if (type === "case.trace") inspector.push(data);
          if (type === "case.failed") setNotice(data.message || "本轮处理未完成", "error");
          if (type === "fulfillment.result_unknown") setNotice("航司结果未知，请核对订单；不会自动重试。", "error");
          if (terminalEvents.has(type)) {
            const record = await loadCase(caseId, controller.signal);
            if (type === "fulfillment.completed") await loadOrders();
            if (record?.status === "COMPLETED") setNotice("交易 Agent 已完成办理，订单已刷新。 ");
            return true;
          }
          return false;
        },
        onError: (error) => { if (isCurrent() && !controller.signal.aborted) setNotice(`事件连接重试：${error.message}`, "warning"); },
      });
    } catch (error) {
      if (!isAbort(error, controller.signal) && isCurrent()) setNotice(error.message, "error");
    } finally {
      signal.removeEventListener("abort", abort);
      if (followController === controller && isCurrent()) { setBusy(false); drawConversation(); }
    }
  }

  async function sendMessage(raw = input.value) {
    const text = raw.trim();
    if (!text || busy) return;
    const orderId = store.getSession().selectedOrderId;
    if (!activeCaseId && !orderId) { setNotice("请先选择一张客票。", "warning"); return; }
    followController?.abort();
    store.appendMessage({ role: "user", text });
    store.patchSession({ draft: "" }); input.value = "";
    activeCase = null; cursor = ""; setNotice(""); inspector.start(); setBusy(true); drawConversation();
    try {
      if (activeCaseId) await api.post(`/cases/${encodeURIComponent(activeCaseId)}/messages`, { message: text }, auth);
      else {
        const created = await api.post("/cases", { message: text, order_id: orderId }, auth);
        activeCaseId = created.case_id; store.patchSession({ caseId: activeCaseId });
        activeCase = { ...created, order_id: orderId, result: {}, quotes: [] };
      }
      if (!isCurrent()) return;
      drawConversation(); void followCase(activeCaseId);
    } catch (error) {
      if (!isAbort(error, signal) && isCurrent()) {
        store.patchSession({ draft: text }); input.value = text; setBusy(false); setNotice(`${error.message}。消息仍保留在输入框，可重试。`, "error"); drawConversation();
      }
    }
  }

  function keysFor(quoteId) {
    if (!confirmationKeys.has(quoteId)) confirmationKeys.set(quoteId, {
      confirmation_id: newRequestId("confirm"), idempotency_key: newRequestId("ticket"),
    });
    return confirmationKeys.get(quoteId);
  }

  function confirmQuote(quote) {
    const detail = quote.details?.[0] || {};
    const fees = detail.fee_items || [];
    openModal({ title: `确认${quote.action === "REFUND" ? "退票" : "改签"}？`,
      body: el("div", null, el("p", null, `案件 ${activeCaseId} · 报价 ${quote.quote_id}`),
        dataTable(["费用项目", "金额"], [...fees.map((fee) => [fee.name, money(fee.amount, quote.currency)]),
          [quote.action === "REFUND" ? "最终退款" : "应付合计", money(quote.amount, quote.currency)]]),
        detail.rule_refs?.length ? el("p", null, `规则依据：${detail.rule_refs.join("、")}`) : null,
        el("p", { class: "aa-warning" }, "确认后服务端会复核价格并提交不可逆的演示交易。只有 TransactionAgent 的最终状态才代表办理成功。")),
      actions: [{ label: "返回检查" }, { label: "确认并提交", primary: true, onClick: (close) => { close(); void executeConfirmation(quote); } }] });
  }

  async function executeConfirmation(quote) {
    if (!activeCaseId || busy) return;
    setBusy(true); drawConversation(); setNotice("正在复核价格并提交办理…");
    try {
      const result = await api.post(`/quotes/${encodeURIComponent(quote.quote_id)}/confirm`, keysFor(quote.quote_id), auth);
      if (!isCurrent()) return;
      setNotice(result.status === "ACCEPTED" ? "Quote API 已受理；等待 TransactionAgent 最终状态。" : `办理状态：${result.status}`);
      if (activeCase) { activeCase.status = result.status === "ACCEPTED" ? "PROCESSING" : result.status; }
      if (shouldFollowConfirmation(result.status)) await followCase(activeCaseId);
      else {
        const record = await loadCase(activeCaseId);
        if (record?.status === "COMPLETED") await loadOrders();
        setBusy(false); drawConversation();
      }
    } catch (error) {
      if (isAbort(error, signal) || !isCurrent()) return;
      let record;
      try { record = await loadCase(activeCaseId); }
      catch {
        setNotice(`${error.message}。无法核对案件，请勿重复提交；相同报价重试会复用幂等键。`, "error");
        setBusy(false); drawConversation(); return;
      }
      const recovery = confirmationRecoveryAction(record);
      if (recovery === "follow") {
        setNotice("请求结果已核对，交易正在办理；继续等待最终状态。");
        await followCase(activeCaseId); return;
      }
      if (recovery === "refresh") await loadOrders();
      setNotice(error.body?.error?.details?.quote_id ? `${error.message}；请确认最新报价。` : `${error.message}；已按案件快照恢复状态。`, "error");
      setBusy(false); drawConversation();
    }
  }

  async function declineQuotes() {
    if (!activeCaseId || busy) return;
    setBusy(true); drawConversation();
    try {
      await api.post(`/cases/${encodeURIComponent(activeCaseId)}/messages`, { message: "暂不办理" }, auth);
      await loadCase(activeCaseId); setNotice("已取消本次全部报价，订单未发生变化。 ");
    } catch (error) { if (!isAbort(error, signal)) setNotice(`取消失败：${error.message}`, "error"); }
    finally { if (isCurrent()) { setBusy(false); drawConversation(); } }
  }

  input.addEventListener("input", () => { store.patchSession({ draft: input.value }); sendButton.disabled = busy || !input.value.trim(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (event) => { event.preventDefault(); void sendMessage(); });

  drawConversation(); setBusy(false);
  await loadOrders();
  if (activeCaseId && isCurrent()) {
    try { await loadCase(activeCaseId); }
    catch (error) { if (!isAbort(error, signal)) setNotice(`历史案件恢复失败：${error.message}`, "error"); }
  }
  return () => { orderGeneration += 1; caseGeneration += 1; followController?.abort(); };
}
