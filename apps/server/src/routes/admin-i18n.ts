/** M3 管理接口：语言、各语言站点文案、界面文案、译文关联 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.ts';
import * as auth from '../services/auth.ts';
import * as i18n from '../services/i18n.ts';
import * as postsSvc from '../services/posts.ts';
import * as org from '../services/organize.ts';
import { getSettings } from '../services/settings.ts';
import { themeStrings } from '../theme/engine.ts';
import { liveTheme } from '../services/themes.ts';

function parse<T>(shape: z.ZodType<T>, data: unknown): T {
  const result = shape.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`参数错误：${issue.path.join('.') || '请求体'} ${issue.message}`);
  }
  return result.data;
}
const codeOf = (req: FastifyRequest) => String((req.params as { code: string }).code);
const idOf = (req: FastifyRequest) => {
  const n = Number((req.params as { id: string }).id);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('参数错误');
  return n;
};

export async function adminI18nRoutes(app: FastifyInstance) {
  const log = (req: FastifyRequest, action: string, entityId: string | number = '', detail: unknown = '') => auth.audit(req.user, action, 'language', entityId, detail, req.ip);

  /* ---------- 语言 ---------- */

  app.get('/languages', async () => i18n.listLanguages());

  app.post('/languages', async (req) => {
    const body = parse(z.object({ code: z.string().max(20), name: z.string().max(50) }), req.body);
    const code = await i18n.addLanguage(body);
    await log(req, 'language_add', code);
    return i18n.listLanguages();
  });

  app.patch('/languages/:code', async (req) => {
    const body = parse(z.object({ name: z.string().max(50).optional(), enabled: z.boolean().optional() }), req.body);
    await i18n.updateLanguage(codeOf(req), body);
    await log(req, 'language_update', codeOf(req), body);
    return i18n.listLanguages();
  });

  app.post('/languages/:code/default', async (req) => {
    await i18n.setDefaultLanguage(codeOf(req));
    await log(req, 'language_default', codeOf(req));
    return i18n.listLanguages();
  });

  app.put('/languages/order', async (req) => {
    const body = parse(z.object({ codes: z.array(z.string()).max(50) }), req.body);
    await i18n.reorderLanguages(body.codes);
    return i18n.listLanguages();
  });

  app.delete('/languages/:code', async (req) => {
    await i18n.deleteLanguage(codeOf(req));
    await log(req, 'language_delete', codeOf(req));
    return i18n.listLanguages();
  });

  /* ---------- 各语言的站点文案 ---------- */

  app.get('/site-texts', async (req) => ({ locale: req.contentLocale, texts: await i18n.getSiteTexts(req.contentLocale), fallback: await getSettings() }));

  app.put('/site-texts', async (req) => {
    const body = parse(z.object({ siteName: z.string().max(100).optional(), tagline: z.string().max(200).optional(), description: z.string().max(500).optional(), footerText: z.string().max(500).optional() }), req.body);
    await i18n.setSiteTexts(req.contentLocale, body);
    await log(req, 'site_texts_update', req.contentLocale);
    return { ok: true };
  });

  /* ---------- 界面文案 ---------- */

  // 每个文案项：默认语言的原文、主题自带的译文、后台的覆盖值
  app.get('/ui-strings', async (req) => {
    const def = await i18n.getDefaultLocale();
    const themeId = (await liveTheme()).id;
    const base = themeStrings(themeId, def);
    const own = themeStrings(themeId, req.contentLocale);
    const overrides = await i18n.getUiOverrides(req.contentLocale);
    return {
      locale: req.contentLocale,
      isDefault: req.contentLocale === def,
      items: Object.keys(base).map((key) => ({ key, source: base[key], builtin: req.contentLocale === def ? base[key] : (own[key] ?? ''), override: overrides[key] ?? '' })),
    };
  });

  app.put('/ui-strings', async (req) => {
    const body = parse(z.object({ entries: z.record(z.string().max(100), z.string().max(1000)) }), req.body);
    await i18n.setUiOverrides(req.contentLocale, body.entries);
    await log(req, 'ui_strings_update', req.contentLocale, Object.keys(body.entries).length);
    return { ok: true };
  });

  /* ---------- 译文 ---------- */

  app.post('/posts/:id/translate', async (req) => {
    const body = parse(z.object({ locale: z.string().max(20) }), req.body);
    const locale = await i18n.resolveContentLocale(body.locale);
    if (locale !== body.locale) throw badRequest('目标语言不存在');
    const created = await postsSvc.createTranslation(idOf(req), locale, req.user!.id);
    await auth.audit(req.user, 'post_translate', 'post', created.id, locale, req.ip);
    return created;
  });

  app.post('/posts/:id/synced', async (req) => postsSvc.markTranslationSynced(idOf(req)));

  app.post('/pages/translate', async (req) => {
    const body = parse(z.object({ pageId: z.number().int() }), req.body);
    return { id: await org.translatePage(body.pageId, req.contentLocale) };
  });
}
