import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, fmtTime, uploadImage } from '../api';
import { Field, Modal, confirmDialog, toast } from '../components/ui';

type Status = 'active' | 'maintained' | 'experimental' | 'archived';
const STATUS_LABEL: Record<Status, string> = { active: '活跃开发', maintained: '维护中', experimental: '实验性', archived: '已归档' };

interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  tagline: string;
  translated: boolean;
  repoUrl: string;
  language: string;
  license: string;
  status: Status;
  featured: boolean;
  visible: boolean;
  stars: number;
  latestVersion: string;
  syncedAt: number | null;
  syncError: string;
  url: string;
}

interface Project extends ProjectRow {
  markdown: string;
  homepage: string;
  docsUrl: string;
  downloadUrl: string;
  logo: string;
  sort: number;
  tagId: number | null;
  forks: number;
}

interface Tag {
  id: number;
  name: string;
}

const isGithub = (url: string) => /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/i.test(url);

export function Projects() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [intro, setIntro] = useState('');
  const [savedIntro, setSavedIntro] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [syncing, setSyncing] = useState<number | 'all' | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ projects: ProjectRow[]; intro: string }>('GET', '/projects');
      setRows(data.projects);
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
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    await load();
  };

  if (!rows) return <div className="muted">加载中…</div>;
  const syncable = rows.filter((r) => isGithub(r.repoUrl)).length;

  const sync = async (id: number | 'all') => {
    setSyncing(id);
    if (id === 'all') {
      await run(async () => {
        const r = await api<{ ok: number; failed: number }>('POST', '/projects/sync', {});
        toast(r.failed ? `已同步 ${r.ok} 个，${r.failed} 个失败` : `已同步 ${r.ok} 个项目`, r.failed ? 'error' : 'ok');
      });
    } else await run(() => api('POST', `/projects/${id}/sync`, {}), '已从 GitHub 同步');
    setSyncing(null);
  };
  const remove = async (p: ProjectRow) => {
    if (await confirmDialog({ title: `删除项目“${p.name}”？`, body: '所有语言的介绍都会一起删除，相关文章不受影响。', confirmText: '删除', danger: true })) await run(() => api('DELETE', `/projects/${p.id}`), '已删除');
  };

  return (
    <>
      <header className="page-head">
        <h1>开源项目</h1>
        <div className="row">
          {syncable > 0 && (
            <button className="btn" disabled={syncing !== null} onClick={() => void sync('all')} title="从 GitHub 更新星标、派生数、最新版本">
              {syncing === 'all' ? '同步中…' : '全部从 GitHub 同步'}
            </button>
          )}
          <a className="btn" href="/projects" target="_blank" rel="noreferrer">
            查看项目页
          </a>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            添加项目
          </button>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="empty">还没有项目。添加后会显示在前台的“开源项目”页面，每个项目有自己的介绍页。</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '52%' }}>项目</th>
                <th>状态</th>
                <th>版本 / 星标</th>
                <th>同步</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} style={p.visible ? undefined : { opacity: 0.55 }}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.featured && <span className="badge badge-published">置顶</span>}
                    {!p.visible && <span className="badge badge-unpublished">已隐藏</span>}
                    {!p.translated && <span className="badge badge-pending" title="当前语言还没有介绍，显示的是其他语言的内容">未翻译</span>}
                    {p.tagline && <div className="muted small">{p.tagline}</div>}
                    <div className="muted small">
                      {p.url}
                      {p.language && ` · ${p.language}`}
                      {p.license && ` · ${p.license}`}
                    </div>
                  </td>
                  <td className="nowrap">{STATUS_LABEL[p.status]}</td>
                  <td className="nowrap">
                    {p.latestVersion || '—'}
                    <div className="muted small">★ {p.stars}</div>
                  </td>
                  <td className="small">
                    {!isGithub(p.repoUrl) ? (
                      <span className="muted">手动维护</span>
                    ) : p.syncError ? (
                      <span className="form-error" title={p.syncError}>
                        失败
                      </span>
                    ) : (
                      <span className="muted">{p.syncedAt ? fmtTime(p.syncedAt) : '未同步'}</span>
                    )}
                  </td>
                  <td className="actions">
                    <button className="link-btn" onClick={() => setEditing(p.id)}>
                      编辑
                    </button>
                    {isGithub(p.repoUrl) && (
                      <button className="link-btn" disabled={syncing !== null} onClick={() => void sync(p.id)}>
                        {syncing === p.id ? '同步中…' : '同步'}
                      </button>
                    )}
                    {p.visible && (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        查看
                      </a>
                    )}
                    <button className="link-btn danger" onClick={() => void remove(p)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">GitHub 仓库可以一键同步星标、派生数、许可证、主要语言和最新版本；已手填的许可证、语言、主页不会被覆盖。其他平台的项目在编辑里手动填写。</p>

      <section className="panel" style={{ marginTop: 24 }}>
        <h2>项目页说明</h2>
        <p className="muted small">显示在项目列表上方，支持 Markdown，留空则不显示。</p>
        <textarea rows={4} value={intro} onChange={(e) => setIntro(e.target.value)} style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }} aria-label="项目页说明" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-primary" disabled={intro === savedIntro} onClick={() => void run(() => api('PUT', '/projects/intro', { intro }), '已保存')}>
            保存说明
          </button>
        </div>
      </section>

      {editing !== null && (
        <ProjectForm
          id={editing === 'new' ? null : editing}
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

const BLANK = { name: '', slug: '', tagline: '', markdown: '', repoUrl: '', homepage: '', docsUrl: '', downloadUrl: '', license: '', language: '', logo: '', status: 'active' as Status, featured: false, visible: true, sort: 0, tagId: null as number | null, stars: 0, forks: 0, latestVersion: '' };

function ProjectForm({ id, onClose, onSaved }: { id: number | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<typeof BLANK | null>(id ? null : BLANK);
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [translated, setTranslated] = useState(true);
  const set = (patch: Partial<typeof BLANK>) => setForm((f) => (f ? { ...f, ...patch } : f));

  useEffect(() => {
    void api<Tag[]>('GET', '/tags').then(setTags, () => setTags([]));
    if (id)
      void api<Project>('GET', `/projects/${id}`).then(
        (p) => {
          setTranslated(p.translated);
          setForm({ name: p.name, slug: p.slug, tagline: p.tagline, markdown: p.markdown, repoUrl: p.repoUrl, homepage: p.homepage, docsUrl: p.docsUrl, downloadUrl: p.downloadUrl, license: p.license, language: p.language, logo: p.logo, status: p.status, featured: p.featured, visible: p.visible, sort: p.sort, tagId: p.tagId, stars: p.stars, forks: p.forks, latestVersion: p.latestVersion });
        },
        (e) => setError((e as Error).message),
      );
  }, [id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    try {
      if (id) await api('PATCH', `/projects/${id}`, form);
      else await api('POST', '/projects', { ...form, slug: form.slug || undefined });
      toast('已保存');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file || !form) return;
    setUploading(true);
    try {
      set({ logo: (await uploadImage(file, form.name)).url });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal title={id ? '编辑项目' : '添加项目'} onClose={onClose} wide>
      {!form ? (
        <div className="modal-body muted">{error || '加载中…'}</div>
      ) : (
        <form onSubmit={submit}>
          <div className="modal-body">
            {!translated && <p className="warn-text small">当前语言还没有这个项目的介绍，下面带出的是其他语言的内容；保存后会成为当前语言的版本。</p>}
            <div className="config-grid">
              <Field label="项目名称">
                <input value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={100} autoFocus />
              </Field>
              <Field label="地址标识" hint={id ? '修改后旧地址会自动跳转' : '留空根据名称生成'}>
                <input value={form.slug} onChange={(e) => set({ slug: e.target.value.trim().toLowerCase() })} placeholder="my-project" spellCheck={false} />
              </Field>
            </div>
            <Field label="一句话介绍" hint="显示在项目卡片和项目页标题下方；同步 GitHub 时如果为空会用仓库描述补上">
              <input value={form.tagline} onChange={(e) => set({ tagline: e.target.value })} maxLength={300} />
            </Field>
            <div className="config-grid">
              <Field label="仓库地址" hint="GitHub 仓库可以一键同步数据">
                <input type="url" value={form.repoUrl} onChange={(e) => set({ repoUrl: e.target.value.trim() })} placeholder="https://github.com/owner/repo" spellCheck={false} />
              </Field>
              <Field label="项目主页">
                <input type="url" value={form.homepage} onChange={(e) => set({ homepage: e.target.value.trim() })} placeholder="https://" spellCheck={false} />
              </Field>
              <Field label="文档地址">
                <input type="url" value={form.docsUrl} onChange={(e) => set({ docsUrl: e.target.value.trim() })} placeholder="https://" spellCheck={false} />
              </Field>
              <Field label="下载地址">
                <input type="url" value={form.downloadUrl} onChange={(e) => set({ downloadUrl: e.target.value.trim() })} placeholder="https://" spellCheck={false} />
              </Field>
              <Field label="主要语言">
                <input value={form.language} onChange={(e) => set({ language: e.target.value })} placeholder="TypeScript" maxLength={60} />
              </Field>
              <Field label="许可证">
                <input value={form.license} onChange={(e) => set({ license: e.target.value })} placeholder="MIT" maxLength={60} />
              </Field>
              <Field label="状态">
                <select value={form.status} onChange={(e) => set({ status: e.target.value as Status })}>
                  {Object.entries(STATUS_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="相关文章" hint="带这个标签的文章会列在项目页底部，适合发布说明、教程">
                <select value={form.tagId ?? ''} onChange={(e) => set({ tagId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">不关联</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="最新版本" hint="GitHub 项目同步时自动更新">
                <input value={form.latestVersion} onChange={(e) => set({ latestVersion: e.target.value })} placeholder="v1.0.0" maxLength={60} />
              </Field>
              <Field label="星标 / 派生" hint="GitHub 项目同步时自动更新">
                <div className="input-row">
                  <input type="number" min={0} value={form.stars} onChange={(e) => set({ stars: Math.max(0, Number(e.target.value) || 0) })} aria-label="星标" />
                  <input type="number" min={0} value={form.forks} onChange={(e) => set({ forks: Math.max(0, Number(e.target.value) || 0) })} aria-label="派生" />
                </div>
              </Field>
            </div>
            <Field label="图标" hint="方形图片效果最好；留空时显示项目名首字">
              <div className="input-row">
                <input value={form.logo} onChange={(e) => set({ logo: e.target.value.trim() })} placeholder="https:// 或 /uploads/…" spellCheck={false} />
                <label className="btn" style={{ flex: 'none' }}>
                  {uploading ? '上传中…' : '上传'}
                  <input type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
                </label>
              </div>
            </Field>
            <Field label="项目介绍" hint="Markdown，显示在项目页；可以写特性、安装方法、截图、路线图">
              <textarea rows={12} value={form.markdown} onChange={(e) => set({ markdown: e.target.value })} style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }} />
            </Field>
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              <label className="check">
                <input type="checkbox" checked={form.featured} onChange={(e) => set({ featured: e.target.checked })} /> 置顶（排在最前并突出显示）
              </label>
              <label className="check">
                <input type="checkbox" checked={form.visible} onChange={(e) => set({ visible: e.target.checked })} /> 在前台显示
              </label>
              <label className="check">
                排序
                <input type="number" value={form.sort} onChange={(e) => set({ sort: Number(e.target.value) || 0 })} style={{ width: 80 }} />
                <span className="muted small">数字小的在前</span>
              </label>
            </div>
            {error && <p className="form-error">{error}</p>}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary">保存</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
