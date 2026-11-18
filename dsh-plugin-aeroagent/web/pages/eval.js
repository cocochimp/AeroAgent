import { el, isAbort, notice, pageHeader, stateView } from "../components.js";

export function validateEvaluationCases(raw) {
  const cases = JSON.parse(raw);
  if (!Array.isArray(cases)) throw new Error("评测集必须是 JSON 数组");
  const ids = cases.map((item) => item?.id);
  if (ids.some((id) => typeof id !== "string" || !/^[\w-]{1,64}$/.test(id))) throw new Error("每条用例必须包含有效 id");
  if (new Set(ids).size !== ids.length) throw new Error("评测用例 ID 不能重复");
  if (cases.some((item) => typeof item?.question !== "string" || !item.question || !item.expect || typeof item.expect !== "object" || Array.isArray(item.expect))) {
    throw new Error("每条用例必须包含 question 和 expect");
  }
  return cases;
}

const METRICS = { n: "样本数", correctness: "业务正确率", tool_acc: "工具准确率", policy_hit: "票规命中率",
  human_rate: "转人工率", latency_avg_ms: "平均耗时 ms", latency_p95_ms: "P95 耗时 ms", tokens_avg: "平均 Token" };
const terminal = (status) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status);

export async function mount({ outlet, api, store, signal, isCurrent }) {
  const userId = store.getUserId();
  const auth = { userId, admin: true, signal };
  let version = "";
  let runs = [];
  let activeRun = null;
  let viewedRunId = null;
  let runningRunId = null;
  let runningRunStatus = null;
  let viewGeneration = 0;
  let compareRun = null;
  let selected = new Set();
  let mode = "offline";
  let generation = 0;
  let pollGeneration = 0;
  let pollTimer = null;
  let startingRun = false;
  const caseList = el("div", { class: "aa-eval-case-list" }, stateView("loading", "正在读取评测用例…"));
  const history = el("div", { class: "aa-run-history" }, stateView("loading", "正在读取运行历史…"));
  const result = el("section", { class: "aa-card aa-eval-result" }, stateView("empty", "尚无评测报告"));
  const noticeHost = el("div");
  const versionLabel = el("span", null, "版本读取中");
  const editor = el("textarea", { class: "aa-json-editor", "aria-label": "评测集 JSON", spellcheck: "false" }, "[]");
  const search = el("input", { class: "aa-input", type: "search", "aria-label": "搜索评测用例", placeholder: "ID / 标题 / 问题" });
  const modeSelect = el("select", { class: "aa-input", "aria-label": "评测模式" },
    el("option", { value: "offline" }, "规则离线模式"), el("option", { value: "deepseek" }, "DeepSeek 模式"));
  const compare = el("select", { class: "aa-input", "aria-label": "选择对比运行" }, el("option", { value: "" }, "选择对比运行"));
  const file = el("input", { type: "file", accept: "application/json,.json", "aria-label": "导入评测集 JSON", hidden: true });
  const runButton = el("button", { type: "button", class: "aa-button aa-button-primary", onclick: () => runEvaluation() }, "保存并运行");

  function setNotice(message, kind = "info") { noticeHost.replaceChildren(message ? notice(message, kind) : ""); }
  function currentCases() { try { return validateEvaluationCases(editor.value); } catch { return []; } }

  function drawCases() {
    const cases = currentCases();
    const query = search.value.trim().toLowerCase();
    const filtered = cases.filter((item) => [item.id, item.title, item.question].some((value) => String(value || "").toLowerCase().includes(query)));
    if (!cases.length) { caseList.replaceChildren(stateView("empty", editor.value.trim() === "[]" ? "评测集为空" : "JSON 暂无法解析", "在右侧编辑、导入或保存有效用例。 ")); return; }
    if (!filtered.length) { caseList.replaceChildren(stateView("empty", "没有匹配的用例")); return; }
    caseList.replaceChildren(...filtered.map((item) => el("div", { class: "aa-eval-case" },
      el("label", null, el("input", { type: "checkbox", checked: selected.has(item.id), "aria-label": `选择评测用例 ${item.id}`,
        onchange: (event) => { if (event.target.checked) selected.add(item.id); else selected.delete(item.id); } }),
        el("span", null, el("code", null, item.id), el("strong", null, item.title || item.question), el("small", null, item.question))),
      el("button", { type: "button", class: "aa-text-button", onclick: () => { search.value = item.id; drawCases(); } }, "查看"))));
  }

  function syncRunButton() {
    runButton.disabled = startingRun || Boolean(runningRunId && !terminal(runningRunStatus));
  }

  function updateExecution(run) {
    if (!run || runningRunId !== run.run_id) return;
    runningRunStatus = run.status;
    if (terminal(run.status)) runningRunId = null;
  }

  function renderRun(run) {
    activeRun = run;
    viewedRunId = run?.run_id || null;
    updateExecution(run);
    syncRunButton();
    const report = run?.report || {};
    const summary = report.summary || {};
    const rows = report.results || [];
    if (!run) { result.replaceChildren(el("h2", null, "运行结果"), stateView("empty", "尚无完成的评测报告")); return; }
    result.replaceChildren(el("div", { class: "aa-section-header" }, el("h2", null, `运行 ${run.run_id}`),
      el("span", { class: "aa-chip" }, `${run.status} · ${run.progress?.completed ?? 0}/${run.progress?.total ?? 0}`)),
      Object.keys(summary).length ? el("div", { class: "aa-metric-grid" }, Object.entries(METRICS).filter(([key]) => summary[key] !== undefined).map(([key, label]) =>
        el("div", null, el("span", null, label), el("strong", null, ["correctness", "tool_acc", "policy_hit", "human_rate"].includes(key)
          ? `${Math.round(summary[key] * 100)}%` : String(summary[key]))))) : stateView("empty", "本次运行尚未返回汇总指标"),
      compareRun ? el("section", { class: "aa-compare" }, el("h3", null, `与 ${compareRun.run_id} 对比`),
        ...["correctness", "tool_acc", "policy_hit", "latency_avg_ms", "tokens_avg"].map((key) => el("div", null,
          el("span", null, METRICS[key]), el("b", null, summary[key] ?? "—"), el("i", null, compareRun.report?.summary?.[key] ?? "—"),
          el("small", null, typeof summary[key] === "number" && typeof compareRun.report?.summary?.[key] === "number"
            ? `Δ ${(summary[key] - compareRun.report.summary[key]).toFixed(4)}` : "—")))) : null,
      Object.keys(summary.failure_reasons || {}).length ? el("section", null, el("h3", null, "失败原因"),
        Object.entries(summary.failure_reasons).map(([reason, count]) => el("p", { class: "aa-reason" }, `${reason}：${count}`))) : null,
      rows.length ? el("section", null, el("h3", null, `逐用例结果 · ${rows.length}`), rows.map((item) => el("details", { class: "aa-eval-detail" },
        el("summary", null, el("code", null, item.case_id), el("span", null, item.title || item.group || ""),
          el("strong", { class: item.passed ? "aa-success-text" : "aa-error-text" }, item.passed ? "通过" : "失败")),
        el("pre", { class: "aa-json" }, JSON.stringify({ expected: item.expected, actual: item.actual, reasons: item.reasons,
          ms: item.ms, tokens: item.tokens, trace: item.trace }, null, 2))))) : stateView("empty", "本次运行没有逐例结果"));
  }

  function drawHistory() {
    compare.replaceChildren(el("option", { value: "" }, "选择对比运行"), ...runs.map((run) => el("option", { value: run.run_id }, run.run_id)));
    if (!runs.length) { history.replaceChildren(stateView("empty", "还没有运行记录", "选择用例和模式后开始运行。 ")); return; }
    history.replaceChildren(...runs.map((run) => el("button", { type: "button", class: activeRun?.run_id === run.run_id ? "aa-run-row selected" : "aa-run-row",
      onclick: () => openRun(run.run_id) }, el("code", null, run.run_id), el("span", null, `${run.mode} · ${run.status}`),
      el("small", null, `${run.progress?.completed ?? 0}/${run.progress?.total ?? 0}`))));
  }

  async function refreshRuns() {
    const data = await api.get("/admin/evaluations?view=runs", auth);
    if (!isCurrent()) return;
    runs = data.runs || []; drawHistory();
  }

  async function openRun(runId) {
    const ownView = ++viewGeneration;
    try {
      const run = await api.get(`/admin/evaluations?view=run&run_id=${encodeURIComponent(runId)}`, auth);
      if (!isCurrent() || ownView !== viewGeneration) return;
      renderRun(run); drawHistory();
      if (!terminal(run.status)) {
        if (!runningRunId) { runningRunId = runId; runningRunStatus = run.status; syncRunButton(); }
        if (runningRunId === runId) poll(runId);
      }
    } catch (error) { if (!isAbort(error, signal) && ownView === viewGeneration) setNotice(error.message, "error"); }
  }

  async function poll(runId, own = ++pollGeneration) {
    clearTimeout(pollTimer);
    const wait = () => new Promise((resolve) => { pollTimer = setTimeout(resolve, 900); });
    while (isCurrent() && own === pollGeneration && !signal.aborted) {
      await wait();
      if (!isCurrent() || own !== pollGeneration) return;
      try {
        const run = await api.get(`/admin/evaluations?view=run&run_id=${encodeURIComponent(runId)}`, auth);
        if (!isCurrent() || own !== pollGeneration) return;
        if (viewedRunId === runId) renderRun(run);
        else { updateExecution(run); syncRunButton(); }
        if (terminal(run.status)) { await refreshRuns(); return; }
      } catch (error) { if (!isAbort(error, signal)) setNotice(error.message, "error"); return; }
    }
  }

  async function saveCases() {
    try {
      const cases = validateEvaluationCases(editor.value);
      selected = new Set([...selected].filter((id) => cases.some((item) => item.id === id)));
      const saved = await api.put("/admin/evaluations/cases", { cases }, auth);
      if (!isCurrent()) return false;
      version = saved.version; versionLabel.textContent = `版本 ${version} · ${cases.length} 条`;
      setNotice(`已保存 ${saved.count} 条用例 · 版本 ${saved.version}`); drawCases(); return true;
    } catch (error) { setNotice(error.message, "error"); return false; }
  }

  async function runEvaluation() {
    if (startingRun || (runningRunId && !terminal(runningRunStatus))) return;
    startingRun = true;
    syncRunButton();
    try {
      if (!(await saveCases())) return;
      if (!currentCases().length) throw new Error("评测集为空");
      const started = await api.post("/admin/evaluations/runs", { mode, case_ids: selected.size ? [...selected] : null }, auth);
      if (!isCurrent()) return;
      runningRunId = started.run_id;
      runningRunStatus = started.status;
      activeRun = { ...started, mode, progress: started.progress || { completed: 0, total: currentCases().length }, report: started.report || {} };
      renderRun(activeRun);
      setNotice(`评测运行已排队：${started.run_id}`);
      await refreshRuns();
      if (!isCurrent()) return;
      openRun(started.run_id);
    } catch (error) { setNotice(error.message, "error"); }
    finally { startingRun = false; if (isCurrent()) syncRunButton(); }
  }

  file.addEventListener("change", () => {
    const selectedFile = file.files?.[0];
    if (!selectedFile) return;
    const reader = new FileReader();
    reader.onload = () => { if (!isCurrent()) return; try { const cases = validateEvaluationCases(String(reader.result)); editor.value = JSON.stringify(cases, null, 2);
      setNotice(`已导入 ${selectedFile.name}；保存前不会覆盖服务端版本`); drawCases(); } catch (error) { setNotice(error.message, "error"); } };
    reader.onerror = () => setNotice("无法读取导入文件", "error"); reader.readAsText(selectedFile);
  });
  search.addEventListener("input", drawCases);
  modeSelect.addEventListener("change", () => { mode = modeSelect.value; if (mode === "deepseek") setNotice("DeepSeek 运行由服务端校验配置；未配置时会明确失败，不会回退为 mock。", "warning"); });
  compare.addEventListener("change", async () => {
    compareRun = null;
    if (compare.value) {
      try { compareRun = await api.get(`/admin/evaluations?view=run&run_id=${encodeURIComponent(compare.value)}`, auth); }
      catch (error) { if (!isAbort(error, signal)) setNotice(error.message, "error"); }
    }
    if (isCurrent()) renderRun(activeRun);
  });

  const root = el("section", { class: "aa-page aa-eval-page" },
    pageHeader("LEARNING / EVALUATION", "评测中心", "搜索、编辑、导入导出并运行真实评测；失败可逐例展开。",
      el("button", { type: "button", class: "aa-button", onclick: () => file.click() }, "导入 JSON"),
      el("button", { type: "button", class: "aa-button", onclick: () => { try { const blob = new Blob([JSON.stringify(validateEvaluationCases(editor.value), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob); const link = el("a", { href: url, download: "evaluation-cases.json" }); link.click(); URL.revokeObjectURL(url); }
        catch (error) { setNotice(error.message, "error"); } } }, "导出 JSON"),
      el("button", { type: "button", class: "aa-button", onclick: () => saveCases() }, "保存"), runButton),
    noticeHost, el("div", { class: "aa-toolbar" }, search, modeSelect, versionLabel), file,
    el("div", { class: "aa-learning-grid" }, el("section", { class: "aa-card" }, el("h2", null, "评测用例"), caseList),
      el("section", { class: "aa-card" }, el("h2", null, "完整用例 JSON"), editor,
        el("p", { class: "aa-muted" }, "非法 JSON 不会覆盖服务端版本。DeepSeek 是否可用由服务端判断。"))),
    el("section", { class: "aa-card" }, el("div", { class: "aa-section-header" }, el("h2", null, "运行历史"), compare), history), result);
  outlet.replaceChildren(root);

  const own = ++generation;
  try {
    const [caseData] = await Promise.all([api.get("/admin/evaluations?view=cases", auth), refreshRuns()]);
    if (!isCurrent() || own !== generation) return;
    editor.value = JSON.stringify(caseData.cases || [], null, 2); version = caseData.version || "seed";
    versionLabel.textContent = `版本 ${version} · ${(caseData.cases || []).length} 条`; drawCases();
    if (runs[0]) await openRun(runs[0].run_id); else renderRun(null);
  } catch (error) {
    if (isAbort(error, signal) || !isCurrent()) return;
    caseList.replaceChildren(stateView("error", "评测数据加载失败", error.message));
    history.replaceChildren(stateView("error", "运行历史加载失败", error.message));
  }
  return () => { generation += 1; viewGeneration += 1; pollGeneration += 1; clearTimeout(pollTimer); };
}
