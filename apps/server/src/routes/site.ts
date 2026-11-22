import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { computeStats, plainExcerpt } from '@nexemc/markdown';
import * as postsSvc from '../services/posts.ts';
import * as auth from '../services/auth.ts';
import { getSettings, isInstalled, type SiteSettings } from '../services/settings.ts';
import { pageCache, renderRevision } from '../services/render.ts';
import { renderPage } from '../theme/engine.ts';

/** 前台页面的内容安全策略：只允许本站脚本，为主题安全边界打基础 */
const CSP = ["default-src 'self'", "img-src * data: blob:", "media-src *", "style-src 'self' 'unsafe-inline'", "script-src 'self'", "frame-ancestors 'self'", "base-uri 'self'", "form-action 'self'"].join('; ');

type ListRow = Awaited<ReturnType<typeof postsSvc.listPublic>>['items'][number];

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

function siteContext(s: SiteSettings) {
  return {
    name: s.siteName,
    tagline: s.tagline,
    description: s.description,
    url: s.siteUrl,
    locale: s.defaultLocale,
    timezone: s.timezone,
    appearance: s.appearance,
    icp: s.icp,
    footer_text: s.footerText,
    year: new Date().getFullYear(),
  };
}

function pagination(page: number, total: number, pageSize: number, basePath: string) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const url = (n: number) => (n <= 1 ? basePath : `${basePath}?page=${n}`);
  return { page, pages, total, prev_url: page > 1 ? url(page - 1) : null, next_url: page < pages ? url(page + 1) : null };
}

/** 供全局 404 处理使用（查重定向表，再渲染主题的 404 页） */
export let siteNotFound: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> = async (_req, reply) => reply.code(404).send();

export async function siteRoutes(app: FastifyInstance) {
  async function send(reply: FastifyReply, template: string, ctx: Record<string, unknown>, status = 200, cacheKey?: string) {
    const s = await getSettings();
    const html = await renderPage(s.activeTheme, template, { site: siteContext(s), ...ctx });
    if (cacheKey) pageCache.set(cacheKey, { html, status });
    return reply.code(status).header('content-security-policy', CSP).type('text/html; charset=utf-8').send(html);
  }

  function sendCached(reply: FastifyReply, key: string) {
    const hit = pageCache.get(key);
    if (!hit) return false;
    reply.code(hit.status).header('content-security-policy', CSP).header('x-cache', 'hit').type('text/html; charset=utf-8').send(hit.html);
    return true;
  }

  const pageOf = (req: FastifyRequest) => {
    const n = Number((req.query as { page?: string }).page ?? 1);
    return Number.isInteger(n) && n >= 1 && n < 100000 ? n : 1;
  };

  async function notFoundPage(req: FastifyRequest, reply: FastifyReply) {
    const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
    const target = await postsSvc.findRedirect(path);
    if (target) return reply.redirect(target, 301);
    return send(reply, '404', { page: { title: '页面不存在', type: '404', noindex: true } }, 404);
  }
  siteNotFound = notFoundPage;

  // 尚未安装时，前台统一引导到安装向导
  app.addHook('onRequest', async (req, reply) => {
    if (!(await isInstalled())) return reply.redirect('/admin/setup');
  });

  app.get('/', async (req, reply) => {
    const page = pageOf(req);
    const key = `home:${page}`;
    if (sendCached(reply, key)) return reply;
    const s = await getSettings();
    const [{ total, items }, featured] = await Promise.all([postsSvc.listPublic(s.defaultLocale, page, s.postsPerPage), page === 1 ? postsSvc.listFeatured(s.defaultLocale, 3) : []]);
    return send(
      reply,
      'home',
      {
        page: { title: s.tagline ? `${s.siteName} - ${s.tagline}` : s.siteName, description: s.description, type: 'home', canonical: s.siteUrl ? `${s.siteUrl}/` : '' },
        posts: items.map(toCard),
        featured: featured.map(toCard),
        pagination: pagination(page, total, s.postsPerPage, '/'),
      },
      200,
      key,
    );
  });

  app.get('/posts', async (req, reply) => {
    const page = pageOf(req);
    const key = `posts:${page}`;
    if (sendCached(reply, key)) return reply;
    const s = await getSettings();
    const { total, items } = await postsSvc.listPublic(s.defaultLocale, page, s.postsPerPage);
    if (page > 1 && !items.length) return notFoundPage(req, reply);
    return send(
      reply,
      'post-list',
      {
        page: { title: `全部文章 - ${s.siteName}`, description: s.description, type: 'list', canonical: s.siteUrl ? `${s.siteUrl}/posts` : '' },
        posts: items.map(toCard),
        pagination: pagination(page, total, s.postsPerPage, '/posts'),
      },
      200,
      key,
    );
  });

  async function postContext(row: postsSvc.PublicPost, s: SiteSettings, updatedAt: number, preview: boolean) {
    const rendered = await renderRevision(row.revisionId, updatedAt, row.markdown);
    const meta = parseMeta(row.meta);
    const neighbors = preview ? { prev: null, next: null } : await postsSvc.getNeighbors(s.defaultLocale, row.firstPublishedAt ?? 0, row.id);
    const card = toCard(row);
    const link = (n: { slug: string; title: string } | null) => (n ? { title: n.title, url: postsSvc.postPath(n.slug) } : null);
    return {
      page: {
        title: `${meta.seoTitle || row.title} - ${s.siteName}`,
        description: meta.seoDescription || card.excerpt,
        type: 'post',
        canonical: s.siteUrl ? `${s.siteUrl}${card.url}` : '',
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
      },
      prev: link(neighbors.prev),
      next: link(neighbors.next),
      preview,
    };
  }

  app.get('/posts/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const s = await getSettings();
    const row = await postsSvc.getPublicBySlug(s.defaultLocale, slug);
    if (!row) return notFoundPage(req, reply);
    postsSvc.recordView(row.id);
    const key = `post:${row.id}:${row.revisionId}`;
    if (sendCached(reply, key)) return reply;
    return send(reply, 'post', await postContext(row, s, 0, false), 200, key);
  });

  // 草稿预览：必须是已登录的管理员，且不进缓存、不被索引
  app.get('/preview/post/:id', async (req, reply) => {
    const user = await auth.getSessionUser(req.cookies[auth.SESSION_COOKIE]);
    if (!user) return notFoundPage(req, reply);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return notFoundPage(req, reply);
    let row: postsSvc.PublicPost;
    try {
      row = (await postsSvc.getDraftAsPublic(id)) as postsSvc.PublicPost;
    } catch {
      return notFoundPage(req, reply);
    }
    const s = await getSettings();
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    return send(reply, 'post', await postContext(row, s, Date.now(), true));
  });
}
