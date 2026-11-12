type Block = { tokens?: number; budget?: number; truncated?: boolean; text?: string };
type ContextData = { total?: number; budget?: number; saved_pct?: number; blocks?: Record<string, Block> } | undefined;
type MemoryData = Record<string, unknown> | undefined;

export default function MemoryInspector({ context, memory }: { context: ContextData; memory: MemoryData }) {
  const hasData = !!context || !!memory;
  if (!hasData) return <p className="observability-empty">本轮无数据</p>;
  const blocks = Object.entries(context?.blocks ?? {});
  return <div className="memory-inspector">
    <div className="memory-summary">
      <strong>{typeof context?.total === 'number' ? context.total : '本轮无数据'} / {typeof context?.budget === 'number' ? context.budget : '本轮无数据'} tokens</strong>
      <span>{typeof context?.saved_pct === 'number' ? `较全量节省 ${context.saved_pct}%` : '本轮无数据'}</span>
    </div>
    {blocks.length ? <div className="memory-blocks" aria-label="上下文 Token 分块">{blocks.map(([name, block]) => {
      const pct = block.budget ? Math.min(100, (block.tokens ?? 0) / block.budget * 100) : 0;
      return <details className="memory-block" key={name}>
        <summary><span>{name}</span><b>{typeof block.tokens === 'number' ? block.tokens : '本轮无数据'} / {typeof block.budget === 'number' ? block.budget : '本轮无数据'}</b>
          {block.truncated === true && <em>已截断</em>}</summary>
        <div className="funnel-track"><i style={{ width: `${pct}%` }} /></div>
        {block.text && <pre>{block.text}</pre>}
      </details>;
    })}</div> : <p className="observability-empty">上下文分块：本轮无数据</p>}
    {memory && <details className="memory-state"><summary>会话记忆快照</summary><pre>{JSON.stringify(memory, null, 2)}</pre></details>}
  </div>;
}
