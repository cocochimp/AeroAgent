import { el, money } from "../components.js";

export function quoteCardState(record, quote) {
  if (record?.status === "RESULT_UNKNOWN") return "unknown";
  if (["HUMAN_REVIEW", "FAILED"].includes(record?.status)) return "failed";
  if (record?.status === "CANCELLED" || quote?.status === "CANCELLED") return "cancelled";
  if (record?.status === "COMPLETED" || quote?.status === "EXECUTED") return quote?.status === "EXECUTED" ? "completed" : "cancelled";
  if (quote?.status === "REQUOTE_REQUIRED") return "requote";
  if (record?.status === "PROCESSING" || quote?.status === "CONFIRMED") return "processing";
  if (record?.status === "WAITING_CONFIRMATION" && quote?.status === "OFFERED") return "offered";
  return "closed";
}

const stateLabels = { offered: "可办理", processing: "办理中", completed: "已完成", cancelled: "已取消",
  requote: "需确认新报价", failed: "办理未完成", unknown: "结果待核对", closed: "已失效" };

export function createQuoteCard(record, quote, { onConfirm, onDecline, busy = false } = {}) {
  const detail = quote.details?.[0] || {};
  const pricing = detail.pricing || {};
  const target = detail.target || pricing.target || {};
  const state = quoteCardState(record, quote);
  const refund = quote.action === "REFUND";
  const feeItems = detail.fee_items || [];
  return el("article", { class: "aa-quote-card", dataset: { quoteId: quote.quote_id, state } },
    el("header", { class: "aa-quote-header" }, el("div", null, el("p", { class: "aa-eyebrow" }, refund ? "REFUND QUOTE" : "CHANGE QUOTE"),
      el("h3", null, detail.title || (refund ? "退票方案" : "改签方案"))), el("span", { class: `aa-status aa-status-${state}` }, stateLabels[state])),
    el("div", { class: "aa-quote-target" },
      el("strong", null, target.flight_no ? `${target.flight_no} · ${target.date || "日期待确认"}` : `订单 ${record.order_id || "—"}`),
      target.dep_time || target.cabin || target.fare_product ? el("span", null,
        `${target.dep_time || "时间待定"} · ${target.cabin || "舱位待定"} · ${target.fare_product || "票种待定"}`) : null),
    feeItems.length ? el("dl", { class: "aa-fee-list" }, feeItems.map((fee) => el("div", null,
      el("dt", null, fee.name), el("dd", null, money(fee.amount, quote.currency))))) : el("p", { class: "aa-muted" }, "本轮无费用明细"),
    el("div", { class: "aa-quote-total" }, el("span", null, refund ? "预计退款" : "确认后应付"),
      el("strong", null, money(quote.amount, quote.currency))),
    detail.rule_refs?.length ? el("p", { class: "aa-rule-refs" }, "依据：", (detail.rule_refs || []).map((ref) => el("code", null, ref))) : null,
    detail.rationale ? el("p", { class: "aa-quote-rationale" }, detail.rationale) : null,
    el("p", { class: "aa-quote-expiry" }, `报价有效期至 ${quote.expires_at || "以服务端为准"}；确认时由服务端重新核价。`),
    state === "offered" ? el("div", { class: "aa-quote-actions" },
      el("button", { type: "button", class: "aa-button aa-button-primary", disabled: busy, onclick: () => onConfirm?.(quote) }, `确认${refund ? "退票" : "改签"}`),
      el("button", { type: "button", class: "aa-button", disabled: busy, onclick: () => onDecline?.(quote) }, "暂不办理")) : null);
}
