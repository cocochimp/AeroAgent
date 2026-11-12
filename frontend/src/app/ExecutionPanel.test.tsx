import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ExecutionPanel from './ExecutionPanel';
import type { CaseResult, TraceEvent } from '../api/client';

const result = {
  case_id: 'case-1', order_id: 'ORD-1', status: 'WAITING_CONFIRMATION',
  result: {
    results: [
      { intent: 'CHANGE', text: '改签到明天', funnel: [{ stage: 'dense', label: '向量召回', count: 8, k: 60, items: [{ id: 'R-CHG', score: 0.91 }] }],
        fee: { total: 120, rule_id: 'R-CHG' }, rules: [{ id: 'R-CHG', title: '改签规则' }] },
      { intent: 'REFUND', text: '退票', funnel: [{ stage: 'sparse', label: 'BM25 召回', count: 2, k: 60, items: [{ id: 'R-RFD', score: 0.8 }] }],
        fee: { refund_amount: 340, rule_id: 'R-RFD' }, rules: [{ id: 'R-RFD', title: '退票规则' }],
        error: '票规限制提示' },
    ],
    context: { total: 180, budget: 1200, blocks: { order: { tokens: 30, budget: 100, truncated: false }, history: { tokens: 150, budget: 300, truncated: true } } },
    retries: 1, final: { options: [{ type: 'CHANGE', rule_refs: ['R-CHG'] }, { type: 'REFUND', rule_refs: ['R-RFD'] }] },
    verify: { confidence: 0.92, threshold: 0.8, support_ratio: 1, passed: true,
      fee_comparison: [{ intent: 'CHANGE', expected: 120, actual: 120, matched: true }], errors: [] },
  }, quotes: [],
} as unknown as CaseResult;
const events: TraceEvent[] = [{ node: 'verify_node', status: 'ok', ms: 5, input: { intent: 'CHANGE' }, output: { passed: true } }];
afterEach(cleanup);

describe('execution observability panel', () => {
  it('shows backend funnel counts, configured caps, candidate ids and scores', () => {
    render(<ExecutionPanel result={result} events={events} config={{ retrieval: { k_recall: 60 } }} />);
    fireEvent.click(screen.getByRole('tab', { name: '检索' }));
    expect(screen.getByText('向量召回')).toBeTruthy();
    expect(screen.getByText('8 / 60')).toBeTruthy();
    expect(screen.getByText('R-CHG')).toBeTruthy();
    expect(screen.getByText('0.9100')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '退票' }));
    expect(screen.getByText('BM25 召回')).toBeTruthy();
    expect(screen.getByText('R-RFD')).toBeTruthy();
    expect(screen.queryByText('R-CHG')).toBeNull();
  });

  it('shows actual trace, token blocks and verification fields', () => {
    render(<ExecutionPanel result={result} events={events} config={{}} />);
    expect(screen.getByText('verify_node')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '记忆' }));
    expect(screen.getByText('180 / 1200 tokens')).toBeTruthy();
    expect(screen.getByText('history')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '校验' }));
    expect(screen.getByText('0.92')).toBeTruthy();
    expect(screen.getByText('R-CHG')).toBeTruthy();
    expect(screen.getByText('一致')).toBeTruthy();
    expect(screen.getByText('票规限制提示')).toBeTruthy();
  });

  it('does not fabricate metrics for an empty case and tabs work by keyboard', () => {
    render(<ExecutionPanel result={null} events={[]} config={{}} />);
    const processTab = screen.getByRole('tab', { name: '流程' });
    processTab.focus();
    fireEvent.keyDown(processTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '检索' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: '记忆' }));
    expect(screen.getAllByText('本轮无数据').length).toBeGreaterThan(0);
  });
});
