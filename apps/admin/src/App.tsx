import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, setContentLocale } from './api';
import { UiHost, toast } from './components/ui';
import { Setup } from './pages/Setup';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Posts } from './pages/Posts';
import { Editor } from './pages/Editor';
import { Media } from './pages/Media';
import { Settings } from './pages/Settings';
import { Categories } from './pages/Categories';
import { Tags } from './pages/Tags';
import { Collections } from './pages/Collections';
import { Pages, PageEditor } from './pages/Pages';
import { Nav } from './pages/Nav';
import { Languages } from './pages/Languages';
import { Themes } from './pages/Themes';
import { Tools } from './pages/Tools';

export interface Language {
  code: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  prefix: string;
}

export interface Status {
  languages: Language[];
  /** 后台当前正在编辑哪种语言的内容 */
  contentLocale: string;
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
          <Route path="/pages/:id" element={<PageEditor />} />
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
        {status.languages.length > 1 && (
          <label className="locale-pick">
            <span>内容语言</span>
            <select
              value={status.contentLocale}
              onChange={async (e) => {
                setContentLocale(e.target.value);
                await reload();
              }}
            >
              {status.languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                  {l.isDefault ? '（默认）' : l.enabled ? '' : '（未启用）'}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="btn btn-primary btn-block" onClick={() => void newPost()}>
          ＋ 新建文章
        </button>
        <nav>
          <NavLink to="/" end>
            仪表盘
          </NavLink>
          <span className="nav-group">内容</span>
          <NavLink to="/posts">文章</NavLink>
          <NavLink to="/pages">页面</NavLink>
          <NavLink to="/media">媒体库</NavLink>
          <span className="nav-group">组织</span>
          <NavLink to="/categories">分类</NavLink>
          <NavLink to="/tags">标签</NavLink>
          <NavLink to="/collections">专题与系列</NavLink>
          <span className="nav-group">站点</span>
          <NavLink to="/themes">主题</NavLink>
          <NavLink to="/nav">导航</NavLink>
          <NavLink to="/languages">多语言</NavLink>
          <NavLink to="/tools">工具</NavLink>
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
        <Routes key={status.contentLocale}>
          <Route path="/" element={<Dashboard onNew={newPost} />} />
          <Route path="/posts" element={<Posts onNew={newPost} />} />
          <Route path="/media" element={<Media />} />
          <Route path="/pages" element={<Pages />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/tags" element={<Tags />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/nav" element={<Nav />} />
          <Route path="/languages" element={<Languages />} />
          <Route path="/themes" element={<Themes />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<Navigate to="/" replace />} />
          <Route path="*" element={<div className="empty">页面不存在</div>} />
        </Routes>
      </div>
    </div>
  );
}
