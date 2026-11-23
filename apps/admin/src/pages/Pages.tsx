import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtTime, uploadImage } from '../api';
import { useStatus } from '../App';
import { MarkdownEditor, type EditorHandle } from '../components/MarkdownEditor';
import { Preview } from '../components/Preview';
import { Field, confirmDialog, toast } from '../components/ui';

export function Pages() {
  const [list, setList] = useState<any[] | null>(null);
  const navigate = useNavigate();
  const { status } = useStatus();
  const langName = status.languages.find((l) => l.code === status.contentLocale)?.name ?? status.contentLocale;

  const translate = async (p: any) => {
    try {
      const { id } = await api('POST', '/pages/translate', { pageId: p.pageId });
      navigate(`/pages/${id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const load = useCallback(async () => {
    try {
      setList(await api('GET', '/pages'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const create = async () => {
    try {
      const { id } = await api('POST', '/pages', { title: '新页面' });
      navigate(`/pages/${id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const remove = async (p: any) => {
    const ok = await confirmDialog({ title: `删除页面“${p.title}”？`, body: `${p.status === 'published' ? `该页面当前是公开的（${p.path}），删除后访客将无法访问，指向它的导航项会自动隐藏。` : ''}${status.languages.length > 1 ? '这个页面的所有语言版本都会被删除。' : ''}此操作无法撤销。`, confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/pages/${p.id}`);
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
        <h1>页面</h1>
        <button className="btn btn-primary" onClick={() => void create()}>
          ＋ 新建页面
        </button>
      </header>
      <p className="muted">“关于”“联系”“友情链接”这类不按时间排列的独立页面。发布后可在“导航”里把它加到菜单。</p>
      {list.length === 0 ? (
        <div className="empty">还没有页面。</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>更新时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.pageId}>
                  <td className="cell-title">
                    {p.translated ? <Link to={`/pages/${p.id}`}>{p.title || '（无标题）'}</Link> : <span>{p.title || '（无标题）'}</span>}
                    <div className="muted small">{p.translated ? p.path : `仅有 ${p.sourceLocale} 版本`}</div>
                  </td>
                  <td>
                    {!p.translated ? <span className="badge badge-pending">未翻译</span> : <span className={`badge badge-${p.status}`}>{p.status === 'published' ? '已发布' : '草稿'}</span>}
                    {p.hasPendingChanges && <span className="badge badge-pending">有未发布修改</span>}
                  </td>
                  <td className="muted nowrap">{fmtTime(p.updatedAt)}</td>
                  <td className="actions">
                    {p.translated ? (
                      <Link to={`/pages/${p.id}`}>编辑</Link>
                    ) : (
                      <button className="link-btn" onClick={() => void translate(p)}>
                        创建{langName}译文
                      </button>
                    )}
                    {p.status === 'published' && (
                      <a href={p.path} target="_blank" rel="noreferrer">
                        查看
                      </a>
                    )}
                    {p.translated && (
                      <button className="link-btn danger" onClick={() => void remove(p)}>
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export function PageEditor() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { status } = useStatus();
  const [page, setPage] = useState<any>(null);
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [slug, setSlug] = useState('');
  const [seo, setSeo] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>(window.innerWidth < 900 ? 'edit' : 'split');
  const editor = useRef<EditorHandle>(null);
  const latest = useRef({ title: '', markdown: '', seo: '' });
  const timer = useRef(0);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));

  useEffect(() => {
    api('GET', `/pages/${id}`)
      .then((p) => {
        setPage(p);
        setTitle(p.title);
        setMarkdown(p.markdown);
        setSlug(p.slug);
        setSeo(p.seoDescription);
        latest.current = { title: p.title, markdown: p.markdown, seo: p.seoDescription };
        editor.current?.setValue(p.markdown);
      })
      .catch((e) => toast(e.message, 'error'));
    return () => window.clearTimeout(timer.current);
  }, [id]);

  const saveNow = async (): Promise<boolean> => {
    const snapshot = { ...latest.current };
    setSaveState('saving');
    try {
      const saved = await api('PUT', `/pages/${id}`, { title: snapshot.title, markdown: snapshot.markdown, seoDescription: snapshot.seo });
      setPage(saved);
      const unchanged = latest.current.title === snapshot.title && latest.current.markdown === snapshot.markdown && latest.current.seo === snapshot.seo;
      setSaveState(unchanged ? 'saved' : 'dirty');
      return true;
    } catch (e) {
      setSaveState('error');
      toast(`保存失败：${(e as Error).message}`, 'error');
      return false;
    }
  };
  const save = () => {
    window.clearTimeout(timer.current);
    chain.current = chain.current.then(saveNow);
    return chain.current;
  };
  const change = (patch: Partial<typeof latest.current>) => {
    latest.current = { ...latest.current, ...patch };
    setSaveState('dirty');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 2000);
  };

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveState !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  const commitSlug = async () => {
    if (!page || slug === page.slug) return;
    try {
      setPage(await api('PUT', `/pages/${id}`, { slug }));
      toast('地址已修改');
    } catch (e) {
      toast((e as Error).message, 'error');
      setSlug(page.slug);
    }
  };

  const publish = async () => {
    if (!(await save())) return;
    try {
      setPage(await api('POST', `/pages/${id}/publish`, {}));
      toast('页面已发布');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const unpublish = async () => {
    if (!(await confirmDialog({ title: '取消发布这个页面？', body: '访客将无法访问，指向它的导航项会自动隐藏。内容会保留。', confirmText: '取消发布', danger: true }))) return;
    try {
      setPage(await api('POST', `/pages/${id}/unpublish`, {}));
      toast('已取消发布');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const saved = await uploadImage(file, `${slug}-img`);
        editor.current?.insertText(`![${saved.alt}](${saved.url})\n`);
      } catch (e) {
        toast(`图片上传失败：${(e as Error).message}`, 'error');
      }
    }
  };

  if (!page) return <div className="center-page muted">加载中…</div>;
  const live = page.status === 'published';
  const label: Record<SaveState, string> = { saved: '已保存', dirty: '有未保存的修改', saving: '保存中…', error: '保存失败' };

  return (
    <div className={`editor-page mode-${mode}`}>
      <header className="editor-top">
        <button
          className="btn"
          onClick={async () => {
            if (saveState === 'saved' || (await save())) navigate('/pages');
          }}
        >
          ← 返回
        </button>
        <input
          className="title-input"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            change({ title: e.target.value });
          }}
          placeholder="页面标题"
          aria-label="页面标题"
          maxLength={200}
        />
        <span className="editor-status">
          <span className={`badge badge-${page.status}`}>{live ? '已发布' : '草稿'}</span>
          {page.hasPendingChanges && <span className="badge badge-pending">有未发布修改</span>}
        </span>
        <span className={`save-state save-${saveState}`} role="status">
          {label[saveState]}
        </span>
        <button className="btn" onClick={() => void save()}>
          保存
        </button>
        <a className="btn" href={`/preview/page/${id}`} target="_blank" rel="noreferrer" onClick={() => void save()}>
          预览 ↗
        </a>
        {live && (
          <button className="btn btn-danger" onClick={() => void unpublish()}>
            取消发布
          </button>
        )}
        <button className="btn btn-primary" onClick={() => void publish()} disabled={live && !page.hasPendingChanges && saveState === 'saved'}>
          {live ? '发布修改' : '发布'}
        </button>
      </header>

      <div className="editor-toolbar">
        <Field label="">
          <span className="input-row" style={{ alignItems: 'center' }}>
            <span className="muted small">地址 /</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value.trim().toLowerCase())} onBlur={() => void commitSlug()} spellCheck={false} aria-label="地址标识" style={{ width: 180, padding: '3px 8px' }} />
          </span>
        </Field>
        <input
          value={seo}
          onChange={(e) => {
            setSeo(e.target.value);
            change({ seo: e.target.value });
          }}
          placeholder="SEO 描述（可留空）"
          aria-label="SEO 描述"
          maxLength={500}
          style={{ flex: 1, minWidth: 160, padding: '3px 8px', margin: '0 8px' }}
        />
        <div className="seg" role="group" aria-label="视图模式">
          {(['edit', 'split', 'preview'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {{ edit: '编辑', split: '分屏', preview: '预览' }[m]}
            </button>
          ))}
        </div>
      </div>

      <div className="editor-body">
        <div className="pane pane-edit">
          <MarkdownEditor
            ref={editor}
            initialValue={markdown}
            wrapLines
            onChange={(md) => {
              setMarkdown(md);
              change({ markdown: md });
            }}
            onSave={() => void save()}
            onFiles={(files) => void uploadFiles(files)}
          />
        </div>
        <div className="pane pane-preview">
          <Preview markdown={markdown} title={title} subtitle="" themeCss={status.themeCss} appearance={status.site.appearance} />
        </div>
      </div>
      <footer className="editor-foot">
        <span>公开地址：{page.path}</span>
        {live && <span>最近发布：{fmtTime(page.publishedAt)}</span>}
        {page.hasPendingChanges && <span className="foot-note">线上仍是上一次发布的内容，发布后才会更新</span>}
      </footer>
    </div>
  );
}
