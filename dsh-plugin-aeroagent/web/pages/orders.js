import { dataTable, el, flightStatus, isAbort, money, notice, pageHeader, routeOf, stateView } from "../components.js";

export function filterAndSortOrders(orders, { query = "", status = "", sort = "order-id" } = {}) {
  const q = query.trim().toLowerCase();
  return orders.filter((order) => {
    if (status && order.status !== status) return false;
    if (!q) return true;
    return [order.order_id, order.flight_no, order.passenger, order.airline, order.date,
      order.flight?.origin, order.flight?.dest, order.flight?.origin_city, order.flight?.dest_city]
      .some((value) => String(value || "").toLowerCase().includes(q));
  }).sort((a, b) => {
    if (sort === "departure-asc") return `${a.date} ${a.flight?.dep_time || ""}`.localeCompare(`${b.date} ${b.flight?.dep_time || ""}`) || a.order_id.localeCompare(b.order_id);
    if (sort === "departure-desc") return `${b.date} ${b.flight?.dep_time || ""}`.localeCompare(`${a.date} ${a.flight?.dep_time || ""}`) || a.order_id.localeCompare(b.order_id);
    return a.order_id.localeCompare(b.order_id);
  });
}

export async function mount({ outlet, api, store, signal, isCurrent, navigate }) {
  const userId = store.getUserId();
  const filters = { query: "", status: "", sort: "order-id" };
  let orders = [];
  let loading = true;
  let loadError = "";
  let generation = 0;
  const content = el("div", { class: "aa-page-content" });
  const count = el("span", { class: "aa-muted" }, "读取中");
  const search = el("input", { class: "aa-input", type: "search", "aria-label": "搜索订单", placeholder: "订单号 / 航班 / 航线" });
  const status = el("select", { class: "aa-input", "aria-label": "订单状态" },
    el("option", { value: "" }, "全部状态"), ...["ISSUED", "CHANGED", "REFUNDED", "PENDING_PAYMENT"].map((value) => el("option", { value }, value)));
  const sort = el("select", { class: "aa-input", "aria-label": "订单排序" },
    el("option", { value: "order-id" }, "订单号稳定排序"), el("option", { value: "departure-asc" }, "出发日期从早到晚"),
    el("option", { value: "departure-desc" }, "出发日期从晚到早"));
  const refresh = el("button", { type: "button", class: "aa-button", onclick: () => load() }, "刷新");
  const root = el("section", { class: "aa-page aa-orders-page" },
    pageHeader("ORDERS", "我的订单", "点击订单只绑定退改对话，不会创建案件或触发付费调用。", refresh),
    el("div", { class: "aa-toolbar" }, search, status, sort, count), content);
  outlet.replaceChildren(root);

  function draw() {
    if (loading) { content.replaceChildren(stateView("loading", "正在读取订单…")); return; }
    if (loadError) { content.replaceChildren(stateView("error", "订单加载失败", loadError),
      el("button", { type: "button", class: "aa-button", onclick: () => load() }, "重试")); return; }
    const rows = filterAndSortOrders(orders, filters);
    count.textContent = `${rows.length} / ${orders.length} 张客票`;
    if (!orders.length) { content.replaceChildren(stateView("empty", "当前用户没有订单", "切换演示用户或稍后重试。 ")); return; }
    if (!rows.length) { content.replaceChildren(stateView("empty", "没有符合筛选条件的订单", "调整搜索词或状态筛选。 ")); return; }
    content.replaceChildren(dataTable(["订单 / 乘客", "航班与航线", "出发", "票价", "订单 / 航班状态", "操作"], rows.map((order) => [
      el("div", { class: "aa-cell-stack" }, el("code", null, order.order_id), el("span", null, order.passenger)),
      el("div", { class: "aa-cell-stack" }, el("strong", null, order.flight_no), el("span", null, routeOf(order))),
      `${order.date} ${order.flight?.dep_time || ""}`,
      money((order.fare || 0) + (order.tax || 0)),
      el("div", { class: "aa-cell-stack" }, el("span", { class: "aa-chip" }, order.status), el("span", { class: `aa-flight-${order.flight?.status || "unknown"}` }, flightStatus(order))),
      el("button", { type: "button", class: store.getSession().selectedOrderId === order.order_id ? "aa-button aa-button-primary" : "aa-button",
        onclick: () => { store.selectOrder(order.order_id); navigate("chat"); } }, store.getSession().selectedOrderId === order.order_id ? "继续对话" : "选择并对话"),
    ])));
  }

  async function load() {
    const own = ++generation;
    loading = true; loadError = ""; draw();
    try {
      const data = await api.get("/orders", { userId, signal });
      if (!isCurrent() || own !== generation) return;
      orders = Array.isArray(data.orders) ? data.orders : [];
      if (data.users) store.setUsers(data.users);
      loading = false; draw();
    } catch (error) {
      if (isAbort(error, signal) || !isCurrent() || own !== generation) return;
      loading = false; loadError = error.message; draw();
    }
  }

  search.addEventListener("input", () => { filters.query = search.value; draw(); });
  status.addEventListener("change", () => { filters.status = status.value; draw(); });
  sort.addEventListener("change", () => { filters.sort = sort.value; draw(); });
  await load();
  return () => { generation += 1; };
}
