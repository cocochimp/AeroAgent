import { dataTable, el, money, stateView } from "../components.js";

const INTENT = { CHANGE: "改签", REFUND: "退票", STATUS: "航班查询", CANCEL: "航班取消" };
const BLOCKS = { system: "系统提示", order: "订单", rules: "规则", history: "历史", profile: "画像" };
const TABS = [["flow", "流程"], ["retrieval", "检索"], ["memory", "记忆"], ["verify", "校验"]];

export function verificationState(verify = {}) {
  if (verify?.passed === true) return { kind: "success", label: "校验通过" };
  if (verify?.passed === false) return { kind: "failure", label: "未通过校验" };
  return { kind: "pending", label: "暂无校验结果" };
}

/** Compare displayed option fees with deterministic engine fields; never invent a match. */
export function buildFeeComparisons(result = {}) {
  const explicit = result?.verify?.fee_comparison;
  if (Array.isArray(explicit) && explicit.length) return explicit.map((row, index) => ({
    label: row.label || `${INTENT[row.intent] || row.intent || `子诉求 ${index + 1}`} · 合计`,
    actual: row.actual, expected: row.expected,
    matched: typeof row.actual === "number" && typeof row.expected === "number" ? row.actual === row.expected : null,
  }));
  const rows = [];
  (result?.final?.options || []).forEach((option, index) => {
    const fee = result?.results?.[index]?.fee;
    if (!fee || fee.allowed === false || !["CHANGE", "REFUND"].includes(option.type)) return;
    const engine = { "改期费": fee.change_fee, "票面差价": fee.fare_diff, "退票费": fee.refund_fee, "机场建设费退还": fee.tax };
    (option.fee_items || []).forEach((item) => rows.push({
      label: `${INTENT[option.type] || option.type} · ${item.name}`, actual: item.amount, expected: engine[item.name],
      matched: typeof item.amount === "number" && typeof engine[item.name] === "number" ? item.amount === engine[item.name] : null,
    }));
    const expected = option.type === "CHANGE" ? fee.total : fee.refund_amount;
    rows.push({ label: `${INTENT[option.type] || option.type} · 合计`, actual: option.total, expected,
      matched: typeof option.total === "number" && typeof expected === "number" ? option.total === expected : null });
  });
  return rows;
}

function jsonBlock(value) { return el("pre", { class: "aa-json" }, JSON.stringify(value ?? {}, null, 2)); }

function renderFlow(events, pending) {
  if (!events.length) return stateView("empty", pending || "本轮暂无流程轨迹", "发起退改对话后展示可展开的 Agent 节点。 ");
  return el("ol", { class: "aa-timeline" }, events.map((event, index) => el("li", { class: `aa-trace aa-trace-${event.status || "ok"}` },
    el("details", null, el("summary", null, el("span", { class: "aa-trace-marker" }, event.status === "error" ? "!" : "✓"),
      el("span", null, el("strong", null, event.node || `Agent 节点 ${index + 1}`), el("small", null, event.note || event.status || "—")),
      el("time", null, typeof event.ms === "number" ? `${event.ms} ms` : "耗时无数据")),
    el("div", { class: "aa-trace-detail" }, el("section", null, el("h4", null, "输入"), event.input ? jsonBlock(event.input) : el("p", { class: "aa-muted" }, "本轮无数据")),
      el("section", null, el("h4", null, "输出"), event.output ? jsonBlock(event.output) : el("p", { class: "aa-muted" }, "本轮无数据")))))));
}

export function renderRetrieval(results = [], { selected = 0, onSelect, highlight = null, onRule } = {}) {
  const available = results.filter((result) => Array.isArray(result?.funnel) && result.funnel.length);
  if (!available.length) return stateView("empty", "本轮暂无检索数据", "完成包含票规检索的对话后显示各子诉求漏斗。 ");
  const currentIndex = Math.min(selected, available.length - 1);
  const current = available[currentIndex];
  const retrieval = current.retrieval || {};
  return el("div", { class: "aa-retrieval" },
    available.length > 1 ? el("div", { class: "aa-segmented", role: "group", "aria-label": "选择子诉求" }, available.map((result, index) =>
      el("button", { type: "button", "aria-pressed": index === currentIndex, onclick: () => onSelect?.(index) },
        INTENT[result.intent] || result.intent || `子诉求 ${index + 1}`))) : null,
    el("div", { class: "aa-retrieval-meta" }, el("span", { class: retrieval.degraded ? "aa-chip aa-chip-warning" : "aa-chip" },
      `${retrieval.backend || "hybrid"}${retrieval.degraded ? " · 降级" : ""}`),
      current.rewrite ? el("span", { class: "aa-chip" }, `改写：${current.rewrite.type || "已改写"}`) : null),
    current.text ? el("p", { class: "aa-subrequest" }, "当前子诉求：", current.text) : null,
    el("div", { class: "aa-funnel" }, current.funnel.map((stage, stageIndex) => {
      const cap = typeof stage.k === "number" && stage.k > 0 ? stage.k : null;
      const count = typeof stage.count === "number" ? stage.count : null;
      const percent = cap && count !== null ? Math.min(100, Math.max(0, count / cap * 100)) : 0;
      return el("section", { class: "aa-funnel-stage" },
        el("header", null, el("strong", null, stage.label || stage.stage || `阶段 ${stageIndex + 1}`),
          el("span", null, `${count ?? "本轮无数据"}${cap ? ` / ${cap}` : ""}`)),
        el("div", { class: "aa-funnel-track", "aria-hidden": "true" }, el("i", { style: { width: `${percent}%` } })),
        stage.items?.length ? el("ul", { class: "aa-candidates" }, stage.items.map((item) => el("li", null,
          el("button", { type: "button", class: item.id === highlight ? "aa-rule-highlight" : "", onclick: () => onRule?.(item.id) },
            el("code", null, item.id || "无规则 ID"), el("span", null, item.title || "无标题"),
            el("b", null, typeof item.score === "number" ? item.score.toFixed(4) : "无分数"))))) : null);
    })));
}

function renderMemory(context, memory) {
  const hasContext = context && Object.keys(context).length;
  const hasMemory = memory && Object.keys(memory).length;
  if (!hasContext && !hasMemory) return stateView("empty", "本轮暂无记忆数据", "对话后显示订单栈、摘要与 Token 预算。 ");
  const blocks = Object.entries(context?.blocks || {});
  return el("div", { class: "aa-memory" },
    hasContext ? el("section", { class: "aa-inspector-card" }, el("h3", null, "Token 预算"),
      el("div", { class: "aa-memory-summary" }, el("strong", null, `${context.total ?? "—"} / ${context.budget ?? "—"} tokens`),
        el("span", null, `较全量节省 ${context.saved_pct ?? 0}%`)),
      blocks.length ? blocks.map(([name, block]) => {
        const percent = block.budget ? Math.min(100, Math.max(0, (block.tokens || 0) / block.budget * 100)) : 0;
        return el("details", { class: "aa-token-block" }, el("summary", null, el("span", null, BLOCKS[name] || name),
          el("b", null, `${block.tokens ?? "—"} / ${block.budget ?? "—"}`), el("em", null, block.truncated ? "已截断" : "完整")),
          el("div", { class: "aa-funnel-track" }, el("i", { style: { width: `${percent}%` } })),
          block.text ? el("pre", null, block.text) : el("p", { class: "aa-muted" }, "无注入文本"));
      }) : stateView("empty", "上下文分块本轮无数据")) : null,
    hasMemory ? el("section", { class: "aa-inspector-card" }, el("h3", null, "会话记忆"),
      memory.order_stack ? el("div", null, el("h4", null, "订单栈"), memory.order_stack.length ? el("ol", null,
        memory.order_stack.map((order) => el("li", null, el("code", null, order)))) : el("p", { class: "aa-muted" }, "空")) : null,
      el("dl", { class: "aa-kv-list" }, el("div", null, el("dt", null, "窗口轮数"),
        el("dd", null, Array.isArray(memory.turns) ? memory.turns.length : memory.turns ?? 0)),
        el("div", null, el("dt", null, "上一意图"), el("dd", null, INTENT[memory.last_intent] || memory.last_intent || "—"))),
      el("h4", null, "滑动窗口摘要"), el("p", null, memory.summary || "尚未产生摘要"),
      el("details", null, el("summary", null, "完整记忆快照"), jsonBlock(memory))) : null);
}

function renderVerification(result) {
  const verify = result?.verify && Object.keys(result.verify).length ? result.verify : result?.final?.verify;
  const comparisons = buildFeeComparisons(result);
  const results = result?.results || [];
  if (!verify && !results.length && !comparisons.length) return stateView("empty", "本轮暂无校验结果", "方案生成后展示金额、引用和论断依据。 ");
  const status = verificationState(verify || {});
  const refs = verify?.references || verify?.rule_refs || (result?.final?.options || []).flatMap((option) => option.rule_refs || []);
  const issues = [...(verify?.errors || []), ...results.map((item) => item.error).filter(Boolean)];
  return el("div", { class: "aa-verification" },
    el("p", { class: `aa-verification-status aa-verification-${status.kind}` }, status.label),
    el("div", { class: "aa-metrics" }, [["置信度", verify?.confidence], ["校验门槛", verify?.threshold],
      ["依据覆盖率", typeof verify?.support_ratio === "number" ? `${Math.round(verify.support_ratio * 100)}%` : undefined],
      ["自我修正", verify?.retries ?? result?.retries]].map(([label, value]) => el("div", null, el("span", null, label),
        el("strong", null, value ?? "本轮无数据")))),
    el("section", { class: "aa-inspector-card" }, el("h3", null, "金额比对（方案 vs 运价引擎）"),
      comparisons.length ? dataTable(["项目", "方案", "引擎", "结果"], comparisons.map((row) => [row.label, money(row.actual), money(row.expected),
        row.matched === true ? "一致" : row.matched === false ? "不一致" : "本轮无数据"])) : stateView("empty", "本轮没有需要比对的金额")),
    el("section", { class: "aa-inspector-card" }, el("h3", null, "论断与规则依据"),
      refs.length ? el("div", { class: "aa-rule-refs" }, refs.map((ref) => el("code", null, String(ref)))) : el("p", { class: "aa-muted" }, "本轮无引用依据"),
      verify?.unsupported_claims?.length ? el("ul", { class: "aa-issue-list" }, verify.unsupported_claims.map((claim) => el("li", null,
        typeof claim === "string" ? claim : JSON.stringify(claim)))) : null,
      verify?.bad_refs?.length ? el("p", { class: "aa-error-text" }, `无效引用：${verify.bad_refs.join("、")}`) : null),
    issues.length ? el("section", { class: "aa-inspector-card" }, el("h3", null, "校验问题"),
      el("ul", { class: "aa-issue-list" }, issues.map((issue) => el("li", null, String(issue))))) : null);
}

export function createInspector(host) {
  let record = null;
  let events = [];
  let activeTab = "flow";
  let selectedSubrequest = 0;
  let highlight = null;
  let pending = "";
  const body = el("div", { class: "aa-inspector-body", role: "tabpanel" });
  const caseLabel = el("code", null, "等待运行");
  const statusLabel = el("span", null, "READY");
  const tabList = el("div", { class: "aa-inspector-tabs", role: "tablist", "aria-label": "运行指标" },
    TABS.map(([id, label]) => el("button", { type: "button", role: "tab", dataset: { tab: id }, "aria-selected": id === activeTab,
      onclick: () => { activeTab = id; draw(); } }, label)));
  host.replaceChildren(el("aside", { class: "aa-inspector", "aria-label": "Agent 执行观测" },
    el("header", { class: "aa-inspector-header" }, el("div", null, el("p", { class: "aa-eyebrow" }, "RUN OBSERVABILITY"),
      el("h2", null, "执行观测"), caseLabel), statusLabel), tabList, body));

  function draw() {
    caseLabel.textContent = record?.case_id || "等待运行";
    statusLabel.textContent = record?.status || (pending ? "RUNNING" : "READY");
    tabList.querySelectorAll("[data-tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.tab === activeTab)));
    const data = record?.result || {};
    if (activeTab === "flow") body.replaceChildren(renderFlow(events, pending));
    else if (activeTab === "retrieval") body.replaceChildren(renderRetrieval(data.results || [], {
      selected: selectedSubrequest, highlight,
      onSelect: (index) => { selectedSubrequest = index; highlight = null; draw(); },
      onRule: (id) => { highlight = id; draw(); },
    }));
    else if (activeTab === "memory") body.replaceChildren(renderMemory(data.context, data.memory));
    else body.replaceChildren(renderVerification(data));
  }
  draw();
  return {
    update(nextRecord, trace) {
      record = nextRecord || null;
      events = trace || record?.result?.trace || [];
      selectedSubrequest = Math.min(selectedSubrequest, Math.max(0, (record?.result?.results || []).length - 1));
      pending = "";
      draw();
    },
    start(hint = "正在理解你的问题…") { record = null; events = []; pending = hint; activeTab = "flow"; draw(); },
    push(event) {
      const key = JSON.stringify([event.node, event.at, event.status]);
      if (!events.some((item) => JSON.stringify([item.node, item.at, item.status]) === key)) events = [...events, event];
      if (activeTab === "flow") draw();
    },
    reset() { record = null; events = []; pending = ""; highlight = null; selectedSubrequest = 0; draw(); },
    showRule(id) {
      const results = record?.result?.results || [];
      const index = results.findIndex((result) => (result.funnel || []).some((stage) => (stage.items || []).some((item) => item.id === id)));
      if (index >= 0) selectedSubrequest = index;
      highlight = id;
      activeTab = "retrieval";
      draw();
    },
    select(tab) { if (TABS.some(([id]) => id === tab)) { activeTab = tab; draw(); } },
  };
}
