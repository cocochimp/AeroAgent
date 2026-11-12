import { useRef, useState, type KeyboardEvent } from 'react';
import type { CaseResult, TraceEvent } from '../api/client';
import MemoryInspector from './MemoryInspector';
import RetrievalFunnel from './RetrievalFunnel';
import TraceTimeline from './TraceTimeline';
import VerificationPanel from './VerificationPanel';

export type RuntimeConfig = Record<string, any>;
type Props = { result: CaseResult | null; events: TraceEvent[]; config: RuntimeConfig };
const tabs = [
  { id: 'flow', label: '流程', icon: '⌘' }, { id: 'retrieval', label: '检索', icon: '▽' },
  { id: 'memory', label: '记忆', icon: '◉' }, { id: 'verify', label: '校验', icon: '◌' },
] as const;
type TabId = typeof tabs[number]['id'];

export default function ExecutionPanel({ result, events, config }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('flow');
  const [mobileOpen, setMobileOpen] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const data = result?.result;
  const results = Array.isArray(data?.results) ? data.results as Array<Record<string, any>> : [];

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    setActiveTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  }

  return <section className={`execution-panel surface ${mobileOpen ? 'mobile-open' : ''}`} aria-label="Agent 执行观测面板">
    <button className="execution-mobile-toggle" type="button" aria-expanded={mobileOpen}
      aria-controls="execution-panel-content" onClick={() => setMobileOpen((open) => !open)}>
      {mobileOpen ? '收起技术指标' : '查看技术指标'} <span aria-hidden="true">{mobileOpen ? '⌄' : '⌃'}</span>
    </button>
    <div id="execution-panel-content" className="execution-panel-content">
      <div className="execution-panel-heading"><div><p className="eyebrow">RUN OBSERVABILITY</p><h2>执行观测</h2></div>
        <span>{result?.case_id ?? '等待运行'}</span></div>
      <div className="execution-tabs" role="tablist" aria-label="运行指标">
        {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
          aria-controls={`execution-tab-${tab.id}`} id={`execution-tab-button-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1}
          ref={(node) => { tabRefs.current[index] = node; }} onClick={() => setActiveTab(tab.id)}
          onKeyDown={(event) => onTabKey(event, index)}><span aria-hidden="true">{tab.icon}</span>{tab.label}</button>)}
      </div>
      <div className="execution-panel-body" role="tabpanel" id={`execution-tab-${activeTab}`}
        aria-labelledby={`execution-tab-button-${activeTab}`}>
        {activeTab === 'flow' && <TraceTimeline events={events} />}
        {activeTab === 'retrieval' && <RetrievalFunnel results={results} config={config} />}
        {activeTab === 'memory' && <MemoryInspector context={data?.context as any} memory={data?.memory as any} />}
        {activeTab === 'verify' && <VerificationPanel verify={data?.verify} results={results} final={data?.final as any} retries={data?.retries} />}
      </div>
    </div>
  </section>;
}
