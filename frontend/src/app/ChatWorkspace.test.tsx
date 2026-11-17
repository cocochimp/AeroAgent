import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { localStorage.clear(); });

describe('learning workbench chat', () => {
  it('loads API bookings, switches server identity and confirms only after an explicit click', async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; body?: any }> = [];
    let caseReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, auth: headers.get('Authorization'), body });
      if (url.endsWith('/orders')) return json({
        orders: [{ order_id: 'ORD1', user_id: 'u_zhang', passenger: '张三', flight_no: 'MU5101', date: '2026-11-20',
          airline: 'MU', cabin: 'Y', fare_product: 'Y_DISCOUNT', fare: 500, tax: 50, status: 'ISSUED',
          flight: { origin_city: '杭州', dest_city: '北京', dep_time: '09:00', status: 'scheduled', delay_min: 0 },
          eligibility: { change: { allowed: true, reason: '票规允许改签' }, refund: { allowed: true, reason: '票规允许退票' } } }],
        users: [{ user_id: 'u_zhang', name: '张三', tier: '金卡' }, { user_id: 'u_li', name: '李四', tier: '银卡' }], profiles: [],
      });
      if (url.endsWith('/cases') && method === 'POST') return json({ case_id: 'case-1', status: 'OPEN' }, 202);
      if (url.includes('/cases/case-1/events') && url.includes('after=3-0')) return new Response(
        'id: 4-0\nevent: fulfillment.completed\ndata: {"operation_id":"op-1","status":"REFUNDED"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
      if (url.includes('/cases/case-1/events')) return new Response([
        'id: 1-0\nevent: case.trace\ndata: {"node":"tool_rule_retrieve","status":"ok","ms":2,"output":{"rule_ids":["MU-Y_DISCOUNT-RFD"]}}\n\n',
        'id: 2-0\nevent: quote.offered\ndata: {"quote":{"quote_id":"q-1","action":"REFUND","amount":400,"currency":"CNY","status":"OFFERED","expires_at":"2026-11-12T12:00:00Z","details":[{"title":"退票方案","rule_refs":["MU-Y_DISCOUNT-RFD"],"fee_items":[{"name":"退票费","amount":150},{"name":"机场建设费退还","amount":50}]}]}}\n\n',
        'id: 3-0\nevent: case.proposed\ndata: {"status":"WAITING_CONFIRMATION"}\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      if (url.endsWith('/cases/case-1')) { caseReads += 1; return json({ case_id: 'case-1', status: caseReads > 1 ? 'COMPLETED' : 'WAITING_CONFIRMATION',
        result: { final: { text: '可退票，预计退款 400 元。' }, trace: [], results: [], context: {}, memory: {}, verify: {} },
        quotes: [{ quote_id: 'q-1', action: 'REFUND', amount: 400, currency: 'CNY', status: 'OFFERED',
          expires_at: '2026-11-12T12:00:00Z', details: [{ title: '退票方案', rule_refs: ['MU-Y_DISCOUNT-RFD'],
            fee_items: [{ name: '退票费', amount: 150 }, { name: '机场建设费退还', amount: 50 }] }] }] }); }
      if (url.endsWith('/quotes/q-1/confirm')) return json({ status: 'ACCEPTED', operation_id: 'op-1' }, 202);
      return json({});
    }));

    render(<App />);
    expect(await screen.findByText('MU5101')).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/orders') && call.auth === 'Bearer demo:u_zhang')).toBe(true);
    for (const page of ['对话', '评测', '规则', '数据', '配置']) {
      expect(screen.getByRole('button', { name: page })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole('button', { name: '乘客模式' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/orders')
      && call.auth === 'Bearer demo-admin:u_zhang')).toBe(true));
    fireEvent.change(screen.getByLabelText('当前用户'), { target: { value: 'u_li' } });
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/orders')
      && call.auth === 'Bearer demo-admin:u_li')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '对话' }));
    fireEvent.click(screen.getByRole('button', { name: /改签 \+ 退票/ }));
    expect(await screen.findByText('可退票，预计退款 400 元。')).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/quotes/q-1/confirm'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /确认退票/ }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/quotes/q-1/confirm')
      && call.method === 'POST')).toBe(true));
    expect(await screen.findByText(/办理完成/)).toBeTruthy();
    expect(calls.some((call) => call.url.includes('/cases/case-1/events?after=3-0'))).toBe(true);
  });
});


it('stops at fulfillment.result_unknown and shows that the result needs verification', async () => {
  let eventRequests = 0;
  let caseReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/orders')) return json({ orders: [
      { order_id: 'ORD1', user_id: 'u_zhang', passenger: '张三', flight_no: 'MU5101', date: '2026-11-20', airline: 'MU',
        cabin: 'Y', fare_product: 'Y', fare: 500, tax: 50, status: 'ISSUED', flight: { origin_city: '杭州', dest_city: '北京',
        dep_time: '09:00', status: 'scheduled', delay_min: 0 }, eligibility: { change: { allowed: true }, refund: { allowed: true } } },
    ] });
    if (url.endsWith('/cases') && init.method === 'POST') return json({ case_id: 'case-unknown' }, 202);
    if (url.includes('/cases/case-unknown/events')) {
      eventRequests += 1;
      return new Response(
        'id: 9-0\nevent: fulfillment.result_unknown\ndata: {"operation_id":"op-unknown","status":"TIMEOUT","message":"航司响应超时，办理结果待核对","retryable":true}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/cases/case-unknown')) {
      caseReads += 1;
      return json({ case_id: 'case-unknown', order_id: 'ORD1', status: 'RESULT_UNKNOWN',
        result: { final: { text: '航司响应超时，办理结果待核对' }, trace: [], results: [], context: {}, memory: {}, verify: {} }, quotes: [] });
    }
    return json({});
  }));

  render(<App />);
  await screen.findByText('MU5101');
  fireEvent.change(screen.getByLabelText('描述退改需求'), { target: { value: '请办理退票' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));

  expect(await screen.findByText('结果待核对 · 航司暂未返回明确办理结果，请核对订单状态')).toBeTruthy();
  await waitFor(() => {
    expect(caseReads).toBe(1);
    expect(eventRequests).toBe(1);
    expect((screen.getByLabelText('描述退改需求') as HTMLTextAreaElement).disabled).toBe(false);
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(caseReads).toBe(1);
  expect(eventRequests).toBe(1);
  expect(screen.queryByText(/主 Agent 正在编排/)).toBeNull();
  expect(screen.queryByText(/事件连接失败/)).toBeNull();
});


it('routes the cancellation and human-handoff shortcuts through the case API', async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, method, body });
    if (url.endsWith('/orders')) return json({ orders: [
      { order_id: 'ORD1', user_id: 'u_zhang', passenger: '张三', flight_no: 'MU5101', date: '2026-11-20', airline: 'MU',
        cabin: 'Y', fare_product: 'Y', fare: 500, tax: 50, status: 'ISSUED', flight: { origin_city: '杭州', dest_city: '北京',
        dep_time: '09:00', status: 'scheduled', delay_min: 0 }, eligibility: { change: { allowed: true }, refund: { allowed: true } } },
      { order_id: 'ORD-CANCEL', user_id: 'u_zhang', passenger: '张三', flight_no: 'MU5111', date: '2026-11-21', airline: 'MU',
        cabin: 'Y', fare_product: 'Y', fare: 500, tax: 50, status: 'ISSUED', flight: { origin_city: '北京', dest_city: '杭州',
        dep_time: '10:00', status: 'cancelled', delay_min: 0 }, eligibility: { change: { allowed: true }, refund: { allowed: true } } },
    ] });
    if (url.endsWith('/cases') || url.endsWith('/messages')) return json({ case_id: 'case-1' }, 202);
    if (url.includes('/events')) return new Response('id: 1-0\nevent: case.proposed\ndata: {"status":"HUMAN_REVIEW"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.endsWith('/cases/case-1')) return json({ case_id: 'case-1', status: 'HUMAN_REVIEW',
      result: { final: { text: '已转人工处理' }, trace: [], results: [], context: {}, memory: {}, verify: {} }, quotes: [] });
    return json({});
  }));
  render(<App />);
  await screen.findByText('MU5101');
  fireEvent.click(screen.getByRole('button', { name: /航班取消/ }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/cases') && call.body?.order_id === 'ORD-CANCEL'
    && call.body?.message.includes('航班取消'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /转人工/ }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/cases/case-1/messages')
    && call.body?.message.includes('人工客服'))).toBe(true));
});
