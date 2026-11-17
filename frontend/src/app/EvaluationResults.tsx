// 展示评测指标、失败原因、运行对比与逐例结果。
type Props = { run: any; compare?: any; onSelectCase?: (id: string) => void };
const metricLabels: Record<string, string> = { n: '样本数', correctness: '业务正确率', tool_acc: '工具准确率', policy_hit: '票规命中率',
  human_rate: '转人工率', latency_avg_ms: '平均耗时 ms', latency_p95_ms: 'P95 耗时 ms', tokens_avg: '平均 Token' };

export default function EvaluationResults({ run, compare, onSelectCase }: Props) {
  const report = run?.report ?? {};
  const summary = report.summary ?? {};
  const rows: any[] = report.results ?? [];
  const groups: Record<string, any> = summary.by_group ?? {};
  return <div className="eval-results">
    {Object.keys(summary).length ? <>
      <div className="eval-metric-grid">{Object.entries(metricLabels).filter(([key]) => summary[key] !== undefined).map(([key, label]) =>
        <div className="workspace-metric" key={key}><span>{label}</span><strong>{typeof summary[key] === 'number' && key.includes('rate') || key === 'correctness' || key === 'tool_acc' || key === 'policy_hit' || key === 'human_rate'
          ? `${Math.round(summary[key] * 100)}%` : String(summary[key])}</strong></div>)}</div>
      <div className="eval-analysis-grid">
        <section className="workspace-card"><h3>航司 × 票种分组</h3><div className="eval-heatmap">{Object.entries(groups).map(([name, value]: [string, any]) =>
          <div key={name} style={{ opacity: .45 + Math.min(1, value.rate ?? 0) * .55 }}><span>{name}</span><b>{value.passed}/{value.n}</b></div>)}</div>
          {!Object.keys(groups).length && <p className="workspace-empty">本次运行未返回分组指标</p>}</section>
        <section className="workspace-card"><h3>失败原因</h3>{Object.entries(summary.failure_reasons ?? {}).length
          ? Object.entries(summary.failure_reasons).map(([reason, count]) => <div className="reason-row" key={reason}><span>{reason}</span><b>{String(count)}</b></div>)
          : <p className="workspace-empty">没有失败原因</p>}</section>
      </div>
      {compare && <section className="workspace-card"><h3>与运行 {compare.run_id} 对比</h3><div className="compare-grid">
        {['correctness', 'tool_acc', 'policy_hit', 'latency_avg_ms', 'tokens_avg'].map((key) => {
          const a = summary[key]; const b = compare.report?.summary?.[key];
          return <div key={key}><span>{metricLabels[key]}</span><b>{a ?? '—'}</b><i>{b ?? '—'}</i><small>{typeof a === 'number' && typeof b === 'number' ? (a - b).toFixed(4) : '—'}</small></div>;
        })}</div></section>}
      <section className="workspace-card"><h3>逐用例结果 · {rows.length}</h3><div className="eval-result-table">
        {rows.map((item) => <details key={item.case_id}><summary><b>{item.case_id}</b><span>{item.title || item.group}</span><strong className={item.passed ? 'status-good' : 'status-bad'}>{item.passed ? '通过' : '失败'}</strong></summary>
          <div className="eval-case-detail"><pre>{JSON.stringify({ expected: item.expected, actual: item.actual, reasons: item.reasons, ms: item.ms, tokens: item.tokens, trace: item.trace }, null, 2)}</pre>
            {onSelectCase && <button type="button" className="text-button" onClick={() => onSelectCase(item.case_id)}>查看完整 Trace</button>}</div></details>)}
      </div></section>
    </> : <p className="workspace-empty">尚无完成的评测报告</p>}
  </div>;
}
