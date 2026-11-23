import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, uploadImage } from '../api';
import { Field, Modal, confirmDialog, toast } from '../components/ui';
import { MoveButtons, moveItem, useDragSort } from '../components/Sortable';

interface Link {
  id: number;
  name: string;
  url: string;
  description: string;
  avatar: string;
  groupName: string;
  sort: number;
  visible: boolean;
}

const EMPTY: Omit<Link, 'id' | 'sort'> = { name: '', url: '', description: '', avatar: '', groupName: '', visible: true };

export function Links() {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [intro, setIntro] = useState('');
  const [savedIntro, setSavedIntro] = useState('');
  const [editing, setEditing] = useState<Link | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ links: Link[]; intro: string }>('GET', '/links');
      setLinks(data.links);
      setIntro(data.intro);
      setSavedIntro(data.intro);
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

  const move = (from: number, to: number) => {
    if (!links) return;
    const next = moveItem(links, from, to);
    setLinks(next);
    void run(() => api('POST', '/links/reorder', { ids: next.map((l) => l.id) }));
  };
  const drag = useDragSort(move);

  if (!links) return <div className="muted">加载中…</div>;
  const groups = [...new Set(links.map((l) => l.groupName).filter(Boolean))];

  const remove = async (l: Link) => {
    if (await confirmDialog({ title: `删除友链“${l.name}”？`, confirmText: '删除', danger: true })) await run(() => api('DELETE', `/links/${l.id}`), '已删除');
  };

  return (
    <>
      <header className="page-head">
        <h1>友链</h1>
        <div className="row">
          <a className="btn" href="/links" target="_blank" rel="noreferrer">
            查看友链页
          </a>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            添加友链
          </button>
        </div>
      </header>

      {links.length === 0 ? (
        <div className="empty">还没有友链。添加后会显示在前台的“友链”页面。</div>
      ) : (
        <ol className="sort-list">
          {links.map((l, index) => (
            <li key={l.id} {...drag(index)} className={l.visible ? '' : 'is-hidden'}>
              <span className="drag-handle" aria-hidden="true">
                ⋮⋮
              </span>
              <span className="link-avatar-sm" aria-hidden="true">
                {l.avatar ? <img src={l.avatar} alt="" referrerPolicy="no-referrer" /> : [...l.name][0]}
              </span>
              <span className="sort-title">
                <strong>{l.name}</strong>
                {l.groupName && <span className="badge">{l.groupName}</span>}
                {!l.visible && <span className="badge badge-unpublished">已隐藏</span>}
                <div className="muted small">
                  {l.url}
                  {l.description && ` · ${l.description}`}
                </div>
              </span>
              <MoveButtons index={index} count={links.length} onMove={move} />
              <span className="actions">
                <button className="link-btn" onClick={() => setEditing(l)}>
                  编辑
                </button>
                <button className="link-btn" onClick={() => void run(() => api('PATCH', `/links/${l.id}`, { visible: !l.visible }), l.visible ? '已隐藏' : '已显示')}>
                  {l.visible ? '隐藏' : '显示'}
                </button>
                <button className="link-btn danger" onClick={() => void remove(l)}>
                  删除
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">拖动或用箭头调整顺序。同一分组的友链在前台排在一起；没有分组的排在最前面。</p>

      <section className="panel" style={{ marginTop: 24 }}>
        <h2>友链页说明</h2>
        <p className="muted small">显示在友链列表下方，适合写交换友链的要求和本站信息。支持 Markdown，留空则不显示。</p>
        <textarea rows={7} value={intro} onChange={(e) => setIntro(e.target.value)} style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }} aria-label="友链页说明" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-primary" disabled={intro === savedIntro} onClick={() => void run(() => api('PUT', '/links/intro', { intro }), '已保存')}>
            保存说明
          </button>
        </div>
      </section>

      {editing && (
        <LinkForm
          link={editing === 'new' ? null : editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function LinkForm({ link, groups, onClose, onSaved }: { link: Link | null; groups: string[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(link ? { name: link.name, url: link.url, description: link.description, avatar: link.avatar, groupName: link.groupName, visible: link.visible } : EMPTY);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (link) await api('PATCH', `/links/${link.id}`, form);
      else await api('POST', '/links', form);
      toast('已保存');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      set({ avatar: (await uploadImage(file, form.name)).url });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal title={link ? '编辑友链' : '添加友链'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="站点名称">
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={100} autoFocus />
          </Field>
          <Field label="地址">
            <input type="url" value={form.url} onChange={(e) => set({ url: e.target.value.trim() })} required placeholder="https://" spellCheck={false} />
          </Field>
          <Field label="一句话介绍">
            <input value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} />
          </Field>
          <Field label="头像 / 站标" hint="可以填图片地址，也可以上传；留空时前台显示名称首字">
            <div className="input-row">
              <input value={form.avatar} onChange={(e) => set({ avatar: e.target.value.trim() })} placeholder="https:// 或 /uploads/…" spellCheck={false} />
              <label className="btn" style={{ flex: 'none' }}>
                {uploading ? '上传中…' : '上传'}
                <input type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
              </label>
            </div>
          </Field>
          <Field label="分组" hint="可留空；同名分组排在一起">
            <input value={form.groupName} onChange={(e) => set({ groupName: e.target.value })} maxLength={50} list="link-groups" />
            <datalist id="link-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.visible} onChange={(e) => set({ visible: e.target.checked })} /> 在前台显示
          </label>
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
