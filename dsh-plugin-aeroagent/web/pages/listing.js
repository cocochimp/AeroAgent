import { el, flightStatus, isAbort, money, pageHeader, routeOf, stateView } from "../components.js";

export function buildFlightListing(orders) {
  const flights = new Map();
  for (const order of orders) {
    if (!order.flight) continue;
    const key = [order.flight_no, order.date, order.flight.origin, order.flight.dest].join("|");
    const previous = flights.get(key);
    const selected = !previous || (order.fare || 0) < (previous.fare || 0) ? { ...order } : previous;
    if (previous?.flight?.status === "cancelled" || order.flight.status === "cancelled") {
      selected.flight = { ...selected.flight, status: "cancelled" };
    }
    flights.set(key, selected);
  }
  return [...flights.values()];
}

export async function mount({ outlet, api, store, signal, isCurrent }) {
  const userId = store.getUserId();
  let flights = [];
  let loading = true;
  let loadError = "";
  let generation = 0;
  const filters = { origin: "", dest: "", date: "", cabin: "", sort: "fare" };
  const content = el("div", { class: "aa-page-content" });
  const origin = el("input", { class: "aa-input", "aria-label": "出发地", placeholder: "出发城市或代码" });
  const dest = el("input", { class: "aa-input", "aria-label": "目的地", placeholder: "到达城市或代码" });
  const date = el("input", { class: "aa-input", type: "date", "aria-label": "出发日期" });
  const cabin = el("select", { class: "aa-input", "aria-label": "舱位" }, el("option", { value: "" }, "全部舱位"),
    ...["F", "C", "Y"].map((value) => el("option", { value }, value)));
  const sort = el("select", { class: "aa-input", "aria-label": "Listing 排序" }, el("option", { value: "fare" }, "价格从低到高"),
    el("option", { value: "time" }, "起飞时间从早盘到晚"));
  const root = el("section", { class: "aa-page aa-listing-page" },
    pageHeader("FLIGHT LISTING", "Listing", "当前仅复用已有订单中的航班与票价快照，不代表实时 OTA 库存。",
      el("button", { type: "button", class: "aa-button", onclick: () => load() }, "刷新快照")),
    el("p", { class: "aa-notice" }, "在线预订与 mock 支付尚未接入；本页不会创建订单。明确的预订能力将在后续任务开放。"),
    el("div", { class: "aa-toolbar" }, origin, dest, date, cabin, sort), content);
  outlet.replaceChildren(root);

  function draw() {
    if (loading) { content.replaceChildren(stateView("loading", "正在读取航班快照…")); return; }
    if (loadError) { content.replaceChildren(stateView("error", "航班快照加载失败", loadError)); return; }
    const originQuery = filters.origin.trim().toLowerCase();
    const destQuery = filters.dest.trim().toLowerCase();
    const rows = flights.filter((order) => {
      const flight = order.flight;
      return (!originQuery || [flight.origin, flight.origin_city].some((value) => String(value).toLowerCase().includes(originQuery))) &&
        (!destQuery || [flight.dest, flight.dest_city].some((value) => String(value).toLowerCase().includes(destQuery))) &&
        (!filters.date || order.date === filters.date) && (!filters.cabin || order.cabin === filters.cabin);
    }).sort((a, b) => filters.sort === "time" ? String(a.flight.dep_time).localeCompare(String(b.flight.dep_time))
      : (a.fare - b.fare) || a.flight_no.localeCompare(b.flight_no));
    if (!flights.length) { content.replaceChildren(stateView("empty", "当前用户没有可展示的航班快照")); return; }
    if (!rows.length) { content.replaceChildren(stateView("empty", "没有匹配的航班", "调整航线、日期或舱位筛选。 ")); return; }
    content.replaceChildren(el("div", { class: "aa-flight-grid" }, rows.map((order) => el("article", { class: "aa-flight-card" },
      el("header", null, el("strong", null, order.flight_no), el("span", { class: `aa-flight-${order.flight.status}` }, flightStatus(order))),
      el("h3", null, routeOf(order)), el("p", null, `${order.date} · ${order.flight.dep_time || "时间未知"} · ${order.cabin} 舱`),
      el("div", { class: "aa-flight-price" }, el("span", null, "演示订单票价快照"), el("strong", null, money(order.fare))),
      el("small", null, "非实时库存；税费与最终资格须由服务端订单接口核对"),
      el("button", { type: "button", class: "aa-button", disabled: true, title: "预订 API 尚未接入" }, "预订尚未开放")))));
  }

  async function load() {
    const own = ++generation;
    loading = true; loadError = ""; draw();
    try {
      const data = await api.get("/orders", { userId, signal });
      if (!isCurrent() || own !== generation) return;
      flights = buildFlightListing(data.orders || []); loading = false; draw();
    } catch (error) {
      if (isAbort(error, signal) || !isCurrent() || own !== generation) return;
      loading = false; loadError = error.message; draw();
    }
  }
  const bindings = [[origin, "origin"], [dest, "dest"], [date, "date"], [cabin, "cabin"], [sort, "sort"]];
  bindings.forEach(([input, key]) => input.addEventListener(input === sort ? "change" : "input", () => { filters[key] = input.value; draw(); }));
  await load();
  return () => { generation += 1; };
}
