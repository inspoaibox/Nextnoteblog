/** M4 管理接口：主题库、切换、预览、配置、导入与卸载 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.ts';
import * as auth from '../services/auth.ts';
import * as themes from '../services/themes.ts';
import { ENGINE_VERSION, REQUIRED_TEMPLATES } from '../theme/engine.ts';
import { getSettings } from '../services/settings.ts';

export const PREVIEW_COOKIE = 'nb_theme_preview';
const MAX_PACKAGE = 20 * 1024 * 1024;

const idOf = (req: FastifyRequest) => String((req.params as { id: string }).id);
function parse<T>(shape: z.ZodType<T>, data: unknown): T {
  const result = shape.safeParse(data ?? {});
  if (!result.success) throw badRequest(`参数错误：${result.error.issues[0].path.join('.') || '请求体'} ${result.error.issues[0].message}`);
  return result.data;
}

async function packageOf(req: FastifyRequest): Promise<Buffer> {
  const file = await req.file({ limits: { fileSize: MAX_PACKAGE } });
  if (!file) throw badRequest('没有收到主题安装包');
  return file.toBuffer();
}

export async function adminThemeRoutes(app: FastifyInstance) {
  const audit = (req: FastifyRequest, action: string, id: string, detail: unknown = '') => auth.audit(req.user, action, 'theme', id, detail, req.ip);

  app.get('/themes', async (req) => {
    const s = await getSettings();
    return {
      themes: await themes.listThemes(),
      active: s.activeTheme,
      previous: s.previousTheme,
      previewing: req.cookies[PREVIEW_COOKIE] ?? '',
      spec: { version: ENGINE_VERSION, requiredTemplates: REQUIRED_TEMPLATES },
      logs: await themes.recentLogs(20),
    };
  });

  app.get('/themes/:id', async (req) => themes.getTheme(idOf(req)));

  /* ---------- 切换与回退 ---------- */

  app.post('/themes/:id/activate', async (req) => {
    await themes.activateTheme(idOf(req), req.user!.id);
    await audit(req, 'theme_activate', idOf(req));
    return { ok: true };
  });

  app.post('/themes/rollback', async (req) => {
    const target = await themes.rollbackTheme(req.user!.id);
    await audit(req, 'theme_rollback', target);
    return { active: target };
  });

  app.post('/themes/:id/version', async (req) => {
    const body = parse(z.object({ version: z.string().max(40) }), req.body);
    await themes.setThemeVersion(idOf(req), body.version, req.user!.id);
    await audit(req, 'theme_version', idOf(req), body.version);
    return themes.getTheme(idOf(req));
  });

  app.delete('/themes/:id/versions/:version', async (req) => {
    await themes.removeVersion(idOf(req), String((req.params as { version: string }).version), req.user!.id);
    return themes.getTheme(idOf(req));
  });

  app.post('/themes/:id/trust', async (req) => {
    const body = parse(z.object({ trusted: z.boolean() }), req.body);
    await themes.setTrusted(idOf(req), body.trusted, req.user!.id);
    await audit(req, 'theme_trust', idOf(req), body.trusted);
    return themes.getTheme(idOf(req));
  });

  /* ---------- 预览：只对当前管理员的浏览器生效 ---------- */

  app.post('/themes/:id/preview', async (req, reply) => {
    const body = parse(z.object({ version: z.string().max(40).optional() }), req.body);
    if (!themes.previewTheme(idOf(req), body.version)) throw badRequest('主题或版本不存在');
    reply.setCookie(PREVIEW_COOKIE, body.version ? `${idOf(req)}@${body.version}` : idOf(req), { path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: 3600 });
    return { ok: true };
  });

  app.post('/themes/preview/stop', async (_req, reply) => {
    reply.clearCookie(PREVIEW_COOKIE, { path: '/' });
    return { ok: true };
  });

  /* ---------- 配置 ---------- */

  app.put('/themes/:id/config', async (req) => themes.saveConfigDraft(idOf(req), parse(z.object({ values: z.record(z.string(), z.unknown()) }), req.body).values));

  for (const [action, run] of [
    ['apply', themes.applyConfig],
    ['revert', themes.revertConfig],
    ['reset', themes.resetConfig],
  ] as const) {
    app.post(`/themes/:id/config/${action}`, async (req) => {
      const result = await run(idOf(req), req.user!.id);
      await audit(req, `theme_config_${action}`, idOf(req));
      return result;
    });
  }

  /* ---------- 导入 ---------- */

  // 只检查不安装：把校验结果、主题信息、脚本清单给管理员看
  app.post('/themes/inspect', async (req) => themes.inspectPackage(await packageOf(req)));

  app.post('/themes/install', async (req) => {
    const result = await themes.installPackage(await packageOf(req), req.user!.id);
    await audit(req, result.report.isUpgrade ? 'theme_upgrade' : 'theme_install', result.theme.id, result.report.manifest?.version);
    return result;
  });

  app.delete('/themes/:id', async (req) => {
    await themes.uninstallTheme(idOf(req), req.user!.id);
    await audit(req, 'theme_uninstall', idOf(req));
    return { ok: true };
  });
}
