import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, fmtTime, STATUS_LABEL } from '../api';
import { Pager, StatusBadge, confirmDialog, toast } from '../components/ui';
import { flattenCats, type CatNode } from './Categories';
import { useStatus } from '../App';

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
  const { status } = useStatus();
  const multi = status.languages.length > 1;
  const isDefaultLocale = status.contentLocale === status.site.defaultLocale;
  const langName = (code: string) => status.languages.find((l) => l.code === code)?.name ?? code;
  const filters = multi && !isDefaultLocale ? [...FILTERS, ['untranslated', '缺失译文'] as [string, string]] : FILTERS;
  const filter = params.get('filter') || 'all';
  const q = params.get('q') || '';
  const categoryId = params.get('categoryId') || '';
  const page = Number(params.get('page') || 1);
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState(q);
  const [cats, setCats] = useState<CatNode[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api('GET', `/posts?filter=${filter}&page=${page}&q=${encodeURIComponent(q)}${categoryId ? `&categoryId=${categoryId}` : ''}`));
      setSelected(new Set());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [filter, page, q, categoryId]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    api('GET', '/categories')
      .then((res) => setCats(flattenCats(res.tree)))
      .catch(() => {});
  }, []);
  const catName = new Map(cats.map((c) => [c.id, c.pathNames]));

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
  const translate = async (p: any) => {
    try {
      const created = await api('POST', `/posts/${p.id}/translate`, { locale: status.contentLocale });
      navigate(`/posts/${created.id}`);
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

  /* ---------- 批量操作 ---------- */
  const items: any[] = data?.items ?? [];
  const picked = items.filter((p) => selected.has(p.id));
  const allChecked = items.length > 0 && picked.length === items.length;

  const bulk = async (action: string, label: string, opts: { danger?: boolean; body?: string; categoryId?: number } = {}) => {
    const publicCount = picked.filter((p) => p.status === 'published' || p.status === 'archived').length;
    const ok = await confirmDialog({
      title: `${label} ${picked.length} 篇文章？`,
      body: opts.body ?? (opts.danger && publicCount ? `其中 ${publicCount} 篇当前是公开的，操作后访客将无法访问。` : undefined),
      confirmText: label,
      danger: opts.danger,
    });
    if (!ok) return;
    try {
      const res = await api('POST', '/posts/bulk', { ids: picked.map((p) => p.id), action, categoryId: opts.categoryId });
      if (res.failed.length) toast(`完成 ${res.done} 篇，${res.failed.length} 篇失败：${res.failed[0].error}`, 'error');
      else toast(`已${label} ${res.done} 篇`);
      setBulkCategory('');
      await load();
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
        {filters.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => update({ filter: key === 'all' ? '' : key, page: '' })}>
            {label}
            {data?.counts && <span className="count">{data.counts[key]}</span>}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {cats.length > 0 && (
          <select value={categoryId} onChange={(e) => update({ categoryId: e.target.value, page: '' })} aria-label="按分类筛选">
            <option value="">全部分类</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {'　'.repeat(c.depth - 1)}
                {c.name}
              </option>
            ))}
          </select>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim(), page: '' });
          }}
        >
          <input type="search" placeholder="搜索标题或地址…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="搜索文章" style={{ width: 200 }} />
        </form>
      </div>

      {filter === 'untranslated' && <p className="muted">以下文章还没有{langName(status.contentLocale)}版本。“创建译文”会复制原文作为草稿，翻译并发布后才会对访客可见。</p>}
      {picked.length > 0 && filter !== 'untranslated' && (
        <div className="bulk-bar" role="region" aria-label="批量操作">
          <strong>已选 {picked.length} 篇</strong>
          {filter === 'trash' ? (
            <button className="btn" onClick={() => void bulk('restore', '恢复')}>
              恢复
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => void bulk('publish', '发布', { body: '将把每篇文章当前的草稿内容发布到线上。标题或正文为空的文章会被跳过。' })}>
                发布
              </button>
              <button className="btn" onClick={() => void bulk('unpublish', '下线', { danger: true })}>
                下线
              </button>
              <button className="btn" onClick={() => void bulk('archive', '归档', { body: '归档后文章仍可通过链接访问，但不再出现在列表中。' })}>
                归档
              </button>
              {cats.length > 0 && (
                <>
                  <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} aria-label="迁移到分类">
                    <option value="">迁移到分类…</option>
                    {cats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.pathNames}
                      </option>
                    ))}
                  </select>
                  <button className="btn" disabled={!bulkCategory} onClick={() => void bulk('setCategory', '迁移', { categoryId: Number(bulkCategory), body: `所选文章的主分类将改为“${catName.get(Number(bulkCategory))}”，附加分类保持不变。文章地址不受影响。` })}>
                    迁移
                  </button>
                </>
              )}
              <button className="btn btn-danger" onClick={() => void bulk('trash', '移入回收站', { danger: true })}>
                移入回收站
              </button>
            </>
          )}
          <button className="link-btn" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      )}

      {!data ? (
        <div className="muted">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">{filter === 'untranslated' ? `默认语言的文章都已有${langName(status.contentLocale)}版本。` : q ? `没有找到包含“${q}”的文章` : filter === 'trash' ? '回收站是空的' : categoryId ? '这个分类下还没有文章' : '这里还没有文章'}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allChecked} aria-label="全选本页" onChange={(e) => setSelected(new Set(e.target.checked ? items.map((p) => p.id) : []))} />
                </th>
                <th>标题</th>
                <th>分类</th>
                {multi && <th>语言版本</th>}
                <th>状态</th>
                <th>阅读</th>
                <th>更新时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className={selected.has(p.id) ? 'is-selected' : ''}>
                  <td>
                    <input type="checkbox" checked={selected.has(p.id)} aria-label={`选择 ${p.title || '无标题'}`} onChange={(e) => setSelected((s) => new Set(e.target.checked ? [...s, p.id] : [...s].filter((x) => x !== p.id)))} />
                  </td>
                  <td className="cell-title">
                    <Link to={`/posts/${p.id}`}>{p.title || '（无标题）'}</Link>
                    {p.pinned && <span className="badge">置顶</span>}
                    {p.featured && <span className="badge">精选</span>}
                    <div className="muted small">{p.path}</div>
                  </td>
                  <td className="small">{p.primaryCategoryId ? (catName.get(p.primaryCategoryId) ?? '—') : <span className="muted">未分类</span>}</td>
                  {multi && (
                    <td className="small">
                      {p.translations.map((t: any) => (
                        <Link key={t.id} to={`/posts/${t.id}`} className={`badge badge-${t.status}`} title={`${langName(t.locale)}：${STATUS_LABEL[t.status] ?? t.status}`}>
                          {t.locale}
                        </Link>
                      ))}
                    </td>
                  )}
                  <td>
                    <StatusBadge status={p.status} pending={p.hasPendingChanges} />
                  </td>
                  <td>{p.viewCount}</td>
                  <td className="muted nowrap">{fmtTime(p.updatedAt)}</td>
                  <td className="actions">
                    {filter === 'untranslated' ? (
                      <button className="link-btn" onClick={() => void translate(p)}>
                        创建{langName(status.contentLocale)}译文
                      </button>
                    ) : filter === 'trash' ? (
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
