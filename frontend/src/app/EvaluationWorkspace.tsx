import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import EvaluationResults from './EvaluationResults';

type EvalCase = { id: string; question: string; expect: Record<string, unknown>; [key: string]: unknown };
type Run = { run_id: string; status: string; mode: string; progress?: { completed?: number; total?: number }; report?: any; created_at?: string };
function validate(raw: string): EvalCase[] {
  const cases = JSON.parse(raw);
  if (!Array.isArray(cases)) throw new Error('评测集必须是 JSON 数组');
  const ids = cases.map((item: any) => item?.id);
  if (ids.some((id: unknown) => typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))) throw new Error('每条用例必须包含有效 id');
  if (new Set(ids).size !== ids.length) throw new Error('评测用例 ID 不能重复');
  if (cases.some((item: any) => typeof item.question !== 'string' || !item.expect || typeof item.expect !== 'object')) throw new Error('每条用例必须包含 question 和 expect');
  return cases;
}

export default function EvaluationWorkspace() {
  const [raw, setRaw] = useState('[]'); const [version, setVersion] = useState(''); const [search, setSearch] = useState('');
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]); const [activeRun, setActiveRun] = useState<Run | null>(null); const [compareId, setCompareId] = useState(''); const [compareRun, setCompareRun] = useState<Run | null>(null);
  const [mode, setMode] = useState<'offline' | 'deepseek'>('offline'); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  let cases: EvalCase[] = []; try { cases = JSON.parse(raw); } catch { /* editor shows malformed draft */ }
  const filtered = useMemo(() => cases.filter((item) => `${item.id} ${item.title ?? ''} ${item.question}`.toLowerCase().includes(search.toLowerCase())), [raw, search]);
  async function refreshRuns() { const data = await api<{ runs: Run[] }>('/admin/evaluations?view=runs'); setRuns(data.runs); }
  useEffect(() => { void api<{ cases: EvalCase[]; version: string }>('/admin/evaluations?view=cases').then((data) => { setRaw(JSON.stringify(data.cases, null, 2)); setVersion(data.version); }).catch((e) => setNotice(e.message));
    void refreshRuns().catch((e) => setNotice(e.message)); }, []);
  useEffect(() => { if (!activeRun || ['SUCCEEDED', 'FAILED'].includes(activeRun.status)) return;
    const timer = window.setInterval(() => { void api<Run>(`/admin/evaluations?view=run&run_id=${encodeURIComponent(activeRun.run_id)}`).then(setActiveRun).catch((e) => setNotice(e.message));
      void refreshRuns().catch(() => {}); }, 900); return () => window.clearInterval(timer);
  }, [activeRun?.run_id, activeRun?.status]);
  useEffect(() => { if (!compareId) { setCompareRun(null); return; }
    void api<Run>(`/admin/evaluations?view=run&run_id=${encodeURIComponent(compareId)}`).then(setCompareRun).catch((e) => setNotice(e.message));
  }, [compareId]);

  async function saveCases(): Promise<boolean> {
    try { const parsed = validate(raw); setSelectedCaseIds((ids) => ids.filter((id) => parsed.some((item) => item.id === id)));
      const saved = await api<{ version: string; count: number }>('/admin/evaluations/cases', { method: 'PUT', body: JSON.stringify({ cases: parsed }) });
      setVersion(saved.version); setNotice(`已保存 ${saved.count} 条用例 · 版本 ${saved.version}`); return true;
    } catch (error) { setNotice((error as Error).message); return false; }
  }
  async function runEval() {
    if (!(await saveCases())) return;
    setBusy(true); try { const started = await api<Run>('/admin/evaluations/runs', { method: 'POST', body: JSON.stringify({ mode, case_ids: selectedCaseIds.length ? selectedCaseIds : undefined }) });
      const run = { ...started, mode }; setActiveRun(run); setNotice(`评测运行已排队：${started.run_id}`); await refreshRuns();
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  function importFile(file?: File) { if (!file) return; const reader = new FileReader(); reader.onload = () => { try { validate(String(reader.result)); setRaw(String(reader.result)); setNotice(`已导入 ${file.name}，保存前不会覆盖服务端版本`); } catch (error) { setNotice((error as Error).message); } }; reader.readAsText(file); }
  function exportCases() { try { const blob = new Blob([JSON.stringify(validate(raw), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'evaluation-cases.json'; link.click(); URL.revokeObjectURL(url); } catch (error) { setNotice((error as Error).message); } }
  const selectedRun = activeRun ?? runs[0] ?? null;
  return <section className="admin-workspace page-enter"><WorkspaceHeading eyebrow="OFFLINE EVAL" title="评测工作区" detail="编辑标准用例，运行真实 Agent 评测，并追踪指标、失败原因和逐例 Trace。" />
    {notice && <p className="workspace-notice" role="status">{notice}</p>}
    <div className="workspace-toolbar"><span>评测集版本：{version || '读取中'} · {cases.length} 条</span><label className="select-label">运行模式<select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="offline">规则离线模式</option><option value="deepseek">DeepSeek 模式</option></select></label>
      <label className="secondary-button file-button">导入 JSON<input aria-label="导入评测集 JSON" type="file" accept="application/json,.json" onChange={(e) => importFile(e.target.files?.[0])} /></label>
      <button type="button" className="secondary-button" onClick={exportCases}>导出 JSON</button><button type="button" className="secondary-button" onClick={() => void saveCases()}>保存评测集</button>
      <button type="button" className="primary-button" disabled={busy || !cases.length} onClick={() => void runEval()}>{busy ? '提交中…' : '运行规则评测'}</button></div>
    {mode === 'deepseek' && <p className="workspace-notice">DeepSeek 评测需要先在“配置”工作区设置 API Key 并完成连通性检查；未配置时服务端会拒绝运行，规则离线模式不受影响。</p>}
    <div className="evaluation-admin-grid"><section className="workspace-card"><div className="workspace-section-head"><div><p className="eyebrow">CASE SET</p><h2>评测用例</h2></div><span>{filtered.length} 条</span></div>
      <input className="workspace-input" aria-label="搜索评测用例" placeholder="搜索 ID、标题或问题" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="admin-case-list">{filtered.map((item) => <div className="admin-case-option" key={item.id}>
        <label><input type="checkbox" aria-label={`选择评测用例 ${item.id}`} checked={selectedCaseIds.includes(item.id)} onChange={(e) => setSelectedCaseIds((ids) => e.target.checked ? [...new Set([...ids, item.id])] : ids.filter((id) => id !== item.id))} />
          <span><b>{item.id}</b><small>{String(item.title ?? item.question)}</small></span></label>
        <button type="button" aria-label={`筛选用例 ${item.id}`} onClick={() => setSearch(item.id)}>查看</button>
      </div>)}</div>
    </section><section className="workspace-card"><div className="workspace-section-head"><div><p className="eyebrow">CASE SET EDITOR</p><h2>完整用例 JSON</h2></div></div>
      <textarea className="workspace-json-editor" aria-label="评测集 JSON" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
      <p className="workspace-help">保留仓库用例字段 `id/title/tags/user_id/airline/fare_product/order/question/history/clarify_answers/expect/forbid`。非法数据不会覆盖已保存版本。</p>
    </section></div>
    <section className="workspace-card"><div className="workspace-section-head"><div><p className="eyebrow">RUN HISTORY</p><h2>运行历史与对比</h2></div><div className="run-compare-controls"><select aria-label="选择对比运行" value={compareId} onChange={(e) => setCompareId(e.target.value)}><option value="">选择对比运行</option>{runs.map((run) => <option key={run.run_id} value={run.run_id}>{run.run_id}</option>)}</select><button type="button" className="secondary-button" onClick={() => void refreshRuns()}>刷新</button></div></div>
      <div className="run-history-list">{runs.map((run) => <button type="button" key={run.run_id} className={selectedRun?.run_id === run.run_id ? 'selected' : ''} onClick={() => { setActiveRun(run); if (run.report?.summary) return; void api<Run>(`/admin/evaluations?view=run&run_id=${encodeURIComponent(run.run_id)}`).then(setActiveRun).catch((e) => setNotice(e.message)); }}><b>{run.run_id}</b><span>{run.mode} · {run.status}</span><small>{run.progress?.completed ?? 0}/{run.progress?.total ?? 0}</small></button>)}</div>
      {selectedRun && <p className="run-progress">运行状态：{selectedRun.status} · {selectedRun.progress?.completed ?? 0}/{selectedRun.progress?.total ?? 0} · 数据集版本 {selectedRun.report?.case_set_version ?? version}</p>}
      <EvaluationResults run={selectedRun} compare={compareRun} />
    </section>
  </section>;
}

function WorkspaceHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <header className="workspace-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{detail}</p></header>;
}
