// 按时间线展示 Agent 节点输入输出与耗时。
import type { TraceEvent } from '../api/client';

export default function TraceTimeline({ events }: { events: TraceEvent[] }) {
  if (!events.length) return <p className="observability-empty">本轮无数据</p>;
  return <ol className="trace-timeline">
    {events.map((event, index) => <li key={`${event.node}-${event.at ?? index}`} className={`trace-event ${event.status}`}>
      <span className="trace-event-marker" aria-hidden="true">{event.status === 'ok' ? '✓' : event.status === 'error' ? '!' : '·'}</span>
      <details>
        <summary><span><b>{event.node}</b><small>{event.note || event.status}</small></span>
          <span className="trace-event-time">{typeof event.ms === 'number' ? `${event.ms} ms` : '本轮无数据'}</span></summary>
        <div className="trace-event-body">
          <div><strong>输入</strong><pre>{event.input ? JSON.stringify(event.input, null, 2) : '本轮无数据'}</pre></div>
          <div><strong>输出</strong><pre>{event.output ? JSON.stringify(event.output, null, 2) : '本轮无数据'}</pre></div>
        </div>
      </details>
    </li>)}
  </ol>;
}
