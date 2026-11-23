import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { db, schema, transaction } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError, badRequest } from '../lib/errors.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../lib/password.ts';
import { slugify } from '../lib/slug.ts';
import * as auth from '../services/auth.ts';
import * as postsSvc from '../services/posts.ts';
import * as mediaSvc from '../services/media.ts';
import { getSettings, isInstalled, updateSettings } from '../services/settings.ts';
import { loadTheme } from '../theme/engine.ts';
import { adminOrgRoutes } from './admin-org.ts';
import { adminShowcaseRoutes } from './admin-showcase.ts';
import { ensureStarterContent } from '../services/starter.ts';
import { adminI18nRoutes } from './admin-i18n.ts';
import { adminThemeRoutes } from './admin-themes.ts';
import { adminToolRoutes } from './admin-tools.ts';
import { liveTheme } from '../services/themes.ts';
import * as i18n from '../services/i18n.ts';
import * as searchSvc from '../services/search.ts';
import { getTree, descendantIds, invalidateTaxonomy } from '../services/taxonomy.ts';

const idParam = (req: FastifyRequest, name = 'id') => {
  const n = Number((req.params as Record<string, string>)[name]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('参数错误');
  return n;
};

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`参数错误：${issue.path.join('.') || '请求体'} ${issue.message}`);
  }
  return result.data;
}

function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie(auth.SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: config.sessionDays * 86400,
  });
}

const draftSchema = z.object({
  title: z.string().max(300),
  subtitle: z.string().max(300).default(''),
  excerpt: z.string().max(2000).default(''),
  cover: z.string().max(1000).default(''),
  markdown: z.string().max(2_000_000),
  frontMatter: z.string().max(100_000).default(''),
  meta: z.record(z.string(), z.unknown()).default({}),
  baseVersion: z.number().int(),
  mode: z.enum(['auto', 'manual']).default('manual'),
  note: z.string().max(300).optional(),
  force: z.boolean().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  /* ---------- 鉴权与 CSRF ---------- */
  const PUBLIC = new Set(['/admin/api/status', '/admin/api/setup', '/admin/api/login']);

  app.addHook('preHandler', async (req) => {
    const route = req.routeOptions.url ?? '';
    // 所有写操作必须带自定义请求头：跨站表单与简单请求带不上它
    if (req.method !== 'GET' && req.headers['x-nb-csrf'] !== '1') throw new HttpError(403, '请求被拒绝（缺少校验头）');
    req.user = await auth.getSessionUser(req.cookies[auth.SESSION_COOKIE]);
    // 后台当前正在编辑哪种语言的内容
    req.contentLocale = await i18n.resolveContentLocale(req.headers['x-nb-locale'] as string | undefined);
    if (!PUBLIC.has(route) && !req.user) throw new HttpError(401, '请先登录');
  });

  const ip = (req: FastifyRequest) => req.ip;
  const me = (req: FastifyRequest) => req.user!;

  /* ---------- 安装 / 登录 ---------- */

  app.get('/status', async (req) => {
    const s = await getSettings();
    const theme = loadTheme((await liveTheme()).id);
    return {
      installed: await isInstalled(),
      user: req.user,
      site: { name: s.siteName, defaultLocale: await i18n.getDefaultLocale(), timezone: s.timezone, appearance: s.appearance },
      languages: await i18n.listLanguages(),
      contentLocale: req.contentLocale,
      themeCss: `/theme/${theme.manifest.id}/${theme.manifest.version}/style.css`,
    };
  });

  app.post('/setup', async (req, reply) => {
    if (await isInstalled()) throw new HttpError(409, '站点已完成安装');
    const body = parse(
      z.object({
        siteName: z.string().trim().min(1).max(100),
        username: z.string().trim().regex(/^[A-Za-z0-9_.-]{3,32}$/, '用户名需为 3–32 位字母、数字或 _ . -'),
        password: z.string(),
        displayName: z.string().trim().max(50).optional(),
        timezone: z.string().max(64).default('Asia/Shanghai'),
      }),
      req.body,
    );
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest(problem);
    try {
      new Intl.DateTimeFormat('en', { timeZone: body.timezone });
    } catch {
      throw badRequest('无效的时区');
    }
    const passwordHash = await hashPassword(body.password);
    const user = await transaction(async () => {
      if (await isInstalled()) throw new HttpError(409, '站点已完成安装');
      const u = await db
        .insert(schema.users)
        .values({ username: body.username, passwordHash, displayName: body.displayName || body.username, role: 'admin', createdAt: Date.now() })
        .returning({ id: schema.users.id })
        .get();
      await db
        .insert(schema.languages)
        .values([
          { code: 'zh-CN', name: '简体中文', isDefault: 1, sort: 0 },
          { code: 'en', name: 'English', isDefault: 0, sort: 1, enabled: 0 },
        ])
        .onConflictDoNothing();
      return u;
    });
    await updateSettings({ siteName: body.siteName, timezone: body.timezone });
    await i18n.refreshLanguages();
    await ensureStarterContent(); // 关于页面、友链与开源项目的导航入口
    await auth.audit({ id: user.id, username: body.username, displayName: '', role: 'admin' }, 'setup', 'site', '', '', ip(req));
    setSessionCookie(req, reply, await auth.createSession(user.id, { ip: ip(req), userAgent: req.headers['user-agent'] }));
    return { ok: true };
  });

  app.post('/login', async (req, reply) => {
    const body = parse(z.object({ username: z.string(), password: z.string() }), req.body);
    auth.assertLoginAllowed(ip(req));
    const user = await db.select().from(schema.users).where(eq(schema.users.username, body.username.trim())).get();
    // 用户不存在时也做一次哈希，避免通过响应时间探测用户名
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : (await hashPassword(body.password), false);
    auth.recordLoginResult(ip(req), ok);
    if (!ok || !user) {
      await auth.audit(null, 'login_failed', 'user', '', body.username.slice(0, 50), ip(req));
      throw new HttpError(401, '用户名或密码错误');
    }
    setSessionCookie(req, reply, await auth.createSession(user.id, { ip: ip(req), userAgent: req.headers['user-agent'] }));
    await auth.audit({ id: user.id, username: user.username, displayName: user.displayName, role: user.role }, 'login', 'user', user.id, '', ip(req));
    return { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } };
  });

  app.post('/logout', async (req, reply) => {
    await auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
    reply.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/account/password', async (req, reply) => {
    const body = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    const user = (await db.select().from(schema.users).where(eq(schema.users.id, me(req).id)).get())!;
    if (!(await verifyPassword(body.current, user.passwordHash))) throw badRequest('当前密码不正确');
    const problem = passwordProblem(body.next);
    if (problem) throw badRequest(problem);
    await db.update(schema.users).set({ passwordHash: await hashPassword(body.next) }).where(eq(schema.users.id, user.id));
    // 改密后所有旧会话失效，再为当前设备签发新会话
    await auth.destroyUserSessions(user.id);
    setSessionCookie(req, reply, await auth.createSession(user.id, { ip: ip(req), userAgent: req.headers['user-agent'] }));
    await auth.audit(me(req), 'password_change', 'user', user.id, '', ip(req));
    return { ok: true };
  });

  /* ---------- 仪表盘 ---------- */

  app.get('/dashboard', async (req) => {
    const def = await i18n.getDefaultLocale();
    const [counts, recent, mediaCount, logs] = await Promise.all([
      postsSvc.counts(req.contentLocale, def),
      postsSvc.listForAdmin({ filter: 'all', page: 1, pageSize: 6, locale: req.contentLocale }),
      db.select({ n: sql<number>`count(*)` }).from(schema.media).get(),
      db
        .select({ id: schema.auditLogs.id, action: schema.auditLogs.action, entity: schema.auditLogs.entity, entityId: schema.auditLogs.entityId, detail: schema.auditLogs.detail, createdAt: schema.auditLogs.createdAt, user: schema.users.displayName })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId))
        .orderBy(desc(schema.auditLogs.id))
        .limit(8),
    ]);
    return { counts, recent: recent.items, mediaCount: mediaCount?.n ?? 0, logs };
  });

  /* ---------- 文章 ---------- */

  app.get('/posts', async (req) => {
    const q = parse(
      z.object({
        filter: z.enum(['all', 'draft', 'published', 'pending', 'unpublished', 'archived', 'trash', 'untranslated']).default('all'),
        q: z.string().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        categoryId: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    // 按分类筛选时包含它的所有下级分类
    const { categoryId, ...rest } = q;
    const node = categoryId ? (await getTree(req.contentLocale)).byId.get(categoryId) : undefined;
    const def = await i18n.getDefaultLocale();
    return { ...(await postsSvc.listForAdmin({ ...rest, categoryIds: node ? descendantIds(node) : undefined, locale: req.contentLocale, sourceLocale: def })), counts: await postsSvc.counts(req.contentLocale, def) };
  });

  app.post('/posts', async (req) => {
    const body = parse(z.object({ title: z.string().max(300).optional() }), req.body ?? {});
    const created = await postsSvc.createPost({ title: body.title, locale: req.contentLocale, authorId: me(req).id });
    await auth.audit(me(req), 'post_create', 'post', created.id, body.title ?? '', ip(req));
    return created;
  });

  app.get('/posts/:id', async (req) => postsSvc.getForEdit(idParam(req)));

  app.put('/posts/:id/draft', async (req) => {
    const { baseVersion, mode, note, force, ...input } = parse(draftSchema, req.body);
    return postsSvc.saveDraft(idParam(req), input, { baseVersion, mode, note, force, userId: me(req).id });
  });

  app.patch('/posts/:id/meta', async (req) => {
    const body = parse(
      z.object({ slug: z.string().optional(), pinned: z.boolean().optional(), featured: z.boolean().optional(), firstPublishedAt: z.number().int().positive().nullable().optional() }),
      req.body,
    );
    const result = await postsSvc.updateMeta(idParam(req), body);
    if (body.slug) await auth.audit(me(req), 'post_slug', 'post', idParam(req), body.slug, ip(req));
    await searchSvc.indexPost(idParam(req));
    return result;
  });

  app.get('/posts/:id/checks', async (req) => {
    const { draft } = await postsSvc.getForEdit(idParam(req));
    return postsSvc.publishChecks(draft);
  });

  const action = (name: string, run: (id: number, req: FastifyRequest) => Promise<unknown>) =>
    app.post(`/posts/:id/${name}`, async (req) => {
      const id = idParam(req);
      const result = await run(id, req);
      await auth.audit(me(req), `post_${name}`, 'post', id, '', ip(req));
      invalidateTaxonomy(); // 发布状态变化会影响分类下的文章计数
      await searchSvc.indexPost(id);
      return result ?? { ok: true };
    });

  action('publish', (id, req) => postsSvc.publish(id, { minor: !!(req.body as { minor?: boolean } | null)?.minor, userId: me(req).id }));
  action('unpublish', (id, req) => postsSvc.setOffline(id, 'unpublished', me(req).id));
  action('archive', (id, req) => postsSvc.setOffline(id, 'archived', me(req).id));
  action('rollback', (id, req) => postsSvc.rollback(id, me(req).id));
  action('trash', (id) => postsSvc.trash(id));
  action('restore', (id) => postsSvc.restoreFromTrash(id));
  action('duplicate', (id, req) => postsSvc.duplicate(id, me(req).id));

  app.delete('/posts/:id', async (req) => {
    const id = idParam(req);
    await postsSvc.purge(id);
    invalidateTaxonomy();
    await searchSvc.indexPost(id);
    await auth.audit(me(req), 'post_purge', 'post', id, '', ip(req));
    return { ok: true };
  });

  app.get('/posts/:id/revisions', async (req) => postsSvc.listRevisions(idParam(req)));
  app.get('/posts/:id/revisions/:rid', async (req) => postsSvc.getRevision(idParam(req), idParam(req, 'rid')));
  app.post('/posts/:id/revisions/:rid/restore', async (req) => {
    const result = await postsSvc.restoreRevision(idParam(req), idParam(req, 'rid'), me(req).id);
    await auth.audit(me(req), 'post_restore_revision', 'post', idParam(req), `#${idParam(req, 'rid')}`, ip(req));
    return result;
  });

  app.get('/slugify', async (req) => {
    const { title = '', exclude } = req.query as { title?: string; exclude?: string };
    return { slug: await postsSvc.uniqueSlug(slugify(title), req.contentLocale, exclude ? Number(exclude) : undefined) };
  });

  /* ---------- 媒体 ---------- */

  app.get('/media', async (req) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(40), unused: z.string().optional() }), req.query);
    return mediaSvc.listMedia({ ...q, unused: q.unused === '1' });
  });

  app.post('/media', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('没有收到文件');
    const buffer = await file.toBuffer(); // 超过大小上限会抛错
    const { name } = req.query as { name?: string };
    const saved = await mediaSvc.saveImage({ buffer, originalName: file.filename || 'image', preferredName: name, uploaderId: me(req).id });
    if (!saved.duplicate) await auth.audit(me(req), 'media_upload', 'media', saved.id, saved.path, ip(req));
    return saved;
  });

  app.patch('/media/:id', async (req) => mediaSvc.updateMedia(idParam(req), parse(z.object({ alt: z.string().max(500).optional(), caption: z.string().max(1000).optional() }), req.body)));

  app.get('/media/:id/usages', async (req) => mediaSvc.findUsages(idParam(req)));

  app.delete('/media/:id', async (req) => {
    const id = idParam(req);
    const usages = await mediaSvc.findUsages(id);
    // 被引用的文件必须由前端展示影响范围后带 force 再删
    if (usages.length && (req.query as { force?: string }).force !== '1') throw new HttpError(409, '该文件仍被文章引用', { usages });
    await mediaSvc.deleteMedia(id);
    await auth.audit(me(req), 'media_delete', 'media', id, '', ip(req));
    return { ok: true };
  });

  /* ---------- 设置 ---------- */

  app.get('/settings', async () => getSettings());

  app.put('/settings', async (req) => {
    const body = parse(
      z
        .object({
          siteName: z.string().trim().min(1).max(100),
          tagline: z.string().max(200),
          description: z.string().max(500),
          siteUrl: z.string().max(200).regex(/^(https?:\/\/[^\s/]+)?$/, '需为 http(s):// 开头的站点地址，末尾不带斜杠'),
          timezone: z.string().max(64),
          postsPerPage: z.number().int().min(1).max(50),
          appearance: z.enum(['light', 'dark', 'auto']),
          icp: z.string().max(100),
          footerText: z.string().max(500),
          langFallback: z.enum(['home', 'hide']),
          siteNoindex: z.boolean(),
        })
        .partial(),
      req.body,
    );
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: body.timezone });
      } catch {
        throw badRequest('无效的时区');
      }
    }
    const result = await updateSettings(body);
    await auth.audit(me(req), 'settings_update', 'settings', '', Object.keys(body).join(','), ip(req));
    return result;
  });

  await app.register(adminOrgRoutes);
  await app.register(adminShowcaseRoutes);
  await app.register(adminI18nRoutes);
  await app.register(adminThemeRoutes);
  await app.register(adminToolRoutes);
}

declare module 'fastify' {
  interface FastifyRequest {
    user: auth.AuthUser | null;
    contentLocale: string;
  }
}
