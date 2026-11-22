import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtTime } from '../api';
import { StatusBadge, toast } from '../components/ui';

const ACTION_LABEL: Record<string, string> = {
  setup: '完成安装',
  login: '登录',
  login_failed: '登录失败',
  password_change: '修改密码',
  post_create: '新建文章',
  post_publish: '发布文章',
  post_unpublish: '下线文章',
  post_archive: '归档文章',
  post_rollback: '回退发布版本',
  post_trash: '移入回收站',
  post_restore: '从回收站恢复',
  post_purge: '永久删除文章',
  post_duplicate: '复制文章',
  post_slug: '修改文章地址',
  post_restore_revision: '恢复历史版本',
  media_upload: '上传图片',
  media_delete: '删除图片',
  settings_update: '修改设置',
};

export function Dashboard({ onNew }: { onNew: () => void }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api('GET', '/dashboard')
      .then(setData)
      .catch((e) => toast(e.message, 'error'));
  }, []);

  if (!data) return <div className="muted">加载中…</div>;
  const c = data.counts;
  const stats: [string, number, string][] = [
    ['全部文章', c.all, '/posts'],
    ['已发布', c.published, '/posts?filter=published'],
    ['草稿', c.draft, '/posts?filter=draft'],
    ['待发布修改', c.pending, '/posts?filter=pending'],
    ['已归档', c.archived, '/posts?filter=archived'],
    ['媒体文件', data.mediaCount, '/media'],
  ];

  return (
    <>
      <header className="page-head">
        <h1>仪表盘</h1>
        <button className="btn btn-primary" onClick={onNew}>
          ＋ 新建文章
        </button>
      </header>

      <div className="stat-grid">
        {stats.map(([label, value, to]) => (
          <Link key={label} to={to} className="stat">
            <strong>{value}</strong>
            <span>{label}</span>
          </Link>
        ))}
      </div>

      <div className="two-col">
        <section className="panel">
          <h2>最近编辑</h2>
          {data.recent.length === 0 ? (
            <p className="muted">还没有文章，点击右上角“新建文章”开始写作。</p>
          ) : (
            <ul className="plain-list">
              {data.recent.map((p: any) => (
                <li key={p.id}>
                  <Link to={`/posts/${p.id}`}>{p.title || '（无标题）'}</Link>
                  <span className="row-meta">
                    <StatusBadge status={p.status} pending={p.hasPendingChanges} />
                    <span className="muted">{fmtTime(p.updatedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <h2>最近操作</h2>
          <ul className="plain-list">
            {data.logs.map((l: any) => (
              <li key={l.id}>
                <span>
                  {ACTION_LABEL[l.action] ?? l.action}
                  {l.entity === 'post' && l.entityId ? ` #${l.entityId}` : ''}
                </span>
                <span className="muted">{fmtTime(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
