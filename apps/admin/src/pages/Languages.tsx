import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useStatus, type Language } from '../App';
import { MoveButtons, moveItem } from '../components/Sortable';
import { Field, confirmDialog, toast } from '../components/ui';

export function Languages() {
  const { status, reload } = useStatus();
  const [tab, setTab] = useState<'languages' | 'strings'>('languages');
  const multi = status.languages.length > 1;
  return (
    <>
      <header className="page-head">
        <h1>多语言</h1>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'languages'} className={tab === 'languages' ? 'active' : ''} onClick={() => setTab('languages')}>
          语言
        </button>
        <button role="tab" aria-selected={tab === 'strings'} className={tab === 'strings' ? 'active' : ''} onClick={() => setTab('strings')}>
          界面文案
        </button>
      </div>
      {tab === 'languages' ? <LanguageList languages={status.languages} reload={reload} /> : <UiStrings key={status.contentLocale} multi={multi} />}
    </>
  );
}

function LanguageList({ languages, reload }: { languages: Language[]; reload: () => Promise<void> }) {
  const [form, setForm] = useState({ code: '', name: '' });
  const [fallback, setFallback] = useState<'home' | 'hide'>('home');

  useEffect(() => {
    api('GET', '/settings')
      .then((s) => setFallback(s.langFallback))
      .catch(() => {});
  }, []);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await reload();
      if (ok) toast(ok);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/languages', form);
      setForm({ code: '', name: '' });
    }, '已添加，启用后才会对访客可见');
  };

  const toggle = async (l: Language) => {
    if (l.enabled) {
      const ok = await confirmDialog({ title: `停用“${l.name}”？`, body: `/${l.prefix}/ 下的所有页面将无法访问，语言切换器里也不再显示它。已有的译文会保留，重新启用即可恢复。`, confirmText: '停用', danger: true });
      if (!ok) return;
    }
    await run(() => api('PATCH', `/languages/${l.code}`, { enabled: !l.enabled }), l.enabled ? '已停用' : '已启用');
  };

  const makeDefault = async (l: Language) => {
    const current = languages.find((x) => x.isDefault)!;
    const ok = await confirmDialog({
      title: `把默认语言改为“${l.name}”？`,
      body: (
        <>
          <p>全站地址会发生变化：</p>
          <ul>
            <li>
              {l.name} 的页面从 <code>/{l.prefix}/…</code> 变为不带前缀
            </li>
            <li>
              {current.name} 的页面改为带前缀 <code>/{current.code.toLowerCase()}/…</code>
            </li>
          </ul>
          <p>已被分享或收录的旧链接不会自动跳转。站点上线后请谨慎操作。</p>
        </>
      ),
      confirmText: '更改默认语言',
      danger: true,
    });
    if (ok) await run(() => api('POST', `/languages/${l.code}/default`, {}), '默认语言已更改');
  };

  const remove = async (l: Language) => {
    if (await confirmDialog({ title: `删除语言“${l.name}”？`, body: '只有没有任何文章译文的语言才能删除。', confirmText: '删除', danger: true })) await run(() => api('DELETE', `/languages/${l.code}`), '已删除');
  };

  const move = (from: number, to: number) => void run(() => api('PUT', '/languages/order', { codes: moveItem(languages, from, to).map((l) => l.code) }));

  return (
    <>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>语言</th>
              <th>代码</th>
              <th>地址</th>
              <th>状态</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {languages.map((l, index) => (
              <tr key={l.code}>
                <td>
                  <input
                    defaultValue={l.name}
                    aria-label={`${l.code} 的显示名称`}
                    style={{ width: 160 }}
                    onBlur={(e) => {
                      if (e.target.value.trim() && e.target.value !== l.name) void run(() => api('PATCH', `/languages/${l.code}`, { name: e.target.value }), '已保存');
                    }}
                  />
                </td>
                <td>
                  <code>{l.code}</code>
                </td>
                <td className="muted small">{l.isDefault ? '/（不带前缀）' : `/${l.prefix}/`}</td>
                <td>
                  {l.isDefault && <span className="badge badge-published">默认</span>}
                  {l.enabled ? !l.isDefault && <span className="badge badge-published">已启用</span> : <span className="badge">未启用</span>}
                </td>
                <td className="actions">
                  <MoveButtons index={index} count={languages.length} onMove={move} />
                  {!l.isDefault && (
                    <>
                      <button className="link-btn" onClick={() => void toggle(l)}>
                        {l.enabled ? '停用' : '启用'}
                      </button>
                      <button className="link-btn" onClick={() => void makeDefault(l)}>
                        设为默认
                      </button>
                      <button className="link-btn danger" onClick={() => void remove(l)}>
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
      <p className="muted small">这里的顺序就是前台语言切换器里的顺序。未启用的语言只在后台可见，可以先把内容翻译好再启用。</p>

      <form className="panel form-narrow" onSubmit={add} style={{ marginTop: 20 }}>
        <h2>添加语言</h2>
        <div className="row">
          <Field label="语言代码" hint="如 en、ja、ko、zh-TW">
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required maxLength={20} spellCheck={false} />
          </Field>
          <Field label="显示名称" hint="访客在切换器里看到的名字，如 English、日本語">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={50} />
          </Field>
        </div>
        <button className="btn">添加</button>
      </form>

      <div className="panel form-narrow">
        <h2>缺少译文时</h2>
        <Field label="访客在一篇没有某语言版本的内容上切换到该语言" hint="无论选哪一种，未发布的译文都不会被公开，也不会出现在站点地图里。">
          <select
            value={fallback}
            style={{ width: '100%' }}
            onChange={(e) => {
              const value = e.target.value as 'home' | 'hide';
              setFallback(value);
              void run(() => api('PUT', '/settings', { langFallback: value }), '已保存');
            }}
          >
            <option value="home">仍显示该语言，点击后前往该语言的首页（并提示没有对应版本）</option>
            <option value="hide">在这一页的切换器里不显示该语言</option>
          </select>
        </Field>
      </div>
    </>
  );
}

interface StringItem {
  key: string;
  source: string;
  builtin: string;
  override: string;
}

function UiStrings({ multi }: { multi: boolean }) {
  const { status } = useStatus();
  const [data, setData] = useState<{ isDefault: boolean; items: StringItem[] } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [query, setQuery] = useState('');
  const lang = status.languages.find((l) => l.code === status.contentLocale);

  const load = useCallback(async () => {
    try {
      setData(await api('GET', '/ui-strings'));
      setEdits({});
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (!data) return <div className="muted">加载中…</div>;
  const valueOf = (i: StringItem) => edits[i.key] ?? i.override;
  const missing = (i: StringItem) => !data.isDefault && !i.builtin && !valueOf(i);
  const q = query.trim().toLowerCase();
  const shown = data.items.filter((i) => (!onlyMissing || missing(i)) && (!q || i.key.includes(q) || i.source.toLowerCase().includes(q) || valueOf(i).toLowerCase().includes(q)));
  const missingCount = data.items.filter(missing).length;
  const changed = Object.keys(edits).length;

  const save = async () => {
    try {
      await api('PUT', '/ui-strings', { entries: edits });
      toast('界面文案已保存');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <p className="muted">
        前台按钮、提示、空状态等界面文字。正在编辑：<strong>{lang?.name ?? status.contentLocale}</strong>
        {multi && '（在左侧“内容语言”处切换）'}。留空表示使用主题自带的文字；主题没有提供该语言时回退到默认语言。
      </p>
      <div className="tabs">
        <input type="search" placeholder="搜索文案…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索文案" style={{ width: 220 }} />
        {!data.isDefault && (
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> 只看未翻译（{missingCount}）
          </label>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn btn-primary" disabled={!changed} onClick={() => void save()}>
          保存{changed ? `（${changed} 项）` : ''}
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="empty">{onlyMissing ? '没有未翻译的文案。' : '没有匹配的文案。'}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{data.isDefault ? '主题自带的文字' : '默认语言原文'}</th>
                <th>{data.isDefault ? '自定义' : `${lang?.name ?? ''}`}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.key}>
                  <td style={{ width: '45%' }}>
                    {i.source}
                    <div className="muted small">{i.key}</div>
                  </td>
                  <td>
                    <input value={valueOf(i)} placeholder={i.builtin || (data.isDefault ? i.source : `未翻译，将显示：${i.source}`)} onChange={(e) => setEdits({ ...edits, [i.key]: e.target.value })} aria-label={i.key} maxLength={1000} />
                    {missing(i) && <span className="badge badge-pending">未翻译</span>}
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
