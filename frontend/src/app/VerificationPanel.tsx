type Verify = Record<string, any> | undefined;
type SubResult = { intent?: string; fee?: Record<string, unknown>; rules?: Array<{ id?: string }> ; error?: string };
type FinalScheme = { options?: Array<{ type?: string; rule_refs?: string[] }> } | undefined;

export default function VerificationPanel({ verify, results, final, retries }: { verify: Verify; results: SubResult[]; final?: FinalScheme; retries?: number }) {
  if (!verify && !results.length) return <p className="observability-empty">本轮无数据</p>;
  const refs = Array.isArray(verify?.references) ? verify.references : Array.isArray(verify?.rule_refs) ? verify.rule_refs
    : (final?.options ?? []).flatMap((option) => option.rule_refs ?? []);
  const errors = [...(Array.isArray(verify?.errors) ? verify.errors : []), ...results.map((item) => item.error).filter(Boolean)];
  const comparisons: Array<Record<string, any>> = Array.isArray(verify?.fee_comparison) ? verify.fee_comparison : [];
  return <div className="verification-panel">
    <div className="verify-metrics">
      <Metric label="置信度" value={verify?.confidence} />
      <Metric label="校验门槛" value={verify?.threshold} />
      <Metric label="依据覆盖率" value={verify?.support_ratio} suffix="%" scale={100} />
      <Metric label="重试次数" value={verify?.retries ?? retries} />
    </div>
    {verify?.passed !== undefined && <p className={`verify-status ${verify.passed ? 'passed' : 'failed'}`}>{verify.passed ? '校验通过' : '未通过校验'}</p>}
    <section><h3>费用核对</h3>{comparisons.length ? comparisons.map((item, index) =>
      <div className="fee-comparison" key={`${item.intent}-${index}`}><b>{item.intent ?? `子诉求 ${index + 1}`}</b>
        <span>引擎金额 <strong>{typeof item.expected === 'number' ? `¥${item.expected.toLocaleString('zh-CN')}` : '本轮无数据'}</strong></span>
        <span>方案金额 <strong>{typeof item.actual === 'number' ? `¥${item.actual.toLocaleString('zh-CN')}` : '本轮无数据'}</strong></span>
        <em className={item.matched ? 'status-good' : 'status-bad'}>{item.matched === true ? '一致' : item.matched === false ? '不一致' : '本轮无数据'}</em>
      </div>) : results.some((item) => item.fee) ? results.filter((item) => item.fee).map((item, index) =>
      <div className="fee-check" key={`${item.intent}-${index}`}><b>{item.intent ?? `子诉求 ${index + 1}`}</b>
        {Object.entries(item.fee ?? {}).filter(([, value]) => typeof value === 'number').map(([name, value]) =>
          <span key={name}>{name} <strong>¥{Number(value).toLocaleString('zh-CN')}</strong></span>)}
      </div>) : <p className="observability-empty">本轮无数据</p>}</section>
    <section><h3>引用依据</h3>{refs.length ? <div className="verify-refs">{refs.map((ref: unknown, index: number) => <code key={`${String(ref)}-${index}`}>{String(ref)}</code>)}</div>
      : <p className="observability-empty">本轮无数据</p>}</section>
    <section><h3>错误与提醒</h3>{errors.length ? <ul className="verify-errors">{errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>
      : <p className="observability-empty">本轮无数据</p>}</section>
  </div>;
}

function Metric({ label, value, suffix = '', scale = 1 }: { label: string; value: unknown; suffix?: string; scale?: number }) {
  const shown = typeof value === 'number' ? `${Number((value * scale).toFixed(4))}${suffix}` : '本轮无数据';
  return <div><span>{label}</span><strong>{shown}</strong></div>;
}
