/**
 * 站内搜索：SQLite FTS5 + 入库前分词。
 * 中文没有空格，直接交给 FTS5 会把整句当成一个词；这里先用 Intl.Segmenter 切词，
 * 用空格连接后再入库，查询时对关键词做同样的处理。
 * 索引是派生数据，随时可以重建（发布状态变化时增量更新，分类标签变更时整体重建）。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { plainExcerpt } from '@nexemc/markdown';
import { db, schema, sqlite } from '../db/index.ts';

const { posts, postTranslations: pt, revisions, postTags, tagTranslations, postCategories, categoryTranslations, searchTerms } = schema;

sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(title, body, terms, tid UNINDEXED, locale UNINDEXED, tokenize = 'unicode61')`);

const segmenters = new Map<string, Intl.Segmenter>();
function words(text: string, locale: string): string[] {
  let seg = segmenters.get(locale);
  if (!seg) segmenters.set(locale, (seg = new Intl.Segmenter(locale, { granularity: 'word' })));
  const out: string[] = [];
  for (const part of seg.segment(text)) if (part.isWordLike) out.push(part.segment.toLowerCase());
  return out;
}
const segment = (text: string, locale: string) => words(text, locale).join(' ');

const removeStmt = sqlite.prepare('DELETE FROM search_index WHERE tid = ?');
const insertStmt = sqlite.prepare('INSERT INTO search_index (title, body, terms, tid, locale) VALUES (?, ?, ?, ?, ?)');

async function loadDocs(tids?: number[]) {
  const rows = await db
    .select({ tid: pt.id, postId: pt.postId, locale: pt.locale, title: revisions.title, excerpt: revisions.excerpt, markdown: revisions.markdown })
    .from(pt)
    .innerJoin(posts, and(eq(posts.id, pt.postId), isNull(posts.deletedAt)))
    .innerJoin(revisions, eq(revisions.id, pt.publishedRevisionId))
    .where(and(eq(pt.status, 'published'), tids ? inArray(pt.id, tids) : undefined));
  if (!rows.length) return [];
  const postIds = rows.map((r) => r.postId);
  const tagRows = await db.select({ postId: postTags.postId, locale: tagTranslations.locale, name: tagTranslations.name }).from(postTags).innerJoin(tagTranslations, eq(tagTranslations.tagId, postTags.tagId)).where(inArray(postTags.postId, postIds));
  const catRows = await db
    .select({ postId: postCategories.postId, locale: categoryTranslations.locale, name: categoryTranslations.name })
    .from(postCategories)
    .innerJoin(categoryTranslations, eq(categoryTranslations.categoryId, postCategories.categoryId))
    .where(inArray(postCategories.postId, postIds));
  return rows.map((r) => ({
    ...r,
    terms: [...tagRows, ...catRows].filter((t) => t.postId === r.postId && t.locale === r.locale).map((t) => t.name).join(' '),
  }));
}

/** 更新单篇文章的索引：已发布则写入，否则移除 */
export async function indexPost(tid: number) {
  removeStmt.run(tid);
  for (const doc of await loadDocs([tid])) {
    insertStmt.run(segment(doc.title, doc.locale), segment(`${doc.excerpt}\n${plainExcerpt(doc.markdown, 1_000_000)}`, doc.locale), segment(doc.terms, doc.locale), doc.tid, doc.locale);
  }
}

export async function rebuildIndex() {
  const docs = await loadDocs();
  sqlite.exec('BEGIN');
  try {
    sqlite.exec('DELETE FROM search_index');
    for (const doc of docs) {
      insertStmt.run(segment(doc.title, doc.locale), segment(`${doc.excerpt}\n${plainExcerpt(doc.markdown, 1_000_000)}`, doc.locale), segment(doc.terms, doc.locale), doc.tid, doc.locale);
    }
    sqlite.exec('COMMIT');
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
  return docs.length;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 在原文里把命中的词标出来（返回已转义、可直接输出的 HTML） */
export function highlight(text: string, tokens: string[], window = 0): string {
  const lower = text.toLowerCase();
  let source = text;
  if (window > 0) {
    const first = tokens.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, first - Math.floor(window / 4));
    source = (start > 0 ? '…' : '') + text.slice(start, start + window).trim() + (start + window < text.length ? '…' : '');
  }
  if (!tokens.length) return escapeHtml(source);
  const pattern = new RegExp([...tokens].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '';
  let last = 0;
  for (const m of source.matchAll(pattern)) {
    out += `${escapeHtml(source.slice(last, m.index))}<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(source.slice(last));
}

export interface SearchHit {
  tid: number;
}

export function search(locale: string, query: string, page: number, pageSize: number): { total: number; tids: number[]; tokens: string[] } {
  const tokens = [...new Set(words(query.slice(0, 100), locale))].slice(0, 12);
  if (!tokens.length) return { total: 0, tids: [], tokens };
  // 每个词都必须命中；拉丁词做前缀匹配，输入 “mark” 也能找到 “markdown”
  const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"${/^[a-z0-9]{2,}$/.test(t) ? '*' : ''}`).join(' ');
  const total = (sqlite.prepare('SELECT count(*) AS n FROM search_index WHERE search_index MATCH ? AND locale = ?').get(match, locale) as { n: number }).n;
  const rows = sqlite
    .prepare('SELECT tid FROM search_index WHERE search_index MATCH ? AND locale = ? ORDER BY bm25(search_index, 10.0, 1.0, 5.0) LIMIT ? OFFSET ?')
    .all(match, locale, pageSize, (page - 1) * pageSize) as { tid: number }[];
  return { total, tids: rows.map((r) => Number(r.tid)), tokens };
}

/** 记录搜索词与结果数，只记第一页，避免翻页重复计数 */
export async function logSearch(term: string, results: number) {
  const key = term.trim().toLowerCase().slice(0, 60);
  if (!key) return;
  await db
    .insert(searchTerms)
    .values({ term: key, count: 1, results, lastAt: Date.now() })
    .onConflictDoUpdate({ target: searchTerms.term, set: { count: sql`${searchTerms.count} + 1`, results, lastAt: Date.now() } });
}

export function indexedCount(): number {
  return (sqlite.prepare('SELECT count(*) AS n FROM search_index').get() as { n: number }).n;
}
