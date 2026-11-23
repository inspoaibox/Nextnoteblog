/**
 * 文章、修订与发布状态机。
 *
 * 每个语言版本有两个指针：
 *   publishedRevisionId —— 前台只读它
 *   draftRevisionId     —— 编辑只推进它
 * 发布 = 把线上指针移到草稿修订；回退 = 把线上指针移回上一次发布的修订；
 * 恢复旧版本 = 用旧内容生成新的草稿修订，不触碰线上。
 */
import { and, desc, eq, inArray, isNotNull, isNull, like, ne, or, sql, gt, lt, asc } from 'drizzle-orm';
import { db, schema, transaction } from '../db/index.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import { isValidSlug, RESERVED_SLUGS, slugify } from '../lib/slug.ts';

const { posts, postTranslations: pt, revisions, publishLog, redirects } = schema;

export type PostStatus = 'draft' | 'scheduled' | 'published' | 'unpublished' | 'archived';
/** 前台可以访问到的状态 */
export const PUBLIC_STATUSES: PostStatus[] = ['published', 'archived'];

export interface DraftInput {
  title: string;
  subtitle: string;
  excerpt: string;
  cover: string;
  markdown: string;
  frontMatter: string;
  meta: Record<string, unknown>;
}

export const postPath = (slug: string) => `/posts/${slug}`;
/** 无标题新建时生成的占位地址：post-<时间戳> */
const PLACEHOLDER_SLUG = /^post-[a-z0-9]{6,}$/;

/** 旧地址 → 新地址的 301；同时修正已有的跳转链，避免连环跳转或自己跳自己 */
export async function addRedirect(from: string, to: string) {
  if (!from || !to || from === to) return;
  await db.delete(redirects).where(eq(redirects.fromPath, to));
  await db.update(redirects).set({ toPath: to }).where(eq(redirects.toPath, from));
  await db.insert(redirects).values({ fromPath: from, toPath: to, createdAt: Date.now() }).onConflictDoUpdate({ target: redirects.fromPath, set: { toPath: to } });
}

async function getTranslation(tid: number) {
  const row = await db.select().from(pt).where(eq(pt.id, tid)).get();
  if (!row) throw notFound('文章');
  return row;
}
const getRevisionRow = (id: number | null) => (id ? db.select().from(revisions).where(eq(revisions.id, id)).get() : undefined);

function serializeRevision(rev: typeof revisions.$inferSelect) {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(rev.meta);
  } catch {
    /* 保持空对象 */
  }
  return { ...rev, meta };
}

/** 在指定语言内找一个未占用的 slug */
export async function uniqueSlug(base: string, locale: string, excludeTid?: number): Promise<string> {
  let candidate = base && !RESERVED_SLUGS.has(base) ? base : base ? `${base}-post` : `post-${Date.now().toString(36)}`;
  for (let n = 2; ; n++) {
    const clash = await db
      .select({ id: pt.id })
      .from(pt)
      .where(and(eq(pt.locale, locale), eq(pt.slug, candidate), excludeTid ? ne(pt.id, excludeTid) : undefined))
      .get();
    if (!clash) return candidate;
    candidate = `${base || 'post'}-${n}`;
  }
}

/* ---------- 创建 / 读取 ---------- */

export async function createPost(input: { title?: string; markdown?: string; locale: string; authorId: number }) {
  const now = Date.now();
  const title = input.title?.trim() || '';
  return transaction(async () => {
    const post = await db.insert(posts).values({ authorId: input.authorId, createdAt: now, updatedAt: now }).returning({ id: posts.id }).get();
    const slug = await uniqueSlug(slugify(title), input.locale);
    const t = await db.insert(pt).values({ postId: post.id, locale: input.locale, slug, status: 'draft', createdAt: now, updatedAt: now }).returning({ id: pt.id }).get();
    const rev = await db
      .insert(revisions)
      .values({ translationId: t.id, title, markdown: input.markdown ?? '', kind: 'manual', note: '创建', authorId: input.authorId, createdAt: now, updatedAt: now })
      .returning({ id: revisions.id })
      .get();
    await db.update(pt).set({ draftRevisionId: rev.id }).where(eq(pt.id, t.id));
    return { id: t.id, postId: post.id, slug };
  });
}

export async function getForEdit(tid: number) {
  const t = await getTranslation(tid);
  const post = (await db.select().from(posts).where(eq(posts.id, t.postId)).get())!;
  const draft = (await getRevisionRow(t.draftRevisionId))!;
  const published = t.publishedRevisionId === t.draftRevisionId ? draft : await getRevisionRow(t.publishedRevisionId);
  return {
    translation: t,
    post,
    draft: serializeRevision(draft),
    published: published ? { id: published.id, title: published.title, updatedAt: published.updatedAt } : null,
    hasPendingChanges: !!t.publishedRevisionId && t.publishedRevisionId !== t.draftRevisionId,
    path: postPath(t.slug),
    ...(await translationInfo(t)),
  };
}

/** 同一篇文章的其他语言版本，以及（如果这是译文）原文在翻译之后是否又发布过 */
async function translationInfo(t: typeof pt.$inferSelect) {
  const siblings = await db.select({ id: pt.id, locale: pt.locale, status: pt.status, slug: pt.slug, publishedRevisionId: pt.publishedRevisionId }).from(pt).where(eq(pt.postId, t.postId));
  const source = t.sourceTranslationId ? siblings.find((s) => s.id === t.sourceTranslationId) : undefined;
  return {
    siblings: siblings.map(({ publishedRevisionId: _p, ...rest }) => rest),
    source: source ? { id: source.id, locale: source.locale, stale: !!source.publishedRevisionId && source.publishedRevisionId !== t.sourceRevisionId } : null,
  };
}

/** 复制一个语言版本，创建另一种语言的译文草稿 */
export async function createTranslation(sourceTid: number, locale: string, userId: number) {
  return transaction(async () => {
    const source = await getTranslation(sourceTid);
    if (source.locale === locale) throw badRequest('译文的语言不能与原文相同');
    const exists = await db.select({ id: pt.id }).from(pt).where(and(eq(pt.postId, source.postId), eq(pt.locale, locale))).get();
    if (exists) throw new HttpError(409, '该语言的译文已存在', { id: exists.id });
    const draft = (await getRevisionRow(source.draftRevisionId))!;
    const now = Date.now();
    const slug = await uniqueSlug(source.slug, locale);
    const t = await db
      .insert(pt)
      .values({ postId: source.postId, locale, slug, status: 'draft', sourceTranslationId: source.id, sourceRevisionId: source.publishedRevisionId ?? source.draftRevisionId, createdAt: now, updatedAt: now })
      .returning({ id: pt.id })
      .get();
    const { id: _id, ...content } = draft;
    const rev = await db
      .insert(revisions)
      .values({ ...content, translationId: t.id, kind: 'manual', note: `复制自 ${source.locale} 版本，待翻译`, authorId: userId, createdAt: now, updatedAt: now })
      .returning({ id: revisions.id })
      .get();
    await db.update(pt).set({ draftRevisionId: rev.id }).where(eq(pt.id, t.id));
    return { id: t.id, slug };
  });
}

/** 译者确认译文已跟上原文的最新发布版本 */
export async function markTranslationSynced(tid: number) {
  const t = await getTranslation(tid);
  if (!t.sourceTranslationId) throw badRequest('这不是一篇译文');
  const source = await getTranslation(t.sourceTranslationId);
  await db.update(pt).set({ sourceRevisionId: source.publishedRevisionId ?? source.draftRevisionId }).where(eq(pt.id, tid));
  return getForEdit(tid);
}

/** 一篇文章在各语言的已发布版本，用于前台语言切换与 hreflang */
export function getPublishedLocales(postId: number) {
  return db
    .select({ locale: pt.locale, slug: pt.slug })
    .from(pt)
    .innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt)))
    .where(and(eq(pt.postId, postId), inArray(pt.status, PUBLIC_STATUSES)));
}

/* ---------- 保存草稿 ---------- */

const sameContent = (a: typeof revisions.$inferSelect, b: DraftInput) =>
  a.title === b.title && a.subtitle === b.subtitle && a.excerpt === b.excerpt && a.cover === b.cover && a.markdown === b.markdown && a.frontMatter === b.frontMatter && a.meta === JSON.stringify(b.meta);

export async function saveDraft(tid: number, input: DraftInput, opts: { baseVersion: number; mode: 'auto' | 'manual'; note?: string; force?: boolean; userId: number }) {
  return transaction(async () => {
    const t = await getTranslation(tid);
    if (!opts.force && opts.baseVersion !== t.lockVersion) {
      // 另一个窗口已经保存过：把服务器当前内容交给前端做差异对比
      throw new HttpError(409, '文章已在别处被修改', await getForEdit(tid));
    }
    const draft = (await getRevisionRow(t.draftRevisionId))!;
    const now = Date.now();

    if (sameContent(draft, input)) {
      if (opts.mode === 'manual' && draft.kind === 'auto') {
        await db.update(revisions).set({ kind: 'manual', note: opts.note ?? '' }).where(eq(revisions.id, draft.id));
      }
      return { lockVersion: t.lockVersion, revisionId: draft.id, savedAt: draft.updatedAt, changed: false, slug: t.slug };
    }

    const fields = { ...input, meta: JSON.stringify(input.meta) };
    // 自动保存的修订尚未成为“线上版”或“手动存档”时可以原地覆盖，避免修订爆炸
    const reusable = draft.kind === 'auto' && draft.id !== t.publishedRevisionId;
    let revisionId = draft.id;
    if (reusable) {
      await db
        .update(revisions)
        .set({ ...fields, kind: opts.mode, note: opts.mode === 'manual' ? (opts.note ?? '') : '', updatedAt: now, authorId: opts.userId })
        .where(eq(revisions.id, draft.id));
    } else {
      const rev = await db
        .insert(revisions)
        .values({ ...fields, translationId: tid, kind: opts.mode, note: opts.note ?? '', authorId: opts.userId, createdAt: now, updatedAt: now })
        .returning({ id: revisions.id })
        .get();
      revisionId = rev.id;
    }
    const lockVersion = t.lockVersion + 1;
    // 新建时没有标题，地址只是占位符；在首次发布前，有了标题就换成由标题生成的地址
    let slug = t.slug;
    if (!t.firstPublishedAt && PLACEHOLDER_SLUG.test(t.slug) && input.title.trim()) {
      const fromTitle = slugify(input.title);
      if (fromTitle) slug = await uniqueSlug(fromTitle, t.locale, tid);
    }
    await db.update(pt).set({ draftRevisionId: revisionId, lockVersion, slug, updatedAt: now }).where(eq(pt.id, tid));
    await db.update(posts).set({ updatedAt: now }).where(eq(posts.id, t.postId));
    return { lockVersion, revisionId, savedAt: now, changed: true, slug };
  });
}

/* ---------- 元信息（不进修订、立即生效的部分） ---------- */

export async function updateMeta(tid: number, patch: { slug?: string; pinned?: boolean; featured?: boolean; firstPublishedAt?: number | null }) {
  return transaction(async () => {
    const t = await getTranslation(tid);
    const now = Date.now();
    const set: Partial<typeof pt.$inferInsert> = { updatedAt: now };

    if (patch.slug !== undefined && patch.slug !== t.slug) {
      if (!isValidSlug(patch.slug)) throw badRequest('地址标识只能包含小写字母、数字和连字符');
      if (RESERVED_SLUGS.has(patch.slug)) throw badRequest(`“${patch.slug}”是系统保留字`);
      const clash = await db.select({ id: pt.id }).from(pt).where(and(eq(pt.locale, t.locale), eq(pt.slug, patch.slug), ne(pt.id, tid))).get();
      if (clash) throw badRequest('该地址标识已被其他文章使用');
      set.slug = patch.slug;
      if (t.firstPublishedAt) {
        // 已经公开过的地址：自动留下 301，旧链接不失效
        await addRedirect(postPath(t.slug), postPath(patch.slug));
      }
    }
    if (patch.firstPublishedAt !== undefined && t.firstPublishedAt) set.firstPublishedAt = patch.firstPublishedAt ?? t.firstPublishedAt;
    await db.update(pt).set(set).where(eq(pt.id, tid));

    const postSet: Partial<typeof posts.$inferInsert> = {};
    if (patch.pinned !== undefined) postSet.pinned = patch.pinned ? 1 : 0;
    if (patch.featured !== undefined) postSet.featured = patch.featured ? 1 : 0;
    if (Object.keys(postSet).length) await db.update(posts).set(postSet).where(eq(posts.id, t.postId));
    return getForEdit(tid);
  });
}

/* ---------- 发布状态机 ---------- */

const logPublish = (translationId: number, revisionId: number | null, action: string, userId: number) =>
  db.insert(publishLog).values({ translationId, revisionId, action, userId, createdAt: Date.now() });

async function assertNotTrashed(postId: number) {
  const post = await db.select({ deletedAt: posts.deletedAt }).from(posts).where(eq(posts.id, postId)).get();
  if (post?.deletedAt) throw badRequest('文章在回收站中，请先恢复');
}

/** 发布前检查：返回阻止发布的问题与仅提醒的问题 */
export function publishChecks(draft: { title: string; markdown: string; excerpt: string; cover: string }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!draft.title.trim()) errors.push('标题不能为空');
  if (!draft.markdown.trim()) errors.push('正文不能为空');
  if (!draft.excerpt.trim()) warnings.push('未填写摘要，将自动截取正文开头');
  if (!draft.cover.trim()) warnings.push('未设置封面图');
  return { errors, warnings };
}

export async function publish(tid: number, opts: { minor?: boolean; userId: number }) {
  return transaction(async () => {
    const t = await getTranslation(tid);
    await assertNotTrashed(t.postId);
    const draft = (await getRevisionRow(t.draftRevisionId))!;
    const { errors } = publishChecks(draft);
    if (errors.length) throw badRequest(`无法发布：${errors.join('；')}`, { errors });
    const now = Date.now();
    // 一旦成为线上版，这条修订不再被自动保存覆盖
    if (draft.kind === 'auto') await db.update(revisions).set({ kind: 'publish' }).where(eq(revisions.id, draft.id));
    await db
      .update(pt)
      .set({
        status: 'published',
        publishedRevisionId: draft.id,
        scheduledAt: null,
        firstPublishedAt: t.firstPublishedAt ?? now,
        publishedAt: now,
        // “小修改”不刷新前台显示的更新日期
        contentUpdatedAt: opts.minor && t.contentUpdatedAt ? t.contentUpdatedAt : now,
        updatedAt: now,
      })
      .where(eq(pt.id, tid));
    await logPublish(tid, draft.id, 'publish', opts.userId);
    return getForEdit(tid);
  });
}

export async function setOffline(tid: number, status: 'unpublished' | 'archived', userId: number) {
  return transaction(async () => {
    const t = await getTranslation(tid);
    if (!t.publishedRevisionId) throw badRequest('文章尚未发布');
    await db.update(pt).set({ status, updatedAt: Date.now() }).where(eq(pt.id, tid));
    await logPublish(tid, t.publishedRevisionId, status === 'archived' ? 'archive' : 'unpublish', userId);
    return getForEdit(tid);
  });
}

/** 回退到上一次发布的版本（只动线上指针，草稿不受影响） */
export async function rollback(tid: number, userId: number) {
  return transaction(async () => {
    const t = await getTranslation(tid);
    if (!t.publishedRevisionId) throw badRequest('文章尚未发布');
    const previous = await db
      .select({ revisionId: publishLog.revisionId })
      .from(publishLog)
      .where(and(eq(publishLog.translationId, tid), inArray(publishLog.action, ['publish', 'rollback']), ne(publishLog.revisionId, t.publishedRevisionId)))
      .orderBy(desc(publishLog.id))
      .get();
    if (!previous?.revisionId) throw badRequest('没有更早的发布版本可以回退');
    await db.update(pt).set({ publishedRevisionId: previous.revisionId, status: 'published', publishedAt: Date.now(), updatedAt: Date.now() }).where(eq(pt.id, tid));
    await logPublish(tid, previous.revisionId, 'rollback', userId);
    return getForEdit(tid);
  });
}

/* ---------- 回收站 ---------- */

export async function trash(tid: number) {
  const t = await getTranslation(tid);
  await db.update(posts).set({ deletedAt: Date.now() }).where(eq(posts.id, t.postId));
}
export async function restoreFromTrash(tid: number) {
  const t = await getTranslation(tid);
  await db.update(posts).set({ deletedAt: null }).where(eq(posts.id, t.postId));
}
export async function purge(tid: number) {
  const t = await getTranslation(tid);
  const post = await db.select().from(posts).where(eq(posts.id, t.postId)).get();
  if (!post?.deletedAt) throw badRequest('只能永久删除回收站中的文章');
  await db.delete(posts).where(eq(posts.id, t.postId)); // 级联删除语言版本与修订
}

export async function duplicate(tid: number, userId: number) {
  const { draft, translation } = await getForEdit(tid);
  const created = await createPost({ title: `${draft.title}（副本）`, locale: translation.locale, authorId: userId, markdown: draft.markdown });
  const copy = await getTranslation(created.id);
  await db
    .update(revisions)
    .set({ subtitle: draft.subtitle, excerpt: draft.excerpt, cover: draft.cover, frontMatter: draft.frontMatter, meta: JSON.stringify(draft.meta), note: `复制自 #${tid}` })
    .where(eq(revisions.id, copy.draftRevisionId!));
  return created;
}

/* ---------- 修订历史 ---------- */

export async function listRevisions(tid: number) {
  const t = await getTranslation(tid);
  const rows = await db
    .select({ id: revisions.id, title: revisions.title, kind: revisions.kind, note: revisions.note, createdAt: revisions.createdAt, updatedAt: revisions.updatedAt, author: schema.users.displayName, length: sql<number>`length(${revisions.markdown})` })
    .from(revisions)
    .leftJoin(schema.users, eq(schema.users.id, revisions.authorId))
    .where(eq(revisions.translationId, tid))
    .orderBy(desc(revisions.id));
  return rows.map((r) => ({ ...r, isDraft: r.id === t.draftRevisionId, isPublished: r.id === t.publishedRevisionId }));
}

export async function getRevision(tid: number, rid: number) {
  const rev = await getRevisionRow(rid);
  if (!rev || rev.translationId !== tid) throw notFound('修订');
  return serializeRevision(rev);
}

export async function restoreRevision(tid: number, rid: number, userId: number) {
  return transaction(async () => {
    const t = await getTranslation(tid);
    const old = await getRevisionRow(rid);
    if (!old || old.translationId !== tid) throw notFound('修订');
    const now = Date.now();
    const { id: _id, ...content } = old;
    const rev = await db
      .insert(revisions)
      .values({ ...content, kind: 'restore', note: `恢复自修订 #${rid}`, authorId: userId, createdAt: now, updatedAt: now })
      .returning({ id: revisions.id })
      .get();
    // 只更新草稿指针：恢复旧版后必须再次确认发布，不静默覆盖线上
    await db.update(pt).set({ draftRevisionId: rev.id, lockVersion: t.lockVersion + 1, updatedAt: now }).where(eq(pt.id, tid));
    return getForEdit(tid);
  });
}

/* ---------- 后台列表 ---------- */

export type AdminFilter = 'all' | 'draft' | 'published' | 'pending' | 'unpublished' | 'archived' | 'trash' | 'untranslated';

/** 默认语言里有、但指定语言还没有译文的文章（不含回收站） */
const missingIn = (locale: string, sourceLocale: string) =>
  and(eq(pt.locale, sourceLocale), isNull(posts.deletedAt), sql`not exists (select 1 from post_translations other where other.post_id = ${pt.postId} and other.locale = ${locale})`);

export async function listForAdmin(opts: { filter: AdminFilter; q?: string; page: number; pageSize: number; categoryIds?: number[]; locale: string; sourceLocale?: string }) {
  const untranslated = opts.filter === 'untranslated';
  const conds = untranslated ? [missingIn(opts.locale, opts.sourceLocale ?? opts.locale)] : [opts.filter === 'trash' ? isNotNull(posts.deletedAt) : isNull(posts.deletedAt), eq(pt.locale, opts.locale)];
  if (opts.filter === 'pending') conds.push(isNotNull(pt.publishedRevisionId), ne(pt.publishedRevisionId, pt.draftRevisionId));
  else if (opts.filter !== 'all' && opts.filter !== 'trash' && !untranslated) conds.push(eq(pt.status, opts.filter));
  if (opts.q?.trim()) {
    const pattern = `%${opts.q.trim()}%`;
    conds.push(or(like(revisions.title, pattern), like(pt.slug, pattern))!);
  }
  if (opts.categoryIds) conds.push(inArray(posts.id, db.select({ id: schema.postCategories.postId }).from(schema.postCategories).where(inArray(schema.postCategories.categoryId, opts.categoryIds))));
  const where = and(...conds);
  const base = () => db.select().from(pt).innerJoin(posts, eq(posts.id, pt.postId)).innerJoin(revisions, eq(revisions.id, pt.draftRevisionId));

  const total = (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(pt)
      .innerJoin(posts, eq(posts.id, pt.postId))
      .innerJoin(revisions, eq(revisions.id, pt.draftRevisionId))
      .where(where)
      .get()
  )!.n;
  const rows = await base()
    .where(where)
    .orderBy(desc(pt.updatedAt))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);

  const primary = rows.length
    ? await db
        .select({ postId: schema.postCategories.postId, categoryId: schema.postCategories.categoryId })
        .from(schema.postCategories)
        .where(and(eq(schema.postCategories.isPrimary, 1), inArray(schema.postCategories.postId, rows.map((r) => r.posts.id))))
    : [];
  const primaryByPost = new Map(primary.map((r) => [r.postId, r.categoryId]));
  // 语言覆盖情况：每篇文章已有哪些语言版本
  const coverage = rows.length ? await db.select({ postId: pt.postId, id: pt.id, locale: pt.locale, status: pt.status }).from(pt).where(inArray(pt.postId, rows.map((r) => r.posts.id))) : [];

  return {
    total,
    page: opts.page,
    pageSize: opts.pageSize,
    items: rows.map(({ post_translations: t, posts: p, revisions: r }) => ({
      primaryCategoryId: primaryByPost.get(p.id) ?? null,
      translations: coverage.filter((c) => c.postId === p.id).map(({ postId: _p, ...rest }) => rest),
      id: t.id,
      postId: p.id,
      title: r.title,
      slug: t.slug,
      locale: t.locale,
      status: t.status as PostStatus,
      hasPendingChanges: !!t.publishedRevisionId && t.publishedRevisionId !== t.draftRevisionId,
      pinned: !!p.pinned,
      featured: !!p.featured,
      viewCount: t.viewCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      firstPublishedAt: t.firstPublishedAt,
      deletedAt: p.deletedAt,
      path: postPath(t.slug),
    })),
  };
}

export async function counts(locale: string, sourceLocale?: string) {
  const rows = await db
    .select({ status: pt.status, trashed: sql<number>`${posts.deletedAt} is not null`, pending: sql<number>`${pt.publishedRevisionId} is not null and ${pt.publishedRevisionId} != ${pt.draftRevisionId}`, n: sql<number>`count(*)` })
    .from(pt)
    .innerJoin(posts, eq(posts.id, pt.postId))
    .where(eq(pt.locale, locale))
    .groupBy(pt.status, sql`2`, sql`3`);
  const out: Record<AdminFilter, number> = { all: 0, draft: 0, published: 0, pending: 0, unpublished: 0, archived: 0, trash: 0, untranslated: 0 };
  for (const r of rows) {
    if (r.trashed) {
      out.trash += r.n;
      continue;
    }
    out.all += r.n;
    if (r.status in out) out[r.status as AdminFilter] += r.n;
    if (r.pending) out.pending += r.n;
  }
  if (sourceLocale && sourceLocale !== locale) {
    out.untranslated = (await db.select({ n: sql<number>`count(*)` }).from(pt).innerJoin(posts, eq(posts.id, pt.postId)).where(missingIn(locale, sourceLocale)).get())!.n;
  }
  return out;
}

/* ---------- 前台查询（只读线上指针） ---------- */

const publicSelect = () =>
  db
    .select({
      id: pt.id,
      postId: posts.id,
      slug: pt.slug,
      status: pt.status,
      revisionId: revisions.id,
      title: revisions.title,
      subtitle: revisions.subtitle,
      excerpt: revisions.excerpt,
      cover: revisions.cover,
      markdown: revisions.markdown,
      meta: revisions.meta,
      firstPublishedAt: pt.firstPublishedAt,
      contentUpdatedAt: pt.contentUpdatedAt,
      viewCount: pt.viewCount,
      pinned: posts.pinned,
      featured: posts.featured,
      author: schema.users.displayName,
    })
    .from(pt)
    .innerJoin(posts, eq(posts.id, pt.postId))
    .innerJoin(revisions, eq(revisions.id, pt.publishedRevisionId))
    .leftJoin(schema.users, eq(schema.users.id, posts.authorId));

export type PublicPost = NonNullable<Awaited<ReturnType<typeof getPublicBySlug>>>;

export interface PublicFilter {
  categoryIds?: number[];
  tagId?: number;
}

const listed = (locale: string, filter: PublicFilter = {}) =>
  and(
    eq(pt.locale, locale),
    eq(pt.status, 'published'),
    isNull(posts.deletedAt),
    filter.categoryIds ? inArray(posts.id, db.select({ id: schema.postCategories.postId }).from(schema.postCategories).where(inArray(schema.postCategories.categoryId, filter.categoryIds))) : undefined,
    filter.tagId ? inArray(posts.id, db.select({ id: schema.postTags.postId }).from(schema.postTags).where(eq(schema.postTags.tagId, filter.tagId))) : undefined,
  );

export async function listPublic(locale: string, page: number, pageSize: number, filter: PublicFilter = {}) {
  const total = (await db.select({ n: sql<number>`count(*)` }).from(pt).innerJoin(posts, eq(posts.id, pt.postId)).where(listed(locale, filter)).get())!.n;
  const items = await publicSelect()
    .where(listed(locale, filter))
    .orderBy(desc(posts.pinned), desc(pt.firstPublishedAt), desc(pt.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { total, items };
}

export function listFeatured(locale: string, limit: number) {
  return publicSelect().where(and(listed(locale), eq(posts.featured, 1))).orderBy(desc(pt.firstPublishedAt)).limit(limit);
}

/** 按给定的语言版本 id 取已发布文章，保持传入顺序（搜索结果、专题条目用） */
export async function getPublicByIds(locale: string, tids: number[]) {
  if (!tids.length) return [];
  const rows = await publicSelect().where(and(listed(locale), inArray(pt.id, tids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return tids.map((id) => byId.get(id)).filter((r) => !!r);
}

/** 按文章主体 id 取已发布文章，保持传入顺序 */
export async function getPublicByPostIds(locale: string, postIds: number[]) {
  if (!postIds.length) return [];
  const rows = await publicSelect().where(and(listed(locale), inArray(posts.id, postIds)));
  const byPost = new Map(rows.map((r) => [r.postId, r]));
  return postIds.map((id) => byPost.get(id)).filter((r) => !!r);
}

/** 归档页用的轻量列表：全部已发布文章的标题、地址与日期 */
export function listArchive(locale: string) {
  return db
    .select({ id: pt.id, slug: pt.slug, title: revisions.title, date: pt.firstPublishedAt })
    .from(pt)
    .innerJoin(posts, eq(posts.id, pt.postId))
    .innerJoin(revisions, eq(revisions.id, pt.publishedRevisionId))
    .where(listed(locale))
    .orderBy(desc(pt.firstPublishedAt), desc(pt.id));
}

/** 站点地图用：某语言下全部可公开访问的文章 */
export function listSitemap(locale: string) {
  return db
    .select({ postId: pt.postId, slug: pt.slug, updated: pt.contentUpdatedAt })
    .from(pt)
    .innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt)))
    .where(and(eq(pt.locale, locale), eq(pt.status, 'published')));
}

export function getPublicBySlug(locale: string, slug: string) {
  return publicSelect()
    .where(and(eq(pt.locale, locale), eq(pt.slug, slug), inArray(pt.status, PUBLIC_STATUSES), isNull(posts.deletedAt)))
    .get();
}

/** 相邻文章：按发布日期，prev 更早、next 更新 */
export async function getNeighbors(locale: string, firstPublishedAt: number, id: number) {
  const pick = { id: pt.id, slug: pt.slug, title: revisions.title };
  const q = () => db.select(pick).from(pt).innerJoin(posts, eq(posts.id, pt.postId)).innerJoin(revisions, eq(revisions.id, pt.publishedRevisionId));
  const prev = await q().where(and(listed(locale), ne(pt.id, id), lt(pt.firstPublishedAt, firstPublishedAt))).orderBy(desc(pt.firstPublishedAt)).get();
  const next = await q().where(and(listed(locale), ne(pt.id, id), gt(pt.firstPublishedAt, firstPublishedAt))).orderBy(asc(pt.firstPublishedAt)).get();
  return { prev: prev ?? null, next: next ?? null };
}

/** 管理员预览：读取草稿修订，形状与前台查询一致 */
export async function getDraftAsPublic(tid: number) {
  const { translation: t, post, draft } = await getForEdit(tid);
  const author = post.authorId ? await db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, post.authorId)).get() : null;
  return {
    id: t.id,
    postId: post.id,
    slug: t.slug,
    status: t.status,
    revisionId: draft.id,
    title: draft.title,
    subtitle: draft.subtitle,
    excerpt: draft.excerpt,
    cover: draft.cover,
    markdown: draft.markdown,
    meta: JSON.stringify(draft.meta),
    firstPublishedAt: t.firstPublishedAt ?? Date.now(),
    contentUpdatedAt: t.contentUpdatedAt,
    viewCount: t.viewCount,
    pinned: post.pinned,
    featured: post.featured,
    author: author?.name ?? null,
  };
}

/* ---------- 阅读量：内存累计，定时批量写入 ---------- */

const pendingViews = new Map<number, number>();
export function recordView(tid: number) {
  pendingViews.set(tid, (pendingViews.get(tid) ?? 0) + 1);
}
export async function flushViews() {
  if (!pendingViews.size) return;
  const batch = [...pendingViews];
  pendingViews.clear();
  for (const [tid, n] of batch) await db.update(pt).set({ viewCount: sql`${pt.viewCount} + ${n}` }).where(eq(pt.id, tid));
}

export async function findRedirect(path: string) {
  const row = await db.select({ to: redirects.toPath }).from(redirects).where(eq(redirects.fromPath, path)).get();
  return row?.to ?? null;
}
