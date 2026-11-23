import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, fmtSize, fmtTime, uploadFile } from '../api';
import { Field, Modal, confirmDialog, toast } from '../components/ui';

interface ThemeInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  source: 'builtin' | 'uploaded';
  trusted: boolean;
  compatible: boolean;
  problem: string;
  isActive: boolean;
  isPrevious: boolean;
  versions: string[];
  activeVersion: string;
  previousVersion: string;
  scripts: string[];
  hasSettings: boolean;
}
interface Setting {
  key: string;
  type: 'color' | 'text' | 'select' | 'boolean' | 'number';
  label: string;
  hint?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

const ACTION: Record<string, string> = { install: '安装', upgrade: '安装新版本', activate: '启用', rollback: '回退到此主题', version: '切换版本', uninstall: '卸载', trust: '信任设置', config_apply: '应用配置', config_revert: '回退配置', config_reset: '恢复默认配置' };

export function Themes() {
  const [lib, setLib] = useState<any>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [pending, setPending] = useState<{ file: File; report: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setLib(await api('GET', '/themes'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      await load();
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const preview = async (t: ThemeInfo, version?: string) => {
    if (await run(() => api('POST', `/themes/${t.id}/preview`, version ? { version } : {}))) window.open('/', '_blank');
  };

  const activate = async (t: ThemeInfo) => {
    const ok = await confirmDialog({
      title: `启用主题“${t.name}”？`,
      body: (
        <>
          <p>全站所有访客会立即看到新主题。文章、分类、图片和链接都不会变化，只是外观和布局不同。</p>
          {!t.trusted && <p className="form-error">这是一个未受信任的主题：它的模板和样式会生效，但脚本被禁用，目录高亮、代码复制等交互不可用。</p>}
          <p className="muted small">建议先点“预览”确认效果。启用后可以随时“回退到上一个主题”。</p>
        </>
      ),
      confirmText: '启用',
    });
    if (ok) await run(() => api('POST', `/themes/${t.id}/activate`, {}), `已启用“${t.name}”`);
  };

  const rollback = async () => {
    const prev = lib.themes.find((t: ThemeInfo) => t.id === lib.previous);
    if (await confirmDialog({ title: `回退到“${prev?.name ?? lib.previous}”？`, body: '全站立即换回上一个主题。', confirmText: '回退' })) await run(() => api('POST', '/themes/rollback', {}), '已回退');
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      setPending({ file, report: await uploadFile('/themes/inspect', file) });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await uploadFile('/themes/install', pending.file);
      toast(res.report.isUpgrade ? `已安装 ${res.theme.name} ${res.report.manifest.version}` : `已安装“${res.theme.name}”`);
      setPending(null);
      await load();
      setManaging(res.theme.id);
    } catch (e) {
      const err = e as ApiError;
      if (err.data?.errors) setPending({ file: pending.file, report: err.data });
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!lib) return <div className="muted">加载中…</div>;
  const previous = lib.themes.find((t: ThemeInfo) => t.id === lib.previous);

  return (
    <>
      <header className="page-head">
        <h1>主题</h1>
        <div className="row wrap">
          {previous && (
            <button className="btn" disabled={busy} onClick={() => void rollback()}>
              回退到上一个主题：{previous.name}
            </button>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            上传主题包
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </header>
      <p className="muted">全站同时只有一套主题对访客生效，由你在这里切换；访客不能自己选择主题。切换主题不会改动任何文章、分类或图片。</p>

      {lib.previewing && (
        <div className="bulk-bar">
          <span>
            你的浏览器正在预览主题 <strong>{lib.previewing}</strong>，访客看到的仍是线上主题。
          </span>
          <a className="btn" href="/" target="_blank" rel="noreferrer">
            打开预览
          </a>
          <button className="btn" onClick={() => void run(() => api('POST', '/themes/preview/stop', {}), '已退出预览')}>
            退出预览
          </button>
        </div>
      )}

      <div className="theme-grid">
        {lib.themes.map((t: ThemeInfo) => (
          <article key={t.id} className={`theme-card${t.isActive ? ' is-active' : ''}`}>
            <header>
              <h2>{t.name}</h2>
              <span className="muted small">
                {t.id} · {t.version}
              </span>
            </header>
            <p className="theme-badges">
              {t.isActive && <span className="badge badge-published">当前启用</span>}
              <span className="badge">{t.source === 'builtin' ? '内置' : '已上传'}</span>
              {!t.trusted && <span className="badge badge-pending">未受信任 · 脚本已禁用</span>}
              {!t.compatible && <span className="badge badge-unpublished">不兼容</span>}
              {t.source === 'uploaded' && t.versions[0] !== t.activeVersion && <span className="badge badge-pending">有新版本 {t.versions[0]}</span>}
            </p>
            <p className="theme-desc">{t.description || '（没有说明）'}</p>
            {t.author && <p className="muted small">作者：{t.author}</p>}
            {t.problem && <p className="form-error small">{t.problem}</p>}
            <footer className="row wrap">
              {!t.isActive && (
                <button className="btn btn-primary" disabled={busy || !t.compatible} onClick={() => void activate(t)}>
                  启用
                </button>
              )}
              <button className="btn" disabled={busy || !t.compatible} onClick={() => void preview(t)}>
                预览
              </button>
              <button className="btn" onClick={() => setManaging(t.id)}>
                {t.hasSettings ? '配置与管理' : '管理'}
              </button>
            </footer>
          </article>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <h2>最近操作</h2>
        {lib.logs.length === 0 ? (
          <p className="muted">还没有主题操作记录。</p>
        ) : (
          <ul className="plain-list">
            {lib.logs.map((l: any) => (
              <li key={l.id}>
                <span>
                  {ACTION[l.action] ?? l.action} <strong>{l.themeId}</strong>
                  {l.detail && <span className="muted small">　{l.detail}</span>}
                </span>
                <span className="muted small nowrap">
                  {l.user ?? '—'} · {fmtTime(l.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">
          想自己做主题？规范版本 {lib.spec.version}，说明见仓库里的 <code>docs/theme-development.md</code>，可用 <code>examples/theme-example</code> 作为起点。
        </p>
      </section>

      {pending && <InstallDialog file={pending.file} report={pending.report} busy={busy} onClose={() => setPending(null)} onInstall={() => void install()} />}
      {managing && (
        <ManageDialog
          id={managing}
          onClose={() => {
            setManaging(null);
            void load();
          }}
          onPreview={(t, v) => void preview(t, v)}
        />
      )}
    </>
  );
}

function InstallDialog({ file, report, busy, onClose, onInstall }: { file: File; report: any; busy: boolean; onClose: () => void; onInstall: () => void }) {
  const m = report.manifest;
  return (
    <Modal title="安装主题包" onClose={onClose} wide>
      <div className="modal-body">
        <p className="muted small">
          {file.name} · {fmtSize(file.size)}
          {report.fileCount > 0 && ` · 共 ${report.fileCount} 个文件，解压后 ${fmtSize(report.totalBytes)}`}
        </p>
        {m && (
          <table className="table kv">
            <tbody>
              <tr>
                <th>名称</th>
                <td>{m.name}</td>
              </tr>
              <tr>
                <th>标识 / 版本</th>
                <td>
                  <code>{m.id}</code> · {m.version}
                  {report.isUpgrade && <span className="badge badge-pending">升级（已安装 {report.installedVersions.join('、')}）</span>}
                </td>
              </tr>
              {m.author && (
                <tr>
                  <th>作者</th>
                  <td>{m.author}</td>
                </tr>
              )}
              {m.description && (
                <tr>
                  <th>说明</th>
                  <td>{m.description}</td>
                </tr>
              )}
              <tr>
                <th>兼容性</th>
                <td>{m.requires ? `要求主题规范 ${m.requires}` : '未声明'}</td>
              </tr>
              <tr>
                <th>可配置项</th>
                <td>{m.settings?.length ? m.settings.map((s: any) => s.label).join('、') : '无'}</td>
              </tr>
            </tbody>
          </table>
        )}

        {report.ok ? (
          <p className="check-ok">✓ 校验通过：文件类型与路径安全、必需模板齐全、全部页面试渲染成功。</p>
        ) : (
          <>
            <p className="form-error">
              <strong>校验未通过，无法安装。</strong>线上主题不受任何影响。
            </p>
            <ul className="form-error">
              {report.errors.map((e: string) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </>
        )}
        {report.warnings.length > 0 && (
          <ul className="warn-list">
            {report.warnings.map((w: string) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {report.scripts.length > 0 && (
          <>
            <h3>包含的脚本</h3>
            <ul className="small muted">
              {report.scripts.map((s: string) => (
                <li key={s}>
                  <code>{s}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        {report.ok && (
          <p className="muted small">
            安装后主题不会自动启用。第三方主题默认“未受信任”：模板和样式可用，脚本被禁用；主题无法执行服务器代码，也读不到数据库和文件。
            {report.isLive && ' 这个主题正在线上使用，新版本安装后仍需你手动切换。'}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          {report.ok ? '取消' : '关闭'}
        </button>
        {report.ok && (
          <button className="btn btn-primary" disabled={busy} onClick={onInstall}>
            {report.isUpgrade ? '安装这个版本' : '安装'}
          </button>
        )}
      </div>
    </Modal>
  );
}

function ManageDialog({ id, onClose, onPreview }: { id: string; onClose: () => void; onPreview: (t: ThemeInfo, version?: string) => void }) {
  const [t, setT] = useState<any>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const importInput = useRef<HTMLInputElement>(null);

  const apply = (data: any) => {
    setT(data);
    setValues(data.config.draft);
  };
  useEffect(() => {
    api('GET', `/themes/${id}`)
      .then(apply)
      .catch((e) => toast(e.message, 'error'));
  }, [id]);

  const call = async (method: string, url: string, body?: unknown, ok?: string) => {
    try {
      const data = await api(method, url, body);
      if (data?.id) apply(data);
      if (ok) toast(ok);
      return data;
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    }
  };

  if (!t) return null;
  const dirty = JSON.stringify(values) !== JSON.stringify(t.config.draft);
  const differs = JSON.stringify(values) !== JSON.stringify(t.config.applied);

  const saveDraft = () => call('PUT', `/themes/${id}/config`, { values });
  const previewDraft = async () => {
    if (await saveDraft()) onPreview(t);
  };
  const applyConfig = async () => {
    if (!(await saveDraft())) return;
    if (t.isActive && !(await confirmDialog({ title: '应用这份配置？', body: '这个主题正在线上使用，应用后访客立即看到新的外观。可以用“回退到上次配置”撤销。', confirmText: '应用' }))) return;
    await call('POST', `/themes/${id}/config/apply`, {}, '配置已应用');
  };
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify({ theme: id, version: t.version, config: values }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${id}-config.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importConfig = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = parsed.config ?? parsed;
      const known = Object.fromEntries(Object.entries(incoming).filter(([k]) => t.settings.some((s: Setting) => s.key === k)));
      setValues({ ...values, ...known });
      toast(`已载入 ${Object.keys(known).length} 项配置，确认后点“应用”`);
    } catch {
      toast('不是有效的配置文件', 'error');
    }
  };

  const uninstall = async () => {
    const ok = await confirmDialog({ title: `卸载主题“${t.name}”？`, body: `将删除它的全部版本（${t.versions.join('、')}）和保存的配置，无法恢复。文章和其他内容不受影响。`, confirmText: '卸载', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/themes/${id}`);
      toast('已卸载');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const trust = async () => {
    if (!t.trusted) {
      const ok = await confirmDialog({
        title: '信任这个主题的脚本？',
        body: (
          <>
            <p>信任后，以下脚本会在访客的浏览器里运行。脚本可以读取页面内容并向外发送请求，请只信任你确认过来源和内容的主题：</p>
            <ul>
              {t.scripts.map((s: string) => (
                <li key={s}>
                  <code>{s}</code>
                </li>
              ))}
            </ul>
          </>
        ),
        confirmText: '我已确认，信任',
        danger: true,
      });
      if (!ok) return;
    }
    await call('POST', `/themes/${id}/trust`, { trusted: !t.trusted }, t.trusted ? '已取消信任，脚本被禁用' : '已标记为受信任');
  };
  const switchVersion = async (version: string) => {
    if (t.isActive && !(await confirmDialog({ title: `切换到版本 ${version}？`, body: '这个主题正在线上使用，切换后访客立即看到该版本。系统会先确认该版本能正常渲染。', confirmText: '切换' }))) return;
    await call('POST', `/themes/${id}/version`, { version }, `已切换到 ${version}`);
  };

  return (
    <Modal title={`${t.name}（${t.id}）`} onClose={onClose} wide>
      <div className="modal-body">
        {t.settings.length > 0 ? (
          <section>
            <h3 style={{ marginTop: 0 }}>外观配置</h3>
            <div className="config-grid">
              {t.settings.map((s: Setting) => (
                <Field key={s.key} label={s.label} hint={s.hint}>
                  {s.type === 'color' ? (
                    <span className="input-row">
                      <input type="color" value={values[s.key]} onChange={(e) => setValues({ ...values, [s.key]: e.target.value })} aria-label={s.label} style={{ width: 48, padding: 2 }} />
                      <input value={values[s.key]} onChange={(e) => setValues({ ...values, [s.key]: e.target.value })} spellCheck={false} aria-label={`${s.label}（十六进制）`} />
                    </span>
                  ) : s.type === 'select' ? (
                    <select value={values[s.key]} onChange={(e) => setValues({ ...values, [s.key]: e.target.value })} style={{ width: '100%' }}>
                      {s.options!.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : s.type === 'boolean' ? (
                    <span className="check">
                      <input type="checkbox" checked={!!values[s.key]} onChange={(e) => setValues({ ...values, [s.key]: e.target.checked })} /> 开启
                    </span>
                  ) : s.type === 'number' ? (
                    <input type="number" value={values[s.key]} min={s.min} max={s.max} onChange={(e) => setValues({ ...values, [s.key]: Number(e.target.value) })} />
                  ) : (
                    <input value={values[s.key]} onChange={(e) => setValues({ ...values, [s.key]: e.target.value })} maxLength={500} />
                  )}
                </Field>
              ))}
            </div>
            {(dirty || t.config.hasDraft) && differs && <p className="muted small">有尚未应用的修改。预览只有你能看到；点“应用”后才对访客生效。</p>}
            <div className="row wrap">
              <button className="btn btn-primary" disabled={!differs} onClick={() => void applyConfig()}>
                应用
              </button>
              <button className="btn" disabled={!differs} onClick={() => void previewDraft()}>
                预览修改
              </button>
              <button className="btn" disabled={!t.config.canRevert} onClick={() => void call('POST', `/themes/${id}/config/revert`, {}, '已回退到上次配置')}>
                回退到上次配置
              </button>
              <button
                className="btn"
                onClick={async () => {
                  if (await confirmDialog({ title: '恢复默认配置？', body: '所有选项恢复为主题的默认值。可以用“回退到上次配置”换回来。', confirmText: '恢复默认' })) await call('POST', `/themes/${id}/config/reset`, {}, '已恢复默认');
                }}
              >
                恢复默认
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={exportConfig}>
                导出配置
              </button>
              <button className="btn" onClick={() => importInput.current?.click()}>
                导入配置
              </button>
              <input
                ref={importInput}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  void importConfig(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </section>
        ) : (
          <p className="muted">这个主题没有可配置的选项。</p>
        )}

        {t.source === 'uploaded' && (
          <>
            <h3>版本</h3>
            <ul className="plain-list">
              {t.versions.map((v: string) => (
                <li key={v}>
                  <span>
                    <strong>{v}</strong>
                    {v === t.activeVersion && <span className="badge badge-published">使用中</span>}
                    {v === t.previousVersion && <span className="badge">上一个版本</span>}
                  </span>
                  {v !== t.activeVersion && (
                    <span className="actions">
                      <button className="link-btn" onClick={() => onPreview(t, v)}>
                        预览
                      </button>
                      <button className="link-btn" onClick={() => void switchVersion(v)}>
                        {v === t.previousVersion ? '回滚到此版本' : '切换到此版本'}
                      </button>
                      <button
                        className="link-btn danger"
                        onClick={async () => {
                          if (await confirmDialog({ title: `删除版本 ${v}？`, body: '删除后无法再回滚到这个版本。', confirmText: '删除', danger: true })) await call('DELETE', `/themes/${id}/versions/${v}`, undefined, '已删除');
                        }}
                      >
                        删除
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="muted small">升级主题：把 theme.json 里的 version 提高后重新上传。旧版本会保留，随时可以回滚。</p>

            <h3>安全</h3>
            <p>
              {t.trusted ? '已受信任：主题脚本可以运行。' : '未受信任：主题的脚本被浏览器的内容安全策略禁用，模板和样式正常生效。'}
              {t.scripts.length > 0 ? ` 包含 ${t.scripts.length} 个脚本文件（${t.scripts.join('、')}）。` : ' 这个主题不包含脚本。'}
            </p>
            <div className="row wrap">
              {t.scripts.length > 0 && (
                <button className="btn" onClick={() => void trust()}>
                  {t.trusted ? '取消信任' : '标记为受信任…'}
                </button>
              )}
              <button className="btn btn-danger" disabled={t.isActive} title={t.isActive ? '正在使用的主题不能卸载，请先切换到其他主题' : ''} onClick={() => void uninstall()}>
                卸载主题
              </button>
              {t.isActive && <span className="muted small">正在使用，需先切换到其他主题才能卸载。</span>}
            </div>
          </>
        )}

        {t.logs.length > 0 && (
          <>
            <h3>操作记录</h3>
            <ul className="plain-list">
              {t.logs.map((l: any) => (
                <li key={l.id}>
                  <span>
                    {ACTION[l.action] ?? l.action}
                    {l.detail && <span className="muted small">　{l.detail}</span>}
                  </span>
                  <span className="muted small nowrap">
                    {l.user ?? '—'} · {fmtTime(l.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
