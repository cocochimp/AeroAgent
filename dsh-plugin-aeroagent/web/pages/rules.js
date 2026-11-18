import { el, isAbort, notice, pageHeader, stateView } from "../components.js";
import { renderRetrieval } from "../components/inspector.js";

const SCENARIOS = ["VOLUNTARY_CHANGE", "VOLUNTARY_REFUND", "CANCEL", "DELAY", "NO_SHOW", "FARE_DIFF"];
export function rulePayload(rule) {
  return { airline: rule.airline, cabin: rule.cabin, fare_product: rule.fare_product, scenario: rule.scenario,
    title: rule.title, content: rule.content, active: Boolean(rule.active) };
}

export async function mount({ outlet, api, store, signal, isCurrent }) {
  const userId = store.getUserId();
  const auth = { userId, admin: true, signal };
  let rules = [];
  let selectedId = "";
  let debug = null;
  let busy = false;
  let generation = 0;
  const list = el("div", { class: "aa-rule-list" }, stateView("loading", "正在读取规则…"));
  const editorHost = el("section", { class: "aa-card aa-rule-editor" }, stateView("empty", "请选择规则"));
  const debugHost = el("div", { class: "aa-rule-debug" });
  const noticeHost = el("div");
  const query = el("input", { class: "aa-input", type: "search", "aria-label": "搜索规则", placeholder: "规则 ID / 标题 / 正文" });
  const airline = el("input", { class: "aa-input aa-input-short", "aria-label": "筛选航司", placeholder: "航司，如 MU" });
  const scenario = el("select", { class: "aa-input", "aria-label": "筛选场景" }, el("option", { value: "" }, "全部场景"),
    ...SCENARIOS.map((value) => el("option", { value }, value)));
  const searchButton = el("button", { type: "button", class: "aa-button aa-button-primary", onclick: () => load() }, "检索规则");
  const selected = () => rules.find((rule) => rule.id === selectedId);
  function setNotice(message, kind = "info") { noticeHost.replaceChildren(message ? notice(message, kind) : ""); }

  function drawList() {
    if (!rules.length) { list.replaceChildren(stateView("empty", "没有匹配规则", "调整检索条件或新增规则。 ")); return; }
    list.replaceChildren(...rules.map((rule) => el("button", { type: "button", class: rule.id === selectedId ? "aa-rule-row selected" : "aa-rule-row",
      onclick: () => { selectedId = rule.id; drawList(); drawEditor(); } },
      el("code", null, rule.id), el("strong", null, rule.title), el("span", null, `${rule.airline} · ${rule.cabin} · ${rule.fare_product}`),
      el("small", null, `v${rule.version} · ${rule.active ? "启用" : "停用"}`))));
  }

  function field(label, key, multiline = false) {
    const rule = selected();
    const input = multiline ? el("textarea", { class: "aa-input", rows: "8", "aria-label": label }, rule[key] || "")
      : el("input", { class: "aa-input", value: rule[key] || "", "aria-label": label });
    input.addEventListener("input", () => { rule[key] = input.value; });
    return el("label", { class: multiline ? "aa-field aa-field-wide" : "aa-field" }, el("span", null, label), input);
  }

  function drawEditor() {
    const rule = selected();
    if (!rule) { editorHost.replaceChildren(stateView("empty", "请选择一条服务端规则")); return; }
    const scenarioInput = el("select", { class: "aa-input", "aria-label": "规则场景" }, ...SCENARIOS.map((value) =>
      el("option", { value, selected: value === rule.scenario }, value)));
    scenarioInput.addEventListener("change", () => { rule.scenario = scenarioInput.value; });
    editorHost.replaceChildren(el("div", { class: "aa-section-header" }, el("div", null, el("p", { class: "aa-eyebrow" }, "VERSIONED RULE"),
      el("h2", null, rule.id)), el("span", null, `版本 ${rule.version}`)),
      el("div", { class: "aa-form-grid" }, field("航司", "airline"), field("舱位", "cabin"), field("票价产品", "fare_product"),
        el("label", { class: "aa-field" }, el("span", null, "场景"), scenarioInput), field("标题", "title"), field("规则正文", "content", true)),
      el("div", { class: "aa-action-row" },
        el("button", { type: "button", class: "aa-button aa-button-primary", disabled: busy, onclick: () => save() }, "保存新版本"),
        el("button", { type: "button", class: "aa-button", disabled: busy, onclick: () => save(!rule.active) }, rule.active ? "停用规则" : "重新启用"),
        el("span", { class: "aa-muted" }, "规则资格与金额始终由服务端引擎决定。")));
  }

  function drawDebug() {
    if (!query.value.trim()) { debugHost.replaceChildren(stateView("empty", "输入问题后检索", "将展示 dense / BM25 / RRF / rerank / MMR / inject 漏斗。 ")); return; }
    if (!debug) { debugHost.replaceChildren(stateView("empty", "本轮无检索调试数据")); return; }
    debugHost.replaceChildren(el("div", { class: "aa-section-header" }, el("h2", null, "真实检索漏斗"),
      el("span", { class: "aa-chip" }, debug.backend || "hybrid")), renderRetrieval([{ text: query.value, funnel: debug.funnel || [] }], {
      onRule: (id) => { if (rules.some((rule) => rule.id === id)) { selectedId = id; drawList(); drawEditor(); } },
    }));
  }

  async function load() {
    const own = ++generation;
    list.replaceChildren(stateView("loading", "正在检索规则…")); setNotice("");
    const params = new URLSearchParams({ debug: "true" });
    if (query.value.trim()) params.set("q", query.value.trim());
    if (airline.value.trim()) params.set("airline", airline.value.trim());
    if (scenario.value) params.set("scenario", scenario.value);
    try {
      const data = await api.get(`/admin/rules?${params}`, auth);
      if (!isCurrent() || own !== generation) return;
      rules = data.rules || [];
      if (!rules.some((rule) => rule.id === selectedId)) selectedId = rules[0]?.id || "";
      debug = data.debug?.retrieval || null;
      setNotice(`服务端命中 ${data.debug?.result_count ?? rules.length} 条规则`); drawList(); drawEditor(); drawDebug();
    } catch (error) {
      if (isAbort(error, signal) || !isCurrent() || own !== generation) return;
      list.replaceChildren(stateView("error", "规则加载失败", error.message)); setNotice(error.message, "error");
    }
  }

  async function save(active = selected()?.active) {
    const rule = selected();
    if (!rule || busy) return;
    busy = true; drawEditor(); setNotice("");
    try {
      const response = await api.put(`/admin/rules/${encodeURIComponent(rule.id)}`, rulePayload({ ...rule, active }), auth);
      if (!isCurrent()) return;
      Object.assign(rule, response.rule); setNotice(`已保存 ${rule.id} · v${rule.version}`); drawList(); drawEditor();
    } catch (error) { if (!isAbort(error, signal)) setNotice(error.message, "error"); }
    finally { busy = false; if (isCurrent()) drawEditor(); }
  }

  const root = el("section", { class: "aa-page aa-rules-page" },
    pageHeader("LEARNING / RULES", "票规检索与维护", "检索真实规则漏斗，编辑版本并明确启停；停用仍保留审计。",
      el("button", { type: "button", class: "aa-button", onclick: () => {
        const id = `CUSTOM-${Date.now().toString(36).toUpperCase()}`;
        rules = [{ id, airline: "*", cabin: "*", fare_product: "*", scenario: "VOLUNTARY_CHANGE", title: "新规则", content: "", active: false, version: 0 }, ...rules];
        selectedId = id; drawList(); drawEditor();
      } }, "新增规则")), noticeHost,
    el("div", { class: "aa-toolbar" }, query, airline, scenario, searchButton), debugHost,
    el("div", { class: "aa-learning-grid" }, el("section", { class: "aa-card" }, el("h2", null, "规则清单"), list), editorHost));
  outlet.replaceChildren(root);
  drawDebug();
  await load();
  return () => { generation += 1; };
}
