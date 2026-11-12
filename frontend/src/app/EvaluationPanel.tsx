import { useEffect, useMemo, useState } from 'react';
import { evaluateCases, validateEvaluationCases, type EvalReport, type EvaluationCase } from '../demo/service';

type Props = { cases: EvaluationCase[]; onSave: (cases: EvaluationCase[]) => void; onReset: () => void };

export default function EvaluationPanel({ cases, onSave, onReset }: Props) {
  const [draftCases, setDraftCases] = useState(cases);
  const [selectedId, setSelectedId] = useState(cases[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [question, setQuestion] = useState('');
  const [intents, setIntents] = useState('');
  const [report, setReport] = useState<EvalReport | null>(null);
  const [notice, setNotice] = useState('');

  const selected = draftCases.find((item) => item.id === selectedId);
  const filtered = useMemo(() => draftCases.filter((item) =>
    `${item.id} ${item.question}`.toLowerCase().includes(search.toLowerCase())), [draftCases, search]);

  useEffect(() => {
    setDraftCases(cases);
  }, [cases]);

  useEffect(() => {
    setQuestion(selected?.question ?? '');
    setIntents(selected?.expect?.intents?.join(', ') ?? '');
  }, [selectedId, draftCases]);

  function applyDraft(source = draftCases): EvaluationCase[] {
    if (!selected) return source;
    return source.map((item) => item.id === selected.id ? {
      ...item,
      question,
      expect: { ...item.expect, intents: intents.split(',').map((value) => value.trim()).filter(Boolean) },
    } : item);
  }

  function saveCurrent() {
    const updated = applyDraft();
    const errors = validateEvaluationCases(updated);
    if (errors.length) { setNotice(errors[0]); return; }
    onSave(updated);
    setDraftCases(updated);
    setNotice(`已保存 ${updated.length} 条评测用例`);
  }

  function addCase() {
    const id = `demo-${Date.now()}`;
    const updated = [...applyDraft(), { id, question: '', expect: { intents: [] } }];
    setDraftCases(updated);
    setSelectedId(id);
    setNotice('已新增用例，请填写问题和预期意图');
  }

  function deleteCase() {
    if (!selected) return;
    const updated = draftCases.filter((item) => item.id !== selected.id);
    setDraftCases(updated);
    setSelectedId(updated[0]?.id ?? '');
    setNotice('用例已删除');
    setReport(null);
  }

  function runEvaluation() {
    const updated = applyDraft();
    const errors = validateEvaluationCases(updated);
    if (errors.length) { setNotice(errors[0]); return; }
    onSave(updated);
    setDraftCases(updated);
    const result = evaluateCases(updated);
    setReport(result);
    setNotice(`评测完成：${result.passed}/${result.total} 条通过`);
  }

  return <div className="evaluation-workspace">
    <div className="eval-toolbar">
      <div><p className="eyebrow">RULE MODE · OFFLINE EVAL</p><h2>评测集管理</h2><p>修改后保存在本机浏览器；规则模式按预期意图统计，不调用 DeepSeek。</p></div>
      <div className="eval-actions">
        <button className="secondary-button" onClick={() => { onReset(); setReport(null); setNotice('已恢复仓库内置评测集'); }}>恢复内置</button>
        <button className="secondary-button" onClick={saveCurrent}>保存评测集</button>
        <button className="primary-button eval-run-button" onClick={runEvaluation}>运行规则评测 <span>→</span></button>
      </div>
    </div>

    {notice && <div className="eval-notice" role="status">{notice}</div>}

    {report && <div className="eval-summary panel">
      <div><span>通过率</span><strong>{report.total ? Math.round(report.passed / report.total * 100) : 0}%</strong></div>
      <div><span>通过</span><strong>{report.passed}</strong></div>
      <div><span>失败</span><strong className={report.failed.length ? 'error-text' : ''}>{report.failed.length}</strong></div>
      <div><span>总数</span><strong>{report.total}</strong></div>
    </div>}

    <div className="eval-grid">
      <section className="panel eval-list-panel">
        <div className="section-head"><div><p className="eyebrow">CASES</p><h3>{draftCases.length} 条用例</h3></div><button className="secondary-button" onClick={addCase}>＋ 新增</button></div>
        <input className="eval-search" aria-label="搜索评测用例" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按问题或 ID 搜索" />
        <div className="eval-case-list">{filtered.map((item) => <button key={item.id} className={item.id === selectedId ? 'eval-case-row selected' : 'eval-case-row'} onClick={() => setSelectedId(item.id)}>
          <strong>{item.id}</strong><span>{item.question || '（未填写问题）'}</span><small>{item.expect.intents?.join(' + ') || '无明确退改意图'}</small>
        </button>)}</div>
        {filtered.length === 0 && <div className="empty-state">没有匹配用例</div>}
      </section>

      <section className="panel eval-editor-panel">
        <div className="section-head"><div><p className="eyebrow">CASE EDITOR</p><h3>{selected?.id ?? '选择一条用例'}</h3></div>{selected && <button className="text-button danger-text" onClick={deleteCase}>删除用例</button>}</div>
        {!selected ? <div className="empty-state">新增或选择一条用例开始编辑</div> : <>
          <label className="field-label" htmlFor="eval-question">用户问题</label>
          <textarea id="eval-question" className="eval-textarea question-input" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：帮我把机票改签到后天" />
          <label className="field-label" htmlFor="eval-intents">预期意图 <span>逗号分隔：CHANGE、REFUND</span></label>
          <input id="eval-intents" className="eval-search" value={intents} onChange={(event) => setIntents(event.target.value)} placeholder="CHANGE, REFUND" />
          <div className="eval-shape-note">保留原评测集 `id / question / expect` 结构；其他字段会随保存一并保留。</div>
          <button className="secondary-button" onClick={saveCurrent}>保存当前用例</button>
        </>}
      </section>
    </div>

    {report?.failed.length ? <section className="panel eval-failures"><div className="section-head"><div><p className="eyebrow">NEEDS ATTENTION</p><h3>未通过用例</h3></div><span className="count-pill">{report.failed.length}</span></div>
      {report.failed.slice(0, 12).map((item) => <div className="failed-case-row" key={item.id}><strong>{item.id}</strong><span>{item.question}</span><small>预期 {item.expected.join('+') || '无'} · 实际 {item.actual.join('+') || '无'}</small></div>)}
    </section> : null}
  </div>;
}
