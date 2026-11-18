import { el, flightStatus, isAbort, money, notice, pageHeader, routeOf, stateView } from "../components.js";
import { confirmDialog } from "../components/modal.js";

export async function mount({ outlet, api, store, signal, isCurrent }) {
  const userId = store.getUserId();
  const auth = { userId, admin: true, signal };
  let orders = [];
  let profiles = [];
  let selectedId = "";
  let generation = 0;
  let busy = false;
  const ordersHost = el("div", { class: "aa-data-orders" }, stateView("loading", "正在读取演示订单…"));
  const profilesHost = el("div", { class: "aa-profile-grid" }, stateView("loading", "正在读取用户画像…"));
  const noticeHost = el("div");
  const delay = el("input", { class: "aa-input", type: "number", min: "0", max: "10080", value: "150", "aria-label": "航班延误分钟" });
  function setNotice(message, kind = "info") { noticeHost.replaceChildren(message ? notice(message, kind) : ""); }
  const selectedOrder = () => orders.find((order) => order.order_id === selectedId) || orders[0];

  function drawOrders() {
    if (!orders.length) { ordersHost.replaceChildren(stateView("empty", "没有演示订单", "可通过确认后的重置恢复共享种子数据。 ")); return; }
    const current = selectedOrder();
    ordersHost.replaceChildren(el("div", { class: "aa-data-order-list" }, orders.map((order) => el("button", {
      type: "button", class: order.order_id === current?.order_id ? "aa-data-order selected" : "aa-data-order",
      onclick: () => { selectedId = order.order_id; drawOrders(); },
    }, el("code", null, order.order_id), el("strong", null, `${order.flight_no} · ${order.passenger}`),
      el("span", null, routeOf(order)), el("small", null, `${order.date} · ${order.status} · ${flightStatus(order)} · ${money(order.fare)}`)))),
      current ? el("div", { class: "aa-action-row aa-data-actions" }, delay,
        el("button", { type: "button", class: "aa-button", disabled: busy, onclick: () => command({ action: "set_flight_status", flight_no: current.flight_no, date: current.date, status: "cancelled" }) }, "设为取消"),
        el("button", { type: "button", class: "aa-button", disabled: busy, onclick: () => command({ action: "set_flight_status", flight_no: current.flight_no,
          date: current.date, status: "delayed", delay_min: Number(delay.value) }) }, "设为延误"),
        el("button", { type: "button", class: "aa-button", disabled: busy, onclick: () => command({ action: "set_flight_status", flight_no: current.flight_no, date: current.date, status: "scheduled" }) }, "恢复正常")) : null);
  }

  function drawProfiles() {
    if (!profiles.length) { profilesHost.replaceChildren(stateView("empty", "没有用户画像", "管理员身份才能读取画像；普通乘客订单接口不返回画像。 ")); return; }
    profilesHost.replaceChildren(...profiles.map((profile) => el("article", { class: "aa-profile-card" },
      el("header", null, el("div", null, el("h3", null, profile.name), el("code", null, profile.user_id)), el("span", { class: "aa-chip" }, profile.tier)),
      el("pre", { class: "aa-json" }, JSON.stringify(profile.data || {}, null, 2)),
      el("p", { class: "aa-muted" }, "画像用于推荐与检索排序，不改变退改费用。"),
      el("button", { type: "button", class: "aa-button", disabled: busy, onclick: async () => {
        if (await confirmDialog({ title: "清空长期画像？", message: `将清空 ${profile.name} 的航线、航司和偏好统计；短期会话不受影响。`, confirmLabel: "清空", danger: true })) {
          await command({ action: "clear_profile", user_id: profile.user_id });
        }
      } }, "清空画像"))));
  }

  async function load() {
    const own = ++generation;
    ordersHost.replaceChildren(stateView("loading", "正在读取演示订单…"));
    try {
      const data = await api.get("/orders", auth);
      if (!isCurrent() || own !== generation) return;
      orders = data.orders || []; profiles = data.profiles || [];
      if (data.users) store.setUsers(data.users);
      if (!orders.some((order) => order.order_id === selectedId)) selectedId = orders[0]?.order_id || "";
      drawOrders(); drawProfiles();
    } catch (error) {
      if (isAbort(error, signal) || !isCurrent() || own !== generation) return;
      ordersHost.replaceChildren(stateView("error", "演示数据加载失败", error.message));
      profilesHost.replaceChildren(stateView("error", "画像加载失败", error.message));
    }
  }

  async function command(body) {
    if (busy) return;
    busy = true; drawOrders(); drawProfiles(); setNotice("");
    try {
      const result = await api.post("/orders", body, auth);
      if (!isCurrent()) return;
      setNotice(`操作完成：${result.action}；服务端已写入审计并同步投影。`); await load();
    } catch (error) { if (!isAbort(error, signal)) setNotice(error.message, "error"); }
    finally { busy = false; if (isCurrent()) { drawOrders(); drawProfiles(); } }
  }

  const root = el("section", { class: "aa-page aa-data-page" },
    pageHeader("LEARNING / DEMO DATA", "订单与用户", "所有数据均为虚构；航班状态、画像清理和重置使用现有管理员 API。",
      el("button", { type: "button", class: "aa-button", onclick: () => load() }, "刷新"),
      el("button", { type: "button", class: "aa-button aa-danger", disabled: busy, onclick: async () => {
        if (await confirmDialog({ title: "确认重置演示数据？", message: "订单、航班和画像将恢复共享种子数据；已办理结果和规则编辑会丢失，审计记录保留。", confirmLabel: "确认重置", danger: true })) {
          await command({ action: "reset_demo_data" });
        }
      } }, "重置演示数据")), noticeHost,
    el("div", { class: "aa-learning-grid" }, el("section", { class: "aa-card" }, el("h2", null, "演示客票"), ordersHost),
      el("section", { class: "aa-card" }, el("h2", null, "会员画像"), profilesHost)));
  outlet.replaceChildren(root);
  await load();
  return () => { generation += 1; };
}
