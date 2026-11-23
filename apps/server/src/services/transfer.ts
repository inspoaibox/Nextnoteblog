/**
 * Markdown 导入与内容导出。
 * 导入：读取 Front Matter、检查冲突与相对路径，确认后才写入；正文原样保存。
 * 导出：正文与保存时完全一致，Front Matter 里不认识的字段原样带回。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest } from '../lib/errors.ts';
import { buildFrontMatter, joinFrontMatter, parseFrontMatter, splitFrontMatter, toStringList, toTimestamp } from '../lib/frontmatter.ts';
import { isValidSlug, slugify } from '../lib/slug.ts';
import * as postsSvc from './posts.ts';
import * as tax from './taxonomy.ts';
import * as org from './organize.ts';
import * as mediaSvc from './media.ts';
import * as i18n from './i18n.ts';
import { getSettings } from './settings.ts';

const { posts, postTranslations: pt, revisions } = schema;

const MD_EXT = /\.(md|markdown|txt)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
const MAX_FILES = 500;
const MAX_TOTAL = 80 * 1024 * 1024;

export interface IncomingFile {
  name: string;
  data: Buffer;
}
export interface ImportOptions {
  /** 地址标识已存在时：跳过、自动改名另存，或把内容存为已有文章的新草稿 */
  onConflict: 'skip' | 'rename' | 'overwrite';
  /** 导入后是否直接发布（Front Matter 里 draft: true 的文章始终保持草稿） */
  publish: boolean;
  createCategories: boolean;
  locale: string;
  userId: number;
}

interface Parsed {
  file: string;
  title: string;
  slug: string;
  locale: string;
  date: number | null;
  updated: number | null;
  excerpt: string;
  subtitle: string;
  cover: string;
  tags: string[];
  categories: string[];
  draft: boolean;
  frontMatter: string;
  unknownKeys: string[];
  body: string;
  errors: string[];
  warnings: string[];
  /** 正文里的相对路径图片：能在压缩包里找到的会随文章一起导入 */
  images: { ref: string; found: boolean }[];
  conflict: { type: 'slug'; id: number; title: string; status: string } | null;
  duplicateOf: { id: number; title: string } | null;
}

const KNOWN_KEYS = new Set(['title', 'slug', 'date', 'updated', 'lastmod', 'excerpt', 'description', 'summary', 'subtitle', 'cover', 'image', 'thumbnail', 'tags', 'tag', 'categories', 'category', 'draft', 'lang', 'locale']);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** 展开上传的文件：.zip 解开，其余原样。返回 相对路径 → 内容 */
function expand(files: IncomingFile[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let total = 0;
  const add = (name: string, data: Buffer) => {
    const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean || clean.split('/').some((s) => s === '..') || clean.startsWith('__MACOSX/') || clean.endsWith('.DS_Store')) return;
    total += data.length;
    if (out.size >= MAX_FILES || total > MAX_TOTAL) throw badRequest(`一次最多导入 ${MAX_FILES} 个文件、共 ${MAX_TOTAL / 1024 / 1024}MB`);
    out.set(clean, data);
  };
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(new Uint8Array(file.data), { filter: (f) => !f.name.endsWith('/') && (MD_EXT.test(f.name) || IMG_EXT.test(f.name)) });
      } catch {
        throw badRequest(`“${file.name}”不是有效的 ZIP 文件`);
      }
      for (const [name, data] of Object.entries(entries)) add(name, Buffer.from(data));
    } else add(file.name, file.data);
  }
  return out;
}

/** 正文里的相对路径引用（图片与链接） */
function relativeRefs(body: string) {
  const images: string[] = [];
  const links: string[] = [];
  const withoutCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of withoutCode.matchAll(/(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const target = m[2];
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) continue; // 绝对地址、站内绝对路径、锚点
    (m[1] ? images : links).push(target);
  }
  return { images: [...new Set(images)], links: [...new Set(links)] };
}

const resolveRef = (mdFile: string, ref: string) => path.posix.normalize(path.posix.join(path.posix.dirname(mdFile), decodeURI(ref.split(/[?#]/)[0])));

async function parseOne(name: string, data: Buffer, all: Map<string, Buffer>, defaultLocale: string, locales: string[]): Promise<Parsed> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = data.toString('utf8');
  if (text.includes('�')) warnings.push('文件不是 UTF-8 编码，部分字符可能显示为乱码，建议先转成 UTF-8 再导入');
  const { raw, body } = splitFrontMatter(text);
  const fm = parseFrontMatter(raw);
  if (fm.error) errors.push(`Front Matter 解析失败：${fm.error}`);
  const d = fm.data;

  const base = path.posix.basename(name).replace(MD_EXT, '');
  // 常见的 2024-01-02-标题.md 命名：前面的日期可以当发布日期用
  const dated = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(base);
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const title = str(d.title) || heading || (dated ? dated[2] : base);
  let slug = str(d.slug) || slugify(dated ? dated[2] : base) || slugify(title);
  if (str(d.slug) && !isValidSlug(slug)) {
    warnings.push(`Front Matter 里的 slug “${slug}”不符合规则，已改为“${slugify(slug) || slugify(title)}”`);
    slug = slugify(slug) || slugify(title);
  }
  if (!title) errors.push('无法确定标题：Front Matter 没有 title，正文也没有一级标题');
  if (!body.trim()) errors.push('正文为空');

  const wantedLocale = str(d.lang) || str(d.locale);
  const locale = locales.find((l) => l.toLowerCase() === wantedLocale.toLowerCase()) ?? defaultLocale;
  if (wantedLocale && locale !== wantedLocale && !locales.some((l) => l.toLowerCase() === wantedLocale.toLowerCase())) warnings.push(`语言“${wantedLocale}”尚未在后台登记，将按当前内容语言导入`);

  const refs = relativeRefs(body);
  const images = refs.images.map((ref) => ({ ref, found: all.has(resolveRef(name, ref)) }));
  const missing = images.filter((i) => !i.found);
  if (missing.length) warnings.push(`${missing.length} 张相对路径的图片没有一起上传，导入后将无法显示：${missing.slice(0, 3).map((i) => i.ref).join('、')}${missing.length > 3 ? ' 等' : ''}`);
  if (refs.links.length) warnings.push(`正文有 ${refs.links.length} 个相对路径链接（如 ${refs.links[0]}），导入后需要手动改成站内地址`);
  const cover = str(d.cover) || str(d.image) || str(d.thumbnail);
  if (cover && !/^([a-z]+:|\/)/i.test(cover) && !all.has(resolveRef(name, cover))) warnings.push(`封面图“${cover}”是相对路径且没有一起上传`);

  const existing = slug
    ? await db
        .select({ id: pt.id, status: pt.status, title: revisions.title })
        .from(pt)
        .innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt)))
        .innerJoin(revisions, eq(revisions.id, pt.draftRevisionId))
        .where(and(eq(pt.locale, locale), eq(pt.slug, slug)))
        .get()
    : undefined;
  const same = await db
    .select({ id: pt.id, title: revisions.title })
    .from(pt)
    .innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt)))
    .innerJoin(revisions, eq(revisions.id, pt.draftRevisionId))
    .where(and(eq(pt.locale, locale), sql`${revisions.markdown} = ${body}`))
    .get();
  if (!existing && !same && title) {
    const sameTitle = await db.select({ id: pt.id }).from(pt).innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt))).innerJoin(revisions, eq(revisions.id, pt.draftRevisionId)).where(and(eq(pt.locale, locale), eq(revisions.title, title))).get();
    if (sameTitle) warnings.push('已有一篇标题相同的文章');
  }

  return {
    file: name,
    title,
    slug,
    locale,
    date: toTimestamp(d.date) ?? (dated ? toTimestamp(dated[1]) : null),
    updated: toTimestamp(d.updated) ?? toTimestamp(d.lastmod),
    excerpt: str(d.excerpt) || str(d.description) || str(d.summary),
    subtitle: str(d.subtitle),
    cover,
    tags: [...toStringList(d.tags), ...toStringList(d.tag)],
    categories: [...toStringList(d.categories), ...toStringList(d.category)],
    draft: d.draft === true,
    frontMatter: raw ?? '',
    unknownKeys: Object.keys(d).filter((k) => !KNOWN_KEYS.has(k)),
    body,
    errors,
    warnings,
    images,
    conflict: existing ? { type: 'slug', id: existing.id, title: existing.title, status: existing.status } : null,
    duplicateOf: same ? { id: same.id, title: same.title } : null,
  };
}

async function parseAll(files: IncomingFile[], locale: string) {
  const all = expand(files);
  const locales = (await i18n.listLanguages()).map((l) => l.code);
  const docs: Parsed[] = [];
  for (const [name, data] of all) if (MD_EXT.test(name)) docs.push(await parseOne(name, data, all, locale, locales));
  // 同一批文件之间的地址冲突
  const seen = new Map<string, string>();
  for (const doc of docs) {
    const key = `${doc.locale}:${doc.slug}`;
    if (seen.has(key)) doc.errors.push(`与同一批里的“${seen.get(key)}”地址标识相同（${doc.slug}）`);
    else seen.set(key, doc.file);
  }
  return { all, docs };
}

/** 导入预检：只读，不写入任何内容 */
export async function inspectImport(files: IncomingFile[], locale: string) {
  const { all, docs } = await parseAll(files, locale);
  return {
    total: docs.length,
    ready: docs.filter((d) => !d.errors.length && !d.conflict).length,
    conflicts: docs.filter((d) => d.conflict).length,
    failed: docs.filter((d) => d.errors.length).length,
    imageFiles: [...all.keys()].filter((n) => IMG_EXT.test(n)).length,
    items: docs.map(({ body, frontMatter, ...rest }) => ({ ...rest, chars: body.length, hasFrontMatter: !!frontMatter })),
  };
}

/** 按“开发/后端”这样的名称路径找到分类，必要时逐级创建 */
async function categoryByPath(locale: string, name: string, create: boolean): Promise<number | null> {
  const parts = name.split(/\s*[/>]\s*/).map((p) => p.trim()).filter(Boolean);
  let parentId: number | null = null;
  for (const part of parts) {
    const tree = await tax.getTree(locale);
    const siblings: tax.CategoryNode[] = parentId == null ? tree.roots : (tree.byId.get(parentId)?.children ?? []);
    const hit = siblings.find((c) => c.name.toLowerCase() === part.toLowerCase());
    if (hit) parentId = hit.id;
    else if (create) parentId = await tax.createCategory(locale, { name: part, parentId });
    else return null;
  }
  return parentId;
}

export async function runImport(files: IncomingFile[], opts: ImportOptions) {
  const { all, docs } = await parseAll(files, opts.locale);
  const results: { file: string; status: 'created' | 'updated' | 'skipped' | 'failed'; id?: number; slug?: string; message?: string }[] = [];

  for (const doc of docs) {
    if (doc.errors.length) {
      results.push({ file: doc.file, status: 'failed', message: doc.errors.join('；') });
      continue;
    }
    if (doc.conflict && opts.onConflict === 'skip') {
      results.push({ file: doc.file, status: 'skipped', message: `地址标识“${doc.slug}”已存在` });
      continue;
    }
    try {
      // 压缩包里能找到的相对路径图片：存进媒体库，并把正文里的引用改成站内地址
      let body = doc.body;
      for (const image of doc.images.filter((i) => i.found)) {
        const saved = await mediaSvc.saveImage({ buffer: all.get(resolveRef(doc.file, image.ref))!, originalName: path.posix.basename(image.ref), uploaderId: opts.userId });
        body = body.split(`](${image.ref}`).join(`](${saved.url}`).split(`](<${image.ref}>`).join(`](${saved.url}`);
      }
      let cover = doc.cover;
      if (cover && !/^([a-z]+:|\/)/i.test(cover)) {
        const data = all.get(resolveRef(doc.file, cover));
        cover = data ? (await mediaSvc.saveImage({ buffer: data, originalName: path.posix.basename(cover), uploaderId: opts.userId })).url : '';
      }

      const overwrite = doc.conflict && opts.onConflict === 'overwrite';
      let tid: number;
      if (overwrite) tid = doc.conflict!.id;
      else {
        const created = await postsSvc.createPost({ title: doc.title, locale: doc.locale, authorId: opts.userId });
        tid = created.id;
        const slug = await postsSvc.uniqueSlug(doc.slug, doc.locale, tid);
        await postsSvc.updateMeta(tid, { slug });
      }
      const current = await postsSvc.getForEdit(tid);
      await postsSvc.saveDraft(
        tid,
        { title: doc.title, subtitle: doc.subtitle, excerpt: doc.excerpt, cover, markdown: body, frontMatter: doc.frontMatter, meta: overwrite ? current.draft.meta : {} },
        { baseVersion: current.translation.lockVersion, mode: 'manual', note: `导入自 ${path.posix.basename(doc.file)}`, userId: opts.userId },
      );

      const postId = current.translation.postId;
      const categoryIds: number[] = [];
      for (const name of doc.categories) {
        const id = await categoryByPath(doc.locale, name, opts.createCategories);
        if (id != null && !categoryIds.includes(id)) categoryIds.push(id);
      }
      if (categoryIds.length || !overwrite) await tax.setPostCategories(doc.locale, postId, categoryIds[0] ?? null, categoryIds.slice(1));
      if (doc.tags.length || !overwrite) await tax.setPostTags(doc.locale, postId, doc.tags);

      if (opts.publish && !doc.draft && !overwrite) {
        await postsSvc.publish(tid, { userId: opts.userId });
        if (doc.date || doc.updated) await postsSvc.setPublishDates(tid, { firstPublishedAt: doc.date, contentUpdatedAt: doc.updated ?? doc.date });
      }
      const slug = (await postsSvc.getForEdit(tid)).translation.slug;
      results.push({ file: doc.file, status: overwrite ? 'updated' : 'created', id: tid, slug, message: overwrite ? '已存为这篇文章的新草稿，线上内容未变' : slug !== doc.slug ? `地址标识已存在，改用“${slug}”` : undefined });
    } catch (err) {
      results.push({ file: doc.file, status: 'failed', message: (err as Error).message });
    }
  }
  tax.invalidateTaxonomy();
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return { created: count('created'), updated: count('updated'), skipped: count('skipped'), failed: count('failed'), results };
}

/* ====================== 导出 ====================== */

/** 一篇文章的 .md 文件内容：Front Matter + 保存时的正文原文 */
export async function exportPostMarkdown(tid: number, source: 'draft' | 'published' = 'draft'): Promise<{ filename: string; content: string }> {
  const edit = await postsSvc.getForEdit(tid);
  const t = edit.translation;
  const rev = source === 'published' && t.publishedRevisionId ? await postsSvc.getRevision(tid, t.publishedRevisionId) : edit.draft;
  const taxonomy = await tax.getPostTaxonomy(t.locale, t.postId);
  const tree = await tax.getTree(t.locale);
  const pathName = (id: number) => tree.byId.get(id)?.trail.map((x) => x.name).join('/');
  const categories = [taxonomy.primaryCategoryId, ...taxonomy.categoryIds].map((id) => (id != null ? pathName(id) : undefined)).filter((x): x is string => !!x);
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : undefined);
  const yaml = buildFrontMatter(rev.frontMatter, {
    title: rev.title,
    slug: t.slug,
    date: iso(t.firstPublishedAt),
    updated: iso(t.contentUpdatedAt),
    subtitle: rev.subtitle || undefined,
    excerpt: rev.excerpt || undefined,
    cover: rev.cover || undefined,
    categories: categories.length ? categories : undefined,
    tags: taxonomy.tags.length ? taxonomy.tags : undefined,
    lang: t.locale,
    // 只有未公开的文章才标记 draft，已发布的把这个键去掉
    draft: t.status === 'published' || t.status === 'archived' ? null : true,
  });
  return { filename: `${t.slug}.md`, content: joinFrontMatter(yaml, rev.markdown) };
}

export interface ExportOptions {
  /** 只导出某个分类（含下级）下的文章；不传则导出全站 */
  categoryId?: number;
  locale: string;
  includeMedia: boolean;
}

/** 全站或按分类导出为 ZIP：文章与页面是 .md，结构数据是 JSON，可选带上全部媒体文件 */
export async function exportSite(opts: ExportOptions): Promise<{ filename: string; data: Buffer }> {
  const files: Record<string, Uint8Array> = {};
  const json = (name: string, value: unknown) => (files[name] = strToU8(JSON.stringify(value, null, 2)));
  const languages = await i18n.listLanguages();
  let postIds: Set<number> | null = null;
  if (opts.categoryId) {
    const node = (await tax.getTree(opts.locale)).byId.get(opts.categoryId);
    if (!node) throw badRequest('分类不存在');
    const ids = tax.descendantIds(node);
    const rows = await db.select({ postId: schema.postCategories.postId, categoryId: schema.postCategories.categoryId }).from(schema.postCategories);
    postIds = new Set(rows.filter((r) => ids.includes(r.categoryId)).map((r) => r.postId));
  }

  const all = await db.select({ id: pt.id, postId: pt.postId, locale: pt.locale, slug: pt.slug, status: pt.status }).from(pt).innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt)));
  const index: unknown[] = [];
  for (const row of all) {
    if (postIds && !postIds.has(row.postId)) continue;
    const { content } = await exportPostMarkdown(row.id);
    const file = `posts/${row.locale}/${row.slug}.md`;
    files[file] = strToU8(content);
    index.push({ file, postId: row.postId, locale: row.locale, slug: row.slug, status: row.status });
  }
  json('posts/index.json', index);

  if (!opts.categoryId) {
    for (const lang of languages) {
      const pages = await db.select().from(schema.pageTranslations).where(eq(schema.pageTranslations.locale, lang.code));
      for (const p of pages) files[`pages/${lang.code}/${p.slug}.md`] = strToU8(joinFrontMatter(buildFrontMatter('', { title: p.title, slug: p.slug, lang: lang.code, draft: p.status === 'published' ? null : true, description: p.seoDescription || undefined }), p.markdown));
      const flat = (nodes: tax.CategoryNode[]): unknown[] => nodes.map((n) => ({ id: n.id, name: n.name, slug: n.slug, description: n.description, visible: n.visible, translated: n.translated, children: flat(n.children) }));
      json(`data/${lang.code}/categories.json`, flat((await tax.getTree(lang.code)).roots));
      json(`data/${lang.code}/tags.json`, (await tax.listTags(lang.code)).map((t) => ({ id: t.id, name: t.name, slug: t.slug, description: t.description })));
      const collections = [];
      for (const c of await org.listCollections(lang.code)) collections.push(await org.getCollection(lang.code, c.id));
      json(`data/${lang.code}/collections.json`, collections);
      json(`data/${lang.code}/nav.json`, { header: await org.getMenuForEdit(lang.code, 'header'), footer: await org.getMenuForEdit(lang.code, 'footer') });
      json(`data/${lang.code}/site-texts.json`, await i18n.getSiteTexts(lang.code));
    }
    const { activeTheme: _a, previousTheme: _p, ...settings } = await getSettings();
    json('data/settings.json', settings);
    json('data/languages.json', languages);
    json('data/redirects.json', await db.select({ from: schema.redirects.fromPath, to: schema.redirects.toPath }).from(schema.redirects));
  }

  const mediaRows = await db.select().from(schema.media);
  json('media/manifest.json', mediaRows.map((m) => ({ file: `media/files/${m.path}`, url: mediaSvc.mediaUrl(m.path), originalName: m.originalName, alt: m.alt, caption: m.caption, mime: m.mime, size: m.size, width: m.width, height: m.height })));
  if (opts.includeMedia) {
    for (const m of mediaRows) {
      const abs = path.join(config.uploadsDir, m.path);
      if (fs.existsSync(abs)) files[`media/files/${m.path}`] = new Uint8Array(fs.readFileSync(abs));
    }
  }
  files['README.txt'] = strToU8(
    ['这是博客内容的导出包。', '', 'posts/{语言}/{地址}.md    文章，Front Matter 里带有标题、日期、分类、标签等', 'pages/{语言}/{地址}.md    自定义页面', 'data/                    分类树、标签、专题系列、导航、站点设置、重定向（JSON）', 'media/manifest.json      媒体文件清单与替代文字', opts.includeMedia ? 'media/files/             媒体文件，正文里的 /uploads/… 对应这里的同名路径' : '（本次导出未包含媒体文件）', '', `导出时间：${new Date().toISOString()}`].join('\n'),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return { filename: `blog-export-${opts.categoryId ? `category-${opts.categoryId}-` : ''}${stamp}.zip`, data: Buffer.from(zipSync(files, { level: 6 })) };
}

export { hashOf };
