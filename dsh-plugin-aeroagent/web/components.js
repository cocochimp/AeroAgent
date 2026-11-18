export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.setAttribute("class", String(value));
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value" || key === "checked" || key === "disabled" || key === "hidden") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  const append = (child) => {
    if (Array.isArray(child)) return child.forEach(append);
    if (child === null || child === undefined || child === false) return;
    node.append(child?.nodeType ? child : document.createTextNode(String(child)));
  };
  children.forEach(append);
  return node;
}

export const money = (value, currency = "CNY") => typeof value === "number"
  ? `${currency === "CNY" ? "¥" : `${currency} `}${value.toLocaleString("zh-CN")}` : "本轮无数据";
export const routeOf = (order) => `${order?.flight?.origin_city || order?.flight?.origin || "—"} → ${order?.flight?.dest_city || order?.flight?.dest || "—"}`;
export const flightStatus = (order) => order?.flight?.status === "cancelled" ? "已取消"
  : order?.flight?.status === "delayed" ? `延误 ${order.flight.delay_min || 0} 分钟` : order?.flight?.status === "scheduled" ? "正常" : "状态未知";

export function pageHeader(eyebrow, title, detail, ...actions) {
  return el("header", { class: "aa-page-header" }, el("div", null, el("p", { class: "aa-eyebrow" }, eyebrow),
    el("h1", null, title), el("p", { class: "aa-page-description" }, detail)),
    actions.length ? el("div", { class: "aa-page-actions" }, actions) : null);
}

export function stateView(kind, title, detail = "") {
  return el("div", { class: `aa-state aa-state-${kind}`, role: kind === "error" ? "alert" : "status" },
    el("span", { class: "aa-state-icon", "aria-hidden": "true" }, kind === "loading" ? "◌" : kind === "error" ? "!" : "○"),
    el("strong", null, title), detail ? el("p", null, detail) : null);
}

export function dataTable(headers, rows, { empty = "暂无数据", labelledBy } = {}) {
  if (!rows.length) return stateView("empty", empty);
  return el("div", { class: "aa-table-wrap" }, el("table", { class: "aa-table", "aria-labelledby": labelledBy || null },
    el("thead", null, el("tr", null, headers.map((header) => el("th", { scope: "col" }, header)))),
    el("tbody", null, rows.map((cells) => el("tr", null, cells.map((cell, index) =>
      el("td", { "data-label": headers[index] || null }, cell?.nodeType ? cell : String(cell ?? "—"))))))));
}

export function notice(message, kind = "info") {
  return el("p", { class: `aa-notice aa-notice-${kind}`, role: kind === "error" ? "alert" : "status" }, message);
}

export function abortable(signal, callback) {
  if (signal?.aborted) return false;
  if (callback) signal?.addEventListener("abort", callback, { once: true });
  return true;
}

export function isAbort(error, signal) { return signal?.aborted || error?.name === "AbortError"; }
