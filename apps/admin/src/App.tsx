import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { UiHost, toast } from './components/ui';
import { Setup } from './pages/Setup';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Posts } from './pages/Posts';
import { Editor } from './pages/Editor';
import { Media } from './pages/Media';
import { Settings } from './pages/Settings';

export interface Status {
  installed: boolean;
  user: { id: number; username: string; displayName: string; role: string } | null;
  site: { name: string; defaultLocale: string; timezone: string; appearance: 'light' | 'dark' | 'auto' };
  themeCss: string;
}

const StatusContext = createContext<{ status: Status; reload: () => Promise<void> }>(null!);
export const useStatus = () => useContext(StatusContext);

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setStatus(await api<Status>('GET', '/status'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onUnauthorized = () => setStatus((s) => (s?.user ? { ...s, user: null } : s));
    window.addEventListener('nb:unauthorized', onUnauthorized);
    return () => window.removeEventListener('nb:unauthorized', onUnauthorized);
  }, [reload]);

  if (error) {
    return (
      <div className="center-page">
        <div className="auth-card">
          <h1>无法连接服务器</h1>
          <p className="muted">{error}</p>
          <button className="btn btn-primary" onClick={() => void reload()}>
            重试
          </button>
        </div>
      </div>
    );
  }
  if (!status) return <div className="center-page muted">加载中…</div>;

  return (
    <StatusContext.Provider value={{ status, reload }}>
      <UiHost />
      {!status.installed ? (
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      ) : !status.user ? (
        <Login />
      ) : (
        <Routes>
          <Route path="/posts/:id" element={<Editor />} />
          <Route path="*" element={<Shell />} />
        </Routes>
      )}
    </StatusContext.Provider>
  );
}

function Shell() {
  const { status, reload } = useStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const logout = async () => {
    await api('POST', '/logout').catch(() => {});
    await reload();
  };
  const newPost = async () => {
    try {
      const created = await api<{ id: number }>('POST', '/posts', {});
      navigate(`/posts/${created.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">{status.site.name}</div>
        <button className="btn btn-primary btn-block" onClick={() => void newPost()}>
          ＋ 新建文章
        </button>
        <nav>
          <NavLink to="/" end>
            仪表盘
          </NavLink>
          <NavLink to="/posts">文章</NavLink>
          <NavLink to="/media">媒体库</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
        <div className="sidebar-foot">
          <a href="/" target="_blank" rel="noreferrer">
            查看站点 ↗
          </a>
          <span className="muted">{status.user!.displayName}</span>
          <button className="link-btn" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </aside>
      <div className="main">
        <button className="menu-toggle btn" onClick={() => setMenuOpen((v) => !v)} aria-label="菜单">
          ☰ 菜单
        </button>
        <Routes>
          <Route path="/" element={<Dashboard onNew={newPost} />} />
          <Route path="/posts" element={<Posts onNew={newPost} />} />
          <Route path="/media" element={<Media />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<Navigate to="/" replace />} />
          <Route path="*" element={<div className="empty">页面不存在</div>} />
        </Routes>
      </div>
    </div>
  );
}
