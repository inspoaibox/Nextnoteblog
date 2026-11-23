import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, fmtSize, fmtTime, getContentLocale } from '../api';
import { useStatus } from '../App';
import { Pager, confirmDialog, toast } from '../components/ui';
import { flattenCats, type CatNode } from './Categories';

type Tab = 'import' | 'export' | 'backup' | 'redirects' | 'audit';
const TABS: [Tab, string][] = [
  ['import', '导入'],
  ['export', '导出'],
  ['backup', '备份与恢复'],
  ['redirects', '重定向'],
  ['audit', '操作日志'],
];

export function Tools() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab) || 'import');
  return (
    <>
      <header className="page-head">
        <h1>工具</h1>
      </header>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'import' && <ImportPanel />}
      {tab === 'export' && <ExportPanel />}
      {tab === 'backup' && <BackupPanel />}
      {tab === 'redirects' && <RedirectPanel />}
      {tab === 'audit' && <AuditPanel />}
    </>
  );
}

/* ====================== 导入 ====================== */

async function sendFiles(url: string, files: File[]) {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.webkitRelativePath || f.name);
  let res: Response;
  try {
    const locale = getContentLocale();
    res = await fetch(`/admin/api${url}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-nb-csrf': '1', ...(locale ? { 'x-nb-locale': locale } : {}) }, body: form });
  } catch {
    throw new ApiError(0, '网络连接失败，上传未完成');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error || `请求失败（${res.status}）`, json?.data);
  return json;
}

function ImportPanel() {
  const { status } = useStatus();
  const [files, setFiles] = useState<File[]>([]);
  const [report, setReport] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState({ onConflict: 'skip', publish: false, createCategories: true });
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const langName = status.languages.find((l) => l.code === status.contentLocale)?.name ?? status.contentLocale;

  const choose = async (list: File[]) => {
    const picked = list.filter((f) => /\.(md|markdown|txt|zip|png|jpe?g|gif|webp|avif)$/i.test(f.name));
    if (!picked.length) return toast('请选择 .md、.markdown、.txt 文件、图片，或包含它们的 .zip', 'error');
    setFiles(picked);
    setResult(null);
    setBusy(true);
    try {
      setReport(await sendFiles('/import/inspect', picked));
    } catch (e) {
      toast((e as Error).message, 'error');
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const q = new URLSearchParams({ onConflict: opts.onConflict, publish: opts.publish ? '1' : '0', createCategories: opts.createCategories ? '1' : '0' });
      const res = await sendFiles(`/import/run?${q}`, files);
      setResult(res);
      setReport(null);
      toast(`导入完成：新建 ${res.created} 篇${res.updated ? `，更新 ${res.updated} 篇` : ''}${res.skipped ? `，跳过 ${res.skipped} 篇` : ''}${res.failed ? `，失败 ${res.failed} 篇` : ''}`, res.failed ? 'error' : 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFiles([]);
    setReport(null);
    setResult(null);
  };

  return (
    <>
      <div
        className="panel dropzone-big"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void choose([...e.dataTransfer.files]);
        }}
      >
        <h2>导入 Markdown</h2>
        <p className="muted">
          支持 .md、.markdown、.txt，可以一次选多个；带图片的文章请连同图片一起选，或打包成 .zip（保持原来的目录结构，正文里的 <code>./images/a.png</code> 这类相对路径会自动对应上）。
          文章会导入为<strong>{langName}</strong>内容。
        </p>
        <p className="muted small">
          会读取 Front Matter 里的 <code>title</code>、<code>slug</code>、<code>date</code>、<code>updated</code>、<code>excerpt</code>/<code>description</code>、<code>cover</code>、<code>tags</code>、<code>categories</code>、<code>draft</code>、<code>lang</code>；其余字段原样保存，导出时带回。正文一个字符都不会改动。
        </p>
        <div className="row wrap">
          <button className="btn btn-primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            选择文件
          </button>
          <button className="btn" disabled={busy} onClick={() => dirInput.current?.click()}>
            选择文件夹
          </button>
          <span className="muted small">也可以把文件拖到这里</span>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".md,.markdown,.txt,.zip,image/*"
          hidden
          onChange={(e) => {
            void choose([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <input
          ref={dirInput}
          type="file"
          // @ts-expect-error 非标准属性：允许选择整个文件夹
          webkitdirectory=""
          hidden
          onChange={(e) => {
            void choose([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        {busy && <p className="muted">正在处理…</p>}
      </div>

      {report && (
        <div className="panel">
          <div className="row between wrap">
            <h2 style={{ margin: 0 }}>导入前检查</h2>
            <span className="muted small">
              共 {report.total} 篇文章{report.imageFiles ? `、${report.imageFiles} 张图片` : ''}：可导入 {report.ready}，地址冲突 {report.conflicts}，有问题 {report.failed}
            </span>
          </div>
          {report.total === 0 ? (
            <p className="muted">没有找到 Markdown 文件。</p>
          ) : (
            <div className="table-scroll" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>标题 / 地址</th>
                    <th>元信息</th>
                    <th>检查结果</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((item: any) => (
                    <tr key={item.file}>
                      <td className="small">
                        <code>{item.file}</code>
                      </td>
                      <td className="cell-title">
                        <strong>{item.title || '（无标题）'}</strong>
                        <div className="muted small">/posts/{item.slug}</div>
                      </td>
                      <td className="small">
                        {item.date && <div>日期 {fmtTime(item.date)}</div>}
                        {item.categories.length > 0 && <div>分类 {item.categories.join('、')}</div>}
                        {item.tags.length > 0 && <div>标签 {item.tags.join('、')}</div>}
                        {item.draft && <span className="badge">草稿</span>}
                        {item.unknownKeys.length > 0 && <div className="muted">保留字段 {item.unknownKeys.join('、')}</div>}
                      </td>
                      <td className="small">
                        {item.errors.map((e: string) => (
                          <div key={e} className="form-error">
                            ✕ {e}
                          </div>
                        ))}
                        {item.conflict && (
                          <div className="warn-text">
                            地址已被 <Link to={`/posts/${item.conflict.id}`}>{item.conflict.title || '（无标题）'}</Link> 使用
                          </div>
                        )}
                        {item.duplicateOf && (
                          <div className="warn-text">
                            正文与 <Link to={`/posts/${item.duplicateOf.id}`}>{item.duplicateOf.title}</Link> 完全相同
                          </div>
                        )}
                        {item.warnings.map((w: string) => (
                          <div key={w} className="warn-text">
                            ! {w}
                          </div>
                        ))}
                        {!item.errors.length && !item.conflict && !item.warnings.length && !item.duplicateOf && <span className="check-ok">✓ 可以导入</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.total > report.failed && (
            <div className="import-opts">
              {report.conflicts > 0 && (
                <label className="field">
                  <span className="field-label">地址冲突的文章</span>
                  <select value={opts.onConflict} onChange={(e) => setOpts({ ...opts, onConflict: e.target.value })}>
                    <option value="skip">跳过，不导入</option>
                    <option value="rename">作为新文章导入，地址自动加序号</option>
                    <option value="overwrite">存为已有文章的新草稿（线上内容不变，需再发布）</option>
                  </select>
                </label>
              )}
              <label className="check">
                <input type="checkbox" checked={opts.publish} onChange={(e) => setOpts({ ...opts, publish: e.target.checked })} /> 导入后直接发布（Front Matter 里 <code>draft: true</code> 的仍保持草稿，沿用原来的发布日期）
              </label>
              <label className="check">
                <input type="checkbox" checked={opts.createCategories} onChange={(e) => setOpts({ ...opts, createCategories: e.target.checked })} /> 自动创建不存在的分类（<code>开发/后端</code> 会建成两级）
              </label>
              <div className="row">
                <button className="btn btn-primary" disabled={busy} onClick={() => void run()}>
                  导入 {report.total - report.failed - (opts.onConflict === 'skip' ? report.conflicts : 0)} 篇
                </button>
                <button className="btn" onClick={reset}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="panel">
          <h2>导入结果</h2>
          <p>
            新建 {result.created} 篇，更新 {result.updated} 篇，跳过 {result.skipped} 篇，失败 {result.failed} 篇。
          </p>
          <ul className="plain-list">
            {result.results.map((r: any) => (
              <li key={r.file}>
                <span>
                  <code className="small">{r.file}</code>
                  {r.message && <span className="muted small">　{r.message}</span>}
                </span>
                <span className="row-meta">
                  <span className={`badge badge-${r.status === 'failed' ? 'unpublished' : r.status === 'skipped' ? 'draft' : 'published'}`}>{{ created: '已新建', updated: '已更新草稿', skipped: '已跳过', failed: '失败' }[r.status as string]}</span>
                  {r.id && <Link to={`/posts/${r.id}`}>打开</Link>}
                </span>
              </li>
            ))}
          </ul>
          <button className="btn" onClick={reset}>
            继续导入
          </button>
        </div>
      )}
    </>
  );
}

/* ====================== 导出 ====================== */

function ExportPanel() {
  const [cats, setCats] = useState<CatNode[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [media, setMedia] = useState(true);

  useEffect(() => {
    api('GET', '/categories')
      .then((res) => setCats(flattenCats(res.tree)))
      .catch(() => {});
  }, []);

  const href = `/admin/api/export/site?${new URLSearchParams({ ...(categoryId ? { categoryId } : {}), media: media ? '1' : '0' })}`;

  return (
    <>
      <div className="panel form-narrow">
        <h2>导出内容</h2>
        <p className="muted">导出为一个 ZIP：每篇文章、每个页面是一个 .md 文件（带 Front Matter），分类树、标签、专题系列、导航、站点设置、重定向是 JSON，可选附带全部媒体文件。适合长期归档或迁移到别的系统。</p>
        <label className="field">
          <span className="field-label">范围</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ width: '100%' }}>
            <option value="">全站（所有语言的文章、页面和结构数据）</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                仅分类：{c.pathNames}（含下级）
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={media} onChange={(e) => setMedia(e.target.checked)} /> 包含媒体文件（图片较多时文件会比较大）
        </label>
        <a className="btn btn-primary" href={href} download>
          下载导出包
        </a>
      </div>
      <div className="panel form-narrow">
        <h2>导出单篇</h2>
        <p className="muted">在文章列表或编辑器的“文章设置”里可以导出单篇 .md。导出的正文与编辑器里保存的源码逐字一致。</p>
        <Link className="btn" to="/posts">
          去文章列表
        </Link>
      </div>
    </>
  );
}

/* ====================== 备份与恢复 ====================== */

function BackupPanel() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [restarting, setRestarting] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api('GET', '/backups'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('POST', '/backups', { note });
      toast(`备份完成（${fmtSize(res.size)}）`);
      setNote('');
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: any) => {
    if (!(await confirmDialog({ title: '删除这份备份？', body: `${b.name}（${fmtSize(b.size)}）将被永久删除。`, confirmText: '删除', danger: true }))) return;
    try {
      await api('DELETE', `/backups/${b.name}`);
      toast('已删除');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const restore = async (b: any) => {
    const m = b.manifest;
    const ok = await confirmDialog({
      title: '恢复到这份备份？',
      danger: true,
      confirmText: '恢复并重启',
      body: (
        <>
          <p>
            全站数据（文章、页面、分类、设置、账号、媒体文件、已上传的主题）将回到 <strong>{m ? fmtTime(m.createdAt) : b.name}</strong> 的状态，之后做的所有修改都会被替换。
          </p>
          <ul>
            <li>恢复前会自动把当前状态再备份一份，恢复错了可以用它换回来。</li>
            <li>被替换下来的数据文件也会保留在数据目录的 replaced-* 文件夹里。</li>
            <li>服务会重启，大约需要几秒；期间站点暂时无法访问，之后需要重新登录（如果备份里的密码不同，用备份时的密码）。</li>
          </ul>
        </>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api('POST', `/backups/${b.name}/restore`, {});
      if (!res.restarting) {
        toast('备份已准备好，重启服务后生效', 'error');
        setBusy(false);
        return;
      }
      setRestarting(res.safetyBackup);
      // 等服务重启完成后回到登录页
      const started = Date.now();
      await new Promise((r) => setTimeout(r, 2500));
      while (Date.now() - started < 90_000) {
        try {
          const ping = await fetch('/healthz', { cache: 'no-store' });
          if (ping.ok) break;
        } catch {
          /* 还在重启 */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      location.href = '/admin/';
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  if (restarting)
    return (
      <div className="panel form-narrow">
        <h2>正在恢复并重启服务…</h2>
        <p className="muted">恢复前的状态已留底为 {restarting}。服务恢复后页面会自动刷新。</p>
        <p className="muted small">如果一分钟后仍没有反应，说明服务没有被自动拉起（例如直接用 node 命令运行时）。请手动重新启动服务，恢复会在启动时完成。</p>
      </div>
    );
  if (!data) return <div className="muted">加载中…</div>;

  return (
    <>
      <form className="panel form-narrow" onSubmit={create}>
        <h2>立即备份</h2>
        <p className="muted">备份包含数据库的完整快照、所有媒体文件和已上传的主题，保存在服务器的数据目录里。系统每天还会自动备份一次，只保留最近 7 份自动备份；手动备份不会被自动删除。</p>
        <div className="input-row">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选），如“改版前”" maxLength={200} />
          <button className="btn btn-primary" disabled={busy}>
            {busy ? '备份中…' : '开始备份'}
          </button>
        </div>
      </form>

      <div className="panel">
        <h2>备份列表</h2>
        {data.backups.length === 0 ? (
          <p className="muted">还没有备份。</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>内容</th>
                  <th>大小</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {data.backups.map((b: any) => (
                  <tr key={b.name}>
                    <td className="backup-time">
                      {b.manifest ? fmtTime(b.manifest.createdAt) : '—'}
                      {b.manifest?.note && <div className="muted small">{b.manifest.note}</div>}
                    </td>
                    <td>{b.manifest?.kind === 'auto' ? <span className="badge">自动</span> : <span className="badge badge-published">手动</span>}</td>
                    <td className="small muted">{b.manifest ? `${b.manifest.posts} 篇文章、${b.manifest.pages} 个页面、${b.manifest.mediaFiles} 个媒体文件` : '无法读取备份清单'}</td>
                    <td className="nowrap">{fmtSize(b.size)}</td>
                    <td className="actions">
                      <a href={`/admin/api/backups/${b.name}`} download>
                        下载
                      </a>
                      <button className="link-btn" disabled={busy || !b.manifest} onClick={() => void restore(b)}>
                        恢复
                      </button>
                      <button className="link-btn danger" disabled={busy} onClick={() => void remove(b)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          备份目录：<code>{data.dir}</code>。建议定期把备份下载到别处保存。从别处恢复：把备份文件放进这个目录，刷新本页即可看到。
        </p>
      </div>
    </>
  );
}

/* ====================== 重定向 ====================== */

function RedirectPanel() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ from: '', to: '' });

  const load = useCallback(async () => {
    try {
      setData(await api('GET', `/redirects?page=${page}&q=${encodeURIComponent(q)}`));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [page, q]);
  useEffect(() => void load(), [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/redirects', form);
      toast('已添加');
      setForm({ from: '', to: '' });
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async (r: any) => {
    if (!(await confirmDialog({ title: '删除这条重定向？', body: `访问 ${r.fromPath} 将不再跳转到 ${r.toPath}。`, confirmText: '删除', danger: true }))) return;
    try {
      await api('DELETE', `/redirects/${r.id}`);
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <form className="panel" onSubmit={add}>
        <h2>添加重定向</h2>
        <p className="muted">修改文章、分类、标签的地址时系统会自动添加重定向。这里用于手动补充，例如从旧博客迁移过来时保留旧链接。只有当旧地址没有内容时才会跳转（301 永久重定向）。</p>
        <div className="row wrap">
          <input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="旧地址，如 /2019/05/hello.html" required style={{ flex: 1, minWidth: 220 }} aria-label="旧地址" />
          <span className="muted">→</span>
          <input value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="新地址，如 /posts/hello 或 https://…" required style={{ flex: 1, minWidth: 220 }} aria-label="新地址" />
          <button className="btn btn-primary">添加</button>
        </div>
      </form>

      <div className="panel">
        <div className="row between wrap">
          <h2 style={{ margin: 0 }}>全部重定向{data ? `（${data.total}）` : ''}</h2>
          <input
            type="search"
            placeholder="搜索地址…"
            aria-label="搜索重定向"
            style={{ width: 220 }}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
        </div>
        {!data ? (
          <p className="muted">加载中…</p>
        ) : data.items.length === 0 ? (
          <p className="muted">{q ? '没有匹配的重定向。' : '还没有重定向。'}</p>
        ) : (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>旧地址</th>
                  <th>跳转到</th>
                  <th>添加时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((r: any) => (
                  <tr key={r.id}>
                    <td className="small">
                      <code>{r.fromPath}</code>
                    </td>
                    <td className="small">
                      <a href={r.toPath} target="_blank" rel="noreferrer">
                        {r.toPath}
                      </a>
                    </td>
                    <td className="muted nowrap small">{fmtTime(r.createdAt)}</td>
                    <td className="actions">
                      <button className="link-btn danger" onClick={() => void remove(r)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
      </div>
    </>
  );
}

/* ====================== 操作日志 ====================== */

const GROUPS: [string, string][] = [
  ['', '全部'],
  ['login', '登录'],
  ['post', '文章'],
  ['page', '页面'],
  ['category', '分类'],
  ['tag', '标签'],
  ['media', '媒体'],
  ['theme', '主题'],
  ['language', '语言'],
  ['backup', '备份'],
  ['import', '导入'],
  ['settings', '设置'],
];

function AuditPanel() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api('GET', `/audit?page=${page}&action=${action}`));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [page, action]);
  useEffect(() => void load(), [load]);

  return (
    <div className="panel">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>操作日志{data ? `（${data.total}）` : ''}</h2>
        <select
          value={action}
          onChange={(e) => {
            setPage(1);
            setAction(e.target.value);
          }}
          aria-label="按类型筛选"
        >
          {GROUPS.map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {!data ? (
        <p className="muted">加载中…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">没有记录。</p>
      ) : (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>操作</th>
                <th>对象</th>
                <th>详情</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((l: any) => (
                <tr key={l.id} className={l.action === 'login_failed' ? 'is-warn' : ''}>
                  <td className="nowrap small">{fmtTime(l.createdAt)}</td>
                  <td className="small">{l.user ?? '—'}</td>
                  <td className="small">
                    <code>{l.action}</code>
                  </td>
                  <td className="small">
                    {l.entity === 'post' && l.entityId ? <Link to={`/posts/${l.entityId}`}>文章 #{l.entityId}</Link> : l.entityId ? `${l.entity} ${l.entityId}` : l.entity}
                  </td>
                  <td className="small muted log-detail">{l.detail}</td>
                  <td className="small muted nowrap">{l.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}
