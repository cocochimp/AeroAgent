export type DemoAction = 'CHANGE' | 'REFUND';
export type MemberTier = '普通' | '银卡' | '金卡' | '黑钻';

export type DemoUser = { id: string; name: string; tier: MemberTier };
export type DemoOrder = {
  order_id: string;
  user_id: string;
  passenger: string;
  flight_no: string;
  date: string;
  airline: string;
  cabin: string;
  fare_product: string;
  fare: number;
  tax: number;
  status: 'ISSUED' | 'CHANGED' | 'REFUNDED';
  ticket_no: string;
  flight: { origin_city: string; dest_city: string; dep_time: string; status: 'scheduled' | 'delayed' | 'cancelled'; delay_min: number };
};
export type Eligibility = { allowed: boolean; reason: string; ruleId: string };
export type DemoQuote = {
  quote_id: string;
  order_id: string;
  action: DemoAction;
  amount: number;
  currency: 'CNY';
  status: 'OFFERED' | 'EXECUTED';
  expires_at: string;
  target_date: string | null;
  rule_id: string;
  details: { title: string; fee_items: { name: string; amount: number }[] }[];
};
export type DemoEvent = { title: string; detail: string; state: 'done' | 'active' | 'pending' };
export type DemoCase = {
  case_id: string;
  user_id: string;
  order_id: string;
  status: 'NEEDS_INFORMATION' | 'WAITING_CONFIRMATION' | 'COMPLETED' | 'HUMAN_REVIEW';
  question: string;
  assistant_text: string;
  quotes: DemoQuote[];
  events: DemoEvent[];
  created_at: string;
  completed_at?: string;
  result?: string;
};
export type EvaluationCase = {
  id: string;
  question: string;
  expect: { intents?: string[]; [key: string]: unknown };
  [key: string]: unknown;
};
export type DemoState = { users: DemoUser[]; orders: DemoOrder[]; cases: DemoCase[] };
export type EvalResult = { id: string; question: string; expected: string[]; actual: string[]; passed: boolean };
export type EvalReport = { total: number; passed: number; failed: EvalResult[]; results: EvalResult[] };

export const DEMO_USERS: DemoUser[] = [
  { id: 'u_zhang', name: '张三', tier: '金卡' },
  { id: 'u_li', name: '李四', tier: '银卡' },
  { id: 'u_wang', name: '王五', tier: '普通' },
  { id: 'u_zhao', name: '赵六', tier: '黑钻' },
];

const BASE_RATES: Record<string, { change: number[] | null; refund: number[] | null }> = {
  F: { change: [0, 0, 5, 10, 20], refund: [0, 5, 10, 15, 25] },
  C: { change: [0, 5, 10, 15, 25], refund: [5, 10, 15, 20, 30] },
  Y: { change: [5, 10, 15, 20, 30], refund: [10, 15, 20, 25, 40] },
  Y_DISCOUNT: { change: [10, 20, 30, 40, 50], refund: [20, 30, 40, 50, 70] },
  SPECIAL: { change: null, refund: [50, 60, 70, 80, 100] },
  GROUP: { change: null, refund: null },
};
const AIRLINE_OFFSET: Record<string, number> = { MU: 0, CA: 5, CZ: 0, HU: 5 };
const WINDOWS = ['d7', 'h48', 'h4', 'lt4', 'after'];
const RULE_LABEL: Record<string, string> = {
  d7: '起飞前 7 天及以上', h48: '起飞前 48 小时至 7 天', h4: '起飞前 4 至 48 小时',
  lt4: '起飞前 4 小时内', after: '起飞后',
};

function dateAt(now: Date, offset: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createDemoState(now = new Date()): DemoState {
  const d = (offset: number) => dateAt(now, offset);
  const orders: DemoOrder[] = [
    { order_id: 'ORD-DEMO-001', user_id: 'u_zhang', passenger: '张三', flight_no: 'MU5101', date: d(3), airline: 'MU', cabin: 'Y', fare_product: 'Y_DISCOUNT', fare: 1280, tax: 50, status: 'ISSUED', ticket_no: '781-2400000001', flight: { origin_city: '杭州', dest_city: '北京', dep_time: '10:30', status: 'scheduled', delay_min: 0 } },
    { order_id: 'ORD-DEMO-002', user_id: 'u_zhang', passenger: '张三', flight_no: 'MU5111', date: d(6), airline: 'MU', cabin: 'Y', fare_product: 'SPECIAL', fare: 680, tax: 50, status: 'ISSUED', ticket_no: '781-2400000002', flight: { origin_city: '北京', dest_city: '杭州', dep_time: '15:10', status: 'scheduled', delay_min: 0 } },
    { order_id: 'ORD-DEMO-003', user_id: 'u_li', passenger: '李四', flight_no: 'CZ5141', date: d(2), airline: 'CZ', cabin: 'Y', fare_product: 'Y', fare: 940, tax: 50, status: 'ISSUED', ticket_no: '781-2400000003', flight: { origin_city: '广州', dest_city: '海口', dep_time: '09:20', status: 'scheduled', delay_min: 0 } },
    { order_id: 'ORD-DEMO-004', user_id: 'u_wang', passenger: '王五', flight_no: 'MU5121', date: d(1), airline: 'MU', cabin: 'Y', fare_product: 'Y', fare: 1160, tax: 50, status: 'ISSUED', ticket_no: '781-2400000004', flight: { origin_city: '上海', dest_city: '广州', dep_time: '13:00', status: 'cancelled', delay_min: 0 } },
    { order_id: 'ORD-DEMO-005', user_id: 'u_wang', passenger: '王五', flight_no: 'HU5141', date: d(5), airline: 'HU', cabin: 'Y', fare_product: 'GROUP', fare: 520, tax: 50, status: 'ISSUED', ticket_no: '781-2400000005', flight: { origin_city: '广州', dest_city: '海口', dep_time: '08:40', status: 'scheduled', delay_min: 0 } },
    { order_id: 'ORD-DEMO-006', user_id: 'u_zhao', passenger: '赵六', flight_no: 'HU5101', date: d(8), airline: 'HU', cabin: 'C', fare_product: 'C', fare: 2980, tax: 50, status: 'ISSUED', ticket_no: '781-2400000006', flight: { origin_city: '杭州', dest_city: '北京', dep_time: '16:20', status: 'scheduled', delay_min: 0 } },
    { order_id: 'ORD-DEMO-007', user_id: 'u_li', passenger: '李四', flight_no: 'CA5131', date: d(4), airline: 'CA', cabin: 'Y', fare_product: 'SPECIAL', fare: 720, tax: 50, status: 'ISSUED', ticket_no: '781-2400000007', flight: { origin_city: '北京', dest_city: '成都', dep_time: '18:10', status: 'delayed', delay_min: 150 } },
  ];
  return { users: DEMO_USERS.map((user) => ({ ...user })), orders, cases: [] };
}

function rateWindow(order: DemoOrder, now: Date): string {
  const departure = new Date(`${order.date}T${order.flight.dep_time}:00`);
  const hours = (departure.getTime() - now.getTime()) / 3_600_000;
  return hours < 0 ? 'after' : hours < 4 ? 'lt4' : hours < 48 ? 'h4' : hours < 168 ? 'h48' : 'd7';
}

export function getEligibility(order: DemoOrder, now = new Date()): { change: Eligibility; refund: Eligibility } {
  if (order.status !== 'ISSUED') {
    const reason = order.status === 'REFUNDED' ? '客票已退，不能重复办理' : '客票状态已变化，不能重复办理';
    return { change: { allowed: false, reason, ruleId: 'ORDER-STATUS' }, refund: { allowed: false, reason, ruleId: 'ORDER-STATUS' } };
  }
  if (order.flight.status === 'cancelled' || (order.flight.status === 'delayed' && order.flight.delay_min >= 120)) {
    const ruleId = order.flight.status === 'cancelled' ? 'GEN-CANCEL' : 'GEN-DELAY';
    const reason = order.flight.status === 'cancelled' ? '航班取消，适用非自愿退改' : '航班延误达到 120 分钟，适用非自愿退改';
    return { change: { allowed: true, reason, ruleId }, refund: { allowed: true, reason, ruleId } };
  }
  const rates = BASE_RATES[order.fare_product];
  if (!rates) {
    const reason = '未找到该票价产品的退改规则';
    return { change: { allowed: false, reason, ruleId: 'RULE-NOT-FOUND' }, refund: { allowed: false, reason, ruleId: 'RULE-NOT-FOUND' } };
  }
  const ruleBase = `${order.airline}-${order.fare_product}`;
  const changeAllowed = rates.change !== null;
  const refundAllowed = rates.refund !== null;
  const name = order.fare_product === 'GROUP' ? '团队票' : '特价票';
  return {
    change: { allowed: changeAllowed, reason: changeAllowed ? `符合自愿改签条件；适用时段：${RULE_LABEL[rateWindow(order, now)]}` : `${name}按当前票规不可自愿改签`, ruleId: `${ruleBase}-CHG` },
    refund: { allowed: refundAllowed, reason: refundAllowed ? `符合自愿退票条件；适用时段：${RULE_LABEL[rateWindow(order, now)]}` : `${name}按当前票规不可自愿退票`, ruleId: `${ruleBase}-RFD` },
  };
}

export function classifyIntent(message: string): DemoAction[] {
  const text = message.toLowerCase();
  const change = /改签|改票|改到|改期|换到|换签/.test(text);
  const refund = /退票|退掉|退款|退订|退钱|退吗|退不|能退/.test(text);
  return [change ? 'CHANGE' : null, refund ? 'REFUND' : null].filter((action): action is DemoAction => action !== null);
}

export function classifyEvaluationIntent(message: string): string[] {
  if (/规定|规则|政策|手续费/.test(message)) return ['POLICY'];
  const actions = classifyIntent(message);
  if (actions.length) return actions;
  if (/航班.*(状态|情况|动态|延误|取消|起飞|到达)|是否(延误|取消)|现在什么情况/.test(message)) return ['STATUS'];
  if (/退订|航空|宠物|积分|里程|餐食|素食|行李|可以带/.test(message)) return ['POLICY'];
  return [];
}

function percent(amount: number, rate: number): number { return Math.floor((amount * rate + 50) / 100); }

export function quoteOrder(order: DemoOrder, action: DemoAction, targetDate: string | null, now = new Date()): DemoQuote & { allowed: boolean; reason: string; ruleId: string } {
  const eligibility = getEligibility(order, now)[action === 'CHANGE' ? 'change' : 'refund'];
  const window = rateWindow(order, now);
  const cancelled = order.flight.status === 'cancelled';
  const delayed = order.flight.status === 'delayed' && order.flight.delay_min >= 120;
  const involuntary = cancelled || delayed;
  const base = BASE_RATES[order.fare_product];
  const ruleId = involuntary ? eligibility.ruleId : `${order.airline}-${order.fare_product}-${action === 'CHANGE' ? 'CHG' : 'RFD'}`;
  const fail = (reason: string): DemoQuote & { allowed: boolean; reason: string; ruleId: string } => ({
    quote_id: `q_${order.order_id}_${action}`, order_id: order.order_id, action, amount: 0, currency: 'CNY',
    status: 'OFFERED', expires_at: new Date(now.getTime() + 600_000).toISOString(), target_date: targetDate,
    rule_id: ruleId, ruleId, allowed: false, reason,
    details: [{ title: '当前方案不可办理', fee_items: [] }],
  });
  if (!eligibility.allowed) return fail(eligibility.reason);
  if (action === 'CHANGE' && !targetDate) return fail('请补充改签目标日期');
  if (!involuntary && !base) return fail('未找到该票价产品的退改规则');
  const feeItems: { name: string; amount: number }[] = [];
  let amount = 0;
  if (action === 'CHANGE') {
    const pctList = base?.change;
    if (!involuntary && !pctList) return fail('当前票规不允许自愿改签');
    const rate = involuntary ? 0 : Math.min(100, (pctList?.[WINDOWS.indexOf(window)] ?? 0) + (AIRLINE_OFFSET[order.airline] ?? 0));
    const changeFee = percent(order.fare, rate);
    const targetDay = targetDate ? new Date(`${targetDate}T12:00:00`).getDay() : 0;
    const fareDiff = involuntary ? 0 : targetDay === 0 || targetDay === 6 ? 180 : 0;
    feeItems.push({ name: '改期费', amount: changeFee }, { name: '票面差价', amount: fareDiff });
    amount = changeFee + fareDiff;
  } else {
    const pctList = base?.refund;
    if (!involuntary && !pctList) return fail('当前票规不允许自愿退票');
    const rate = involuntary ? 0 : Math.min(100, (pctList?.[WINDOWS.indexOf(window)] ?? 0) + (AIRLINE_OFFSET[order.airline] ?? 0));
    const refundFee = percent(order.fare, rate);
    const refundTax = order.tax;
    feeItems.push({ name: '退票费', amount: refundFee }, { name: '退还税费', amount: refundTax });
    amount = order.fare - refundFee + refundTax;
  }
  if (involuntary) feeItems.push({ name: '航变免收费用', amount: 0 });
  return {
    quote_id: `q_${order.order_id}_${action}_${targetDate ?? 'none'}`, order_id: order.order_id, action,
    amount, currency: 'CNY', status: 'OFFERED', expires_at: new Date(now.getTime() + 600_000).toISOString(),
    target_date: targetDate, rule_id: ruleId, ruleId, allowed: true, reason: eligibility.reason,
    details: [{ title: action === 'CHANGE' ? '改签费用明细' : '退票金额明细', fee_items: feeItems }],
  };
}

function targetDateFromMessage(message: string, now: Date): string | null {
  const explicit = message.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  if (explicit) return explicit;
  const offset = /大后天/.test(message) ? 3 : /后天/.test(message) ? 2 : /明天/.test(message) ? 1 : 0;
  return offset ? dateAt(now, offset) : null;
}

export function startCase(state: DemoState, userId: string, orderId: string, message: string, now = new Date()): DemoState {
  const next: DemoState = structuredClone(state);
  const order = next.orders.find((item) => item.order_id === orderId && item.user_id === userId);
  if (!order) throw new Error('所选客票不属于当前演示用户');
  const intents = classifyIntent(message);
  const targetDate = targetDateFromMessage(message, now);
  const quotes = intents.filter((action) => action !== 'CHANGE' || targetDate)
    .map((action) => quoteOrder(order, action, action === 'CHANGE' ? targetDate : null, now))
    .filter((quote) => quote.allowed);
  const needsDate = intents.includes('CHANGE') && !targetDate;
  const status: DemoCase['status'] = quotes.length ? 'WAITING_CONFIRMATION' : needsDate || !intents.length ? 'NEEDS_INFORMATION' : 'HUMAN_REVIEW';
  const matchText = intents.length ? intents.map((intent) => intent === 'CHANGE' ? '改签' : '退票').join('与') : '未识别退改诉求';
  const assistantText = quotes.length
    ? `已识别${matchText}需求，核对客票状态并命中退改规则。请查看下方费用明细，确认后才会完成模拟办理。`
    : needsDate ? '已识别改签需求。请补充目标日期，例如“改签到明天”或“改签到 2026-11-15”。'
      : !intents.length ? '请告诉我需要退票还是改签；也可以点击客票旁的快捷操作。'
        : '按当前客票状态和票规没有可直接办理的方案，请转人工客服处理。';
  const caseId = `CASE-${String(next.cases.length + 1).padStart(4, '0')}`;
  next.cases.push({
    case_id: caseId, user_id: userId, order_id: orderId, status, question: message,
    assistant_text: assistantText, quotes, created_at: now.toISOString(),
    events: [
      { title: '识别乘客诉求', detail: `规则模式识别：${matchText}`, state: 'done' },
      { title: '核对客票与退改资格', detail: order.flight.status === 'cancelled' ? '命中航班取消保障' : '核对票价产品和客票状态', state: 'done' },
      { title: '计算费用并展示方案', detail: quotes.length ? `命中 ${quotes.map((quote) => quote.rule_id).join('、')}` : assistantText, state: quotes.length ? 'done' : 'active' },
      { title: '乘客确认', detail: quotes.length ? '等待乘客点击确认' : '尚未生成报价', state: quotes.length ? 'active' : 'pending' },
      { title: '完成模拟办理', detail: '确认报价后执行', state: 'pending' },
    ],
  });
  return next;
}

export function confirmQuote(state: DemoState, caseId: string, quoteId: string, now = new Date()): DemoState {
  const next: DemoState = structuredClone(state);
  const currentCase = next.cases.find((item) => item.case_id === caseId);
  if (!currentCase || currentCase.status !== 'WAITING_CONFIRMATION') throw new Error('案件当前不在待确认状态');
  const quote = currentCase.quotes.find((item) => item.quote_id === quoteId && item.status === 'OFFERED');
  if (!quote) throw new Error('报价不存在或已办理');
  const order = next.orders.find((item) => item.order_id === quote.order_id && item.user_id === currentCase.user_id);
  if (!order || order.status !== 'ISSUED') throw new Error('客票状态已变化，无法办理');
  if (quote.action === 'CHANGE') {
    order.date = quote.target_date ?? order.date;
    order.status = 'CHANGED';
    order.ticket_no = `781-${quote.quote_id.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0)}`;
    currentCase.result = `改签已完成：${order.date} ${order.flight_no}，确认金额 ${quote.amount} 元，新票号 ${order.ticket_no}。`;
  } else {
    order.status = 'REFUNDED';
    currentCase.result = `退票已完成：预计退款 ${quote.amount} 元，按原支付路径退回。`;
  }
  quote.status = 'EXECUTED';
  currentCase.status = 'COMPLETED';
  currentCase.completed_at = now.toISOString();
  currentCase.events = currentCase.events.map((event) => ({ ...event, state: 'done' }));
  currentCase.events[currentCase.events.length - 1] = { title: '完成模拟办理', detail: currentCase.result, state: 'done' };
  return next;
}

export function validateEvaluationCases(cases: unknown): string[] {
  if (!Array.isArray(cases)) return ['评测集必须是 JSON 数组'];
  const errors: string[] = [];
  const ids = new Set<string>();
  cases.forEach((item, index) => {
    if (!item || typeof item !== 'object') { errors.push(`第 ${index + 1} 条必须是对象`); return; }
    const row = item as Partial<EvaluationCase>;
    if (typeof row.id !== 'string' || !row.id.trim()) errors.push(`第 ${index + 1} 条缺少 id`);
    else if (ids.has(row.id)) errors.push(`评测用例 ID 重复：${row.id}`);
    else ids.add(row.id);
    if (typeof row.question !== 'string' || !row.question.trim()) errors.push(`第 ${index + 1} 条缺少 question`);
    if (!row.expect || typeof row.expect !== 'object') errors.push(`第 ${index + 1} 条缺少 expect 对象`);
    else if (row.expect.intents !== undefined && (!Array.isArray(row.expect.intents) || row.expect.intents.some((intent) => typeof intent !== 'string'))) {
      errors.push(`第 ${index + 1} 条的 expect.intents 必须是字符串数组`);
    }
  });
  return errors;
}

export function evaluateCases(cases: EvaluationCase[]): EvalReport {
  const results = cases.map((item) => {
    const actual = classifyEvaluationIntent(item.question);
    const expected = Array.isArray(item.expect?.intents) ? item.expect.intents : [];
    const passed = expected.length === actual.length && expected.every((value, index) => value === actual[index]);
    return { id: item.id, question: item.question, expected, actual, passed };
  });
  return { total: results.length, passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed), results };
}
