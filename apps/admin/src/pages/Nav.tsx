import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { MoveButtons, moveItem, useDragSort } from '../components/Sortable';
import { toast } from '../components/ui';
import { flattenCats, type CatNode } from './Categories';

interface NavItem {
  id?: number;
  type: string;
  targetId: number | null;
  url: string;
  label: string;
  newTab: boolean;
  visible: boolean;
  resolvedUrl?: string | null;
  defaultLabel?: string;
}

const TYPE_LABEL: Record<string, string> = { home: '首页', posts: '文章列表', archive: '归档', category: '分类', tag: '标签', collection: '专题 / 系列', page: '页面', url: '自定义链接' };

export function Nav() {
  const [menu, setMenu] = useState<'header' | 'footer'>('header');
  const [items, setItems] = useState<NavItem[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [targets, setTargets] = useState<Record<string, { id: number; label: string }[]>>({});
  const [addType, setAddType] = useState('category');
  const [addTarget, setAddTarget] = useState('');
  const [addUrl, setAddUrl] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await api('GET', `/nav/${menu}`));
      setDirty(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [menu]);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    Promise.all([api('GET', '/categories'), api('GET', '/tags'), api('GET', '/collections'), api('GET', '/pages')])
      .then(([cats, tags, cols, pages]) =>
        setTargets({
          category: flattenCats(cats.tree as CatNode[]).map((c) => ({ id: c.id, label: c.pathNames })),
          tag: tags.map((t: any) => ({ id: t.id, label: t.name })),
          collection: cols.map((c: any) => ({ id: c.id, label: `${c.kind === 'series' ? '系列' : '专题'}：${c.title}${c.visible ? '' : '（未公开）'}` })),
          page: pages.map((p: any) => ({ id: p.pageId, label: `${p.title}${p.status === 'published' ? '' : p.status === 'missing' ? '（当前语言未翻译）' : '（未发布）'}` })),
        }),
      )
      .catch((e) => toast(e.message, 'error'));
  }, []);

  const update = (next: NavItem[]) => {
    setItems(next);
    setDirty(true);
  };
  const move = (from: number, to: number) => items && update(moveItem(items, from, to));
  const drag = useDragSort(move);
  const patch = (index: number, change: Partial<NavItem>) => items && update(items.map((it, i) => (i === index ? { ...it, ...change } : it)));

  const add = () => {
    if (!items) return;
    const builtin = ['home', 'posts', 'archive'].includes(addType);
    if (addType === 'url') {
      if (!/^(https?:\/\/|\/|mailto:)/i.test(addUrl)) return toast('链接需以 http://、https://、/ 或 mailto: 开头', 'error');
      update([...items, { type: 'url', targetId: null, url: addUrl, label: '', newTab: /^https?:/i.test(addUrl), visible: true, resolvedUrl: addUrl, defaultLabel: addUrl }]);
      setAddUrl('');
    } else if (builtin) {
      update([...items, { type: addType, targetId: null, url: '', label: '', newTab: false, visible: true, resolvedUrl: '', defaultLabel: TYPE_LABEL[addType] }]);
    } else {
      const target = targets[addType]?.find((t) => String(t.id) === addTarget);
      if (!target) return toast('请选择要链接的内容', 'error');
      update([...items, { type: addType, targetId: target.id, url: '', label: '', newTab: false, visible: true, resolvedUrl: '', defaultLabel: target.label.split(' / ').at(-1)! }]);
      setAddTarget('');
    }
  };

  const save = async () => {
    try {
      setItems(await api('PUT', `/nav/${menu}`, { items: items!.map(({ id, type, targetId, url, label, newTab, visible }) => ({ id, type, targetId, url, label, newTab, visible })) }));
      setDirty(false);
      toast('导航已保存');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>导航</h1>
        <button className="btn btn-primary" disabled={!dirty} onClick={() => void save()}>
          保存{menu === 'header' ? '顶部' : '页脚'}导航
        </button>
      </header>

      <div className="tabs" role="tablist">
        {(['header', 'footer'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={menu === m}
            className={menu === m ? 'active' : ''}
            onClick={() => {
              if (dirty && !window.confirm('当前菜单有未保存的修改，切换后会丢失。继续吗？')) return;
              setMenu(m);
            }}
          >
            {m === 'header' ? '顶部导航' : '页脚导航'}
          </button>
        ))}
      </div>

      {!items ? (
        <div className="muted">加载中…</div>
      ) : (
        <div className="panel">
          {items.length === 0 ? (
            <p className="muted">{menu === 'header' ? '尚未配置顶部导航，前台目前显示默认的“首页 / 文章 / 归档”。添加任意一项后，将以这里的配置为准。' : '页脚导航为空，前台不显示。'}</p>
          ) : (
            <ol className="sort-list nav-list">
              {items.map((item, index) => (
                <li key={index} {...drag(index)} className={item.visible ? '' : 'is-hidden'}>
                  <span className="drag-handle" aria-hidden="true">
                    ⠿
                  </span>
                  <span className="badge">{TYPE_LABEL[item.type]}</span>
                  <input value={item.label} placeholder={item.defaultLabel || '显示名称'} onChange={(e) => patch(index, { label: e.target.value })} aria-label="显示名称" maxLength={100} />
                  {item.resolvedUrl === null ? <span className="form-error small">指向的内容已删除或未公开，前台不显示</span> : <span className="muted small nav-url">{item.type === 'url' ? item.url : item.resolvedUrl}</span>}
                  <label className="check small">
                    <input type="checkbox" checked={item.newTab} onChange={(e) => patch(index, { newTab: e.target.checked })} /> 新窗口
                  </label>
                  <label className="check small">
                    <input type="checkbox" checked={item.visible} onChange={(e) => patch(index, { visible: e.target.checked })} /> 显示
                  </label>
                  <MoveButtons index={index} count={items.length} onMove={move} />
                  <button className="icon-btn" onClick={() => update(items.filter((_, i) => i !== index))} aria-label="移除">
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          )}

          <div className="row wrap nav-add">
            <strong>添加：</strong>
            <select
              value={addType}
              onChange={(e) => {
                setAddType(e.target.value);
                setAddTarget('');
              }}
              aria-label="导航类型"
            >
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {addType === 'url' ? (
              <input value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="https://…" style={{ width: 260 }} aria-label="链接地址" />
            ) : targets[addType] ? (
              <select value={addTarget} onChange={(e) => setAddTarget(e.target.value)} aria-label="链接到">
                <option value="">{targets[addType].length ? '请选择…' : '（暂无可选内容）'}</option>
                {targets[addType].map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            ) : null}
            <button className="btn" onClick={add}>
              添加
            </button>
          </div>
          <p className="muted small">菜单的结构各语言共用，显示名称按语言分别填写。拖动或用箭头调整顺序。显示名称留空时使用内容自己的名称；修改后需点击右上角保存。</p>
        </div>
      )}
    </>
  );
}
