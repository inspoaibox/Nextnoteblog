/**
 * 分类树与标签。
 * 分类的父子关系、排序存在主体表里，名称与地址存在译文表里；
 * 分类地址是整条路径 /category/a/b/c，文章地址不含分类，所以调整分类不会影响文章链接。
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema, transaction } from '../db/index.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import { isValidSlug, slugify } from '../lib/slug.ts';
import { addRedirect } from './posts.ts';
import { defaultLocaleSync } from './i18n.ts';

const { categories, categoryTranslations: ct, postCategories: pc, tags, tagTranslations: tt, postTags: ptags, posts, postTranslations: pt, revisions } = schema;

export const MAX_CATEGORY_DEPTH = 6;
export const categoryPath = (path: string) => `/category/${path}`;
export const tagPath = (slug: string) => `/tag/${slug}`;

export interface CategoryNode {
  id: number;
  parentId: number | null;
  sort: number;
  visible: boolean;
  name: string;
  slug: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  /** 当前语言是否有自己的译文；false 表示名称与地址回退自其他语言 */
  translated: boolean;
  /** 从 1 开始的层级深度 */
  depth: number;
  /** slug 路径，如 dev/web/css */
  path: string;
  url: string;
  /** 从根到自己的名称与地址，用于面包屑 */
  trail: { id: number; name: string; url: string }[];
  children: CategoryNode[];
  /** 直接归属本分类的文章数（不含回收站） */
  postCount: number;
  /** 直接归属本分类且已发布的文章数 */
  publishedCount: number;
  /** 本分类及所有下级分类中已发布的文章数（去重） */
  totalPublished: number;
}

export interface CategoryTree {
  roots: CategoryNode[];
  byId: Map<number, CategoryNode>;
  byPath: Map<string, CategoryNode>;
}

/** 从一组译文里为每个主体挑一条：当前语言优先，其次默认语言，最后任意一条 */
export function pickTranslation<T extends { locale: string }>(all: T[], keyOf: (t: T) => number, locale: string) {
  const groups = new Map<number, T[]>();
  for (const t of all) groups.set(keyOf(t), [...(groups.get(keyOf(t)) ?? []), t]);
  const fallback = defaultLocaleSync();
  return (id: number): T | undefined => {
    const list = groups.get(id);
    return list?.find((t) => t.locale === locale) ?? list?.find((t) => t.locale === fallback) ?? list?.[0];
  };
}

const treeCache = new Map<string, CategoryTree>();
/** 任何可能影响分类结构或文章计数的写操作之后调用 */
export function invalidateTaxonomy() {
  treeCache.clear();
}

export async function getTree(locale: string): Promise<CategoryTree> {
  const cached = treeCache.get(locale);
  if (cached) return cached;

  const rows = await db.select().from(categories);
  // 译文回退：当前语言 → 默认语言 → 任意一种，保证各语言下树结构完整
  const allTranslations = await db.select().from(ct);
  const pick = pickTranslation(allTranslations, (t) => t.categoryId, locale);
  const byId = new Map<number, CategoryNode>();
  for (const c of rows) {
    const t = pick(c.id);
    byId.set(c.id, {
      id: c.id,
      parentId: c.parentId,
      sort: c.sort,
      visible: !!c.visible,
      name: t?.name ?? `#${c.id}`,
      slug: t?.slug ?? `c${c.id}`,
      description: t?.locale === locale ? t.description : '',
      seoTitle: t?.locale === locale ? t.seoTitle : '',
      seoDescription: t?.locale === locale ? t.seoDescription : '',
      translated: t?.locale === locale,
      depth: 1,
      path: '',
      url: '',
      trail: [],
      children: [],
      postCount: 0,
      publishedCount: 0,
      totalPublished: 0,
    });
  }
  const roots: CategoryNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node); // 找不到父级的节点当作顶级，避免丢失
  }

  // 文章归属：一次取出，用集合做去重汇总
  const links = await db
    .select({ categoryId: pc.categoryId, postId: pc.postId, published: sql<number>`${pt.status} = 'published'` })
    .from(pc)
    .innerJoin(posts, and(eq(posts.id, pc.postId), isNull(posts.deletedAt)))
    .innerJoin(pt, and(eq(pt.postId, pc.postId), eq(pt.locale, locale)));
  const publishedSets = new Map<number, Set<number>>();
  for (const link of links) {
    const node = byId.get(link.categoryId);
    if (!node) continue;
    node.postCount++;
    if (link.published) {
      node.publishedCount++;
      if (!publishedSets.has(node.id)) publishedSets.set(node.id, new Set());
      publishedSets.get(node.id)!.add(link.postId);
    }
  }

  const byPath = new Map<string, CategoryNode>();
  const walk = (nodes: CategoryNode[], parent: CategoryNode | null): void => {
    nodes.sort((a, b) => a.sort - b.sort || a.id - b.id);
    for (const node of nodes) {
      node.depth = parent ? parent.depth + 1 : 1;
      node.path = parent ? `${parent.path}/${node.slug}` : node.slug;
      node.url = categoryPath(node.path);
      node.trail = [...(parent?.trail ?? []), { id: node.id, name: node.name, url: node.url }];
      byPath.set(node.path, node);
      walk(node.children, node);
    }
  };
  walk(roots, null);

  const collect = (node: CategoryNode): Set<number> => {
    const all = new Set(publishedSets.get(node.id));
    for (const child of node.children) for (const postId of collect(child)) all.add(postId);
    node.totalPublished = all.size;
    return all;
  };
  roots.forEach(collect);

  const tree = { roots, byId, byPath };
  treeCache.set(locale, tree);
  return tree;
}

/** 自己加上所有下级分类的 id */
export function descendantIds(node: CategoryNode): number[] {
  return [node.id, ...node.children.flatMap(descendantIds)];
}
const subtreeHeight = (node: CategoryNode): number => 1 + Math.max(0, ...node.children.map(subtreeHeight));

async function requireNode(locale: string, id: number) {
  const node = (await getTree(locale)).byId.get(id);
  if (!node) throw notFound('分类');
  return node;
}

async function assertSlugFree(locale: string, parentId: number | null, slug: string, excludeId?: number) {
  if (!isValidSlug(slug)) throw badRequest('地址标识只能包含小写字母、数字和连字符');
  const tree = await getTree(locale);
  const siblings = parentId == null ? tree.roots : (tree.byId.get(parentId)?.children ?? []);
  if (siblings.some((s) => s.slug === slug && s.id !== excludeId)) throw badRequest(`同一层级下已有地址标识为“${slug}”的分类`);
}

async function freeSlug(locale: string, parentId: number | null, base: string) {
  const tree = await getTree(locale);
  const taken = new Set((parentId == null ? tree.roots : (tree.byId.get(parentId)?.children ?? [])).map((s) => s.slug));
  let candidate = base || 'category';
  for (let n = 2; taken.has(candidate); n++) candidate = `${base || 'category'}-${n}`;
  return candidate;
}

/** 取一组分类当前的地址，供变更前后对比生成重定向 */
async function urlsOf(locale: string, ids: number[]) {
  const tree = await getTree(locale);
  return new Map(ids.map((id) => [id, tree.byId.get(id)?.url ?? '']));
}
async function redirectChanged(locale: string, before: Map<number, string>) {
  invalidateTaxonomy();
  const after = await urlsOf(locale, [...before.keys()]);
  for (const [id, from] of before) {
    const to = after.get(id);
    if (from && to && from !== to) await addRedirect(from, to);
  }
}

export async function createCategory(locale: string, input: { name: string; slug?: string; parentId?: number | null; description?: string }) {
  const name = input.name.trim();
  if (!name) throw badRequest('分类名称不能为空');
  const parentId = input.parentId ?? null;
  return transaction(async () => {
    const tree = await getTree(locale);
    if (parentId != null) {
      const parent = tree.byId.get(parentId);
      if (!parent) throw badRequest('上级分类不存在');
      if (parent.depth >= MAX_CATEGORY_DEPTH) throw badRequest(`分类最多 ${MAX_CATEGORY_DEPTH} 层`);
    }
    const slug = input.slug?.trim() ? input.slug.trim() : await freeSlug(locale, parentId, slugify(name));
    await assertSlugFree(locale, parentId, slug);
    const siblings = parentId == null ? tree.roots : tree.byId.get(parentId)!.children;
    const sort = siblings.length ? Math.max(...siblings.map((s) => s.sort)) + 1 : 0;
    const row = await db.insert(categories).values({ parentId, sort, createdAt: Date.now() }).returning({ id: categories.id }).get();
    await db.insert(ct).values({ categoryId: row.id, locale, name, slug, description: input.description ?? '' });
    invalidateTaxonomy();
    return row.id;
  });
}

export async function updateCategory(locale: string, id: number, patch: { name?: string; slug?: string; description?: string; visible?: boolean; seoTitle?: string; seoDescription?: string }) {
  return transaction(async () => {
    const node = await requireNode(locale, id);
    const before = await urlsOf(locale, descendantIds(node));
    if (patch.name !== undefined && !patch.name.trim()) throw badRequest('分类名称不能为空');
    if (patch.slug !== undefined && patch.slug !== node.slug) await assertSlugFree(locale, node.parentId, patch.slug, id);
    const { visible, ...text } = patch;
    if (text.name !== undefined) text.name = text.name.trim();
    const values = { name: node.name, slug: node.slug, description: node.description, seoTitle: node.seoTitle, seoDescription: node.seoDescription, ...text };
    await db.insert(ct).values({ categoryId: id, locale, ...values }).onConflictDoUpdate({ target: [ct.categoryId, ct.locale], set: values });
    if (visible !== undefined) await db.update(categories).set({ visible: visible ? 1 : 0 }).where(eq(categories.id, id));
    await redirectChanged(locale, before); // 改了地址标识：本级和所有下级的旧地址自动跳转
  });
}

/** 移动分类：换父级和 / 或调整在同级中的位置 */
export async function moveCategory(locale: string, id: number, target: { parentId: number | null; index?: number }) {
  return transaction(async () => {
    const tree = await getTree(locale);
    const node = await requireNode(locale, id);
    const newParent = target.parentId == null ? null : tree.byId.get(target.parentId);
    if (target.parentId != null && !newParent) throw badRequest('目标上级分类不存在');
    if (newParent && descendantIds(node).includes(newParent.id)) throw badRequest('不能把分类移动到它自己或它的下级分类之下');
    if ((newParent?.depth ?? 0) + subtreeHeight(node) > MAX_CATEGORY_DEPTH) throw badRequest(`移动后会超过 ${MAX_CATEGORY_DEPTH} 层的上限`);
    if (target.parentId !== node.parentId) await assertSlugFree(locale, target.parentId, node.slug, id);

    const before = await urlsOf(locale, descendantIds(node));
    const siblings = (newParent ? newParent.children : tree.roots).filter((s) => s.id !== id);
    const index = Math.min(Math.max(target.index ?? siblings.length, 0), siblings.length);
    siblings.splice(index, 0, node);
    await db.update(categories).set({ parentId: target.parentId }).where(eq(categories.id, id));
    for (const [i, s] of siblings.entries()) await db.update(categories).set({ sort: i }).where(eq(categories.id, s.id));
    await redirectChanged(locale, before);
  });
}

/** 删除或移动前展示的影响范围 */
export async function categoryImpact(locale: string, id: number) {
  const node = await requireNode(locale, id);
  const sample = await db
    .select({ id: pt.id, title: revisions.title, status: pt.status })
    .from(pc)
    .innerJoin(pt, and(eq(pt.postId, pc.postId), eq(pt.locale, locale)))
    .innerJoin(revisions, eq(revisions.id, pt.draftRevisionId))
    .where(eq(pc.categoryId, id))
    .limit(10);
  return { id, name: node.name, url: node.url, childCount: node.children.length, descendantCount: descendantIds(node).length - 1, postCount: node.postCount, publishedCount: node.publishedCount, samplePosts: sample };
}

/** 把一个分类下的文章归属转移到另一个分类，保留“主分类”标记 */
async function reassignPosts(fromId: number, toId: number) {
  const links = await db.select().from(pc).where(eq(pc.categoryId, fromId));
  for (const link of links) {
    const existing = await db.select().from(pc).where(and(eq(pc.postId, link.postId), eq(pc.categoryId, toId))).get();
    if (existing) {
      if (link.isPrimary && !existing.isPrimary) await db.update(pc).set({ isPrimary: 1 }).where(and(eq(pc.postId, link.postId), eq(pc.categoryId, toId)));
      await db.delete(pc).where(and(eq(pc.postId, link.postId), eq(pc.categoryId, fromId)));
    } else {
      await db.update(pc).set({ categoryId: toId }).where(and(eq(pc.postId, link.postId), eq(pc.categoryId, fromId)));
    }
  }
  return links.length;
}

/**
 * 删除分类。有下级分类时拒绝；有文章时必须说明去向：
 *   moveTo = 目标分类 id → 文章迁移过去（即“合并分类”）
 *   moveTo = null       → 明确选择清空归属
 */
export async function deleteCategory(locale: string, id: number, opts: { moveTo?: number | null }) {
  return transaction(async () => {
    const node = await requireNode(locale, id);
    if (node.children.length) throw new HttpError(409, '该分类下还有子分类，请先移动或删除子分类', await categoryImpact(locale, id));
    if (node.postCount > 0 && opts.moveTo === undefined) throw new HttpError(409, '该分类下还有文章，请选择迁移到其他分类或清空归属', await categoryImpact(locale, id));
    let moved = 0;
    if (opts.moveTo != null) {
      if (opts.moveTo === id) throw badRequest('不能迁移到正在删除的分类');
      await requireNode(locale, opts.moveTo);
      moved = await reassignPosts(id, opts.moveTo);
      await addRedirect(node.url, (await requireNode(locale, opts.moveTo)).url);
    }
    await db.delete(categories).where(eq(categories.id, id)); // 归属关系随外键级联删除
    invalidateTaxonomy();
    return { moved };
  });
}

/* ---------- 文章与分类 ---------- */

export async function getPostTaxonomy(locale: string, postId: number) {
  const cats = await db.select().from(pc).where(eq(pc.postId, postId));
  const linked = new Set((await db.select({ tagId: ptags.tagId }).from(ptags).where(eq(ptags.postId, postId))).map((r) => r.tagId));
  const tagRows = (await listTags(locale)).filter((t) => linked.has(t.id)).map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
  return {
    primaryCategoryId: cats.find((c) => c.isPrimary)?.categoryId ?? null,
    categoryIds: cats.filter((c) => !c.isPrimary).map((c) => c.categoryId),
    tags: tagRows.map((t) => t.name),
    tagList: tagRows,
  };
}

export async function setPostCategories(locale: string, postId: number, primaryId: number | null, extraIds: number[]) {
  const tree = await getTree(locale);
  const all = [...new Set([...(primaryId != null ? [primaryId] : []), ...extraIds])];
  for (const id of all) if (!tree.byId.has(id)) throw badRequest('所选分类不存在');
  await transaction(async () => {
    await db.delete(pc).where(eq(pc.postId, postId));
    if (all.length) await db.insert(pc).values(all.map((categoryId) => ({ postId, categoryId, isPrimary: categoryId === primaryId ? 1 : 0 })));
  });
  invalidateTaxonomy();
}

/** 批量把文章的主分类改为指定分类（原主分类归属移除，附加分类保留） */
export async function bulkSetPrimaryCategory(locale: string, postIds: number[], categoryId: number) {
  await requireNode(locale, categoryId);
  await transaction(async () => {
    for (const postId of postIds) {
      await db.delete(pc).where(and(eq(pc.postId, postId), eq(pc.isPrimary, 1), ne(pc.categoryId, categoryId)));
      await db.insert(pc).values({ postId, categoryId, isPrimary: 1 }).onConflictDoUpdate({ target: [pc.postId, pc.categoryId], set: { isPrimary: 1 } });
    }
  });
  invalidateTaxonomy();
}

/* ---------- 标签 ---------- */

export async function listTags(locale: string) {
  const rows = await db.select().from(tags);
  const pick = pickTranslation(await db.select().from(tt), (t) => t.tagId, locale);
  const counts = await db
    .select({ tagId: ptags.tagId, total: sql<number>`count(*)`, published: sql<number>`sum(case when ${pt.status} = 'published' then 1 else 0 end)` })
    .from(ptags)
    .innerJoin(posts, and(eq(posts.id, ptags.postId), isNull(posts.deletedAt)))
    .leftJoin(pt, and(eq(pt.postId, posts.id), eq(pt.locale, locale)))
    .groupBy(ptags.tagId);
  const countOf = new Map(counts.map((c) => [c.tagId, c]));
  return rows
    .map((row) => {
      const t = pick(row.id);
      const slug = t?.slug ?? `t${row.id}`;
      return {
        id: row.id,
        name: t?.name ?? `#${row.id}`,
        slug,
        description: t?.locale === locale ? t.description : '',
        translated: t?.locale === locale,
        postCount: countOf.get(row.id)?.total ?? 0,
        publishedCount: Number(countOf.get(row.id)?.published ?? 0),
        url: tagPath(slug),
      };
    })
    .sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name, locale));
}

export const getTagBySlug = async (locale: string, slug: string) => (await listTags(locale)).find((t) => t.slug === slug);

async function freeTagSlug(locale: string, base: string, excludeId?: number) {
  let candidate = base || 'tag';
  for (let n = 2; ; n++) {
    const clash = await db.select({ id: tt.tagId }).from(tt).where(and(eq(tt.locale, locale), eq(tt.slug, candidate), excludeId ? ne(tt.tagId, excludeId) : undefined)).get();
    if (!clash) return candidate;
    candidate = `${base || 'tag'}-${n}`;
  }
}

async function findOrCreateTag(locale: string, rawName: string): Promise<number> {
  const name = rawName.trim().slice(0, 50);
  // 按当前语言下“看到的名称”查重（含回退名），避免同名标签重复创建
  const existing = (await listTags(locale)).find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const tag = await db.insert(tags).values({ createdAt: Date.now() }).returning({ id: tags.id }).get();
  await db.insert(tt).values({ tagId: tag.id, locale, name, slug: await freeTagSlug(locale, slugify(name)) });
  return tag.id;
}

export async function createTag(locale: string, name: string) {
  if (!name.trim()) throw badRequest('标签名称不能为空');
  return transaction(() => findOrCreateTag(locale, name));
}

export async function updateTag(locale: string, id: number, patch: { name?: string; slug?: string; description?: string }) {
  return transaction(async () => {
    const shown = (await listTags(locale)).find((t) => t.id === id);
    if (!shown) throw notFound('标签');
    const own = await db.select().from(tt).where(and(eq(tt.tagId, id), eq(tt.locale, locale))).get();
    const next = { name: (patch.name ?? shown.name).trim(), slug: patch.slug ?? (own ? own.slug : await freeTagSlug(locale, shown.slug, id)), description: patch.description ?? shown.description };
    if (!next.name) throw badRequest('标签名称不能为空');
    const clash = await db.select({ id: tt.tagId }).from(tt).where(and(eq(tt.locale, locale), sql`lower(${tt.name}) = lower(${next.name})`, ne(tt.tagId, id))).get();
    if (clash) throw badRequest(`已存在名为“${next.name}”的标签，可以使用“合并”`);
    if (!isValidSlug(next.slug)) throw badRequest('地址标识只能包含小写字母、数字和连字符');
    if ((await freeTagSlug(locale, next.slug, id)) !== next.slug) throw badRequest('该地址标识已被其他标签使用');
    if (own && own.slug !== next.slug) await addRedirect(tagPath(own.slug), tagPath(next.slug));
    // 当前语言还没有译文时，这次保存就是在创建译文
    await db.insert(tt).values({ tagId: id, locale, ...next }).onConflictDoUpdate({ target: [tt.tagId, tt.locale], set: next });
  });
}

export async function deleteTags(ids: number[]) {
  if (ids.length) await db.delete(tags).where(inArray(tags.id, ids));
}

/** 合并标签：把 sourceIds 的文章都改挂到 targetId，然后删除来源标签 */
export async function mergeTags(locale: string, sourceIds: number[], targetId: number) {
  const sources = sourceIds.filter((id) => id !== targetId);
  return transaction(async () => {
    const all = await listTags(locale);
    const target = all.find((t) => t.id === targetId);
    if (!target) throw notFound('目标标签');
    for (const sourceId of sources) {
      const source = all.find((t) => t.id === sourceId);
      const links = await db.select().from(ptags).where(eq(ptags.tagId, sourceId));
      for (const link of links) await db.insert(ptags).values({ postId: link.postId, tagId: targetId }).onConflictDoNothing();
      if (source) await addRedirect(source.url, target.url);
    }
    await deleteTags(sources);
  });
}

export async function deleteEmptyTags(locale: string) {
  const empty = (await listTags(locale)).filter((t) => t.postCount === 0).map((t) => t.id);
  await deleteTags(empty);
  return empty.length;
}

export async function setPostTags(locale: string, postId: number, names: string[]) {
  const unique = [...new Map(names.map((n) => n.trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()].slice(0, 30);
  await transaction(async () => {
    const ids: number[] = [];
    for (const name of unique) ids.push(await findOrCreateTag(locale, name));
    await db.delete(ptags).where(eq(ptags.postId, postId));
    if (ids.length) await db.insert(ptags).values([...new Set(ids)].map((tagId) => ({ postId, tagId })));
  });
}
