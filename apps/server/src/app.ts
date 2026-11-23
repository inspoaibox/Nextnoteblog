import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { runMigrations } from './db/index.ts';
import { HttpError } from './lib/errors.ts';
import { adminRoutes } from './routes/admin.ts';
import { siteRoutes, siteNotFound } from './routes/site.ts';
import { pageCache } from './services/render.ts';
import { flushViews } from './services/posts.ts';
import { themeAssetsDir } from './theme/engine.ts';
import { invalidateTaxonomy } from './services/taxonomy.ts';
import { indexedCount, rebuildIndex } from './services/search.ts';
import { listLanguages, splitLocale } from './services/i18n.ts';
import { initThemes } from './services/themes.ts';

export async function buildApp(opts: { logger?: boolean } = {}) {
  await runMigrations();

  await listLanguages(); // 预热语言表，地址改写是同步的
  await initThemes();

  const app = Fastify({
    // /en/posts/x → /posts/x，并记下语言；这样所有前台路由天然支持每一种语言
    rewriteUrl(req) {
      const url = req.url ?? '/';
      const hit = splitLocale(url);
      if (!hit || /^\/(admin|uploads|theme|healthz)(\/|$|\?)/.test(hit.url)) return url;
      (req as { nbLocale?: string }).nbLocale = hit.locale;
      return hit.url;
    },
    logger: opts.logger ?? true,
    trustProxy: true, // 运行在 Caddy / Nginx 之后
    bodyLimit: 4 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, data: err.data });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `文件超过 ${config.maxUploadBytes / 1024 / 1024}MB 上限` });
    if (typeof err.statusCode === 'number' && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    if (req.url.startsWith('/admin/api')) return reply.code(500).send({ error: '服务器内部错误' });
    return reply.code(500).type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>500</title><h1>服务器内部错误</h1><p>请稍后再试。</p>');
  });

  // 健康检查：供容器探活与监控使用
  app.get('/healthz', async () => ({ ok: true }));

  /* ---------- 上传文件 ---------- */
  await app.register(fastifyStatic, {
    root: config.uploadsDir,
    prefix: '/uploads/',
    decorateReply: true,
    index: false,
    maxAge: '30d',
    immutable: true, // 文件名带内容哈希
  });

  /* ---------- 主题静态资源：/theme/{id}/{version}/... ---------- */
  app.get('/theme/:id/:version/*', (req, reply) => {
    const { id, version, '*': file } = req.params as { id: string; version: string; '*': string };
    const dir = themeAssetsDir(id, version);
    if (!dir) return reply.code(404).send();
    return reply.sendFile(file, dir, { maxAge: config.isProd ? '365d' : 0, immutable: config.isProd });
  });

  /* ---------- 管理 API ---------- */
  await app.register(adminRoutes, { prefix: '/admin/api' });

  // 后台写操作成功后，整页缓存整体失效（M1 采用最简单可靠的策略）
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && req.url.startsWith('/admin/api') && reply.statusCode < 400) {
      pageCache.clear();
      invalidateTaxonomy(); // 分类计数依赖文章状态
    }
  });

  /* ---------- 后台单页应用 ---------- */
  const adminIndex = path.join(config.adminDist, 'index.html');
  const hasAdmin = fs.existsSync(adminIndex);
  if (hasAdmin) {
    await app.register(fastifyStatic, { root: config.adminDist, prefix: '/admin/', decorateReply: false, index: false, wildcard: true });
  }
  const sendAdmin = (reply: any) =>
    hasAdmin
      ? reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(fs.readFileSync(adminIndex))
      : reply.code(503).type('text/plain; charset=utf-8').send('后台尚未构建，请先执行 pnpm build（开发时访问 Vite 开发服务器）。');
  app.get('/admin', (_req, reply) => sendAdmin(reply));

  /* ---------- 前台 ---------- */
  await app.register(siteRoutes);

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/admin/api')) return reply.code(404).send({ error: '接口不存在' });
    if (url.startsWith('/admin/') && req.method === 'GET' && !path.extname(url)) return sendAdmin(reply);
    if (url.startsWith('/uploads/') || url.startsWith('/theme/') || url.startsWith('/admin/')) return reply.code(404).send();
    return siteNotFound(req, reply);
  });

  // 搜索索引是派生数据：为空时（首次升级、被清空）自动重建
  if (indexedCount() === 0) await rebuildIndex();

  const viewTimer = setInterval(() => flushViews().catch((err) => app.log.error(err)), 15_000);
  app.addHook('onClose', async () => {
    clearInterval(viewTimer);
    await flushViews();
  });

  return app;
}
