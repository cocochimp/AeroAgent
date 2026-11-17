// 检索、调试并维护票规及其启停状态。
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import RetrievalFunnel from './RetrievalFunnel';

type Rule = { id: string; airline: string; cabin: string; fare_product: string; scenario: string; title: string; content: string; active: boolean; version: number };
const scenarios = ['VOLUNTARY_CHANGE', 'VOLUNTARY_REFUND', 'CANCEL', 'DELAY', 'NO_SHOW', 'FARE_DIFF'];
export default function RulesWorkspace() {
  const [rules, setRules] = useState<Rule[]>([]); const [selectedId, setSelectedId] = useState(''); const [query, setQuery] = useState('');
  const [airline, setAirline] = useState(''); const [scenario, setScenario] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [retrievalDebug, setRetrievalDebug] = useState<any>(null);
  const selected = rules.find((item) => item.id === selectedId);
  async function load() { setBusy(true); try { const params = new URLSearchParams({ debug: 'true' }); if (query) params.set('q', query); if (airline) params.set('airline', airline); if (scenario) params.set('scenario', scenario);
    const response = await api<{ rules: Rule[]; debug?: { result_count: number; retrieval?: any } }>(`/admin/rules?${params}`); setRules(response.rules); setSelectedId((id) => response.rules.some((x) => x.id === id) ? id : response.rules[0]?.id ?? ''); setRetrievalDebug(response.debug?.retrieval ?? null); setNotice(`服务端命中 ${response.debug?.result_count ?? response.rules.length} 条规则`);
  } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } }
  useEffect(() => { void load(); }, []);
  function update(patch: Partial<Rule>) { if (selected) setRules((items) => items.map((item) => item.id === selected.id ? { ...item, ...patch } : item)); }
  async function save(active = selected?.active ?? true) { if (!selected) return; setBusy(true);
    try { const body = { airline: selected.airline, cabin: selected.cabin, fare_product: selected.fare_product,
      scenario: selected.scenario, title: selected.title, content: selected.content, active };
      const response = await api<{ rule: { version: number; active: boolean } }>(`/admin/rules/${selected.id}`, { method: 'PUT', body: JSON.stringify(body) });
      setRules((items) => items.map((item) => item.id === selected.id ? { ...item, ...response.rule } : item)); setNotice(`已保存 ${selected.id} · v${response.rule.version}`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  return <section className="admin-workspace page-enter"><header className="workspace-heading"><p className="eyebrow">POLICY RULES</p><h1>规则检索与维护</h1><p>按航司、票种和场景筛选服务端规则；停用规则保留版本和审计记录。</p></header>
    {notice && <p className="workspace-notice" role="status">{notice}</p>}
    <div className="workspace-toolbar"><input className="workspace-input" aria-label="搜索规则" placeholder="搜索规则内容或标题" value={query} onChange={(e) => setQuery(e.target.value)} />
      <input className="workspace-input short" aria-label="筛选航司" placeholder="航司代码" value={airline} onChange={(e) => setAirline(e.target.value)} />
      <select aria-label="筛选场景" value={scenario} onChange={(e) => setScenario(e.target.value)}><option value="">所有场景</option>{scenarios.map((x) => <option key={x}>{x}</option>)}</select>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void load()}>检索规则</button></div>
    {query && <section className="workspace-card rule-retrieval-debug"><div className="workspace-section-head"><div><p className="eyebrow">RETRIEVAL DEBUG</p><h2>真实检索漏斗</h2></div><span>{retrievalDebug?.backend ?? '等待检索'}</span></div>
      {retrievalDebug ? <RetrievalFunnel results={[{ text: retrievalDebug.query, funnel: retrievalDebug.funnel }]} config={{}} /> : <p className="workspace-empty">点击“检索规则”查看 dense / BM25 / RRF / rerank / MMR / inject 各阶段结果。</p>}</section>}
    <div className="rules-admin-grid"><section className="workspace-card"><div className="workspace-section-head"><h2>规则清单</h2><button type="button" className="secondary-button" onClick={() => {
      const id = `CUSTOM-${Date.now().toString(36).toUpperCase()}`; setRules((items) => [{ id, airline: '*', cabin: '*', fare_product: '*', scenario: 'VOLUNTARY_CHANGE', title: '新规则', content: '', active: false, version: 0 }, ...items]); setSelectedId(id);
    }}>新增规则</button></div>
      <div className="admin-case-list">{rules.map((rule) => <button type="button" key={rule.id} className={rule.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(rule.id)}>
        <b>{rule.id}</b><span>{rule.title}</span><small>{rule.airline} · {rule.fare_product} · v{rule.version} · {rule.active ? '启用' : '停用'}</small></button>)}</div>
      {!rules.length && <p className="workspace-empty">没有匹配规则</p>}</section>
      <section className="workspace-card"><div className="workspace-section-head"><div><p className="eyebrow">RULE EDITOR</p><h2>{selected?.id ?? '选择规则'}</h2></div>{selected && <span>版本 {selected.version}</span>}</div>
        {selected ? <div className="workspace-form-grid"><label>航司<input value={selected.airline} onChange={(e) => update({ airline: e.target.value })} /></label><label>舱位<input value={selected.cabin} onChange={(e) => update({ cabin: e.target.value })} /></label>
          <label>票价产品<input value={selected.fare_product} onChange={(e) => update({ fare_product: e.target.value })} /></label><label>场景<select value={selected.scenario} onChange={(e) => update({ scenario: e.target.value })}>{scenarios.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label className="span-all">标题<input value={selected.title} onChange={(e) => update({ title: e.target.value })} /></label><label className="span-all">规则正文<textarea value={selected.content} onChange={(e) => update({ content: e.target.value })} /></label>
          <div className="workspace-action-row"><button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存规则'}</button>
            {selected.active && <button className="secondary-button danger-action" type="button" disabled={busy} onClick={() => void save(false)}>停用规则</button>}
            {!selected.active && <button className="secondary-button" type="button" disabled={busy} onClick={() => void save(true)}>重新启用</button>}</div>
        </div> : <p className="workspace-empty">请选择一条服务端规则</p>}</section></div>
  </section>;
}
