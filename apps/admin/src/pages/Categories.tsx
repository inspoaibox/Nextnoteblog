import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Field, Modal, confirmDialog, toast } from '../components/ui';

export interface CatNode {
  id: number;
  parentId: number | null;
  name: string;
  slug: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  visible: boolean;
  translated: boolean;
  depth: number;
  path: string;
  url: string;
  pathNames: string;
  postCount: number;
  publishedCount: number;
  totalPublished: number;
  children: CatNode[];
}

export const flattenCats = (nodes: CatNode[]): CatNode[] => nodes.flatMap((n) => [n, ...flattenCats(n.children)]);
const idsUnder = (n: CatNode): number[] => [n.id, ...n.children.flatMap(idsUnder)];

type Editing = { mode: 'create'; parentId: number | null } | { mode: 'edit'; node: CatNode };

export function Categories() {
  const [tree, setTree] = useState<CatNode[] | null>(null);
  const [maxDepth, setMaxDepth] = useState(6);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<{ node: CatNode; impact: any } | null>(null);
  const dragId = useRef<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api('GET', '/categories');
      setTree(res.tree);
      setMaxDepth(res.maxDepth);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (!tree) return <div className="muted">加载中…</div>;
  const all = flattenCats(tree);
  const byId = new Map(all.map((n) => [n.id, n]));
  const siblingsOf = (n: CatNode) => (n.parentId == null ? tree : (byId.get(n.parentId)?.children ?? []));

  const move = async (node: CatNode, parentId: number | null, index: number) => {
    // 换了上级且分类已有公开内容时，地址会变化，先说明影响
    if (parentId !== node.parentId && node.totalPublished > 0) {
      const target = parentId == null ? '顶级' : `“${byId.get(parentId)?.name}”之下`;
      const ok = await confirmDialog({
        title: `把“${node.name}”移动到${target}？`,
        body: (
          <>
            <p>该分类及其下级分类的地址会随之变化，共涉及 {idsUnder(node).length} 个分类、{node.totalPublished} 篇已发布文章。</p>
            <p>旧地址会自动跳转到新地址；文章自身的地址不受影响。</p>
          </>
        ),
        confirmText: '移动',
      });
      if (!ok) return;
    }
    try {
      await api('POST', `/categories/${node.id}/move`, { parentId, index });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const step = (node: CatNode, delta: number) => {
    const index = siblingsOf(node).findIndex((s) => s.id === node.id);
    void move(node, node.parentId, index + delta);
  };

  /** 拖到某一行上：放到它前面，并跟它成为同级 */
  const dropOn = (target: CatNode) => {
    const source = dragId.current != null ? byId.get(dragId.current) : undefined;
    dragId.current = null;
    setOverId(null);
    if (!source || source.id === target.id) return;
    if (idsUnder(source).includes(target.id)) return toast('不能把分类拖到它自己的下级里', 'error');
    const siblings = siblingsOf(target).filter((s) => s.id !== source.id);
    void move(source, target.parentId, siblings.findIndex((s) => s.id === target.id));
  };

  const askDelete = async (node: CatNode) => {
    try {
      setDeleting({ node, impact: await api('GET', `/categories/${node.id}/impact`) });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const toggle = async (node: CatNode) => {
    try {
      await api('PATCH', `/categories/${node.id}`, { visible: !node.visible });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const q = query.trim().toLowerCase();
  const matches = (n: CatNode): boolean => !q || n.name.toLowerCase().includes(q) || n.slug.includes(q) || n.children.some(matches);

  const renderNodes = (nodes: CatNode[]) =>
    nodes.filter(matches).map((node, index, shown) => {
      const open = q ? true : !collapsed.has(node.id);
      return (
        <li key={node.id}>
          <div
            className={`tree-row${overId === node.id ? ' drop-target' : ''}${node.visible ? '' : ' is-hidden'}`}
            draggable={!q}
            onDragStart={(e) => {
              dragId.current = node.id;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', String(node.id));
            }}
            onDragOver={(e) => {
              if (dragId.current == null || dragId.current === node.id) return;
              e.preventDefault();
              setOverId(node.id);
            }}
            onDragLeave={() => setOverId((cur) => (cur === node.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              dropOn(node);
            }}
            onDragEnd={() => {
              dragId.current = null;
              setOverId(null);
            }}
          >
            <span className="drag-handle" aria-hidden="true" title="拖动排序">
              ⠿
            </span>
            {node.children.length > 0 ? (
              <button className="icon-btn twisty" aria-label={open ? '收起' : '展开'} onClick={() => setCollapsed((s) => new Set(s.has(node.id) ? [...s].filter((x) => x !== node.id) : [...s, node.id]))}>
                {open ? '▾' : '▸'}
              </button>
            ) : (
              <span className="twisty" />
            )}
            <span className="tree-name">
              <strong>{node.name}</strong>
              {!node.visible && <span className="badge">已隐藏</span>}
              {!node.translated && <span className="badge badge-pending" title="当前语言还没有译名，前台显示的是其他语言的名称。点击“编辑”填写即可">未翻译</span>}
              <span className="muted small">/category/{node.path}</span>
            </span>
            <span className="tree-counts muted small" title="直接归属的文章数 / 其中已发布 / 含下级分类的已发布数">
              <Link to={`/posts?categoryId=${node.id}`}>{node.postCount} 篇</Link>
              <span>已发布 {node.publishedCount}</span>
              {node.children.length > 0 && <span>含下级 {node.totalPublished}</span>}
            </span>
            <span className="actions">
              <span className="move-btns">
                <button className="icon-btn" disabled={index === 0 || !!q} onClick={() => step(node, -1)} aria-label="上移" title="上移">
                  ↑
                </button>
                <button className="icon-btn" disabled={index === shown.length - 1 || !!q} onClick={() => step(node, 1)} aria-label="下移" title="下移">
                  ↓
                </button>
              </span>
              {node.depth < maxDepth && (
                <button className="link-btn" onClick={() => setEditing({ mode: 'create', parentId: node.id })}>
                  添加子分类
                </button>
              )}
              <button className="link-btn" onClick={() => setEditing({ mode: 'edit', node })}>
                编辑
              </button>
              <button className="link-btn" onClick={() => void toggle(node)}>
                {node.visible ? '隐藏' : '显示'}
              </button>
              <button className="link-btn danger" onClick={() => void askDelete(node)}>
                删除
              </button>
            </span>
          </div>
          {open && node.children.length > 0 && <ul className="tree">{renderNodes(node.children)}</ul>}
        </li>
      );
    });

  return (
    <>
      <header className="page-head">
        <h1>分类</h1>
        <div className="row">
          <input type="search" placeholder="搜索分类…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索分类" />
          <button className="btn btn-primary" onClick={() => setEditing({ mode: 'create', parentId: null })}>
            ＋ 新建分类
          </button>
        </div>
      </header>

      {all.length === 0 ? (
        <div className="empty">还没有分类。点击“新建分类”创建第一个，分类最多可以有 {maxDepth} 层。</div>
      ) : (
        <div className="panel tree-panel">
          <ul className="tree">{renderNodes(tree)}</ul>
          <p className="muted small tree-hint">拖动一行到另一行上，可以把它排到那一行前面并成为同级；要放进某个分类之下，请用“编辑”修改上级分类。这里的顺序就是前台的显示顺序。</p>
        </div>
      )}

      {editing && (
        <CategoryForm
          editing={editing}
          all={all}
          maxDepth={maxDepth}
          onClose={() => setEditing(null)}
          onSaved={async (parentChange) => {
            setEditing(null);
            if (parentChange) await move(parentChange.node, parentChange.parentId, 9999);
            await load();
          }}
        />
      )}

      {deleting && (
        <DeleteCategory
          node={deleting.node}
          impact={deleting.impact}
          all={all}
          onClose={() => setDeleting(null)}
          onDone={async () => {
            setDeleting(null);
            await load();
          }}
        />
      )}
    </>
  );
}

function CategoryForm({ editing, all, maxDepth, onClose, onSaved }: { editing: Editing; all: CatNode[]; maxDepth: number; onClose: () => void; onSaved: (parentChange?: { node: CatNode; parentId: number | null }) => void }) {
  const node = editing.mode === 'edit' ? editing.node : null;
  const [form, setForm] = useState({
    name: node?.name ?? '',
    slug: node?.slug ?? '',
    description: node?.description ?? '',
    seoTitle: node?.seoTitle ?? '',
    seoDescription: node?.seoDescription ?? '',
    parentId: node ? node.parentId : editing.mode === 'create' ? editing.parentId : null,
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  // 不能选自己或自己的下级作为上级
  const banned = new Set(node ? idsUnder(node) : []);
  const parents = all.filter((c) => !banned.has(c.id) && c.depth < maxDepth);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (node) {
        const slugChanged = form.slug !== node.slug;
        if (slugChanged && node.totalPublished > 0) {
          const ok = await confirmDialog({ title: '修改地址标识？', body: `分类地址会从 /category/${node.path} 变为新地址，旧地址会自动跳转。`, confirmText: '修改' });
          if (!ok) return;
        }
        await api('PATCH', `/categories/${node.id}`, { name: form.name, slug: form.slug, description: form.description, seoTitle: form.seoTitle, seoDescription: form.seoDescription });
        onSaved(form.parentId !== node.parentId ? { node, parentId: form.parentId } : undefined);
      } else {
        await api('POST', '/categories', { name: form.name, slug: form.slug || undefined, parentId: form.parentId, description: form.description });
        onSaved();
      }
      toast('已保存');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={node ? '编辑分类' : '新建分类'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label="名称">
            <input value={form.name} onChange={set('name')} required maxLength={100} autoFocus />
          </Field>
          <Field label="上级分类">
            <select value={form.parentId ?? ''} onChange={(e) => setForm({ ...form, parentId: e.target.value ? Number(e.target.value) : null })} style={{ width: '100%' }}>
              <option value="">（顶级分类）</option>
              {parents.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.pathNames}
                </option>
              ))}
            </select>
          </Field>
          <Field label="地址标识" hint={node ? '同一层级内不能重复' : '留空则根据名称自动生成（中文转拼音）'}>
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.trim().toLowerCase() })} spellCheck={false} />
          </Field>
          <Field label="介绍" hint="显示在分类页标题下方">
            <textarea rows={2} value={form.description} onChange={set('description')} maxLength={1000} />
          </Field>
          {node && (
            <>
              <Field label="SEO 标题" hint="留空使用分类名称">
                <input value={form.seoTitle} onChange={set('seoTitle')} maxLength={200} />
              </Field>
              <Field label="SEO 描述" hint="留空使用介绍">
                <textarea rows={2} value={form.seoDescription} onChange={set('seoDescription')} maxLength={500} />
              </Field>
            </>
          )}
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

function DeleteCategory({ node, impact, all, onClose, onDone }: { node: CatNode; impact: any; all: CatNode[]; onClose: () => void; onDone: () => void }) {
  const [choice, setChoice] = useState<'move' | 'clear'>('move');
  const [target, setTarget] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const others = all.filter((c) => c.id !== node.id);
  const hasChildren = impact.childCount > 0;
  const hasPosts = impact.postCount > 0;

  const remove = async () => {
    setBusy(true);
    try {
      const query = !hasPosts ? '' : choice === 'move' ? `?moveTo=${target}` : '?clear=1';
      const res = await api('DELETE', `/categories/${node.id}${query}`);
      toast(res.moved ? `已删除，${res.moved} 篇文章已迁移` : '已删除');
      onDone();
    } catch (e) {
      toast((e as ApiError).message, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title={`删除分类“${node.name}”`} onClose={onClose}>
      <div className="modal-body">
        {hasChildren ? (
          <p>
            该分类下还有 {impact.childCount} 个子分类（共 {impact.descendantCount} 个下级分类）。请先把子分类移动到别处或逐个删除，再删除它。
          </p>
        ) : !hasPosts ? (
          <p>该分类下没有文章，可以直接删除。</p>
        ) : (
          <>
            <p>
              该分类下有 {impact.postCount} 篇文章（其中 {impact.publishedCount} 篇已发布）。删除前需要决定这些文章的去向：
            </p>
            <ul className="small muted">
              {impact.samplePosts.map((p: any) => (
                <li key={p.id}>{p.title || '（无标题）'}</li>
              ))}
              {impact.postCount > impact.samplePosts.length && <li>…等 {impact.postCount} 篇</li>}
            </ul>
            <label className="check">
              <input type="radio" name="choice" checked={choice === 'move'} onChange={() => setChoice('move')} /> 迁移到另一个分类（合并）
            </label>
            {choice === 'move' && (
              <select value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : '')} style={{ width: '100%', marginBottom: 10 }} aria-label="目标分类">
                <option value="">请选择目标分类</option>
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.pathNames}
                  </option>
                ))}
              </select>
            )}
            <label className="check">
              <input type="radio" name="choice" checked={choice === 'clear'} onChange={() => setChoice('clear')} /> 不迁移，这些文章将不再属于该分类
            </label>
            <p className="muted small">文章本身和文章地址都不会受影响；该分类的旧地址{choice === 'move' ? '会跳转到目标分类' : '将无法访问'}。</p>
          </>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          {hasChildren ? '知道了' : '取消'}
        </button>
        {!hasChildren && (
          <button className="btn btn-danger" disabled={busy || (hasPosts && choice === 'move' && !target)} onClick={() => void remove()}>
            删除分类
          </button>
        )}
      </div>
    </Modal>
  );
}
