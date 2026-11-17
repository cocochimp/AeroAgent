// 查看、校验并保存服务端运行配置。
import { useEffect, useState } from 'react';
import { api } from '../api/client';

function validateConfig(config: any) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是 JSON 对象');
  if (config.memory?.token_budget !== undefined && (!Number.isInteger(config.memory.token_budget) || config.memory.token_budget < 200)) throw new Error('memory.token_budget 不能小于 200');
  for (const key of ['k_recall', 'k_fuse', 'k_rerank', 'k_mmr', 'k_inject']) if (config.retrieval?.[key] !== undefined && (!Number.isInteger(config.retrieval[key]) || config.retrieval[key] < 1)) throw new Error(`retrieval.${key} 必须是正整数`);
  if (config.mode !== undefined && !['mock', 'offline', 'deepseek'].includes(config.mode)) throw new Error('mode 只支持 mock 或 deepseek');
  if (config.retrieval?.backend !== undefined && !['hybrid', 'fallback'].includes(config.retrieval.backend)) throw new Error('retrieval.backend 只支持 hybrid 或 fallback');
}
export default function ConfigWorkspace() {
  const [raw, setRaw] = useState('{}'); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [probe, setProbe] = useState(false);
  useEffect(() => { void api<Record<string, unknown>>('/admin/config').then((config) => setRaw(JSON.stringify(config, null, 2))).catch((error) => setNotice(error.message)); }, []);
  async function save() {
    setBusy(true); try { const config = JSON.parse(raw); validateConfig(config); const response = await api<{ config: Record<string, unknown>; llm_probe?: string }>('/admin/config', { method: 'PUT', body: JSON.stringify({ patch: config, probe_llm: probe }) });
      setRaw(JSON.stringify(response.config, null, 2)); setNotice(response.llm_probe === 'passed' ? '配置已保存，LLM 连通性检查通过' : '配置已保存并写入运行配置');
    } catch (error) { const detail = (error as Error & { body?: { error?: { message?: string } } }).body?.error?.message; setNotice(detail ?? (error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="admin-workspace page-enter"><header className="workspace-heading"><p className="eyebrow">RUNTIME SETTINGS</p><h1>运行配置</h1><p>服务端读取当前配置并对 API Key 打码。修改后由服务端校验范围，支持连通性检查。</p></header>
    {notice && <p className="workspace-notice" role="status">{notice}</p>}
    <section className="workspace-card config-editor-card"><div className="workspace-section-head"><div><p className="eyebrow">ACTIVE CONFIG</p><h2>JSON 配置</h2></div><label className="probe-toggle"><input type="checkbox" checked={probe} onChange={(e) => setProbe(e.target.checked)} />保存时检查 LLM 连接</label></div>
      <textarea className="workspace-json-editor config-json" aria-label="运行配置 JSON" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
      <p className="workspace-help">可编辑 mode、llm、query、planner、retrieval、memory、verify。返回的 API Key 只显示掩码；保存掩码会保留服务端已有密钥。</p>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存配置'}</button></section>
  </section>;
}
