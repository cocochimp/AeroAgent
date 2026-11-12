import { useEffect, useState, type ReactNode } from 'react';
import type { DemoUser } from '../api/client';

export type WorkbenchPage = 'chat' | 'eval' | 'rules' | 'data' | 'config';
type Props = {
  page: WorkbenchPage; onPageChange: (page: WorkbenchPage) => void; children: ReactNode;
  userId: string; users: DemoUser[]; isAdmin: boolean;
  onUserChange: (userId: string) => void; onRoleToggle: () => void; notice: string;
};
const pages: Array<{ id: WorkbenchPage; label: string; icon: string }> = [
  { id: 'chat', label: '对话', icon: '◉' }, { id: 'eval', label: '评测', icon: '◎' },
  { id: 'rules', label: '规则', icon: '▤' }, { id: 'data', label: '数据', icon: '▧' },
  { id: 'config', label: '配置', icon: '⚙' },
];

export default function WorkbenchShell(props: Props) {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('air-ticket-theme') === 'light' ? 'light' : 'dark');
  useEffect(() => { localStorage.setItem('air-ticket-theme', theme); }, [theme]);
  const user = props.users.find((item) => item.user_id === props.userId);
  return <div className={`workbench-shell theme-${theme}`}>
    <aside className="side-rail">
      <div className="brand-mark" aria-label="云航工作台">✈</div>
      <nav aria-label="主导航" className="side-nav">
        {pages.map((item) => <button type="button" key={item.id}
          className={`side-nav-item ${props.page === item.id ? 'active' : ''}`}
          aria-label={item.label} aria-current={props.page === item.id ? 'page' : undefined}
          onClick={() => props.onPageChange(item.id)}>
          <span className="side-nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
        </button>)}
      </nav>
      <div className="rail-status"><i /> <span>规则引擎在线</span></div>
    </aside>
    <main className="workbench-main">
      <header className="workbench-topbar">
        <div className="topbar-brand"><strong>退改签助手</strong><span className="demo-label">演示数据</span></div>
        <div className="topbar-tools">
          <div className="mode-switch" aria-label="Agent 模式">
            <span className="mode-active">规则模式</span><button type="button" className="mode-disabled"
              aria-label="DeepSeek 模式配置" title="DeepSeek 需配置 API Key；打开管理员配置工作区"
              onClick={() => props.onPageChange('config')}>DeepSeek · 配置</button>
          </div>
          <label className="sr-only" htmlFor="demo-user">当前用户</label>
          <select id="demo-user" aria-label="当前用户" value={props.userId}
            onChange={(event) => props.onUserChange(event.target.value)} disabled={props.users.length < 2}>
            {props.users.map((item) => <option key={item.user_id} value={item.user_id}>{item.name} · {item.tier}</option>)}
          </select>
          <button type="button" className={`role-toggle ${props.isAdmin ? 'admin' : ''}`}
            onClick={props.onRoleToggle} aria-label={props.isAdmin ? '管理员模式' : '乘客模式'}>
            {props.isAdmin ? '管理员模式' : '乘客模式'}
          </button>
          <span className="avatar" title={user?.name}>{user?.name.slice(0, 1) ?? '学'}</span>
          <span className="retrieval-badge"><i />检索 hybrid</span>
          <button type="button" className="theme-toggle" aria-label="切换主题"
            onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☼' : '◐'}</button>
        </div>
      </header>
      {props.notice && <div className="global-notice" role="status">{props.notice}</div>}
      <div className="workspace-content">{props.children}</div>
    </main>
  </div>;
}
