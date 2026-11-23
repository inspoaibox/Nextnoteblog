import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Field, Modal, confirmDialog, toast } from '../components/ui';

interface Tag {
  id: number;
  name: string;
  slug: string;
  description: string;
  translated: boolean;
  postCount: number;
  publishedCount: number;
  url: string;
}

export function Tags() {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'count' | 'name'>('count');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Tag | null>(null);
  const [merging, setMerging] = useState(false);

  const load = useCallback(async () => {
    try {
      setTags(await api('GET', '/tags'));
      setSelected(new Set());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>, okText?: string) => {
    try {
      await fn();
      if (okText) toast(okText);
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (!tags) return <div className="muted">加载中…</div>;
  const q = query.trim().toLowerCase();
  const shown = tags.filter((t) => !q || t.name.toLowerCase().includes(q) || t.slug.includes(q)).sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.postCount - a.postCount));
  const emptyCount = tags.filter((t) => t.postCount === 0).length;
  const picked = tags.filter((t) => selected.has(t.id));

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    void run(async () => {
      await api('POST', '/tags', { name: newName });
      setNewName('');
    }, '已添加');
  };

  const remove = async (t: Tag) => {
    const ok = await confirmDialog({ title: `删除标签“${t.name}”？`, body: t.postCount ? `有 ${t.postCount} 篇文章使用了这个标签，删除后这些文章将不再带有它。文章本身不受影响。` : '该标签没有被任何文章使用。', confirmText: '删除', danger: true });
    if (ok) await run(() => api('DELETE', `/tags/${t.id}`), '已删除');
  };

  const cleanup = async () => {
    if (await confirmDialog({ title: `清理 ${emptyCount} 个空标签？`, body: '将删除所有没有文章使用的标签。', confirmText: '清理', danger: true })) await run(() => api('POST', '/tags/cleanup', {}), '已清理');
  };

  return (
    <>
      <header className="page-head">
        <h1>标签</h1>
        <form className="row" onSubmit={add}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新标签名称" maxLength={50} aria-label="新标签名称" />
          <button className="btn btn-primary">添加</button>
        </form>
      </header>

      <div className="tabs">
        <input type="search" placeholder="搜索标签…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索标签" style={{ width: 220 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value as 'count' | 'name')} aria-label="排序">
          <option value="count">按文章数排序</option>
          <option value="name">按名称排序</option>
        </select>
        <span style={{ flex: 1 }} />
        {selected.size >= 2 && (
          <button className="btn" onClick={() => setMerging(true)}>
            合并所选的 {selected.size} 个标签
          </button>
        )}
        {emptyCount > 0 && (
          <button className="btn" onClick={() => void cleanup()}>
            清理 {emptyCount} 个空标签
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="empty">{q ? '没有匹配的标签' : '还没有标签。可以在这里添加，也可以在编辑文章时直接输入。'}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th aria-label="选择" />
                <th>名称</th>
                <th>地址</th>
                <th>文章数</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td>
                    <input type="checkbox" checked={selected.has(t.id)} aria-label={`选择 ${t.name}`} onChange={(e) => setSelected((s) => new Set(e.target.checked ? [...s, t.id] : [...s].filter((x) => x !== t.id)))} />
                  </td>
                  <td>
                    <strong>{t.name}</strong>
                    {!t.translated && <span className="badge badge-pending" title="当前语言还没有译名，显示的是其他语言的名称">未翻译</span>}
                    {t.description && <div className="muted small">{t.description}</div>}
                  </td>
                  <td className="muted small">{t.url}</td>
                  <td>
                    {t.postCount}
                    <span className="muted small">（已发布 {t.publishedCount}）</span>
                  </td>
                  <td className="actions">
                    <button className="link-btn" onClick={() => setEditing(t)}>
                      编辑
                    </button>
                    {t.publishedCount > 0 && (
                      <a href={t.url} target="_blank" rel="noreferrer">
                        查看
                      </a>
                    )}
                    <button className="link-btn danger" onClick={() => void remove(t)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <TagForm
          tag={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {merging && (
        <Modal title="合并标签" onClose={() => setMerging(false)}>
          <div className="modal-body">
            <p>选择要保留的标签，其余标签下的文章会改挂到它上面，然后其余标签被删除。旧标签地址会自动跳转。</p>
            {picked.map((t) => (
              <button
                key={t.id}
                className="btn btn-block"
                style={{ marginBottom: 8, justifyContent: 'space-between' }}
                onClick={() => {
                  setMerging(false);
                  void run(() => api('POST', '/tags/merge', { sourceIds: picked.map((p) => p.id), targetId: t.id }), `已合并到“${t.name}”`);
                }}
              >
                <span>保留“{t.name}”</span>
                <span className="muted small">{t.postCount} 篇</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

function TagForm({ tag, onClose, onSaved }: { tag: Tag; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: tag.name, slug: tag.slug, description: tag.description });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('PATCH', `/tags/${tag.id}`, form);
      toast('已保存');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="编辑标签" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="名称">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={50} autoFocus />
          </Field>
          <Field label="地址标识" hint="修改后旧地址会自动跳转">
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.trim().toLowerCase() })} required spellCheck={false} />
          </Field>
          <Field label="说明" hint="显示在标签页标题下方">
            <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} />
          </Field>
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary">保存</button>
        </div>
      </form>
    </Modal>
  );
}
