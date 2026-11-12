import React from 'react';

type FunnelStage = { stage?: string; label?: string; count?: number; k?: number | null; items?: Array<{ id?: string; title?: string; score?: number }> };
type SubResult = { intent?: string; text?: string; funnel?: FunnelStage[] };
const labelByIntent: Record<string, string> = { CHANGE: '改签', REFUND: '退票', STATUS: '航班查询', CANCEL: '航班取消' };

export default function RetrievalFunnel({ results, config }: { results: SubResult[]; config: Record<string, any> }) {
  const [selected, setSelected] = React.useState(0);
  React.useEffect(() => setSelected((value) => Math.min(value, Math.max(0, results.length - 1))), [results.length]);
  const current = results[selected];
  const stages = current?.funnel ?? [];
  const configured = config.retrieval ?? {};
  return <div className="retrieval-inspector">
    {results.length > 1 && <div className="subrequest-switch" aria-label="选择子诉求">{results.map((item, index) =>
      <button type="button" key={`${item.intent}-${index}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>
        {labelByIntent[item.intent ?? ''] ?? `子诉求 ${index + 1}`}</button>)}</div>}
    {!stages.length ? <p className="observability-empty">本轮无数据</p> : <>
      <div className="funnel-stages">{stages.map((stage, index) => {
        const cap = stage.k ?? configured[stage.stage ?? ''];
        const pct = typeof cap === 'number' && cap > 0 ? Math.min(100, (stage.count ?? 0) / cap * 100) : 0;
        return <div className="funnel-stage" key={`${stage.stage}-${index}`}>
          <div className="funnel-stage-head"><span>{stage.label ?? stage.stage ?? '阶段'}</span>
            <b>{typeof stage.count === 'number' ? stage.count : '本轮无数据'}{typeof cap === 'number' ? ` / ${cap}` : ''}</b></div>
          <div className="funnel-track" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
          {!!stage.items?.length && <ul className="candidate-list">{stage.items.map((item, itemIndex) => <li key={`${item.id}-${itemIndex}`}>
            <span><code>{item.id ?? '本轮无数据'}</code>{item.title && <small>{item.title}</small>}</span>
            <b>{typeof item.score === 'number' ? item.score.toFixed(4) : '本轮无数据'}</b>
          </li>)}</ul>}
        </div>;
      })}</div>
      {current?.text && <p className="subrequest-caption">当前子诉求：{current.text}</p>}
    </>}
  </div>;
}

