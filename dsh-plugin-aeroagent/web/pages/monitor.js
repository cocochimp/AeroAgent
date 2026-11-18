import { dataTable, el, flightStatus, isAbort, money, pageHeader, routeOf, stateView } from "../components.js";

export async function mount({ outlet, api, store, signal, isCurrent }) {
  const userId = store.getUserId();
  const content = el("div", { class: "aa-page-content" });
  let generation = 0;
  const root = el("section", { class: "aa-page aa-monitor-page" },
    pageHeader("PRICE WATCH", "低价监控", "先查看当前演示订单的票价快照；持久化监控将在后续任务接入。",
      el("button", { type: "button", class: "aa-button", onclick: () => load() }, "重新读取快照")),
    el("div", { class: "aa-notice aa-notice-warning" },
      el("strong", null, "监控尚未开启"), el("p", null, "当前不会保存低价目标、定时评估或发送通知。本页只读现有订单数据，不调用 watch/booking API。"),
      el("button", { type: "button", class: "aa-button", disabled: true }, "创建监控尚未开放")), content);
  outlet.replaceChildren(root);

  async function load() {
    const own = ++generation;
    content.replaceChildren(stateView("loading", "正在读取价格快照…"));
    try {
      const data = await api.get("/orders", { userId, signal });
      if (!isCurrent() || own !== generation) return;
      const orders = data.orders || [];
      if (!orders.length) { content.replaceChildren(stateView("empty", "当前用户没有价格快照", "没有订单并不代表已创建低价监控。 ")); return; }
      content.replaceChildren(dataTable(["航班", "航线", "日期", "票面快照", "航班状态", "监控状态"], orders.map((order) => [
        order.flight_no, routeOf(order), order.date, money(order.fare), flightStatus(order),
        el("span", { class: "aa-chip" }, "未创建监控"),
      ])));
    } catch (error) {
      if (isAbort(error, signal) || !isCurrent() || own !== generation) return;
      content.replaceChildren(stateView("error", "价格快照加载失败", error.message),
        el("button", { type: "button", class: "aa-button", onclick: () => load() }, "重试"));
    }
  }
  await load();
  return () => { generation += 1; };
}
