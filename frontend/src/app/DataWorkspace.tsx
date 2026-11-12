import { useEffect, useState } from 'react';
import { api, type Order } from '../api/client';

type Profile = { user_id: string; name: string; tier: string; data: Record<string, unknown> };
type Response = { orders: Order[]; users?: Array<{ user_id: string; name: string; tier: string }>; profiles?: Profile[] };
export default function DataWorkspace({ onNotice }: { onNotice: (notice: string) => void }) {
  const [data, setData] = useState<Response>({ orders: [] }); const [selectedOrder, setSelectedOrder] = useState('');
  const [notice, setNotice] = useState(''); const [confirmReset, setConfirmReset] = useState(false); const [delay, setDelay] = useState(150);
  const order = data.orders.find((item) => item.order_id === selectedOrder) ?? data.orders[0];
  async function load() { try { const result = await api<Response>('/orders'); setData(result); setSelectedOrder((id) => result.orders.some((x) => x.order_id === id) ? id : result.orders[0]?.order_id ?? ''); }
    catch (error) { setNotice((error as Error).message); } }
  useEffect(() => { void load(); }, []);
  async function command(body: Record<string, unknown>) { try { const result = await api<{ action: string }>('/orders', { method: 'POST', body: JSON.stringify(body) }); setNotice(`操作完成：${result.action}`); onNotice(`演示数据已更新：${result.action}`); await load(); }
    catch (error) { setNotice((error as Error).message); onNotice((error as Error).message); } }
  return <section className="admin-workspace page-enter"><header className="workspace-heading"><p className="eyebrow">DEMO DATA CONTROL</p><h1>演示数据管理</h1><p>管理虚构订单、航班状态和会员画像。所有修改写入服务端演示库并进入审计记录。</p></header>
    {notice && <p className="workspace-notice" role="status">{notice}</p>}
    <div className="workspace-toolbar"><span>订单 {data.orders.length} · 用户画像 {data.profiles?.length ?? 0}</span><button className="secondary-button" type="button" onClick={() => void load()}>刷新数据</button>
      <button className="secondary-button danger-action" type="button" onClick={() => setConfirmReset(true)}>重置演示数据</button></div>
    <div className="data-admin-grid"><section className="workspace-card"><div className="workspace-section-head"><h2>演示客票</h2><span>{data.orders.length}</span></div>
      <div className="admin-case-list">{data.orders.map((item) => <button type="button" key={item.order_id} className={item.order_id === order?.order_id ? 'selected' : ''} onClick={() => setSelectedOrder(item.order_id)}><b>{item.flight_no} · {item.passenger}</b>
        <span>{item.flight?.origin_city ?? item.flight?.origin} → {item.flight?.dest_city ?? item.flight?.dest}</span><small>{item.date} · {item.status} · 航班 {item.flight?.status}</small></button>)}</div>
      {order && <div className="workspace-action-row"><label>航班延误分钟<input type="number" min="0" max="10080" value={delay} onChange={(e) => setDelay(Number(e.target.value))} /></label>
        <button type="button" className="secondary-button" onClick={() => void command({ action: 'set_flight_status', flight_no: order.flight_no, date: order.date, status: 'cancelled' })}>设置航班取消</button>
        <button type="button" className="secondary-button" onClick={() => void command({ action: 'set_flight_status', flight_no: order.flight_no, date: order.date, status: 'delayed', delay_min: delay })}>设置航班延误</button>
        <button type="button" className="secondary-button" onClick={() => void command({ action: 'set_flight_status', flight_no: order.flight_no, date: order.date, status: 'scheduled' })}>恢复正常</button></div>}</section>
      <section className="workspace-card"><div className="workspace-section-head"><h2>会员画像</h2><span>{data.profiles?.length ?? 0}</span></div>
        <div className="profile-grid">{(data.profiles ?? []).map((profile) => <article key={profile.user_id}><div><b>{profile.name}</b><span>{profile.tier}</span></div><code>{profile.user_id}</code><pre>{JSON.stringify(profile.data, null, 2)}</pre>
          <button type="button" className="secondary-button" onClick={() => void command({ action: 'clear_profile', user_id: profile.user_id })}>清理画像</button></article>)}</div>
        {!data.profiles?.length && <p className="workspace-empty">管理员身份才能读取用户画像</p>}</section></div>
    {confirmReset && <div className="modal-backdrop" role="presentation"><section className="workspace-modal" role="dialog" aria-modal="true" aria-labelledby="reset-title"><h2 id="reset-title">确认重置演示数据？</h2>
      <p>订单、航班和画像将恢复到共享种子数据；评测历史和审计记录会保留。</p><div className="workspace-action-row"><button type="button" className="secondary-button" onClick={() => setConfirmReset(false)}>取消</button>
        <button type="button" className="primary-button danger-action" onClick={() => { setConfirmReset(false); void command({ action: 'reset_demo_data' }); }}>确认重置</button></div></section></div>}
  </section>;
}
