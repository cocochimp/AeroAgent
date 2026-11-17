// 管理全局身份、订单数据与工作区路由。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, setToken, tokenFor, type DemoUser, type Order } from '../api/client';
import ChatWorkspace from './ChatWorkspace';
import WorkbenchShell, { type WorkbenchPage } from './WorkbenchShell';
import EvaluationWorkspace from './EvaluationWorkspace';
import RulesWorkspace from './RulesWorkspace';
import DataWorkspace from './DataWorkspace';
import ConfigWorkspace from './ConfigWorkspace';

type OrdersResponse = { orders: Order[]; users?: DemoUser[] };

export default function App() {
  const [page, setPage] = useState<WorkbenchPage>('chat');
  const [userId, setUserId] = useState('u_zhang');
  const [isAdmin, setIsAdmin] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [users, setUsers] = useState<DemoUser[]>([{ user_id: 'u_zhang', name: '张三', tier: '金卡' }]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const refreshOrders = useCallback(async () => {
    setToken(tokenFor(userId, isAdmin));
    setLoading(true);
    try {
      const response = await api<OrdersResponse>('/orders');
      setOrders(response.orders);
      if (response.users?.length) setUsers(response.users);
      setNotice('');
    } catch (error) {
      setNotice((error as Error).message || '无法读取演示订单，请检查后端服务');
    } finally { setLoading(false); }
  }, [userId, isAdmin]);
  useEffect(() => { void refreshOrders(); }, [refreshOrders]);

  const userOrders = useMemo(() => isAdmin ? orders : orders.filter((order) => order.user_id === userId),
    [orders, userId, isAdmin]);
  const activeUser = users.find((user) => user.user_id === userId) ?? users[0];
  const toggleRole = () => {
    const next = !isAdmin;
    setToken(tokenFor(userId, next));
    setIsAdmin(next);
    setNotice(isAdmin ? '已切换为乘客身份。订单范围由服务端按当前用户限制。'
      : '已切换为管理员身份。管理操作仍由服务端角色校验。');
  };

  return <WorkbenchShell page={page} onPageChange={setPage} userId={userId} users={users} isAdmin={isAdmin}
    onUserChange={(id) => { setUserId(id); setNotice(''); }} onRoleToggle={toggleRole} notice={notice}>
    {page === 'chat' ? <ChatWorkspace orders={userOrders} userId={userId} user={activeUser} loading={loading}
      isAdmin={isAdmin} onRefresh={refreshOrders} onNotice={setNotice} /> : !isAdmin ? <AdminAccessRequired onSwitch={() => toggleRole()} /> :
      page === 'eval' ? <EvaluationWorkspace /> : page === 'rules' ? <RulesWorkspace /> :
        page === 'data' ? <DataWorkspace onNotice={setNotice} /> : <ConfigWorkspace />}
  </WorkbenchShell>;
}

function AdminAccessRequired({ onSwitch }: { onSwitch: () => void }) {
  return <section className="workspace-placeholder page-enter"><p className="eyebrow">ADMIN WORKSPACE</p><h1>管理员工作区</h1>
    <p>评测集、规则、演示数据和运行配置仅对管理员身份开放。</p>
    <button type="button" className="primary-button" onClick={onSwitch}>切换到管理员模式</button></section>;
}
