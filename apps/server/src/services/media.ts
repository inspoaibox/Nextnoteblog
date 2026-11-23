import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { desc, eq, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';

const { media, revisions, postTranslations: pt } = schema;

/** 以文件内容探测到的真实格式为准，不相信扩展名和浏览器上报的类型 */
const ALLOWED: Record<string, { ext: string; mime: string }> = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  webp: { ext: 'webp', mime: 'image/webp' },
  gif: { ext: 'gif', mime: 'image/gif' },
  avif: { ext: 'avif', mime: 'image/avif' },
  heif: { ext: 'avif', mime: 'image/avif' },
};

export const mediaUrl = (relPath: string) => `/uploads/${relPath}`;
const serialize = (m: typeof media.$inferSelect) => ({ ...m, url: mediaUrl(m.path) });

export async function saveImage(input: { buffer: Buffer; originalName: string; preferredName?: string; uploaderId: number }) {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(input.buffer, { animated: true }).metadata();
  } catch {
    throw badRequest('无法识别的图片文件');
  }
  const kind = meta.format ? ALLOWED[meta.format] : undefined;
  if (!kind) throw badRequest(`不支持的图片格式：${meta.format ?? '未知'}（支持 JPG、PNG、WebP、GIF、AVIF）`);

  let buffer = input.buffer;
  let width = meta.width ?? null;
  let height = meta.pageHeight ?? meta.height ?? null;
  if (meta.format === 'jpeg') {
    // 重新编码以清除 EXIF（含 GPS 定位）；先按 EXIF 方向摆正
    const out = await sharp(input.buffer).rotate().jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    buffer = out.data;
    width = out.info.width;
    height = out.info.height;
  }

  const hash = createHash('sha256').update(buffer).digest('hex');
  const existing = await db.select().from(media).where(eq(media.hash, hash)).get();
  if (existing) return { ...serialize(existing), duplicate: true };

  const now = new Date();
  const dir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const base = slugify(input.preferredName || path.parse(input.originalName).name, 60) || 'image';
  const relPath = `${dir}/${base}-${hash.slice(0, 8)}.${kind.ext}`;
  const absPath = path.join(config.uploadsDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, buffer);

  const row = await db
    .insert(media)
    .values({ path: relPath, originalName: input.originalName.slice(0, 200), mime: kind.mime, size: buffer.length, width, height, hash, uploaderId: input.uploaderId, createdAt: now.getTime() })
    .returning()
    .get();
  return { ...serialize(row), duplicate: false };
}

/** 当前所有“活着的”内容文本：文章的线上版与草稿、页面、专题封面。用来判断图片是否仍被引用 */
async function referencedText(): Promise<string> {
  const revs = await db
    .select({ markdown: revisions.markdown, cover: revisions.cover })
    .from(pt)
    .innerJoin(revisions, or(eq(revisions.id, pt.draftRevisionId), eq(revisions.id, pt.publishedRevisionId)));
  const pages = await db.select({ a: schema.pageTranslations.markdown, b: schema.pageTranslations.publishedMarkdown }).from(schema.pageTranslations);
  const cols = await db.select({ cover: schema.collections.cover }).from(schema.collections);
  return [...revs.flatMap((r) => [r.markdown, r.cover]), ...pages.flatMap((p) => [p.a, p.b]), ...cols.map((c) => c.cover)].join('\n');
}

export async function listMedia(opts: { q?: string; page: number; pageSize: number; unused?: boolean }) {
  if (opts.unused) {
    // 未引用资源：全量扫描后在内存里分页（个人博客的媒体数量级足够小）
    const text = await referencedText();
    const all = (await db.select().from(media).orderBy(desc(media.id))).filter((m) => !text.includes(mediaUrl(m.path)));
    const start = (opts.page - 1) * opts.pageSize;
    return { total: all.length, page: opts.page, pageSize: opts.pageSize, items: all.slice(start, start + opts.pageSize).map((m) => ({ ...serialize(m), used: false })) };
  }
  const where = opts.q?.trim() ? or(like(media.originalName, `%${opts.q.trim()}%`), like(media.path, `%${opts.q.trim()}%`), like(media.alt, `%${opts.q.trim()}%`)) : undefined;
  const total = (await db.select({ n: sql<number>`count(*)` }).from(media).where(where).get())!.n;
  const rows = await db.select().from(media).where(where).orderBy(desc(media.id)).limit(opts.pageSize).offset((opts.page - 1) * opts.pageSize);
  const text = await referencedText();
  return { total, page: opts.page, pageSize: opts.pageSize, items: rows.map((m) => ({ ...serialize(m), used: text.includes(mediaUrl(m.path)) })) };
}

async function getMedia(id: number) {
  const row = await db.select().from(media).where(eq(media.id, id)).get();
  if (!row) throw notFound('文件');
  return row;
}

export async function updateMedia(id: number, patch: { alt?: string; caption?: string }) {
  await getMedia(id);
  await db.update(media).set(patch).where(eq(media.id, id));
  return serialize(await getMedia(id));
}

/** 哪些文章的线上版或草稿引用了该文件（正文或封面） */
export async function findUsages(id: number) {
  const m = await getMedia(id);
  const url = mediaUrl(m.path);
  const rows = await db
    .select({ id: pt.id, title: revisions.title, slug: pt.slug, isPublished: sql<number>`${revisions.id} = ${pt.publishedRevisionId}` })
    .from(pt)
    .innerJoin(revisions, or(eq(revisions.id, pt.draftRevisionId), eq(revisions.id, pt.publishedRevisionId)))
    .where(or(like(revisions.markdown, `%${url}%`), eq(revisions.cover, url)));
  const byPost = new Map<number, { id: number; title: string; slug: string; inPublished: boolean }>();
  for (const r of rows) {
    const cur = byPost.get(r.id) ?? { id: r.id, title: r.title, slug: r.slug, inPublished: false };
    cur.inPublished ||= !!r.isPublished;
    byPost.set(r.id, cur);
  }
  return [...byPost.values()];
}

export async function deleteMedia(id: number) {
  const m = await getMedia(id);
  await db.delete(media).where(eq(media.id, id));
  await fs.rm(path.join(config.uploadsDir, m.path), { force: true });
}
