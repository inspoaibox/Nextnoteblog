import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { flattenCats, type CatNode } from '../pages/Categories';
import { Field, toast } from './ui';

interface Taxonomy {
  primaryCategoryId: number | null;
  categoryIds: number[];
  tags: string[];
}

/** 文章的分类与标签。它们与语言、修订无关，修改后立即生效（与“置顶”一样） */
export function TaxonomyPanel({ postId }: { postId: number }) {
  const [cats, setCats] = useState<CatNode[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [value, setValue] = useState<Taxonomy | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [showExtra, setShowExtra] = useState(false);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    Promise.all([api('GET', '/categories'), api('GET', '/tags'), api('GET', `/posts/${postId}/taxonomy`)])
      .then(([c, t, tx]) => {
        setCats(flattenCats(c.tree));
        setAllTags(t.map((x: { name: string }) => x.name));
        setValue({ primaryCategoryId: tx.primaryCategoryId, categoryIds: tx.categoryIds, tags: tx.tags });
        setShowExtra(tx.categoryIds.length > 0);
      })
      .catch((e) => toast(e.message, 'error'));
  }, [postId]);

  const save = (next: Taxonomy) => {
    setValue(next);
    // 串行提交，避免快速连续修改时后发先至
    saving.current = saving.current.then(() => api('PUT', `/posts/${postId}/taxonomy`, next).catch((e) => toast(`分类标签保存失败：${e.message}`, 'error')));
  };

  if (!value) return <p className="muted small">加载分类与标签…</p>;

  const addTags = (raw: string) => {
    const names = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    const have = new Set(value.tags.map((t) => t.toLowerCase()));
    const fresh = names.filter((n) => !have.has(n.toLowerCase()));
    if (fresh.length) save({ ...value, tags: [...value.tags, ...fresh] });
    setTagInput('');
  };
  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      addTags(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && value.tags.length) {
      save({ ...value, tags: value.tags.slice(0, -1) });
    }
  };
  const suggestions = allTags.filter((t) => !value.tags.some((v) => v.toLowerCase() === t.toLowerCase()));

  return (
    <>
      <Field label="主分类" hint={cats.length ? '决定文章页的面包屑路径' : '还没有分类，可在“分类”页面创建'}>
        <select
          value={value.primaryCategoryId ?? ''}
          style={{ width: '100%' }}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            save({ ...value, primaryCategoryId: id, categoryIds: value.categoryIds.filter((c) => c !== id) });
          }}
        >
          <option value="">（未分类）</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {'　'.repeat(c.depth - 1)}
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      {cats.length > 1 && (
        <div className="field">
          <button type="button" className="link-btn" onClick={() => setShowExtra((v) => !v)}>
            {showExtra ? '收起附加分类' : `附加分类${value.categoryIds.length ? `（${value.categoryIds.length}）` : ''}`}
          </button>
          {showExtra && (
            <div className="check-list">
              {cats
                .filter((c) => c.id !== value.primaryCategoryId)
                .map((c) => (
                  <label key={c.id} className="check" style={{ paddingLeft: (c.depth - 1) * 14 }}>
                    <input
                      type="checkbox"
                      checked={value.categoryIds.includes(c.id)}
                      onChange={(e) => save({ ...value, categoryIds: e.target.checked ? [...value.categoryIds, c.id] : value.categoryIds.filter((x) => x !== c.id) })}
                    />
                    {c.name}
                  </label>
                ))}
            </div>
          )}
        </div>
      )}

      <Field label="标签" hint="输入后按回车或逗号添加，没有的标签会自动创建">
        <div className="chips">
          {value.tags.map((t) => (
            <span key={t} className="chip">
              {t}
              <button type="button" aria-label={`移除标签 ${t}`} onClick={() => save({ ...value, tags: value.tags.filter((x) => x !== t) })}>
                ✕
              </button>
            </span>
          ))}
          <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={onTagKey} onBlur={() => addTags(tagInput)} list="nb-tag-suggestions" placeholder={value.tags.length ? '' : '添加标签…'} maxLength={50} aria-label="添加标签" />
          <datalist id="nb-tag-suggestions">
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
      </Field>
    </>
  );
}
