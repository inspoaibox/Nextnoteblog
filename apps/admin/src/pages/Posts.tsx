import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, fmtTime } from '../api';
import { Pager, StatusBadge, confirmDialog, toast } from '../components/ui';

const FILTERS: [string, string][] = [
  ['all', '全部'],
  ['draft', '草稿'],
  ['published', '已发布'],
  ['pending', '待发布修改'],
  ['unpublished', '已下线'],
  ['archived', '已归档'],
  ['trash', '回收站'],
];

export function Posts({ onNew }: { onNew: () => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const filter = params.get('filter') || 'all';
  const q = params.get('q') || '';
  const page = Number(params.get('page') || 1);
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState(q);

  const load = useCallback(async () => {
    try {
      setData(await api('GET', `/posts?filter=${filter}&page=${page}&q=${encodeURIComponent(q)}`));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [filter, page, q]);
  useEffect(() => void load(), [load]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next);
  };

  const act = async (id: number, action: string, okText: string) => {
    try {
      await api('POST', `/posts/${id}/${action}`, {});
      toast(okText);
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const unpublish = async (p: any) => {
    if (await confirmDialog({ title: '下线这篇文章？', body: `“${p.title}”将无法被访客访问，原稿与版本历史会保留，可随时重新发布。`, confirmText: '下线', danger: true })) await act(p.id, 'unpublish', '已下线');
  };
  const trash = async (p: any) => {
    const published = p.status === 'published' || p.status === 'archived';
    if (await confirmDialog({ title: '移入回收站？', body: published ? `“${p.title}”当前是公开的，移入回收站后访客将无法访问。可在回收站中恢复。` : `“${p.title || '（无标题）'}”可在回收站中恢复。`, confirmText: '移入回收站', danger: true }))
      await act(p.id, 'trash', '已移入回收站');
  };
  const purge = async (p: any) => {
    if (!(await confirmDialog({ title: '永久删除？', body: `“${p.title || '（无标题）'}”及其全部历史版本将被永久删除，无法恢复。`, confirmText: '永久删除', danger: true }))) return;
    try {
      await api('DELETE', `/posts/${p.id}`);
      toast('已永久删除');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const duplicate = async (p: any) => {
    try {
      const created = await api('POST', `/posts/${p.id}/duplicate`, {});
      navigate(`/posts/${created.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>文章</h1>
        <button className="btn btn-primary" onClick={onNew}>
          ＋ 新建文章
        </button>
      </header>

      <div className="tabs" role="tablist">
        {FILTERS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => update({ filter: key === 'all' ? '' : key, page: '' })}>
            {label}
            {data?.counts && <span className="count">{data.counts[key]}</span>}
          </button>
        ))}
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim(), page: '' });
          }}
        >
          <input type="search" placeholder="搜索标题或地址…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="搜索文章" />
        </form>
      </div>

      {!data ? (
        <div className="muted">加载中…</div>
      ) : data.items.length === 0 ? (
        <div className="empty">{q ? `没有找到包含“${q}”的文章` : filter === 'trash' ? '回收站是空的' : '这里还没有文章'}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>阅读</th>
                <th>更新时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((p: any) => (
                <tr key={p.id}>
                  <td className="cell-title">
                    <Link to={`/posts/${p.id}`}>{p.title || '（无标题）'}</Link>
                    {p.pinned && <span className="badge">置顶</span>}
                    {p.featured && <span className="badge">精选</span>}
                    <div className="muted small">{p.path}</div>
                  </td>
                  <td>
                    <StatusBadge status={p.status} pending={p.hasPendingChanges} />
                  </td>
                  <td>{p.viewCount}</td>
                  <td className="muted nowrap">{fmtTime(p.updatedAt)}</td>
                  <td className="actions">
                    {filter === 'trash' ? (
                      <>
                        <button className="link-btn" onClick={() => void act(p.id, 'restore', '已恢复')}>
                          恢复
                        </button>
                        <button className="link-btn danger" onClick={() => void purge(p)}>
                          永久删除
                        </button>
                      </>
                    ) : (
                      <>
                        <Link to={`/posts/${p.id}`}>编辑</Link>
                        {p.status === 'published' || p.status === 'archived' ? (
                          <a href={p.path} target="_blank" rel="noreferrer">
                            查看
                          </a>
                        ) : (
                          <a href={`/preview/post/${p.id}`} target="_blank" rel="noreferrer">
                            预览
                          </a>
                        )}
                        <button className="link-btn" onClick={() => void duplicate(p)}>
                          复制
                        </button>
                        {p.status === 'published' && (
                          <button className="link-btn" onClick={() => void unpublish(p)}>
                            下线
                          </button>
                        )}
                        <button className="link-btn danger" onClick={() => void trash(p)}>
                          删除
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onChange={(p) => update({ page: String(p) })} />}
    </>
  );
}
