import { describe, expect, it } from 'vitest';
import goldCases from '../../../eval/gold_cases.json';
import {
  classifyIntent,
  classifyEvaluationIntent,
  confirmQuote,
  createDemoState,
  evaluateCases,
  getEligibility,
  quoteOrder,
  startCase,
} from './service';

const NOW = new Date('2026-11-11T04:00:00.000Z');

describe('rule-mode ticket servicing', () => {
  it('shows group tickets as ineligible for voluntary refund and change', () => {
    const state = createDemoState(NOW);
    const groupTicket = state.orders.find((order) => order.fare_product === 'GROUP')!;
    const eligibility = getEligibility(groupTicket);

    expect(eligibility.change.allowed).toBe(false);
    expect(eligibility.refund.allowed).toBe(false);
    expect(eligibility.change.reason).toMatch(/团队票/);
  });

  it('recognizes one or both servicing intents without an LLM', () => {
    expect(classifyIntent('帮我改签到后天')).toEqual(['CHANGE']);
    expect(classifyIntent('退票，顺便看看改签要多少钱')).toEqual(['CHANGE', 'REFUND']);
    expect(classifyIntent('帮我改票并退掉')).toEqual(['CHANGE', 'REFUND']);
  });

  it('quotes rule-based fees and waives fees for a cancelled flight', () => {
    const state = createDemoState(NOW);
    const discountTicket = state.orders.find((order) => order.fare_product === 'Y_DISCOUNT')!;
    const change = quoteOrder(discountTicket, 'CHANGE', '2026-11-15', NOW);
    expect(change.allowed).toBe(true);
    expect(change.amount).toBeGreaterThanOrEqual(0);
    expect(change.ruleId).toContain('CHG');

    const cancelledTicket = state.orders.find((order) => order.flight.status === 'cancelled')!;
    const refund = quoteOrder(cancelledTicket, 'REFUND', null, NOW);
    expect(refund.allowed).toBe(true);
    expect(refund.amount).toBe(cancelledTicket.fare + cancelledTicket.tax);
    expect(refund.ruleId).toContain('CANCEL');
  });

  it('requires confirmation before changing the ticket state', () => {
    const initial = createDemoState(NOW);
    const user = initial.users[0];
    const order = initial.orders.find((item) => item.user_id === user.id)!;
    const draft = startCase(initial, user.id, order.order_id, '帮我改签到后天', NOW);
    const quote = draft.cases[0].quotes[0];
    expect(draft.orders.find((item) => item.order_id === order.order_id)?.status).toBe('ISSUED');

    const completed = confirmQuote(draft, draft.cases[0].case_id, quote.quote_id, NOW);
    expect(completed.cases[0].status).toBe('COMPLETED');
    expect(completed.orders.find((item) => item.order_id === order.order_id)?.status).toBe('CHANGED');
  });

  it('scores the existing evaluation case shape by expected intent', () => {
    const report = evaluateCases([
      { id: 'case-change', question: '帮我改签到后天', expect: { intents: ['CHANGE'] } },
      { id: 'case-refund', question: '这张机票退票能退多少', expect: { intents: ['REFUND'] } },
      { id: 'case-both', question: '改签到明天并看看退票金额', expect: { intents: ['CHANGE', 'REFUND'] } },
    ]);

    expect(report.total).toBe(3);
    expect(report.passed).toBe(3);
    expect(report.failed).toEqual([]);
  });

  it('evaluates flight status and policy questions in the existing gold set', () => {
    expect(classifyEvaluationIntent('这个航班现在什么情况')).toEqual(['STATUS']);
    expect(classifyEvaluationIntent('海岛航空团队票更改行程的规定')).toEqual(['POLICY']);
    expect(classifyEvaluationIntent('机上餐食可以选素食吗')).toEqual(['POLICY']);
  });

  it('passes the complete checked-in gold set for rule-mode intent recognition', () => {
    const report = evaluateCases(goldCases);
    expect(report.passed).toBe(65);
    expect(report.failed).toEqual([]);
  });
});
