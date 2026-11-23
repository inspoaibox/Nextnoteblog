import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { computeStats, plainExcerpt, renderMarkdown, type RenderLabels } from '@nexemc/markdown';
import * as postsSvc from '../services/posts.ts';
import * as auth from '../services/auth.ts';
import * as tax from '../services/taxonomy.ts';
import * as org from '../services/organize.ts';
import * as searchSvc from '../services/search.ts';
import * as i18n from '../services/i18n.ts';
import { getSettings, isInstalled, type SiteSettings } from '../services/settings.ts';
import { pageCache, renderRevision } from '../services/render.ts';
import { renderPage, translate } from '../theme/engine.ts';

/** 前台页面的内容安全策略：只允许本站脚本，为主题安全边界打基础 */
const CSP = ["default-src 'self'", "img-src * data: blob:", "media-src *", "style-src 'self' 'unsafe-inline'", "script-src 'self'", "frame-ancestors 'self'", "base-uri 'self'", "form-action 'self'"].join('; ');

type ListRow = Awaited<ReturnType<typeof postsSvc.listPublic>>['items'][number];
interface Crumb {
  name: string;
  url: string;
}
/** 当前页面在另一种语言下对应的地址（不含语言前缀）；没有对应内容时返回 null */
type Alternate = (locale: string) => Promise<string | null> | string | null;
/** 一次请求的语言环境 */
interface Scope {
  locale: string;
  prefix: string;
  /** 已套用当前语言站点文案的设置 */
  s: SiteSettings;
  ui: Record<string, string>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

function parseMeta(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toCard(row: ListRow) {
  const stats = computeStats(row.markdown);
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    excerpt: row.excerpt || plainExcerpt(row.markdown),
    cover: row.cover,
    url: postsSvc.postPath(row.slug),
    date: row.firstPublishedAt,
    updated: row.contentUpdatedAt,
    author: row.author,
    views: row.viewCount,
    pinned: !!row.pinned,
    featured: !!row.featured,
    reading_minutes: stats.readingMinutes,
    words: stats.words,
  };
}

function pagination(page: number, total: number, pageSize: number, basePath: string, query: Record<string, string> = {}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const url = (n: number) => {
    const params = new URLSearchParams(query);
    if (n > 1) params.set('page', String(n));
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  return { page, pages, total, prev_url: page > 1 ? url(page - 1) : null, next_url: page < pages ? url(page + 1) : null };
}

/** 分类节点 → 模板用的精简结构 */
const catView = (n: tax.CategoryNode): Record<string, unknown> => ({ id: n.id, name: n.name, url: n.url, description: n.description, depth: n.depth, count: n.totalPublished, children: n.children.filter((c) => c.visible).map(catView) });

const URL_KEYS = new Set(['url', 'prev_url', 'next_url', 'self_url']);
/**
 * 给上下文里所有站内地址加上语言前缀。返回深拷贝，不改动原对象（分类树等是缓存的）。
 * 服务层只产出不带前缀的地址，前缀统一在这里加，不会漏。
 */
function withPrefix<T>(value: T, prefix: string): T {
  if (!prefix || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => withPrefix(v, prefix)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (URL_KEYS.has(key) && typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) out[key] = v === '/' ? prefix : prefix + v;
    else out[key] = withPrefix(v, prefix);
  }
  return out as T;
}
const join = (prefix: string, path: string) => (path === '/' ? prefix || '/' : prefix + path);
const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** 供全局 404 处理使用（查重定向表，再渲染主题的 404 页） */
export let siteNotFound: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> = async (_req, reply) => reply.code(404).send();

export async function siteRoutes(app: FastifyInstance) {
  async function scopeOf(req: FastifyRequest): Promise<Scope> {
    const locale = (req.raw as { nbLocale?: string }).nbLocale ?? (await i18n.getDefaultLocale());
    const base = await i18n.getLocalizedSettings(locale);
    const ui = await i18n.getUiOverrides(locale);
    return { locale, prefix: await i18n.prefixFor(locale), s: { ...base, defaultLocale: locale }, ui, t: (key, vars) => translate(base.activeTheme, locale, key, ui, vars) };
  }

  const origin = (req: FastifyRequest, s: SiteSettings) => s.siteUrl || `${req.protocol}://${req.host}`;
  const cacheKey = (sc: Scope, key: string) => `${sc.locale}|${key}`;

  /** 语言切换器与 hreflang：每种启用的语言对应到当前内容的哪个地址 */
  async function languageLinks(sc: Scope, alternate: Alternate | undefined, fallback: 'home' | 'hide') {
    const langs = await i18n.enabledLanguages();
    if (langs.length < 2) return [];
    const out = [];
    for (const lang of langs) {
      const prefix = lang.isDefault ? '' : `/${lang.prefix}`;
      const path = lang.code === sc.locale ? null : alternate ? await alternate(lang.code) : null;
      const current = lang.code === sc.locale;
      const available = current || path != null;
      if (!available && fallback === 'hide') continue;
      // 没有对应译文时指向该语言的首页，并在模板里给出说明
      out.push({ code: lang.code, name: lang.name, current, available, href: current ? '' : join(prefix, path ?? '/') });
    }
    return out;
  }

  async function send(req: FastifyRequest, reply: FastifyReply, sc: Scope, template: string, ctx: Record<string, unknown> & { alternate?: Alternate }, status = 200, key?: string) {
    const { s } = sc;
    const { alternate, ...rest } = ctx;
    const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
    const mark = (items: Awaited<ReturnType<typeof org.getPublicMenu>>) =>
      items.map((i) => ({ ...i, label: i.label_key ? sc.t(i.label_key) : i.label, current: i.url === '/' ? path === '/' : path === i.url || path.startsWith(`${i.url}/`) }));
    const nav = { header: mark(await org.getPublicMenu(sc.locale, 'header')), footer: mark(await org.getPublicMenu(sc.locale, 'footer')) };
    const languages = await languageLinks(sc, status === 200 ? alternate : undefined, s.langFallback);
    const site = {
      name: s.siteName,
      tagline: s.tagline,
      description: s.description,
      url: s.siteUrl,
      locale: sc.locale,
      prefix: sc.prefix,
      timezone: s.timezone,
      appearance: s.appearance,
      icp: s.icp,
      footer_text: s.footerText,
      year: new Date().getFullYear(),
      feed_url: join(sc.prefix, '/feed.xml'),
    };
    const page = rest.page as Record<string, unknown> | undefined;
    // 只有真正存在对应译文的语言才输出 hreflang
    const hreflang = page?.noindex ? [] : languages.filter((l) => l.available).map((l) => ({ code: l.code, href: `${s.siteUrl}${l.current ? join(sc.prefix, path) : l.href}` }));
    const html = await renderPage(s.activeTheme, template, { site, nav: withPrefix(nav, sc.prefix), query: '', languages, hreflang, _ui: sc.ui, ...withPrefix(rest, sc.prefix) });
    if (key) pageCache.set(cacheKey(sc, key), { html, status });
    return reply.code(status).header('content-security-policy', CSP).header('content-language', sc.locale).type('text/html; charset=utf-8').send(html);
  }

  function sendCached(reply: FastifyReply, sc: Scope, key: string) {
    const hit = pageCache.get(cacheKey(sc, key));
    if (!hit) return false;
    reply.code(hit.status).header('content-security-policy', CSP).header('content-language', sc.locale).header('x-cache', 'hit').type('text/html; charset=utf-8').send(hit.html);
    return true;
  }

  const pageOf = (req: FastifyRequest) => {
    const n = Number((req.query as { page?: string }).page ?? 1);
    return Number.isInteger(n) && n >= 1 && n < 100000 ? n : 1;
  };
  const canonical = (sc: Scope, path: string) => (sc.s.siteUrl ? `${sc.s.siteUrl}${join(sc.prefix, path)}` : '');
  const same = (path: string): Alternate => () => path;

  async function notFoundPage(req: FastifyRequest, reply: FastifyReply) {
    const sc = await scopeOf(req);
    const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
    const target = await postsSvc.findRedirect(path);
    if (target) return reply.redirect(join(sc.prefix, target), 301);
    return send(req, reply, sc, '404', { page: { title: sc.t('not_found_title'), type: '404', noindex: true } }, 404);
  }
  siteNotFound = notFoundPage;

  // 尚未安装时，前台统一引导到安装向导
  app.addHook('onRequest', async (_req, reply) => {
    if (!(await isInstalled())) return reply.redirect('/admin/setup');
  });

  /* ---------- 首页与文章列表 ---------- */

  app.get('/', async (req, reply) => {
    const sc = await scopeOf(req);
    const page = pageOf(req);
    const key = `home:${page}`;
    if (sendCached(reply, sc, key)) return reply;
    const { s, locale } = sc;
    const [{ total, items }, featured, tree, tags] = await Promise.all([postsSvc.listPublic(locale, page, s.postsPerPage), page === 1 ? postsSvc.listFeatured(locale, 4) : [], tax.getTree(locale), tax.listTags(locale)]);
    return send(
      req,
      reply,
      sc,
      'home',
      {
        page: { title: s.tagline ? `${s.siteName} - ${s.tagline}` : s.siteName, description: s.description, type: 'home', canonical: canonical(sc, '/') },
        posts: items.map(toCard),
        featured: featured.map(toCard),
        categories: tree.roots.filter((c) => c.visible && c.totalPublished > 0).map(catView),
        tags: tags.filter((t) => t.publishedCount > 0).slice(0, 24).map((t) => ({ name: t.name, url: t.url, count: t.publishedCount })),
        pagination: pagination(page, total, s.postsPerPage, '/'),
        alternate: same('/'),
      },
      200,
      key,
    );
  });

  app.get('/posts', async (req, reply) => {
    const sc = await scopeOf(req);
    const page = pageOf(req);
    const key = `posts:${page}`;
    if (sendCached(reply, sc, key)) return reply;
    const { s, locale } = sc;
    const { total, items } = await postsSvc.listPublic(locale, page, s.postsPerPage);
    if (page > 1 && !items.length) return notFoundPage(req, reply);
    return send(
      req,
      reply,
      sc,
      'post-list',
      {
        page: { title: `${sc.t('all_posts')} - ${s.siteName}`, description: s.description, type: 'list', canonical: canonical(sc, '/posts') },
        heading: sc.t('all_posts'),
        crumbs: [],
        posts: items.map(toCard),
        pagination: pagination(page, total, s.postsPerPage, '/posts'),
        alternate: same('/posts'),
      },
      200,
      key,
    );
  });

  /* ---------- 分类 ---------- */

  app.get('/category/*', async (req, reply) => {
    const sc = await scopeOf(req);
    const path = (req.params as { '*': string })['*'].replace(/\/+$/, '');
    const page = pageOf(req);
    // scope=self：只看直接归属本级的文章；默认包含所有下级分类
    const selfOnly = (req.query as { scope?: string }).scope === 'self';
    const key = `cat:${path}:${selfOnly}:${page}`;
    if (sendCached(reply, sc, key)) return reply;
    const { s, locale } = sc;
    const node = (await tax.getTree(locale)).byPath.get(path);
    if (!node || !node.visible) return notFoundPage(req, reply);
    const { total, items } = await postsSvc.listPublic(locale, page, s.postsPerPage, { categoryIds: selfOnly ? [node.id] : tax.descendantIds(node) });
    return send(
      req,
      reply,
      sc,
      'category',
      {
        page: { title: `${node.seoTitle || node.name} - ${s.siteName}`, description: node.seoDescription || node.description, type: 'category', canonical: canonical(sc, node.url) },
        category: { ...catView(node), self_only: selfOnly, self_count: node.publishedCount, self_url: `${node.url}?scope=self`, has_children: node.children.some((c) => c.visible) },
        crumbs: node.trail.slice(0, -1) as Crumb[],
        posts: items.map(toCard),
        pagination: pagination(page, total, s.postsPerPage, node.url, selfOnly ? { scope: 'self' } : {}),
        // 分类树各语言结构一致：同一个节点在另一种语言下的路径
        alternate: async (other) => (await tax.getTree(other)).byId.get(node.id)?.url ?? null,
      },
      200,
      key,
    );
  });

  /* ---------- 标签 ---------- */

  app.get('/tags', async (req, reply) => {
    const sc = await scopeOf(req);
    if (sendCached(reply, sc, 'tags')) return reply;
    const tags = (await tax.listTags(sc.locale)).filter((t) => t.publishedCount > 0);
    return send(req, reply, sc, 'tags', { page: { title: `${sc.t('tags')} - ${sc.s.siteName}`, type: 'tags', canonical: canonical(sc, '/tags') }, tags: tags.map((t) => ({ name: t.name, url: t.url, count: t.publishedCount })), alternate: same('/tags') }, 200, 'tags');
  });

  app.get('/tag/:slug', async (req, reply) => {
    const sc = await scopeOf(req);
    const { slug } = req.params as { slug: string };
    const page = pageOf(req);
    const key = `tag:${slug}:${page}`;
    if (sendCached(reply, sc, key)) return reply;
    const { s, locale } = sc;
    const tag = await tax.getTagBySlug(locale, slug);
    if (!tag) return notFoundPage(req, reply);
    const { total, items } = await postsSvc.listPublic(locale, page, s.postsPerPage, { tagId: tag.id });
    return send(
      req,
      reply,
      sc,
      'post-list',
      {
        page: { title: `${sc.t('tags')}: ${tag.name} - ${s.siteName}`, description: tag.description, type: 'tag', canonical: canonical(sc, tag.url) },
        heading: tag.name,
        intro: tag.description,
        crumbs: [{ name: sc.t('tags'), url: '/tags' }],
        posts: items.map(toCard),
        pagination: pagination(page, total, s.postsPerPage, tag.url),
        alternate: async (other) => (await tax.listTags(other)).find((t) => t.id === tag.id)?.url ?? null,
      },
      200,
      key,
    );
  });

  /* ---------- 专题 / 系列 ---------- */

  for (const kind of ['topic', 'series'] as const) {
    app.get(`/${kind}/:slug`, async (req, reply) => {
      const sc = await scopeOf(req);
      const { slug } = req.params as { slug: string };
      const key = `${kind}:${slug}`;
      if (sendCached(reply, sc, key)) return reply;
      const col = await org.getPublicCollection(sc.locale, kind, slug);
      if (!col) return notFoundPage(req, reply);
      const rows = await postsSvc.getPublicByPostIds(sc.locale, col.postIds);
      return send(
        req,
        reply,
        sc,
        'collection',
        {
          page: { title: `${col.title} - ${sc.s.siteName}`, description: col.description, type: kind, canonical: canonical(sc, col.url), image: col.cover },
          collection: { title: col.title, description: col.description, cover: col.cover, kind, is_series: kind === 'series', url: col.url },
          posts: rows.map(toCard),
          alternate: async (other) => (await org.listCollections(other, { kind, onlyVisible: true })).find((c) => c.id === col.id)?.url ?? null,
        },
        200,
        key,
      );
    });
  }

  /* ---------- 归档 ---------- */

  app.get('/archive', async (req, reply) => {
    const sc = await scopeOf(req);
    if (sendCached(reply, sc, 'archive')) return reply;
    const rows = await postsSvc.listArchive(sc.locale);
    const yearOf = new Intl.DateTimeFormat(sc.locale, { year: 'numeric', timeZone: sc.s.timezone });
    const years: { year: string; count: number; posts: { title: string; url: string; date: number | null }[] }[] = [];
    for (const row of rows) {
      const year = yearOf.format(new Date(row.date ?? 0));
      if (years.at(-1)?.year !== year) years.push({ year, count: 0, posts: [] });
      const group = years.at(-1)!;
      group.count++;
      group.posts.push({ title: row.title, url: postsSvc.postPath(row.slug), date: row.date });
    }
    return send(req, reply, sc, 'archive', { page: { title: `${sc.t('archive')} - ${sc.s.siteName}`, type: 'archive', canonical: canonical(sc, '/archive') }, years, total: rows.length, alternate: same('/archive') }, 200, 'archive');
  });

  /* ---------- 搜索（不缓存，不让搜索引擎收录结果页） ---------- */

  app.get('/search', async (req, reply) => {
    const sc = await scopeOf(req);
    const q = String((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    const page = pageOf(req);
    const { s, locale } = sc;
    const pageSize = s.postsPerPage;
    const found = q ? searchSvc.search(locale, q, page, pageSize) : { total: 0, tids: [], tokens: [] };
    const rows = await postsSvc.getPublicByIds(locale, found.tids);
    if (q && page === 1) await searchSvc.logSearch(q, found.total);
    const results = rows.map((row) => {
      const card = toCard(row);
      return { ...card, title_html: searchSvc.highlight(row.title, found.tokens), excerpt_html: searchSvc.highlight(plainExcerpt(`${row.excerpt}\n${row.markdown}`, 100_000), found.tokens, 150) };
    });
    // 没有结果时给出最新文章，避免死胡同
    const suggestions = q && !results.length ? (await postsSvc.listPublic(locale, 1, 5)).items.map(toCard) : [];
    reply.header('x-robots-tag', 'noindex');
    return send(req, reply, sc, 'search', {
      page: { title: q ? `${sc.t('search')}: ${q} - ${s.siteName}` : `${sc.t('search')} - ${s.siteName}`, type: 'search', noindex: true },
      query: q,
      results,
      suggestions,
      pagination: pagination(page, found.total, pageSize, '/search', { q }),
      alternate: same('/search'),
    });
  });

  /* ---------- 文章详情 ---------- */

  const labelsOf = (sc: Scope): RenderLabels => ({ footnotes: sc.t('footnotes'), footnoteBack: sc.t('footnote_back'), copy: sc.t('copy_code'), unsupported: sc.t('unsupported_block') });

  async function postContext(row: postsSvc.PublicPost, sc: Scope, updatedAt: number, preview: boolean) {
    const { s, locale } = sc;
    const rendered = await renderRevision(row.revisionId, updatedAt, row.markdown, labelsOf(sc));
    const meta = parseMeta(row.meta);
    const [neighbors, taxonomy, tree, series, published] = await Promise.all([
      preview ? { prev: null, next: null } : postsSvc.getNeighbors(locale, row.firstPublishedAt ?? 0, row.id),
      tax.getPostTaxonomy(locale, row.postId),
      tax.getTree(locale),
      org.getSeriesFor(locale, row.postId),
      postsSvc.getPublishedLocales(row.postId),
    ]);
    const primary = taxonomy.primaryCategoryId != null ? tree.byId.get(taxonomy.primaryCategoryId) : undefined;
    const others = taxonomy.categoryIds.map((id) => tree.byId.get(id)).filter((c) => !!c && c.visible);
    const card = toCard(row);
    const link = (n: { slug: string; title: string } | null) => (n ? { title: n.title, url: postsSvc.postPath(n.slug) } : null);
    return {
      page: {
        title: `${meta.seoTitle || row.title} - ${s.siteName}`,
        description: meta.seoDescription || card.excerpt,
        type: 'post',
        canonical: canonical(sc, card.url),
        image: row.cover,
        noindex: preview || meta.noindex === true,
      },
      post: {
        ...card,
        html: rendered.html,
        toc: rendered.toc,
        show_toc: meta.showToc !== false && rendered.toc.length >= 2,
        archived: row.status === 'archived',
        // 更新日期与发布日期相差超过一天才值得展示
        show_updated: !!row.contentUpdatedAt && !!row.firstPublishedAt && row.contentUpdatedAt - row.firstPublishedAt > 86400_000,
        categories: [primary, ...others].filter((c) => !!c && c.visible).map((c) => ({ name: c!.name, url: c!.url })),
        tags: taxonomy.tagList.map((t) => ({ name: t.name, url: tax.tagPath(t.slug) })),
      },
      // 面包屑走主分类的完整路径
      crumbs: (primary && primary.visible ? primary.trail : []) as Crumb[],
      series,
      prev: link(neighbors.prev),
      next: link(neighbors.next),
      preview,
      // 只认已发布的译文：未发布的语言版本不会出现在切换器和 hreflang 里
      alternate: ((other) => {
        const hit = published.find((p) => p.locale === other);
        return hit ? postsSvc.postPath(hit.slug) : null;
      }) as Alternate,
    };
  }

  app.get('/posts/:slug', async (req, reply) => {
    const sc = await scopeOf(req);
    const { slug } = req.params as { slug: string };
    const row = await postsSvc.getPublicBySlug(sc.locale, slug);
    if (!row) return notFoundPage(req, reply);
    postsSvc.recordView(row.id);
    const key = `post:${row.id}:${row.revisionId}`;
    if (sendCached(reply, sc, key)) return reply;
    return send(req, reply, sc, 'post', await postContext(row, sc, 0, false), 200, key);
  });

  // 草稿预览：必须是已登录的管理员，且不进缓存、不被索引。语言取自该语言版本自身
  app.get('/preview/post/:id', async (req, reply) => {
    const user = await auth.getSessionUser(req.cookies[auth.SESSION_COOKIE]);
    if (!user) return notFoundPage(req, reply);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return notFoundPage(req, reply);
    let row: postsSvc.PublicPost;
    let locale: string;
    try {
      row = (await postsSvc.getDraftAsPublic(id)) as postsSvc.PublicPost;
      locale = (await postsSvc.getForEdit(id)).translation.locale;
    } catch {
      return notFoundPage(req, reply);
    }
    (req.raw as { nbLocale?: string }).nbLocale = locale;
    const sc = await scopeOf(req);
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    return send(req, reply, sc, 'post', await postContext(row, sc, Date.now(), true));
  });

  /* ---------- 自定义页面 ---------- */

  const renderCustomPage = async (req: FastifyRequest, reply: FastifyReply, sc: Scope, p: { pageId: number; title: string; markdown: string; seoDescription: string; slug: string }, preview: boolean) => {
    const rendered = await renderMarkdown(p.markdown, { labels: labelsOf(sc) });
    return send(req, reply, sc, 'page', {
      page: { title: `${p.title} - ${sc.s.siteName}`, description: p.seoDescription || plainExcerpt(p.markdown), type: 'page', canonical: canonical(sc, org.pagePath(p.slug)), noindex: preview },
      content: { title: p.title, html: rendered.html },
      preview,
      alternate: async (other) => {
        const hit = await org.getPublicPageById(p.pageId, other);
        return hit ? org.pagePath(hit.slug) : null;
      },
    });
  };

  app.get('/preview/page/:id', async (req, reply) => {
    const user = await auth.getSessionUser(req.cookies[auth.SESSION_COOKIE]);
    const id = Number((req.params as { id: string }).id);
    if (!user || !Number.isInteger(id)) return notFoundPage(req, reply);
    try {
      const p = await org.getPage(id);
      (req.raw as { nbLocale?: string }).nbLocale = p.locale;
      reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
      return await renderCustomPage(req, reply, await scopeOf(req), p, true);
    } catch {
      return notFoundPage(req, reply);
    }
  });

  /* ---------- 订阅、站点地图、robots ---------- */

  app.get('/feed.xml', async (req, reply) => {
    const sc = await scopeOf(req);
    const base = origin(req, sc.s);
    const { items } = await postsSvc.listPublic(sc.locale, 1, 20);
    const self = `${base}${join(sc.prefix, '/feed.xml')}`;
    const entries = items
      .map((row) => {
        const url = `${base}${join(sc.prefix, postsSvc.postPath(row.slug))}`;
        return `  <entry>\n    <title>${xml(row.title)}</title>\n    <link href="${xml(url)}"/>\n    <id>${xml(url)}</id>\n    <published>${new Date(row.firstPublishedAt ?? 0).toISOString()}</published>\n    <updated>${new Date(row.contentUpdatedAt ?? row.firstPublishedAt ?? 0).toISOString()}</updated>\n    <summary>${xml(row.excerpt || plainExcerpt(row.markdown, 300))}</summary>\n${row.author ? `    <author><name>${xml(row.author)}</name></author>\n` : ''}  </entry>`;
      })
      .join('\n');
    const updated = new Date(Math.max(0, ...items.map((r) => r.contentUpdatedAt ?? r.firstPublishedAt ?? 0))).toISOString();
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xml(sc.locale)}">\n  <title>${xml(sc.s.siteName)}</title>\n${sc.s.tagline ? `  <subtitle>${xml(sc.s.tagline)}</subtitle>\n` : ''}  <link href="${xml(self)}" rel="self"/>\n  <link href="${xml(base + join(sc.prefix, '/'))}"/>\n  <id>${xml(base + join(sc.prefix, '/'))}</id>\n  <updated>${updated}</updated>\n${entries}\n</feed>\n`;
    return reply.type('application/atom+xml; charset=utf-8').send(body);
  });

  app.get('/sitemap.xml', async (req, reply) => {
    const s = await getSettings();
    const base = origin(req, s);
    const langs = await i18n.enabledLanguages();
    const prefixOf = (code: string) => {
      const lang = langs.find((l) => l.code === code)!;
      return lang.isDefault ? '' : `/${lang.prefix}`;
    };
    // 一组互为译文的地址：每个 <url> 都列出全部语言版本
    const groups: { locale: string; path: string; lastmod?: number | null }[][] = [];
    for (const path of ['/', '/posts', '/archive']) groups.push(langs.map((l) => ({ locale: l.code, path })));

    const byPost = new Map<number, { locale: string; path: string; lastmod?: number | null }[]>();
    const byPage = new Map<number, { locale: string; path: string; lastmod?: number | null }[]>();
    for (const lang of langs) {
      for (const row of await postsSvc.listSitemap(lang.code)) byPost.set(row.postId, [...(byPost.get(row.postId) ?? []), { locale: lang.code, path: postsSvc.postPath(row.slug), lastmod: row.updated }]);
      for (const p of await org.listPublicPages(lang.code)) byPage.set(p.pageId, [...(byPage.get(p.pageId) ?? []), { locale: lang.code, path: org.pagePath(p.slug), lastmod: p.publishedAt }]);
    }
    groups.push(...byPost.values(), ...byPage.values());
    // 分类：只收录该语言下确有已发布文章的节点
    const trees = await Promise.all(langs.map(async (l) => ({ locale: l.code, tree: await tax.getTree(l.code) })));
    for (const id of trees[0]?.tree.byId.keys() ?? []) {
      const group = trees.map(({ locale, tree }) => ({ locale, node: tree.byId.get(id) })).filter((x) => x.node && x.node.visible && x.node.totalPublished > 0);
      if (group.length) groups.push(group.map((x) => ({ locale: x.locale, path: x.node!.url })));
    }

    const urls = groups.flatMap((group) =>
      group.map((entry) => {
        const loc = `${base}${join(prefixOf(entry.locale), entry.path)}`;
        const links = group.length > 1 ? group.map((alt) => `    <xhtml:link rel="alternate" hreflang="${xml(alt.locale)}" href="${xml(base + join(prefixOf(alt.locale), alt.path))}"/>`).join('\n') + '\n' : '';
        return `  <url>\n    <loc>${xml(loc)}</loc>\n${entry.lastmod ? `    <lastmod>${new Date(entry.lastmod).toISOString()}</lastmod>\n` : ''}${links}  </url>`;
      }),
    );
    return reply.type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
  });

  app.get('/robots.txt', async (req, reply) => {
    const s = await getSettings();
    return reply.type('text/plain; charset=utf-8').send(`User-agent: *\nDisallow: /admin/\nDisallow: /preview/\nDisallow: /search\n\nSitemap: ${origin(req, s)}/sitemap.xml\n`);
  });

  // 放在最后：只有不属于系统路由的单段地址才会落到这里
  app.get('/:slug', async (req, reply) => {
    const sc = await scopeOf(req);
    const { slug } = req.params as { slug: string };
    const p = await org.getPublicPage(sc.locale, slug);
    if (!p) return notFoundPage(req, reply);
    return renderCustomPage(req, reply, sc, { pageId: p.pageId, title: p.publishedTitle, markdown: p.publishedMarkdown, seoDescription: p.seoDescription, slug: p.slug }, false);
  });
}
