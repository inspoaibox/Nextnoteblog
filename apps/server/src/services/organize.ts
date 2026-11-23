/** 专题 / 系列、自定义页面、导航菜单 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema, transaction } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { isValidSlug, RESERVED_SLUGS, slugify } from '../lib/slug.ts';
import { addRedirect, postPath } from './posts.ts';
import { getTree, listTags, pickTranslation } from './taxonomy.ts';
import { listLanguages } from './i18n.ts';

const { collections, collectionTranslations: colT, collectionItems: items, pages, pageTranslations: pgT, navItems, navItemTranslations: navT, posts, postTranslations: pt, revisions } = schema;

/* ====================== 专题 / 系列 ====================== */

export type CollectionKind = 'topic' | 'series';
export const collectionPath = (kind: string, slug: string) => `/${kind === 'series' ? 'series' : 'topic'}/${slug}`;

async function freeCollectionSlug(locale: string, base: string, excludeId?: number) {
  let candidate = base || 'collection';
  for (let n = 2; ; n++) {
    const clash = await db.select({ id: colT.collectionId }).from(colT).where(and(eq(colT.locale, locale), eq(colT.slug, candidate), excludeId ? ne(colT.collectionId, excludeId) : undefined)).get();
    if (!clash) return candidate;
    candidate = `${base || 'collection'}-${n}`;
  }
}

export async function listCollections(locale: string, opts: { kind?: CollectionKind; onlyVisible?: boolean } = {}) {
  const rows = await db
    .select({ id: collections.id, kind: collections.kind, cover: collections.cover, visible: collections.visible, sort: collections.sort, itemCount: sql<number>`(select count(*) from ${items} where ${items.collectionId} = ${collections.id})` })
    .from(collections)
    .where(and(opts.kind ? eq(collections.kind, opts.kind) : undefined, opts.onlyVisible ? eq(collections.visible, 1) : undefined))
    .orderBy(asc(collections.sort), desc(collections.id));
  const pick = pickTranslation(await db.select().from(colT), (t) => t.collectionId, locale);
  return rows.map((r) => {
    const t = pick(r.id);
    const slug = t?.slug ?? `c${r.id}`;
    return { ...r, visible: !!r.visible, title: t?.title ?? `#${r.id}`, slug, description: t?.locale === locale ? t.description : '', translated: t?.locale === locale, url: collectionPath(r.kind, slug) };
  });
}

export async function getCollection(locale: string, id: number) {
  const row = (await listCollections(locale)).find((c) => c.id === id);
  if (!row) throw notFound('专题 / 系列');
  const list = await db
    .select({ postId: items.postId, tid: pt.id, title: revisions.title, status: pt.status, deletedAt: posts.deletedAt })
    .from(items)
    .innerJoin(posts, eq(posts.id, items.postId))
    .innerJoin(pt, and(eq(pt.postId, items.postId), eq(pt.locale, locale)))
    .innerJoin(revisions, eq(revisions.id, pt.draftRevisionId))
    .where(eq(items.collectionId, id))
    .orderBy(asc(items.sort));
  return { ...row, items: list };
}

export async function createCollection(locale: string, input: { kind: CollectionKind; title: string; slug?: string; description?: string }) {
  const title = input.title.trim();
  if (!title) throw badRequest('标题不能为空');
  return transaction(async () => {
    const slug = input.slug?.trim() || (await freeCollectionSlug(locale, slugify(title)));
    if (!isValidSlug(slug)) throw badRequest('地址标识只能包含小写字母、数字和连字符');
    if ((await freeCollectionSlug(locale, slug)) !== slug) throw badRequest('该地址标识已被使用');
    const row = await db.insert(collections).values({ kind: input.kind, createdAt: Date.now() }).returning({ id: collections.id }).get();
    await db.insert(colT).values({ collectionId: row.id, locale, title, slug, description: input.description ?? '' });
    return row.id;
  });
}

export async function updateCollection(locale: string, id: number, patch: { title?: string; slug?: string; description?: string; cover?: string; visible?: boolean; postIds?: number[] }) {
  return transaction(async () => {
    const cur = await getCollection(locale, id);
    const set: Partial<typeof colT.$inferInsert> = {};
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw badRequest('标题不能为空');
      set.title = patch.title.trim();
    }
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.slug !== undefined && patch.slug !== cur.slug) {
      if (!isValidSlug(patch.slug)) throw badRequest('地址标识只能包含小写字母、数字和连字符');
      if ((await freeCollectionSlug(locale, patch.slug, id)) !== patch.slug) throw badRequest('该地址标识已被使用');
      set.slug = patch.slug;
      if (cur.translated) await addRedirect(cur.url, collectionPath(cur.kind, patch.slug));
    }
    if (Object.keys(set).length || !cur.translated) {
      // 当前语言没有译文时，以回退内容为底创建一条
      const values = { title: cur.title, slug: cur.translated ? cur.slug : await freeCollectionSlug(locale, cur.slug, id), description: cur.description, ...set };
      await db.insert(colT).values({ collectionId: id, locale, ...values }).onConflictDoUpdate({ target: [colT.collectionId, colT.locale], set: values });
    }
    const main: Partial<typeof collections.$inferInsert> = {};
    if (patch.cover !== undefined) main.cover = patch.cover;
    if (patch.visible !== undefined) main.visible = patch.visible ? 1 : 0;
    if (Object.keys(main).length) await db.update(collections).set(main).where(eq(collections.id, id));
    if (patch.postIds) {
      // 条目整体替换：数组顺序就是章节顺序
      const unique = [...new Set(patch.postIds)];
      await db.delete(items).where(eq(items.collectionId, id));
      if (unique.length) await db.insert(items).values(unique.map((postId, sort) => ({ collectionId: id, postId, sort })));
    }
  });
}

export const deleteCollection = (id: number) => db.delete(collections).where(eq(collections.id, id));

export async function getPublicCollection(locale: string, kind: CollectionKind, slug: string) {
  const row = (await listCollections(locale, { kind, onlyVisible: true })).find((c) => c.slug === slug);
  if (!row) return null;
  const list = await db.select({ postId: items.postId }).from(items).where(eq(items.collectionId, row.id)).orderBy(asc(items.sort));
  return { ...row, postIds: list.map((i) => i.postId) };
}

/** 文章所属的系列（取第一个公开的），以及它在其中的位置 */
export async function getSeriesFor(locale: string, postId: number) {
  const member = await db
    .select({ id: collections.id })
    .from(items)
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(and(eq(items.postId, postId), eq(collections.kind, 'series'), eq(collections.visible, 1)))
    .orderBy(asc(collections.sort))
    .get();
  if (!member) return null;
  const col = (await listCollections(locale, { kind: 'series' })).find((c) => c.id === member.id);
  if (!col) return null;
  const chapters = await db
    .select({ postId: items.postId, slug: pt.slug, title: revisions.title })
    .from(items)
    .innerJoin(posts, and(eq(posts.id, items.postId), isNull(posts.deletedAt)))
    .innerJoin(pt, and(eq(pt.postId, items.postId), eq(pt.locale, locale), eq(pt.status, 'published')))
    .innerJoin(revisions, eq(revisions.id, pt.publishedRevisionId))
    .where(eq(items.collectionId, col.id))
    .orderBy(asc(items.sort));
  const index = chapters.findIndex((c) => c.postId === postId);
  if (index < 0) return null;
  const link = (c: (typeof chapters)[number] | undefined) => (c ? { title: c.title, url: postPath(c.slug) } : null);
  return {
    title: col.title,
    url: col.url,
    position: index + 1,
    total: chapters.length,
    chapters: chapters.map((c, i) => ({ title: c.title, url: postPath(c.slug), current: i === index })),
    prev: link(chapters[index - 1]),
    next: link(chapters[index + 1]),
  };
}

/* ====================== 自定义页面 ====================== */

export const pagePath = (slug: string) => `/${slug}`;

async function assertPageSlug(locale: string, slug: string, excludeId?: number) {
  if (!isValidSlug(slug)) throw badRequest('地址标识只能包含小写字母、数字和连字符');
  if (RESERVED_SLUGS.has(slug)) throw badRequest(`“${slug}”是系统保留字，不能用作页面地址`);
  if ((await listLanguages()).some((l) => l.code.toLowerCase() === slug)) throw badRequest(`“${slug}”是语言的地址前缀，不能用作页面地址`);
  const clash = await db.select({ id: pgT.id }).from(pgT).where(and(eq(pgT.locale, locale), eq(pgT.slug, slug), excludeId ? ne(pgT.id, excludeId) : undefined)).get();
  if (clash) throw badRequest('该地址标识已被其他页面使用');
}

const serializePage = (p: typeof pgT.$inferSelect) => ({
  ...p,
  path: pagePath(p.slug),
  hasPendingChanges: p.status === 'published' && (p.title !== p.publishedTitle || p.markdown !== p.publishedMarkdown),
});

export async function listPages(locale: string) {
  const all = await db.select().from(pgT).orderBy(desc(pgT.updatedAt));
  const pick = pickTranslation(all, (t) => t.pageId, locale);
  const pageIds = [...new Set(all.map((t) => t.pageId))];
  return pageIds.map((pageId) => {
    const t = pick(pageId)!;
    const own = t.locale === locale;
    return {
      pageId,
      // 当前语言没有译文时 id 为 null，标题取自其他语言，供后台提示“创建译文”
      id: own ? t.id : null,
      translated: own,
      sourceLocale: t.locale,
      title: t.title,
      slug: t.slug,
      status: own ? t.status : 'missing',
      updatedAt: t.updatedAt,
      path: pagePath(t.slug),
      hasPendingChanges: own && t.status === 'published' && (t.title !== t.publishedTitle || t.markdown !== t.publishedMarkdown),
    };
  });
}

/** 以其他语言的内容为底，为页面创建当前语言的译文草稿 */
export async function translatePage(pageId: number, locale: string) {
  return transaction(async () => {
    const all = await db.select().from(pgT).where(eq(pgT.pageId, pageId));
    if (!all.length) throw notFound('页面');
    if (all.some((t) => t.locale === locale)) throw badRequest('该语言的译文已存在');
    const source = pickTranslation(all, (t) => t.pageId, locale)(pageId)!;
    let slug = source.slug;
    for (let n = 2; await db.select({ id: pgT.id }).from(pgT).where(and(eq(pgT.locale, locale), eq(pgT.slug, slug))).get(); n++) slug = `${source.slug}-${n}`;
    const row = await db.insert(pgT).values({ pageId, locale, slug, title: source.title, markdown: source.markdown, updatedAt: Date.now() }).returning({ id: pgT.id }).get();
    return row.id;
  });
}

export async function getPage(id: number) {
  const row = await db.select().from(pgT).where(eq(pgT.id, id)).get();
  if (!row) throw notFound('页面');
  return serializePage(row);
}

export async function createPage(locale: string, input: { title: string; slug?: string }) {
  const title = input.title.trim();
  if (!title) throw badRequest('页面标题不能为空');
  return transaction(async () => {
    let slug = input.slug?.trim() || slugify(title) || 'page';
    if (!input.slug?.trim()) {
      // 自动生成的地址：遇到保留字或重名时加后缀
      const base = RESERVED_SLUGS.has(slug) ? `${slug}-page` : slug;
      slug = base;
      for (let n = 2; await db.select({ id: pgT.id }).from(pgT).where(and(eq(pgT.locale, locale), eq(pgT.slug, slug))).get(); n++) slug = `${base}-${n}`;
    }
    await assertPageSlug(locale, slug);
    const now = Date.now();
    const page = await db.insert(pages).values({ createdAt: now }).returning({ id: pages.id }).get();
    const row = await db.insert(pgT).values({ pageId: page.id, locale, slug, title, updatedAt: now }).returning({ id: pgT.id }).get();
    return row.id;
  });
}

export async function savePage(id: number, patch: { title?: string; markdown?: string; slug?: string; seoDescription?: string }) {
  return transaction(async () => {
    const cur = await getPage(id);
    const set: Partial<typeof pgT.$inferInsert> = { updatedAt: Date.now() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.markdown !== undefined) set.markdown = patch.markdown;
    if (patch.seoDescription !== undefined) set.seoDescription = patch.seoDescription;
    if (patch.slug !== undefined && patch.slug !== cur.slug) {
      await assertPageSlug(cur.locale, patch.slug, id);
      set.slug = patch.slug;
      if (cur.publishedAt) await addRedirect(pagePath(cur.slug), pagePath(patch.slug));
    }
    await db.update(pgT).set(set).where(eq(pgT.id, id));
    return getPage(id);
  });
}

export async function publishPage(id: number) {
  const cur = await getPage(id);
  if (!cur.title.trim()) throw badRequest('无法发布：标题不能为空');
  if (!cur.markdown.trim()) throw badRequest('无法发布：正文不能为空');
  await db.update(pgT).set({ status: 'published', publishedTitle: cur.title, publishedMarkdown: cur.markdown, publishedAt: Date.now() }).where(eq(pgT.id, id));
  return getPage(id);
}

export async function unpublishPage(id: number) {
  await getPage(id);
  await db.update(pgT).set({ status: 'draft' }).where(eq(pgT.id, id));
  return getPage(id);
}

export async function deletePage(id: number) {
  const cur = await getPage(id);
  await db.delete(pages).where(eq(pages.id, cur.pageId));
}

export const getPublicPage = (locale: string, slug: string) =>
  db.select().from(pgT).where(and(eq(pgT.locale, locale), eq(pgT.slug, slug), eq(pgT.status, 'published'))).get();

/** 页面在指定语言下的已发布译文（语言切换用） */
export const getPublicPageById = (pageId: number, locale: string) =>
  db.select().from(pgT).where(and(eq(pgT.pageId, pageId), eq(pgT.locale, locale), eq(pgT.status, 'published'))).get();

export const listPublicPages = (locale: string) =>
  db.select({ pageId: pgT.pageId, slug: pgT.slug, publishedAt: pgT.publishedAt }).from(pgT).where(and(eq(pgT.locale, locale), eq(pgT.status, 'published')));

/* ====================== 导航菜单 ====================== */

export type NavMenu = 'header' | 'footer';
export const NAV_TYPES = ['home', 'posts', 'archive', 'projects', 'links', 'category', 'tag', 'collection', 'page', 'post', 'url'] as const;
export type NavType = (typeof NAV_TYPES)[number];

export interface NavInput {
  /** 已有导航项的 id；带上它保存时会原地更新，其他语言的名称得以保留 */
  id?: number;
  type: NavType;
  targetId?: number | null;
  url?: string;
  label?: string;
  newTab?: boolean;
  visible?: boolean;
}

const BUILTIN: Record<string, { url: string; label: string; labelKey: string }> = {
  // labelKey：未自定义名称时，前台用主题语言包里的这一项，随语言变化
  home: { url: '/', label: '首页', labelKey: 'nav_home' },
  posts: { url: '/posts', label: '文章', labelKey: 'nav_posts' },
  archive: { url: '/archive', label: '归档', labelKey: 'archive' },
  projects: { url: '/projects', label: '开源项目', labelKey: 'nav_projects' },
  links: { url: '/links', label: '友链', labelKey: 'nav_links' },
};
const DEFAULT_HEADER: NavInput[] = [{ type: 'home' }, { type: 'posts' }, { type: 'archive' }];

/** 把导航项解析成最终的地址与默认名称；目标不存在或未公开时返回 null */
async function resolveTarget(locale: string, type: string, targetId: number | null, url: string): Promise<{ url: string; label: string } | null> {
  if (BUILTIN[type]) return BUILTIN[type];
  if (type === 'url') return /^(https?:\/\/|\/|mailto:)/i.test(url) ? { url, label: url } : null;
  if (targetId == null) return null;
  if (type === 'category') {
    const node = (await getTree(locale)).byId.get(targetId);
    return node ? { url: node.url, label: node.name } : null;
  }
  if (type === 'tag') {
    const tag = (await listTags(locale)).find((t) => t.id === targetId);
    return tag ? { url: tag.url, label: tag.name } : null;
  }
  if (type === 'collection') {
    const col = (await listCollections(locale, { onlyVisible: true })).find((c) => c.id === targetId);
    return col ? { url: col.url, label: col.title } : null;
  }
  if (type === 'page') {
    // targetId 是页面主体 id：各语言各自解析到自己的译文，没有已发布译文就不显示
    const page = await db.select().from(pgT).where(and(eq(pgT.pageId, targetId), eq(pgT.locale, locale), eq(pgT.status, 'published'))).get();
    return page ? { url: pagePath(page.slug), label: page.publishedTitle } : null;
  }
  if (type === 'post') {
    const post = await db
      .select({ slug: pt.slug, title: revisions.title })
      .from(pt)
      .innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt)))
      .innerJoin(revisions, eq(revisions.id, pt.publishedRevisionId))
      .where(and(eq(pt.postId, targetId), eq(pt.locale, locale), inArray(pt.status, ['published', 'archived'])))
      .get();
    return post ? { url: postPath(post.slug), label: post.title } : null;
  }
  return null;
}

/** 后台编辑用：原样返回菜单项，并标出目标是否仍然有效 */
export async function getMenuForEdit(locale: string, menu: NavMenu) {
  const rows = await db
    .select({ item: navItems, label: navT.label })
    .from(navItems)
    .leftJoin(navT, and(eq(navT.navItemId, navItems.id), eq(navT.locale, locale)))
    .where(eq(navItems.menu, menu))
    .orderBy(asc(navItems.sort), asc(navItems.id));
  const out = [];
  for (const { item, label } of rows) {
    const resolved = await resolveTarget(locale, item.type, item.targetId, item.url);
    out.push({ id: item.id, type: item.type as NavType, targetId: item.targetId, url: item.url, label: label ?? '', newTab: !!item.newTab, visible: !!item.visible, resolvedUrl: resolved?.url ?? null, defaultLabel: resolved?.label ?? '' });
  }
  return out;
}

/** 整体替换一个菜单：数组顺序就是显示顺序 */
export async function saveMenu(locale: string, menu: NavMenu, list: NavInput[]) {
  for (const item of list) {
    if (!NAV_TYPES.includes(item.type)) throw badRequest('不支持的导航类型');
    if (item.type === 'url' && !/^(https?:\/\/|\/|mailto:)/i.test(item.url ?? '')) throw badRequest('自定义链接需以 http://、https://、/ 或 mailto: 开头');
    if (!BUILTIN[item.type] && item.type !== 'url' && item.targetId == null) throw badRequest('导航项缺少指向的内容');
  }
  await transaction(async () => {
    const existing = new Set((await db.select({ id: navItems.id }).from(navItems).where(eq(navItems.menu, menu))).map((r) => r.id));
    const kept = new Set(list.map((i) => i.id).filter((id): id is number => id != null && existing.has(id)));
    for (const id of existing) if (!kept.has(id)) await db.delete(navItems).where(eq(navItems.id, id));
    for (const [sort, item] of list.entries()) {
      const values = { menu, sort, type: item.type, targetId: item.targetId ?? null, url: item.type === 'url' ? (item.url ?? '') : '', newTab: item.newTab ? 1 : 0, visible: item.visible === false ? 0 : 1 };
      let id = item.id != null && kept.has(item.id) ? item.id : null;
      if (id) await db.update(navItems).set(values).where(eq(navItems.id, id));
      else id = (await db.insert(navItems).values(values).returning({ id: navItems.id }).get()).id;
      // 只改当前语言的显示名称
      const label = item.label?.trim() ?? '';
      if (label) await db.insert(navT).values({ navItemId: id, locale, label }).onConflictDoUpdate({ target: [navT.navItemId, navT.locale], set: { label } });
      else await db.delete(navT).where(and(eq(navT.navItemId, id), eq(navT.locale, locale)));
    }
  });
}

/** 前台用：解析好的菜单。顶部菜单未配置时使用默认项 */
export async function getPublicMenu(locale: string, menu: NavMenu) {
  let list: { type: string; targetId: number | null; url: string; label: string; newTab: boolean; visible: boolean }[] = await getMenuForEdit(locale, menu);
  const builtinLabel = (type: string) => BUILTIN[type]?.labelKey;
  if (!list.length && menu === 'header') list = DEFAULT_HEADER.map((i) => ({ type: i.type, targetId: null, url: '', label: '', newTab: false, visible: true }));
  const out: { label: string; label_key: string; url: string; new_tab: boolean; external: boolean }[] = [];
  for (const item of list) {
    if (!item.visible) continue;
    const resolved = await resolveTarget(locale, item.type, item.targetId, item.url);
    if (!resolved) continue; // 指向的内容已删除或未公开：不显示，而不是给访客一个坏链接
    out.push({ label_key: item.label ? '' : (builtinLabel(item.type) ?? ''), label: item.label || resolved.label, url: resolved.url, new_tab: item.newTab, external: /^https?:\/\//i.test(resolved.url) });
  }
  return out;
}
