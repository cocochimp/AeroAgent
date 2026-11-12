import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setToken, tokenFor } from '../api/client';
import EvaluationWorkspace from './EvaluationWorkspace';
import RulesWorkspace from './RulesWorkspace';
import DataWorkspace from './DataWorkspace';
import ConfigWorkspace from './ConfigWorkspace';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { localStorage.clear(); setToken(tokenFor('u_zhang', true)); });
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('admin learning workspaces', () => {
  it('filters and validates evaluation cases before save, then starts a scoped run', async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); const method = init.method ?? 'GET'; const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/admin/evaluations?view=cases')) return json({ version: 'v1', cases: [
        { id: 'C1', title: '退票测试', question: '帮我退票', expect: { intents: ['REFUND'] } },
        { id: 'C2', title: '改签测试', question: '改签到明天', expect: { intents: ['CHANGE'] } },
      ] });
      if (url.endsWith('/admin/evaluations?view=runs')) return json({ runs: [] });
      if (url.endsWith('/admin/evaluations/cases') && method === 'PUT') return json({ version: 'v2', count: body.cases.length });
      if (url.endsWith('/admin/evaluations/runs') && method === 'POST') return json({ run_id: 'run-1', status: 'QUEUED' }, 202);
      return json({ runs: [] });
    }));
    render(<EvaluationWorkspace />);
    expect(await screen.findByText('退票测试')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索评测用例'), { target: { value: '改签' } });
    expect(screen.getByText('改签测试')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('选择评测用例 C2'));
    const editor = screen.getByLabelText('评测集 JSON');
    fireEvent.change(editor, { target: { value: JSON.stringify([{ id: 'DUP', question: 'a', expect: {} }, { id: 'DUP', question: 'b', expect: {} }]) } });
    fireEvent.click(screen.getByRole('button', { name: '保存评测集' }));
    expect(await screen.findByText('评测用例 ID 不能重复')).toBeTruthy();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    fireEvent.change(editor, { target: { value: JSON.stringify([
      { id: 'C1', title: '退票测试', question: '帮我退票', expect: { intents: ['REFUND'] } },
      { id: 'C2', title: '改签测试', question: '改签到明天', expect: { intents: ['CHANGE'] } },
    ]) } });
    fireEvent.click(screen.getByRole('button', { name: '运行规则评测' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/admin/evaluations/cases') && call.method === 'PUT')).toBe(true));
    expect(calls.some((call) => call.url.endsWith('/admin/evaluations/runs') && call.method === 'POST'
      && call.body.mode === 'offline' && call.body.case_ids?.[0] === 'C2')).toBe(true);
  });

  it('imports a valid case file and compares two persisted run reports', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/admin/evaluations?view=cases')) return json({ version: 'v1', cases: [] });
      if (url.endsWith('/admin/evaluations?view=runs')) return json({ runs: [
        { run_id: 'run-a', status: 'SUCCEEDED', mode: 'offline', progress: { completed: 1, total: 1 } },
        { run_id: 'run-b', status: 'SUCCEEDED', mode: 'offline', progress: { completed: 1, total: 1 } },
      ] });
      if (url.includes('run_id=run-a')) return json({ run_id: 'run-a', status: 'SUCCEEDED', mode: 'offline', report: {
        summary: { n: 1, correctness: .75, tool_acc: .8, policy_hit: 1, human_rate: 0, latency_avg_ms: 100, latency_p95_ms: 100, tokens_avg: 50, by_group: {}, failure_reasons: { wrong_tools: 1 } }, results: [] } });
      if (url.includes('run_id=run-b')) return json({ run_id: 'run-b', status: 'SUCCEEDED', mode: 'offline', report: {
        summary: { n: 1, correctness: .9, tool_acc: .9, policy_hit: 1, human_rate: 0, latency_avg_ms: 80, latency_p95_ms: 80, tokens_avg: 45, by_group: {}, failure_reasons: {} }, results: [] } });
      return json({});
    }));
    render(<EvaluationWorkspace />);
    const fileInput = screen.getByLabelText('导入评测集 JSON');
    const invalidFile = new File([JSON.stringify([{ id: 'DUP', question: 'a', expect: {} }, { id: 'DUP', question: 'b', expect: {} }])], 'invalid.json', { type: 'application/json' });
    fireEvent.change(fileInput, { target: { files: [invalidFile] } });
    expect(await screen.findByText('评测用例 ID 不能重复')).toBeTruthy();
    expect((screen.getByLabelText('评测集 JSON') as HTMLTextAreaElement).value).toBe('[]');
    const file = new File([JSON.stringify([{ id: 'I1', title: '导入测试', question: '查询', expect: { outcome: 'ANSWER' } }])], 'cases.json', { type: 'application/json' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect((screen.getByLabelText('评测集 JSON') as HTMLTextAreaElement).value).toContain('导入测试'));
    fireEvent.click(await screen.findByRole('button', { name: /run-a/ }));
    expect(await screen.findByText('75%')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('选择对比运行'), { target: { value: 'run-b' } });
    expect(await screen.findByText(/与运行 run-b 对比/)).toBeTruthy();
    expect(calls.some((url) => url.includes('run_id=run-b'))).toBe(true);
  });

  it('loads rule debug matches and saves inactive rule through API', async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); const method = init.method ?? 'GET'; const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.includes('/admin/rules')) return json({ rules: [{ id: 'R1', airline: 'MU', cabin: '*', fare_product: 'Y', scenario: 'VOLUNTARY_REFUND', title: '退款规则', content: '按票规计算', active: true, version: 2 }], debug: { result_count: 1, retrieval: { query: '自愿退票', backend: 'fallback', funnel: [{ stage: 'dense', label: '向量召回', k: 60, count: 1, items: [{ id: 'R1', score: .9 }] }] } } });
      if (method === 'PUT') return json({ rule: { id: 'R1', version: 3, active: false } });
      return json({});
    }));
    render(<RulesWorkspace />);
    expect(await screen.findByText('退款规则')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索规则'), { target: { value: '自愿退票' } });
    fireEvent.click(screen.getByRole('button', { name: '检索规则' }));
    expect(await screen.findByText('向量召回')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停用规则' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/admin/rules/R1')
      && call.body.active === false)).toBe(true));
  });

  it('sets cancelled flight, clears profile and confirms demo reset via orders API', async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
      if (url.endsWith('/orders')) return json({ orders: [{ order_id: 'O1', user_id: 'u_zhang', passenger: '张三', flight_no: 'MU1', date: '2026-11-20', status: 'ISSUED', flight: { status: 'scheduled' } }],
        users: [{ user_id: 'u_zhang', name: '张三', tier: '金卡' }], profiles: [{ user_id: 'u_zhang', name: '张三', tier: '金卡', data: {} }] });
      return json({ action: body?.action, result: {} });
    }));
    render(<DataWorkspace onNotice={() => {}} />);
    await screen.findByText(/MU1/);
    fireEvent.click(screen.getByRole('button', { name: '设置航班取消' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/orders') && call.body?.action === 'set_flight_status'
      && call.body.status === 'cancelled')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '清理画像' }));
    await waitFor(() => expect(calls.some((call) => call.body?.action === 'clear_profile')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '重置演示数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }));
    await waitFor(() => expect(calls.some((call) => call.body?.action === 'reset_demo_data')).toBe(true));
  });

  it('masks secrets and rejects invalid config without sending it to the server', async () => {
    const calls: Array<{ method: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      void input;
      calls.push({ method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (!init.method || init.method === 'GET') return json({ mode: 'offline', llm: { base_url: 'https://example.test', api_key: 'abcd****wxyz', model: 'demo' }, memory: { token_budget: 3000 }, retrieval: { k_recall: 60 } });
      return json({ config: { mode: 'offline' } });
    }));
    render(<ConfigWorkspace />);
    const editor = await screen.findByLabelText('运行配置 JSON') as HTMLTextAreaElement;
    expect(editor.value).toContain('****');
    fireEvent.change(editor, { target: { value: '{"memory":{"token_budget":10}}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByText(/不能小于/)).toBeTruthy();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});
