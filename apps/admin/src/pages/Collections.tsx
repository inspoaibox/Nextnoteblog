import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, uploadImage } from '../api';
import { MoveButtons, moveItem, useDragSort } from '../components/Sortable';
import { Field, Modal, StatusBadge, confirmDialog, toast } from '../components/ui';

const KIND: Record<string, string> = { topic: '专题', series: '系列' };

interface Item {
  postId: number;
  tid: number;
  title: string;
  status: string;
  deletedAt: number | null;
}

export function Collections() {
  const [list, setList] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api('GET', '/collections'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const remove = async (c: any) => {
    const ok = await confirmDialog({ title: `删除${KIND[c.kind]}“${c.title}”？`, body: `其中收录的 ${c.itemCount} 篇文章不会被删除，只是不再属于这个${KIND[c.kind]}。`, confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/collections/${c.id}`);
      toast('已删除');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (!list) return <div className="muted">加载中…</div>;

  return (
    <>
      <header className="page-head">
        <h1>专题与系列</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          ＋ 新建
        </button>
      </header>
      <p className="muted">专题把相关的文章收在一起；系列是有先后顺序的章节，文章页会显示“上一章 / 下一章”。它们与分类互相独立。</p>

      {list.length === 0 ? (
        <div className="empty">还没有专题或系列。</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>标题</th>
                <th>类型</th>
                <th>文章数</th>
                <th>状态</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="cell-title">
                    <button className="link-btn" onClick={() => setEditingId(c.id)}>
                      <strong>{c.title}</strong>
                    </button>
                    {!c.translated && <span className="badge badge-pending">未翻译</span>}
                    <div className="muted small">{c.url}</div>
                  </td>
                  <td>{KIND[c.kind]}</td>
                  <td>{c.itemCount}</td>
                  <td>{c.visible ? <span className="badge badge-published">公开</span> : <span className="badge">未公开</span>}</td>
                  <td className="actions">
                    <button className="link-btn" onClick={() => setEditingId(c.id)}>
                      编辑与排序
                    </button>
                    {c.visible && (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        查看
                      </a>
                    )}
                    <button className="link-btn danger" onClick={() => void remove(c)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateForm
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setEditingId(id);
            void load();
          }}
        />
      )}
      {editingId != null && (
        <CollectionEditor
          id={editingId}
          onClose={() => {
            setEditingId(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function CreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [form, setForm] = useState({ kind: 'series', title: '', description: '' });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onCreated((await api('POST', '/collections', form)).id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="新建专题或系列" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="类型">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ width: '100%' }}>
              <option value="series">系列：有先后顺序的章节</option>
              <option value="topic">专题：一组相关的文章</option>
            </select>
          </Field>
          <Field label="标题">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={200} autoFocus />
          </Field>
          <Field label="介绍">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={2000} />
          </Field>
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary">创建</button>
        </div>
      </form>
    </Modal>
  );
}

function CollectionEditor({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState({ title: '', slug: '', description: '', cover: '', visible: true });
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api('GET', `/collections/${id}`)
      .then((d) => {
        setData(d);
        setForm({ title: d.title, slug: d.slug, description: d.description, cover: d.cover, visible: d.visible });
        setItems(d.items);
      })
      .catch((e) => toast(e.message, 'error'));
  }, [id]);

  // 搜索文章以加入
  useEffect(() => {
    if (!query.trim()) return setFound([]);
    const timer = setTimeout(() => {
      api('GET', `/posts?q=${encodeURIComponent(query.trim())}&pageSize=8`)
        .then((res) => setFound(res.items))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const move = (from: number, to: number) => setItems((list) => moveItem(list, from, to));
  const drag = useDragSort(move);

  const save = async () => {
    setSaving(true);
    try {
      await api('PATCH', `/collections/${id}`, { ...form, postIds: items.map((i) => i.postId) });
      toast('已保存');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setSaving(false);
    }
  };

  if (!data) return null;
  const isSeries = data.kind === 'series';
  const inList = new Set(items.map((i) => i.postId));

  return (
    <Modal title={`编辑${KIND[data.kind]}`} onClose={onClose} wide>
      <div className="modal-body two-col">
        <div>
          <Field label="标题">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} />
          </Field>
          <Field label="地址标识" hint={`/${data.kind}/${form.slug}`}>
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.trim().toLowerCase() })} spellCheck={false} />
          </Field>
          <Field label="介绍">
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={2000} />
          </Field>
          <Field label="封面图">
            <div className="input-row">
              <input value={form.cover} onChange={(e) => setForm({ ...form, cover: e.target.value })} placeholder="图片地址" />
              <button type="button" className="btn" onClick={() => coverInput.current?.click()}>
                上传
              </button>
            </div>
            <input
              ref={coverInput}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  setForm({ ...form, cover: (await uploadImage(file, `${form.slug}-cover`)).url });
                } catch (err) {
                  toast((err as Error).message, 'error');
                }
              }}
            />
            {form.cover && <img className="cover-thumb" src={form.cover} alt="封面预览" />}
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.visible} onChange={(e) => setForm({ ...form, visible: e.target.checked })} /> 公开（取消后访客无法访问该页）
          </label>
        </div>

        <div>
          <h3 style={{ marginTop: 0 }}>{isSeries ? '章节（顺序即阅读顺序）' : '收录的文章'}</h3>
          {items.length === 0 ? (
            <p className="muted">还没有文章。在下方搜索并添加。</p>
          ) : (
            <ol className="sort-list">
              {items.map((item, index) => (
                <li key={item.postId} {...drag(index)}>
                  <span className="drag-handle" aria-hidden="true">
                    ⠿
                  </span>
                  {isSeries && <span className="muted small">{index + 1}.</span>}
                  <span className="sort-title">
                    {item.title || '（无标题）'}
                    {item.deletedAt ? <span className="badge badge-unpublished">在回收站</span> : item.status !== 'published' && <StatusBadge status={item.status} />}
                  </span>
                  <MoveButtons index={index} count={items.length} onMove={move} />
                  <button className="icon-btn" onClick={() => setItems((list) => list.filter((i) => i.postId !== item.postId))} aria-label="移出">
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          )}
          {items.some((i) => i.status !== 'published' || i.deletedAt) && <p className="muted small">未发布的文章不会出现在前台，发布后自动按这里的顺序显示。</p>}
          <Field label="添加文章">
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入标题搜索…" />
          </Field>
          {found.length > 0 && (
            <ul className="plain-list">
              {found.map((p) => (
                <li key={p.id}>
                  <span>
                    {p.title || '（无标题）'} <StatusBadge status={p.status} />
                  </span>
                  {inList.has(p.postId) ? (
                    <span className="muted small">已添加</span>
                  ) : (
                    <button className="link-btn" onClick={() => setItems((list) => [...list, { postId: p.postId, tid: p.id, title: p.title, status: p.status, deletedAt: null }])}>
                      添加
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          保存
        </button>
      </div>
    </Modal>
  );
}
