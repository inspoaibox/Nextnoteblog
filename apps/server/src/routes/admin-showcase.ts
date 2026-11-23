/** 管理接口：友链、开源项目 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.ts';
import * as auth from '../services/auth.ts';
import * as showcase from '../services/showcase.ts';
import { getSettings, updateSettings } from '../services/settings.ts';

const idOf = (req: FastifyRequest) => {
  const n = Number((req.params as Record<string, string>).id);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('参数错误');
  return n;
};
function parse<T>(shape: z.ZodType<T>, data: unknown): T {
  const result = shape.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`参数错误：${issue.path.join('.') || '请求体'} ${issue.message}`);
  }
  return result.data;
}

const linkShape = z.object({
  name: z.string().max(100).optional(),
  url: z.string().max(500).optional(),
  description: z.string().max(300).optional(),
  avatar: z.string().max(500).optional(),
  groupName: z.string().max(50).optional(),
  sort: z.number().int().optional(),
  visible: z.boolean().optional(),
});

const projectShape = z.object({
  name: z.string().max(100).optional(),
  slug: z.string().trim().max(120).optional(),
  tagline: z.string().max(300).optional(),
  markdown: z.string().max(500_000).optional(),
  repoUrl: z.string().max(500).optional(),
  homepage: z.string().max(500).optional(),
  docsUrl: z.string().max(500).optional(),
  downloadUrl: z.string().max(500).optional(),
  license: z.string().max(60).optional(),
  language: z.string().max(60).optional(),
  logo: z.string().max(500).optional(),
  status: z.enum(showcase.PROJECT_STATUSES).optional(),
  featured: z.boolean().optional(),
  sort: z.number().int().optional(),
  visible: z.boolean().optional(),
  tagId: z.number().int().positive().nullable().optional(),
  stars: z.number().int().min(0).optional(),
  forks: z.number().int().min(0).optional(),
  latestVersion: z.string().max(60).optional(),
});

export async function adminShowcaseRoutes(app: FastifyInstance) {
  const log = (req: FastifyRequest, action: string, entity: string, entityId: string | number = '', detail: unknown = '') => auth.audit(req.user, action, entity, entityId, detail, req.ip);

  /* ---------- 友链 ---------- */

  app.get('/links', async () => ({ links: (await showcase.listLinks()).map((l) => ({ ...l, visible: !!l.visible })), intro: (await getSettings()).linksIntro }));

  app.post('/links', async (req) => {
    const body = parse(linkShape, req.body);
    const id = await showcase.createLink(body);
    await log(req, 'link_create', 'link', id, body.name);
    return { id };
  });

  app.patch('/links/:id', async (req) => {
    await showcase.updateLink(idOf(req), parse(linkShape, req.body));
    await log(req, 'link_update', 'link', idOf(req));
    return { ok: true };
  });

  app.delete('/links/:id', async (req) => {
    await showcase.deleteLink(idOf(req));
    await log(req, 'link_delete', 'link', idOf(req));
    return { ok: true };
  });

  app.post('/links/reorder', async (req) => {
    await showcase.reorderLinks(parse(z.object({ ids: z.array(z.number().int()).max(2000) }), req.body).ids);
    return { ok: true };
  });

  app.put('/links/intro', async (req) => {
    await updateSettings({ linksIntro: parse(z.object({ intro: z.string().max(20_000) }), req.body).intro });
    return { ok: true };
  });

  /* ---------- 开源项目 ---------- */

  app.get('/projects', async (req) => ({ projects: await showcase.listProjects(req.contentLocale), intro: (await getSettings()).projectsIntro }));

  app.get('/projects/:id', async (req) => showcase.getProject(idOf(req), req.contentLocale));

  app.post('/projects', async (req) => {
    const body = parse(projectShape, req.body);
    const id = await showcase.createProject(req.contentLocale, body);
    await log(req, 'project_create', 'project', id, body.name);
    return { id };
  });

  app.patch('/projects/:id', async (req) => {
    await showcase.updateProject(idOf(req), req.contentLocale, parse(projectShape, req.body));
    await log(req, 'project_update', 'project', idOf(req));
    return showcase.getProject(idOf(req), req.contentLocale);
  });

  app.delete('/projects/:id', async (req) => {
    await showcase.deleteProject(idOf(req));
    await log(req, 'project_delete', 'project', idOf(req));
    return { ok: true };
  });

  app.post('/projects/:id/sync', async (req) => {
    await showcase.syncProject(idOf(req));
    return showcase.getProject(idOf(req), req.contentLocale);
  });

  app.post('/projects/sync', async () => showcase.syncAllProjects());

  app.put('/projects/intro', async (req) => {
    await updateSettings({ projectsIntro: parse(z.object({ intro: z.string().max(20_000) }), req.body).intro });
    return { ok: true };
  });
}
