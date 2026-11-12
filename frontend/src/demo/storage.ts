import bundledCases from '../../../eval/gold_cases.json';
import { createDemoState, type DemoState, type EvaluationCase } from './service';

const DEMO_STATE_KEY = 'air-ticket-rule-demo-state-v1';
const EVAL_CASES_KEY = 'air-ticket-rule-eval-cases-v1';

export function loadDemoState(): DemoState {
  try {
    const raw = localStorage.getItem(DEMO_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState;
      if (Array.isArray(parsed.users) && Array.isArray(parsed.orders) && Array.isArray(parsed.cases)) return parsed;
    }
  } catch { /* Use the bundled demo state if local data is damaged. */ }
  return createDemoState();
}

export function saveDemoState(state: DemoState): void {
  localStorage.setItem(DEMO_STATE_KEY, JSON.stringify(state));
}

export function loadEvaluationCases(): EvaluationCase[] {
  try {
    const raw = localStorage.getItem(EVAL_CASES_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as EvaluationCase[];
    }
  } catch { /* Keep the checked-in gold set as the recovery copy. */ }
  return structuredClone(bundledCases) as EvaluationCase[];
}

export function saveEvaluationCases(cases: EvaluationCase[]): void {
  localStorage.setItem(EVAL_CASES_KEY, JSON.stringify(cases));
}

export function resetEvaluationCases(): EvaluationCase[] {
  localStorage.removeItem(EVAL_CASES_KEY);
  return structuredClone(bundledCases) as EvaluationCase[];
}
