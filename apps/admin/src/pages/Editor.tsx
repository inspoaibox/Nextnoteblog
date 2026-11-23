import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { computeStats } from '@nexemc/markdown';
import { ApiError, STATUS_LABEL, api, fmtTime, uploadImage } from '../api';
import { useStatus } from '../App';
import { MarkdownEditor, type EditorHandle } from '../components/MarkdownEditor';
import { Preview, type PreviewHandle } from '../components/Preview';
import { DiffView, Revisions } from '../components/Revisions';
import { TaxonomyPanel } from '../components/TaxonomyPanel';
import { Field, Modal, StatusBadge, confirmDialog, toast } from '../components/ui';

interface Fields {
  title: string;
  subtitle: string;
  excerpt: string;
  cover: string;
  markdown: string;
  frontMatter: string;
  meta: Record<string, any>;
}
type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'error';
type Mode = 'edit' | 'split' | 'preview';

const AUTOSAVE_MS = 2500;
const CODE_LANGS = ['text', 'bash', 'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'sql', 'json', 'yaml', 'html', 'css', 'markdown', 'diff', 'dockerfile', 'nginx'];
const SHORTCUTS: [string, string][] = [
  ['Ctrl/⌘ + S', '保存'],
  ['Ctrl/⌘ + B', '粗体'],
  ['Ctrl/⌘ + I', '斜体'],
  ['Ctrl/⌘ + K', '插入链接'],
  ['Ctrl/⌘ + E', '行内代码'],
  ['Ctrl/⌘ + F', '查找 / 替换'],
  ['Ctrl/⌘ + Z / Shift + Z', '撤销 / 重做'],
  ['Alt + 点击 / Ctrl + D', '多光标 / 选中下一个相同词'],
  ['Tab / Shift + Tab', '缩进 / 减少缩进'],
  ['粘贴或拖入图片', '自动上传并插入'],
];

const pickFields = (draft: any): Fields => ({ title: draft.title, subtitle: draft.subtitle, excerpt: draft.excerpt, cover: draft.cover, markdown: draft.markdown, frontMatter: draft.frontMatter, meta: draft.meta ?? {} });
const backupKey = (id: number) => `nb:draft:${id}`;

export function Editor() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { status } = useStatus();

  const [data, setData] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [fields, setFields] = useState<Fields | null>(null);
  const [slug, setSlug] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>(() => (window.innerWidth < 900 ? 'edit' : ((localStorage.getItem('nb:editor-mode') as Mode) || 'split')));
  const [wrapLines, setWrapLines] = useState(() => localStorage.getItem('nb:editor-wrap') !== '0');
  const [fullscreen, setFullscreen] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [conflict, setConflict] = useState<any>(null);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);

  const editor = useRef<EditorHandle>(null);
  const preview = useRef<PreviewHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const fieldsRef = useRef<Fields | null>(null);
  const lockVersion = useRef(0);
  const savedSnapshot = useRef('');
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const autosaveTimer = useRef<number>(0);
  const uploadSeq = useRef(0);

  /* ---------- 加载 ---------- */

  const apply = useCallback((payload: any, resetEditor: boolean) => {
    const f = pickFields(payload.draft);
    setData(payload);
    setFields(f);
    fieldsRef.current = f;
    setSlug(payload.translation.slug);
    lockVersion.current = payload.translation.lockVersion;
    savedSnapshot.current = JSON.stringify(f);
    setSavedAt(payload.draft.updatedAt);
    setSaveState('saved');
    if (resetEditor) editor.current?.setValue(f.markdown);
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await api('GET', `/posts/${id}`);
      apply(payload, true);

      // 上次编辑中断时留在本机的内容（断网、崩溃、误关页面）
      const raw = localStorage.getItem(backupKey(id));
      if (raw) {
        const backup = JSON.parse(raw) as { fields: Fields; ts: number };
        const differs = JSON.stringify(backup.fields) !== JSON.stringify(pickFields(payload.draft));
        if (differs && backup.ts > payload.draft.updatedAt) {
          const ok = await confirmDialog({
            title: '发现未保存到服务器的本地内容',
            body: `本机保留了一份 ${fmtTime(backup.ts)} 的编辑内容，比服务器上的草稿更新。要恢复它吗？`,
            confirmText: '恢复本地内容',
            cancelText: '丢弃',
          });
          if (ok) {
            setFields(backup.fields);
            fieldsRef.current = backup.fields;
            editor.current?.setValue(backup.fields.markdown);
            setSaveState('dirty');
            scheduleAutosave();
            return;
          }
        }
        localStorage.removeItem(backupKey(id));
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, apply]);

  useEffect(() => {
    void load();
    return () => window.clearTimeout(autosaveTimer.current);
  }, [load]);

  /* ---------- 保存 ---------- */

  const isDirty = () => !!fieldsRef.current && JSON.stringify(fieldsRef.current) !== savedSnapshot.current;

  const saveNow = async (saveMode: 'auto' | 'manual', force = false): Promise<boolean> => {
    const current = fieldsRef.current;
    if (!current) return false;
    const snapshot = JSON.stringify(current);
    if (snapshot === savedSnapshot.current && saveMode === 'auto' && !force) return true;
    setSaveState('saving');
    try {
      const res = await api('PUT', `/posts/${id}/draft`, { ...current, baseVersion: lockVersion.current, mode: saveMode, force });
      lockVersion.current = res.lockVersion;
      savedSnapshot.current = snapshot;
      setSavedAt(res.savedAt);
      if (res.slug) {
        // 首次发布前，服务器会把占位地址换成由标题生成的地址
        setSlug((cur) => (document.activeElement?.closest('.meta-panel') ? cur : res.slug));
        setData((d: any) => (d && d.translation.slug !== res.slug ? { ...d, translation: { ...d.translation, slug: res.slug }, path: `/posts/${res.slug}` } : d));
      }
      if (JSON.stringify(fieldsRef.current) === snapshot) {
        localStorage.removeItem(backupKey(id));
        setSaveState('saved');
      } else {
        setSaveState('dirty');
        scheduleAutosave();
      }
      setData((d: any) => (d ? { ...d, hasPendingChanges: !!d.translation.publishedRevisionId && (res.changed || d.hasPendingChanges) } : d));
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) {
        setConflict(err.data);
        setSaveState('error');
      } else if (err.status === 0) {
        setSaveState('offline'); // 内容仍在本机备份里，联网后自动重试
        autosaveTimer.current = window.setTimeout(() => void save('auto'), 8000);
      } else {
        setSaveState('error');
        toast(`保存失败：${err.message}`, 'error');
      }
      return false;
    }
  };

  /** 保存请求串行执行，避免自己和自己产生版本冲突 */
  const save = (saveMode: 'auto' | 'manual', force = false) => {
    window.clearTimeout(autosaveTimer.current);
    saveChain.current = saveChain.current.then(() => saveNow(saveMode, force));
    return saveChain.current;
  };

  function scheduleAutosave() {
    window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => void save('auto'), AUTOSAVE_MS);
  }

  const change = (patch: Partial<Fields>) => {
    if (!fieldsRef.current) return;
    const next = { ...fieldsRef.current, ...patch };
    fieldsRef.current = next;
    setFields(next);
    if (!isDirty()) return setSaveState('saved');
    setSaveState((s) => (s === 'offline' ? s : 'dirty'));
    try {
      localStorage.setItem(backupKey(id), JSON.stringify({ fields: next, ts: Date.now() }));
    } catch {
      /* 本地存储已满时忽略，服务器保存仍会进行 */
    }
    scheduleAutosave();
  };
  const changeMeta = (patch: Record<string, unknown>) => change({ meta: { ...fieldsRef.current!.meta, ...patch } });

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** 切到同一篇文章的另一个语言版本前，先把当前修改存好 */
  const switchTo = async (path: string) => {
    if (isDirty() && !(await save('auto'))) return;
    navigate(path);
  };
  const addTranslation = async (locale: string, name: string) => {
    const ok = await confirmDialog({ title: `创建${name}译文？`, body: '会复制当前语言的内容作为译文草稿。翻译并发布后才会对访客可见，其他语言版本不受影响。', confirmText: '创建译文' });
    if (!ok || (isDirty() && !(await save('manual')))) return;
    try {
      const created = await api('POST', `/posts/${id}/translate`, { locale });
      navigate(`/posts/${created.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const markSynced = async () => {
    try {
      const payload = await api('POST', `/posts/${id}/synced`, {});
      setData((d: any) => ({ ...d, source: payload.source }));
      toast('已标记为与原文同步');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const leave = async () => {
    if (isDirty() && !(await save('auto'))) {
      if (!(await confirmDialog({ title: '修改尚未保存到服务器', body: '内容已保留在本机，下次打开这篇文章时可以恢复。仍要离开吗？', confirmText: '离开', danger: true }))) return;
    }
    navigate('/posts');
  };

  /* ---------- 图片 ---------- */

  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      const seq = ++uploadSeq.current;
      const token = `uploading-${Date.now()}-${seq}`;
      const placeholder = `![上传中…](${token})`;
      editor.current?.insertText(`${placeholder}\n`);
      setUploading((n) => n + 1);
      try {
        // 粘贴的截图没有有意义的文件名，按“文章地址 + 序号”命名
        const generic = !file.name || /^image\.\w+$/i.test(file.name);
        const saved = await uploadImage(file, generic ? `${slug}-${seq}` : '');
        const alt = generic ? '' : file.name.replace(/\.\w+$/, '');
        editor.current?.replaceText(placeholder, `![${saved.alt || alt}](${saved.url})`);
      } catch (e) {
        editor.current?.replaceText(`${placeholder}\n`, '');
        toast(`图片上传失败：${(e as Error).message}`, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const uploadCover = async (file: File | undefined) => {
    if (!file) return;
    try {
      const saved = await uploadImage(file, `${slug}-cover`);
      change({ cover: saved.url });
    } catch (e) {
      toast(`封面上传失败：${(e as Error).message}`, 'error');
    }
  };

  /* ---------- 元信息（立即生效，不进修订） ---------- */

  const patchMeta = async (patch: Record<string, unknown>) => {
    try {
      const payload = await api('PATCH', `/posts/${id}/meta`, patch);
      setData((d: any) => ({ ...d, translation: { ...payload.translation, lockVersion: d.translation.lockVersion }, post: payload.post, path: payload.path }));
      setSlug(payload.translation.slug);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };

  const commitSlug = async () => {
    const original = data.translation.slug;
    if (slug === original) return;
    if (data.translation.firstPublishedAt) {
      const ok = await confirmDialog({ title: '修改已公开文章的地址？', body: `地址将从 /posts/${original} 变为 /posts/${slug}。旧地址会自动跳转到新地址，但已被分享或收录的链接需要一段时间才会更新。`, confirmText: '修改地址' });
      if (!ok) return setSlug(original);
    }
    if (!(await patchMeta({ slug }))) setSlug(original);
  };

  const generateSlug = async () => {
    try {
      const res = await api('GET', `/slugify?title=${encodeURIComponent(fieldsRef.current!.title)}&exclude=${id}`);
      setSlug(res.slug);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /* ---------- 发布相关 ---------- */

  const runAction = async (action: string, okText: string, body: unknown = {}) => {
    setBusy(true);
    try {
      const payload = await api('POST', `/posts/${id}/${action}`, body);
      setData(payload);
      lockVersion.current = payload.translation.lockVersion;
      toast(okText);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!(await save('manual'))) return;
    let checks: { errors: string[]; warnings: string[] };
    try {
      checks = await api('GET', `/posts/${id}/checks`);
    } catch (e) {
      return toast((e as Error).message, 'error');
    }
    if (checks.errors.length) {
      await confirmDialog({ title: '还不能发布', body: <ul>{checks.errors.map((x) => <li key={x}>{x}</li>)}</ul>, confirmText: '知道了', cancelText: '关闭' });
      return;
    }
    const live = !!data.translation.publishedRevisionId && data.translation.status === 'published';
    let minor = false;
    const ok = await confirmDialog({
      title: live ? '发布新版本？' : '发布这篇文章？',
      confirmText: live ? '发布新版本' : '发布',
      body: (
        <>
          <p>{live ? '当前编辑内容将替换线上版本，访客立即可见。' : `文章将公开在 /posts/${slug}。`}</p>
          {checks.warnings.length > 0 && (
            <ul className="warn-list">
              {checks.warnings.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          {live && (
            <label className="check">
              <input type="checkbox" onChange={(e) => (minor = e.target.checked)} /> 只是小修改，不更新文章的“更新日期”
            </label>
          )}
        </>
      ),
    });
    if (ok) await runAction('publish', live ? '新版本已发布' : '文章已发布', { minor });
  };

  const unpublish = async () => {
    if (await confirmDialog({ title: '下线这篇文章？', body: '访客将无法访问，原稿与版本历史会保留，可随时重新发布。', confirmText: '下线', danger: true })) await runAction('unpublish', '已下线');
  };
  const archive = async () => {
    if (await confirmDialog({ title: '归档这篇文章？', body: '归档后文章仍可通过链接访问，但不再出现在首页和文章列表中。', confirmText: '归档' })) await runAction('archive', '已归档');
  };
  const rollback = async () => {
    if (await confirmDialog({ title: '回退到上一个发布版本？', body: '线上内容会换回上一次发布的版本。当前草稿不受影响。', confirmText: '回退', danger: true })) await runAction('rollback', '线上已回退到上一版本');
  };

  /* ---------- 冲突处理 ---------- */

  const resolveConflict = async (keepMine: boolean) => {
    const server = conflict;
    setConflict(null);
    if (keepMine) {
      lockVersion.current = server.translation.lockVersion;
      if (await save('manual', true)) toast('已用当前内容覆盖');
    } else {
      localStorage.removeItem(backupKey(id));
      apply(server, true);
      toast('已载入服务器上的版本');
    }
  };

  /* ---------- 视图 ---------- */

  const setModePersist = (m: Mode) => {
    setMode(m);
    localStorage.setItem('nb:editor-mode', m);
  };
  const stats = useMemo(() => computeStats(fields?.markdown ?? ''), [fields?.markdown]);

  if (loadError) {
    return (
      <div className="center-page">
        <div className="auth-card">
          <h1>无法打开文章</h1>
          <p className="muted">{loadError}</p>
          <button className="btn" onClick={() => navigate('/posts')}>
            返回文章列表
          </button>
        </div>
      </div>
    );
  }
  if (!data || !fields) return <div className="center-page muted">加载中…</div>;

  const t = data.translation;
  const isLive = t.status === 'published' || t.status === 'archived';
  const ed = editor.current;
  const saveLabel: Record<SaveState, string> = {
    saved: savedAt ? `已保存 ${new Intl.DateTimeFormat('zh-CN', { timeStyle: 'short' }).format(savedAt)}` : '已保存',
    dirty: '有未保存的修改',
    saving: '保存中…',
    offline: '网络不可用，改动已保留在本机，将自动重试',
    error: '保存失败',
  };

  const tools: ([string, string, () => void] | null)[] = [
    ['B', '粗体 (Ctrl+B)', () => ed?.wrap('**', '**', '粗体')],
    ['I', '斜体 (Ctrl+I)', () => ed?.wrap('*', '*', '斜体')],
    ['S', '删除线', () => ed?.wrap('~~', '~~', '删除线')],
    ['<>', '行内代码 (Ctrl+E)', () => ed?.wrap('`', '`', 'code')],
    null,
    ['”', '引用', () => ed?.prefixLines('> ')],
    ['•', '无序列表', () => ed?.prefixLines('- ')],
    ['1.', '有序列表', () => ed?.prefixLines((i) => `${i + 1}. `)],
    ['☑', '任务列表', () => ed?.prefixLines('- [ ] ')],
    null,
    ['🔗', '链接 (Ctrl+K)', () => ed?.wrap('[', '](https://)', '链接文字')],
    ['🖼', '上传图片', () => fileInput.current?.click()],
    ['▦', '表格', () => ed?.insertBlock('| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |', 2, 5)],
    ['—', '分割线', () => ed?.insertBlock('---')],
    ['¹', '脚注', () => ed?.insertText('[^1]\n\n[^1]: 脚注内容')],
    ['!', '提示块', () => ed?.insertBlock(':::tip[提示]\n内容\n:::', 15, 17)],
  ];

  return (
    <div className={`editor-page mode-${mode}${fullscreen ? ' fullscreen' : ''}`}>
      <header className="editor-top">
        <button className="btn" onClick={() => void leave()} title="返回文章列表">
          ← 返回
        </button>
        <input className="title-input" value={fields.title} onChange={(e) => change({ title: e.target.value })} placeholder="文章标题" aria-label="文章标题" maxLength={300} />
        <span className="editor-status">
          <StatusBadge status={t.status} pending={data.hasPendingChanges} />
        </span>
        <span className={`save-state save-${saveState}`} role="status">
          {saveLabel[saveState]}
        </span>
        <button className="btn" onClick={() => void save('manual')} disabled={saveState === 'saving'}>
          保存
        </button>
        <a className="btn" href={`/preview/post/${id}`} target="_blank" rel="noreferrer" onClick={() => void save('auto')} title="用站点主题预览当前草稿（仅管理员可见）">
          预览 ↗
        </a>
        <button className="btn" onClick={() => setShowHistory(true)}>
          历史
        </button>
        <button className={`btn${showMeta ? ' active' : ''}`} onClick={() => setShowMeta((v) => !v)}>
          文章设置
        </button>
        <button className="btn btn-primary" onClick={() => void publish()} disabled={busy || (t.status === 'published' && !data.hasPendingChanges && saveState === 'saved')}>
          {t.status === 'published' ? '发布新版本' : t.publishedRevisionId ? '重新发布' : '发布'}
        </button>
      </header>

      {status.languages.length > 1 && (
        <div className="lang-bar">
          <span className="muted small">语言版本</span>
          {status.languages.map((l) => {
            const sibling = data.siblings.find((x: any) => x.locale === l.code);
            if (sibling)
              return sibling.id === id ? (
                <strong key={l.code} className="lang-tab active">
                  {l.name}
                </strong>
              ) : (
                <button key={l.code} className="lang-tab" onClick={() => void switchTo(`/posts/${sibling.id}`)} title={STATUS_LABEL[sibling.status]}>
                  {l.name}
                  <span className={`dot dot-${sibling.status}`} />
                </button>
              );
            return (
              <button key={l.code} className="lang-tab lang-add" onClick={() => void addTranslation(l.code, l.name)}>
                ＋ {l.name}
              </button>
            );
          })}
          {data.source?.stale && (
            <span className="lang-stale">
              原文在翻译之后又发布了新版本，译文可能需要更新。
              <button className="link-btn" onClick={() => void switchTo(`/posts/${data.source.id}`)}>
                查看原文
              </button>
              <button className="link-btn" onClick={() => void markSynced()}>
                已更新，不再提示
              </button>
            </span>
          )}
        </div>
      )}

      <div className="editor-toolbar" role="toolbar" aria-label="Markdown 工具栏">
        <select
          aria-label="标题级别"
          value=""
          onChange={(e) => {
            if (e.target.value) ed?.prefixLines(`${'#'.repeat(Number(e.target.value))} `);
          }}
        >
          <option value="">标题</option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              H{n}
            </option>
          ))}
        </select>
        {tools.map((tool, i) =>
          tool ? (
            <button key={tool[1]} className="tool" title={tool[1]} aria-label={tool[1]} onClick={tool[2]}>
              {tool[0]}
            </button>
          ) : (
            <span key={i} className="tool-sep" />
          ),
        )}
        <select
          aria-label="插入代码块"
          value=""
          onChange={(e) => {
            if (e.target.value) ed?.insertBlock(`\`\`\`${e.target.value === 'text' ? '' : e.target.value}\n\n\`\`\``, e.target.value === 'text' ? 4 : e.target.value.length + 4);
          }}
        >
          <option value="">代码块</option>
          {CODE_LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <span className="tool-space" />
        {uploading > 0 && <span className="muted small">正在上传 {uploading} 张图片…</span>}
        <label className="check small">
          <input
            type="checkbox"
            checked={wrapLines}
            onChange={(e) => {
              setWrapLines(e.target.checked);
              localStorage.setItem('nb:editor-wrap', e.target.checked ? '1' : '0');
            }}
          />
          自动折行
        </label>
        <div className="seg" role="group" aria-label="视图模式">
          {(['edit', 'split', 'preview'] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setModePersist(m)}>
              {{ edit: '编辑', split: '分屏', preview: '预览' }[m]}
            </button>
          ))}
        </div>
        <button className="tool" title={fullscreen ? '退出专注模式' : '专注模式'} onClick={() => setFullscreen((v) => !v)}>
          ⛶
        </button>
        <button className="tool" title="快捷键说明" onClick={() => setShowHelp(true)}>
          ?
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void uploadFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>

      <div className="editor-body">
        <div className="pane pane-edit">
          <MarkdownEditor ref={editor} initialValue={fields.markdown} wrapLines={wrapLines} onChange={(markdown) => change({ markdown })} onSave={() => void save('manual')} onFiles={(files) => void uploadFiles(files)} onTopLine={(line) => preview.current?.scrollToLine(line)} />
        </div>
        <div className="pane pane-preview">
          <Preview ref={preview} markdown={fields.markdown} title={fields.title} subtitle={fields.subtitle} themeCss={status.themeCss} appearance={status.site.appearance} />
        </div>

        {showMeta && (
          <aside className="meta-panel">
            <div className="row between">
              <h2>文章设置</h2>
              <button className="icon-btn" onClick={() => setShowMeta(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <Field label="地址标识" hint={`公开地址：/posts/${slug}`}>
              <div className="input-row">
                <input value={slug} onChange={(e) => setSlug(e.target.value.trim().toLowerCase())} onBlur={() => void commitSlug()} spellCheck={false} />
                <button className="btn" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void generateSlug().then(() => setTimeout(() => void commitSlug(), 0))} title="根据标题生成（中文转拼音）">
                  生成
                </button>
              </div>
            </Field>
            <TaxonomyPanel postId={id} />
            <Field label="副标题">
              <input value={fields.subtitle} onChange={(e) => change({ subtitle: e.target.value })} maxLength={300} />
            </Field>
            <Field label="摘要" hint="留空时自动截取正文开头">
              <textarea rows={3} value={fields.excerpt} onChange={(e) => change({ excerpt: e.target.value })} maxLength={2000} />
            </Field>
            <Field label="封面图">
              <div className="input-row">
                <input value={fields.cover} onChange={(e) => change({ cover: e.target.value })} placeholder="图片地址" />
                <button className="btn" type="button" onClick={() => coverInput.current?.click()}>
                  上传
                </button>
              </div>
              <input
                ref={coverInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void uploadCover(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              {fields.cover && <img className="cover-thumb" src={fields.cover} alt="封面预览" />}
            </Field>
            <label className="check">
              <input type="checkbox" checked={!!data.post.pinned} onChange={(e) => void patchMeta({ pinned: e.target.checked })} /> 置顶
            </label>
            <label className="check">
              <input type="checkbox" checked={!!data.post.featured} onChange={(e) => void patchMeta({ featured: e.target.checked })} /> 精选（显示在首页精选区）
            </label>
            <label className="check">
              <input type="checkbox" checked={fields.meta.showToc !== false} onChange={(e) => changeMeta({ showToc: e.target.checked })} /> 显示目录
            </label>

            <h3>SEO</h3>
            <Field label="SEO 标题" hint="留空使用文章标题">
              <input value={fields.meta.seoTitle ?? ''} onChange={(e) => changeMeta({ seoTitle: e.target.value })} maxLength={200} />
            </Field>
            <Field label="SEO 描述" hint="留空使用摘要">
              <textarea rows={2} value={fields.meta.seoDescription ?? ''} onChange={(e) => changeMeta({ seoDescription: e.target.value })} maxLength={500} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={fields.meta.noindex === true} onChange={(e) => changeMeta({ noindex: e.target.checked })} /> 不让搜索引擎收录
            </label>

            {t.publishedRevisionId && (
              <>
                <h3>发布</h3>
                <p className="muted small">
                  首次发布：{fmtTime(t.firstPublishedAt)}
                  <br />
                  最近发布：{fmtTime(t.publishedAt)}
                </p>
                <div className="row wrap">
                  {isLive && (
                    <a className="btn" href={data.path} target="_blank" rel="noreferrer">
                      查看线上 ↗
                    </a>
                  )}
                  <button className="btn" onClick={() => void rollback()} disabled={busy}>
                    回退上一版
                  </button>
                  {t.status === 'published' && (
                    <button className="btn" onClick={() => void archive()} disabled={busy}>
                      归档
                    </button>
                  )}
                  {isLive && (
                    <button className="btn btn-danger" onClick={() => void unpublish()} disabled={busy}>
                      下线
                    </button>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      <footer className="editor-foot">
        <span>{stats.words} 字</span>
        <span>{stats.chars} 字符</span>
        <span>{stats.paragraphs} 段</span>
        <span>约 {stats.readingMinutes} 分钟读完</span>
        {data.hasPendingChanges && <span className="foot-note">线上仍是上一次发布的版本，发布后才会更新</span>}
      </footer>

      {showHistory && (
        <Revisions
          postId={id}
          currentMarkdown={fields.markdown}
          dirty={saveState !== 'saved'}
          onClose={() => setShowHistory(false)}
          onRestored={() => {
            setShowHistory(false);
            localStorage.removeItem(backupKey(id));
            void load();
          }}
        />
      )}

      {showHelp && (
        <Modal title="快捷键" onClose={() => setShowHelp(false)}>
          <table className="table">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {conflict && (
        <Modal title="这篇文章已在别处被修改" onClose={() => {}} wide>
          <div className="modal-body">
            <p>另一个窗口或设备在你编辑期间保存了这篇文章（{fmtTime(conflict.draft.updatedAt)}）。请对比后决定保留哪一份。</p>
            <DiffView before={conflict.draft.markdown} after={fields.markdown} beforeLabel="服务器上的版本" afterLabel="我当前的内容" />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => void resolveConflict(false)}>
              放弃我的修改，载入服务器版本
            </button>
            <button className="btn btn-primary" onClick={() => void resolveConflict(true)}>
              保留我的内容并覆盖
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
