export const API = import.meta.env.VITE_API_BASE ?? '/api/v1';

export type DemoUser = { user_id: string; name: string; tier: string };
export type Eligibility = { allowed: boolean; reason: string; rule_id?: string; amount?: number };
export type Order = {
  order_id: string; user_id: string; passenger: string; flight_no: string; date: string; airline: string;
  cabin: string; fare_product: string; fare: number; tax: number; status: string; ticket_no: string;
  flight?: { origin: string; dest: string; origin_city: string; dest_city: string; dep_time: string; status: string; delay_min: number } | null;
  eligibility?: { change: Eligibility; refund: Eligibility };
};
export type Quote = {
  quote_id: string; action: 'CHANGE' | 'REFUND'; amount: number; currency: string; status: string;
  expires_at: string; details: Array<{ title?: string; fee_items?: Array<{ name: string; amount: number }>;
    rule_refs?: string[]; pricing?: Record<string, unknown> }>;
};
export type TraceEvent = { node: string; status: string; ms?: number; at?: string; note?: string;
  input?: Record<string, unknown>; output?: Record<string, unknown> };
export type CaseResult = {
  case_id: string; order_id: string | null; status: string; intent?: string | null;
  result: { final?: { text?: string; options?: unknown[] }; interrupt?: unknown; trace?: TraceEvent[];
    results?: unknown[]; context?: Record<string, unknown>; memory?: Record<string, unknown>;
    verify?: Record<string, unknown>; parsed?: Record<string, unknown>; retries?: number };
  quotes: Quote[];
};
export type CaseStreamEvent = { id: string; type: string; data: any };

const tokenKey = 'air-ticket-demo-token';
export function tokenFor(userId: string, admin = false) {
  return `${admin ? 'demo-admin' : 'demo'}:${userId}`;
}
export function setToken(token: string) { localStorage.setItem(tokenKey, token); }
export function getToken() { return localStorage.getItem(tokenKey) || tokenFor('u_zhang'); }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? body?.detail?.message ?? '请求失败'), { response, body });
  return body as T;
}

export function parseSSEBlock(block: string): CaseStreamEvent | null {
  let id = '';
  let type = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try { return { id, type, data: JSON.parse(data.join('\n')) }; }
  catch { return { id, type, data: { message: data.join('\n') } }; }
}

export async function streamEvents(path: string, onEvent: (type: string, data: any, id: string) => boolean | void | Promise<boolean | void>,
                                   signal: AbortSignal, initialCursor = '') {
  let cursor = initialCursor;
  while (!signal.aborted) {
    const url = new URL(`${API}${path}`, window.location.origin);
    if (cursor) url.searchParams.set('after', cursor);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` }, signal });
      if (!response.ok || !response.body) throw Object.assign(new Error('事件连接失败'), { response });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const event = parseSSEBlock(block);
          if (!event) continue;
          if (event.id) cursor = event.id;
          if (await onEvent(event.type, event.data, event.id)) { await reader.cancel(); return; }
        }
      }
      if (signal.aborted) return;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof Error && 'response' in error) throw error;
    }
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 500);
      signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

export function newRequestId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}
