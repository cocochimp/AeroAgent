import { useEffect, useMemo, useRef, useState } from 'react';
import { api, newRequestId, streamEvents, type CaseResult, type DemoUser, type Order, type Quote, type TraceEvent } from '../api/client';
import ExecutionPanel from './ExecutionPanel';

type Props = { orders: Order[]; userId: string; user?: DemoUser; loading: boolean; isAdmin: boolean;
  onRefresh: () => Promise<void>; onNotice: (notice: string) => void };
type CaseRecord = CaseResult & { question: string };
const quickActions = [
  { label: '改签差价', prompt: '帮我改签到后天，差价和手续费分别是多少？' },
  { label: '改签 + 退票', prompt: '改签到后天要多少钱？如果退票又能退多少？' },
  { label: '航班取消', prompt: '航班取消了，帮我办理退票' },
  { label: '指代追问', prompt: '那回程那张呢？' },
  { label: '模糊日期', prompt: '改到下个月初' },
  { label: '转人工', prompt: '请帮我转人工客服' },
];

function money(amount?: number) { return typeof amount === 'number' ? `¥${amount.toLocaleString('zh-CN')}` : '—'; }
function flightStatus(order: Order) { return order.flight?.status === 'cancelled' ? '已取消' : order.flight?.status === 'delayed' ? `延误 ${order.flight.delay_min} 分钟` : '正常'; }
function terminal(type: string) { return ['case.proposed', 'case.failed', 'case.cancelled', 'quote.revised',
  'fulfillment.completed', 'fulfillment.rejected'].includes(type); }

export default function ChatWorkspace({ orders, userId, user, loading, isAdmin, onRefresh, onNotice }: Props) {
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [input, setInput] = useState('');
  const [activeCase, setActiveCase] = useState<CaseRecord | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const lastEventId = useRef('');
  const activeOrder = orders.find((order) => order.order_id === selectedOrderId) ?? orders[0];
  const openQuotes = useMemo(() => activeCase?.quotes.filter((quote) => quote.status === 'OFFERED') ?? [], [activeCase]);
  const assistantText = activeCase?.result.final?.text ?? '';

  useEffect(() => {
    setSelectedOrderId(orders.find((order) => order.user_id === userId)?.order_id ?? orders[0]?.order_id ?? '');
  }, [orders, userId]);
  useEffect(() => {
    setActiveCase(null); setTrace([]); setInput(''); lastEventId.current = '';
    controller.current?.abort();
  }, [userId]);
  useEffect(() => () => controller.current?.abort(), []);

  async function loadCase(caseId: string, question: string) {
    try {
      const record = await api<CaseResult>(`/cases/${caseId}`);
      setActiveCase({ ...record, question });
      setTrace(record.result.trace ?? []);
    } catch (error) { onNotice((error as Error).message); }
  }

  async function followCase(caseId: string, question: string, initialCursor = '') {
    controller.current?.abort();
    const aborter = new AbortController(); controller.current = aborter;
    setBusy(true);
    try {
      await streamEvents(`/cases/${caseId}/events`, async (type, data, id) => {
        if (id) lastEventId.current = id;
        if (type === 'case.trace') setTrace((items) => [...items, data as TraceEvent]);
        if (type === 'quote.offered' || type === 'quote.revised') {
          const quote = data.quote as Quote;
          setActiveCase((record) => record ? { ...record, status: 'WAITING_CONFIRMATION',
            quotes: [...record.quotes.filter((item) => item.quote_id !== quote.quote_id), quote] } : record);
        }
        if (type === 'case.failed') onNotice(data.message || '本轮处理未完成');
        if (type === 'fulfillment.completed') onNotice('交易 Agent 已完成办理，结果已写入演示订单。');
        if (type === 'fulfillment.rejected') onNotice('办理复核未通过，案件已转人工处理。');
        if (terminal(type)) {
          await loadCase(caseId, question);
          if (type === 'fulfillment.completed') await onRefresh();
          setBusy(false);
          return true;
        }
        return false;
      }, aborter.signal, initialCursor);
    } catch (error) { if (!aborter.signal.aborted) onNotice((error as Error).message); }
    finally { if (!aborter.signal.aborted) setBusy(false); }
  }

  async function sendMessage(message = input, forcedOrderId?: string) {
    const text = message.trim(); if (!text || busy) return;
    const orderId = forcedOrderId ?? activeOrder?.order_id;
    if (!activeCase && !orderId) { onNotice('请先选择一张客票'); return; }
    setInput(''); onNotice('已提交，正在运行 Agent 流程…');
    setBusy(true); setTrace([]);
    try {
      let caseId = activeCase?.case_id;
      if (caseId) {
        await api(`/cases/${caseId}/messages`, { method: 'POST', body: JSON.stringify({ message: text }) });
        setActiveCase((record) => record ? { ...record, question: text } : record);
      } else {
        const created = await api<{ case_id: string }>('/cases', { method: 'POST',
          body: JSON.stringify({ message: text, order_id: orderId }) });
        caseId = created.case_id;
        setActiveCase({ case_id: caseId, order_id: orderId ?? null, status: 'OPEN', question: text,
          result: {}, quotes: [] });
      }
      if (caseId) void followCase(caseId, text);
    } catch (error) { setBusy(false); onNotice((error as Error).message || '提交案件失败'); }
  }

  async function confirmQuote(quote: Quote) {
    if (!activeCase || busy) return;
    setBusy(true); onNotice('正在按报价复核金额并提交办理…');
    try {
      const result = await api<{ status: string; operation_id?: string }>(`/quotes/${quote.quote_id}/confirm`, {
        method: 'POST', body: JSON.stringify({ confirmation_id: newRequestId('confirm'),
          idempotency_key: newRequestId('ticket') }),
      });
      setActiveCase((record) => record ? { ...record, status: result.status === 'ACCEPTED' ? 'PROCESSING' : result.status,
        quotes: record.quotes.map((item) => item.quote_id === quote.quote_id ? { ...item, status: 'CONFIRMED' } : item) } : record);
      onNotice(result.status === 'ACCEPTED' ? '确认成功，正在等待交易 Agent 返回办理结果…' : `办理状态：${result.status}`);
      if (result.status === 'ACCEPTED') await followCase(activeCase.case_id, activeCase.question, lastEventId.current);
    } catch (error) {
      const body = (error as Error & { body?: { error?: { details?: { quote_id?: string; amount?: number } } } }).body;
      if (body?.error?.details?.quote_id) await loadCase(activeCase.case_id, activeCase.question);
      onNotice((error as Error).message || '确认办理失败');
    } finally { setBusy(false); }
  }

  function chooseAction(action: typeof quickActions[number]) {
    let order = activeOrder;
    if (action.label === '航班取消') order = orders.find((item) => item.flight?.status === 'cancelled') ?? activeOrder;
    if (order) setSelectedOrderId(order.order_id);
    void sendMessage(action.prompt, order?.order_id);
  }

  return <section className="chat-workspace page-enter">
    <div className="chat-heading"><div><p className="eyebrow">AGENT LEARNING WORKBENCH</p><h1>机票退改签全链路</h1>
      <p>从识别诉求到规则核验、报价确认和交易执行，逐步观察 Agent 如何完成办理。</p></div>
      <div className="run-state"><i className={busy ? 'busy' : ''} />{busy ? '运行中' : activeCase ? activeCase.status : '就绪'}</div>
    </div>
    <div className="demo-banner"><strong>规则模式 · 演示数据</strong><span>所有订单和办理结果均为虚构数据；确认报价后才会写入演示交易记录。</span></div>
    <div className="learning-grid">
      <section className="booking-column surface">
        <header className="surface-header"><div><p className="eyebrow">BOOKINGS</p><h2>{isAdmin ? '演示客票' : '我的客票'}</h2></div><span className="count-pill">{orders.length} 张</span></header>
        {loading ? <p className="empty-state">正在读取服务端订单…</p> : orders.length ? <div className="booking-list">
          {orders.map((order) => <article key={order.order_id} className={`booking-card ${activeOrder?.order_id === order.order_id ? 'selected' : ''}`}>
            <button type="button" className="booking-select" onClick={() => setSelectedOrderId(order.order_id)}>
              <span className="booking-top"><b>{order.flight_no}</b><span className={`flight-status ${order.flight?.status}`}>{flightStatus(order)}</span></span>
              <span className="booking-route">{order.flight?.origin_city ?? order.flight?.origin} <i>→</i> {order.flight?.dest_city ?? order.flight?.dest}</span>
              <span className="booking-meta">{order.date} · {order.flight?.dep_time} · {order.airline} · {order.fare_product}</span>
            </button>
            <div className="eligibility-summary">
              {(['change', 'refund'] as const).map((key) => {
                const item = order.eligibility?.[key];
                return <div key={key} className={item?.allowed ? 'eligible' : 'not-eligible'}>
                  <span>{key === 'change' ? '改签' : '退票'}{item?.allowed ? '可办理' : '不可办理'}</span>
                  <small>{item?.reason || '等待服务端规则核验'}</small>
                </div>;
              })}
            </div>
          </article>)}
        </div> : <p className="empty-state">此演示身份没有可见客票。</p>}
      </section>

      <section className="conversation-column surface">
        <header className="surface-header conversation-header"><div><p className="eyebrow">CASE ASSISTANT</p><h2>退改方案咨询</h2></div>
          <span className="backend-status"><i />API / Agent 在线</span></header>
        <div className="conversation-feed" aria-live="polite">
          {!activeCase ? <div className="welcome-card"><span className="welcome-glyph">✦</span>
            <h3>选择客票，发起一个真实流程</h3><p>Agent 会读取当前订单和规则；每一步会同步显示在右侧流程面板。</p>
          </div> : <div className="message-stack">
            <div className="message-row user-message"><span className="message-avatar">{user?.name.slice(0, 1) ?? '学'}</span>
              <div><small>{user?.name ?? '演示乘客'}</small><p>{activeCase.question}</p></div></div>
            {assistantText && <div className="message-row assistant-message"><span className="message-avatar">云</span>
              <div><small>主 Agent · 规则模式</small><p>{assistantText}</p></div></div>}
            {activeCase.status === 'HUMAN_REVIEW' && <div className="handoff-banner">已转人工处理：系统未找到足够规则依据，不会自动办理。</div>}
            {activeCase.status === 'COMPLETED' && <div className="completed-banner">办理完成 · 演示客票和交易记录已更新</div>}
          </div>}
          {busy && <div className="processing-row"><span className="spinner" />主 Agent 正在编排方案 Agent、规则检索与费用校验…</div>}
        </div>
        {openQuotes.map((quote) => <QuoteCard key={quote.quote_id} quote={quote} busy={busy} onConfirm={() => void confirmQuote(quote)} />)}
        <div className="composer-area">
          <div className="quick-actions" aria-label="快捷场景">
            {quickActions.map((item) => <button key={item.label} type="button" disabled={busy || !orders.length}
              onClick={() => chooseAction(item)}><span>↗</span>{item.label}</button>)}
          </div>
          <form className="message-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
            <textarea aria-label="描述退改需求" value={input} onChange={(event) => setInput(event.target.value)}
              placeholder="描述你的退改需求… Enter 发送，Shift + Enter 换行" disabled={busy || !orders.length}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} />
            <button type="submit" aria-label="发送" disabled={busy || !input.trim() || !orders.length}>↑</button>
          </form>
          <div className="composer-foot"><span>订单/票规/会员等级由服务端演示数据提供</span>
            <span>{activeCase ? `案件 ${activeCase.case_id}` : '未创建案件'}</span></div>
        </div>
      </section>

      <aside className="case-column">
        <section className="surface case-progress"><p className="eyebrow">CURRENT CASE</p><h2>办理链路</h2>
          <ol className="case-steps">
            <li className={activeCase ? 'complete' : 'active'}><i>1</i><span>识别诉求与客票</span></li>
            <li className={trace.length ? 'active' : ''}><i>2</i><span>核验票规与适用条件</span></li>
            <li className={openQuotes.length ? 'active' : ''}><i>3</i><span>生成报价并等待确认</span></li>
            <li className={activeCase?.status === 'COMPLETED' ? 'complete' : ''}><i>4</i><span>交易办理结果</span></li>
          </ol>
        </section>
        <section className="surface guard-card"><span className="guard-icon">✓</span><div><strong>确认保护</strong>
          <p>方案 Agent 只查询和报价。只有点击报价确认后，交易 Agent 才会提交办理。</p></div></section>
        {user && <section className="surface tier-card"><p className="eyebrow">MEMBER PROFILE</p>
          <strong>{user.name} · {user.tier}</strong><p>等级和画像用于解释个性化检索；票规资格仍按服务端当前规则判断。</p></section>}
        <ExecutionPanel result={activeCase} events={trace} config={{}} />
      </aside>
    </div>
  </section>;
}

function QuoteCard({ quote, busy, onConfirm }: { quote: Quote; busy: boolean; onConfirm: () => void }) {
  const detail = quote.details?.[0];
  return <article className="quote-card" aria-label={`${quote.action === 'REFUND' ? '退票' : '改签'}报价`}>
    <div className="quote-card-head"><div><p className="eyebrow">方案 Agent · 已核验规则</p><h3>{detail?.title || (quote.action === 'REFUND' ? '退票方案' : '改签方案')}</h3></div>
      <span className="quote-rule">{detail?.rule_refs?.[0] ?? '规则已匹配'}</span></div>
    <div className="quote-fees">{(detail?.fee_items ?? []).map((fee) => <div key={fee.name}><span>{fee.name}</span><strong>{money(fee.amount)}</strong></div>)}</div>
    <div className="quote-total"><span>{quote.action === 'REFUND' ? '预计退款' : '确认后应付'}</span><strong>{money(quote.amount)}</strong></div>
    <p className="quote-expiry">报价有效期至 {new Date(quote.expires_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 确认时会复核价格</p>
    <button type="button" className="confirm-action" disabled={busy} onClick={onConfirm}>确认{quote.action === 'REFUND' ? '退票' : '改签'} <span>→</span></button>
  </article>;
}
