/**
 * 多语言：站点支持的语言、地址前缀、各语言的站点文案与界面文案覆盖。
 * 默认语言的地址不带前缀，其他语言带前缀（/en/...）。
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, schema, transaction } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { RESERVED_SLUGS } from '../lib/slug.ts';
import { getSettings, updateSettings, type SiteSettings } from './settings.ts';

const { languages, settings, uiTranslations, postTranslations } = schema;

export interface Language {
  code: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  sort: number;
  /** 地址前缀（不含斜杠）；默认语言为空串 */
  prefix: string;
}

let cache: Language[] | null = null;
/** 启用中的非默认语言：地址前缀 → 语言代码。供同步的地址改写使用 */
let prefixMap = new Map<string, string>();
let defaultCode = 'zh-CN';

export async function listLanguages(): Promise<Language[]> {
  if (cache) return cache;
  const rows = await db.select().from(languages).orderBy(asc(languages.sort), asc(languages.code));
  const s = await getSettings();
  // 安装向导完成之前语言表是空的，用设置里的默认语言兜底
  const list = rows.length ? rows : [{ code: s.defaultLocale, name: s.defaultLocale, enabled: 1, isDefault: 1, sort: 0 }];
  const def = list.find((l) => l.isDefault) ?? list[0];
  cache = list.map((l) => ({ code: l.code, name: l.name, enabled: !!l.enabled || l.code === def.code, isDefault: l.code === def.code, sort: l.sort, prefix: l.code === def.code ? '' : l.code.toLowerCase() }));
  defaultCode = def.code;
  prefixMap = new Map(cache.filter((l) => l.enabled && !l.isDefault).map((l) => [l.prefix, l.code]));
  return cache;
}

/** 语言表被直接改动之后（例如安装向导）调用，刷新缓存与地址前缀 */
export function refreshLanguages() {
  cache = null;
  return listLanguages();
}
const invalidate = refreshLanguages;

export const getDefaultLocale = async () => (await listLanguages()).find((l) => l.isDefault)!.code;
export const enabledLanguages = async () => (await listLanguages()).filter((l) => l.enabled);
/** 同步读取（需先调用过 listLanguages，应用启动时会预热） */
export const defaultLocaleSync = () => defaultCode;

/** 地址的第一段若是某个启用语言的前缀，返回该语言与去掉前缀后的地址 */
export function splitLocale(url: string): { locale: string; url: string } | null {
  const match = /^\/([A-Za-z0-9-]+)(?=\/|\?|$)/.exec(url);
  if (!match) return null;
  const locale = prefixMap.get(match[1].toLowerCase());
  if (!locale) return null;
  const rest = url.slice(match[0].length);
  return { locale, url: rest.startsWith('/') ? rest : `/${rest}` };
}

/** 某语言的地址前缀：默认语言为 ''，其他为 '/en' */
export async function prefixFor(locale: string): Promise<string> {
  const lang = (await listLanguages()).find((l) => l.code === locale);
  return lang && !lang.isDefault ? `/${lang.prefix}` : '';
}

/** 后台请求里指定的内容语言：必须是已登记的语言，否则用默认语言 */
export async function resolveContentLocale(requested: string | undefined): Promise<string> {
  const list = await listLanguages();
  return list.find((l) => l.code === requested)?.code ?? list.find((l) => l.isDefault)!.code;
}

function canonicalCode(raw: string): string {
  let code: string;
  try {
    [code] = Intl.getCanonicalLocales(raw.trim());
  } catch {
    throw badRequest('语言代码不合法，请使用类似 en、ja、zh-TW 的写法');
  }
  if (!code || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) throw badRequest('语言代码不合法，请使用类似 en、ja、zh-TW 的写法');
  const prefix = code.toLowerCase();
  if (RESERVED_SLUGS.has(prefix) && prefix !== 'en' && prefix !== 'zh') throw badRequest(`“${code}”与系统地址冲突，不能作为语言代码`);
  return code;
}

export async function addLanguage(input: { code: string; name: string }) {
  const code = canonicalCode(input.code);
  const name = input.name.trim();
  if (!name) throw badRequest('语言名称不能为空');
  const list = await listLanguages();
  if (list.some((l) => l.code.toLowerCase() === code.toLowerCase())) throw badRequest('该语言已存在');
  await db.insert(languages).values({ code, name, enabled: 0, isDefault: 0, sort: list.length ? Math.max(...list.map((l) => l.sort)) + 1 : 0 });
  await invalidate();
  return code;
}

export async function updateLanguage(code: string, patch: { name?: string; enabled?: boolean }) {
  const lang = (await listLanguages()).find((l) => l.code === code);
  if (!lang) throw notFound('语言');
  const set: Partial<typeof languages.$inferInsert> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw badRequest('语言名称不能为空');
    set.name = patch.name.trim();
  }
  if (patch.enabled !== undefined) {
    if (lang.isDefault && !patch.enabled) throw badRequest('默认语言不能停用');
    set.enabled = patch.enabled ? 1 : 0;
  }
  if (Object.keys(set).length) await db.update(languages).set(set).where(eq(languages.code, code));
  await invalidate();
}

export async function reorderLanguages(codes: string[]) {
  await transaction(async () => {
    for (const [sort, code] of codes.entries()) await db.update(languages).set({ sort }).where(eq(languages.code, code));
  });
  await invalidate();
}

/** 更换默认语言：新的默认语言地址去掉前缀，原默认语言的地址加上前缀 */
export async function setDefaultLanguage(code: string) {
  const lang = (await listLanguages()).find((l) => l.code === code);
  if (!lang) throw notFound('语言');
  await transaction(async () => {
    await db.update(languages).set({ isDefault: 0 });
    await db.update(languages).set({ isDefault: 1, enabled: 1 }).where(eq(languages.code, code));
  });
  await updateSettings({ defaultLocale: code });
  await invalidate();
}

export async function deleteLanguage(code: string) {
  const lang = (await listLanguages()).find((l) => l.code === code);
  if (!lang) throw notFound('语言');
  if (lang.isDefault) throw badRequest('不能删除默认语言');
  const used = await db.select({ n: sql<number>`count(*)` }).from(postTranslations).where(eq(postTranslations.locale, code)).get();
  if (used?.n) throw badRequest(`该语言下还有 ${used.n} 篇文章译文。如果只是不想对外展示，请停用它。`);
  await db.delete(languages).where(eq(languages.code, code));
  await invalidate();
}

/* ---------- 各语言的站点文案 ---------- */

export const SITE_TEXT_KEYS = ['siteName', 'tagline', 'description', 'footerText'] as const;
export type SiteTexts = Partial<Pick<SiteSettings, (typeof SITE_TEXT_KEYS)[number]>>;
const textCache = new Map<string, SiteTexts>();

export async function getSiteTexts(locale: string): Promise<SiteTexts> {
  if (textCache.has(locale)) return textCache.get(locale)!;
  const row = await db.select().from(settings).where(eq(settings.key, `i18n.${locale}`)).get();
  let value: SiteTexts = {};
  try {
    value = row ? JSON.parse(row.value) : {};
  } catch {
    /* 使用空对象 */
  }
  textCache.set(locale, value);
  return value;
}

export async function setSiteTexts(locale: string, texts: SiteTexts) {
  const clean: SiteTexts = {};
  for (const key of SITE_TEXT_KEYS) if (typeof texts[key] === 'string' && texts[key]!.trim()) clean[key] = texts[key]!.trim();
  const json = JSON.stringify(clean);
  await db.insert(settings).values({ key: `i18n.${locale}`, value: json }).onConflictDoUpdate({ target: settings.key, set: { value: json } });
  textCache.delete(locale);
}

/** 站点设置 + 当前语言的文案覆盖（留空的项回退到默认语言的设置） */
export async function getLocalizedSettings(locale: string): Promise<SiteSettings> {
  const base = await getSettings();
  return locale === (await getDefaultLocale()) ? base : { ...base, ...(await getSiteTexts(locale)) };
}

/* ---------- 界面文案覆盖 ---------- */

const uiCache = new Map<string, Record<string, string>>();

export async function getUiOverrides(locale: string): Promise<Record<string, string>> {
  if (uiCache.has(locale)) return uiCache.get(locale)!;
  const rows = await db.select().from(uiTranslations).where(eq(uiTranslations.locale, locale));
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  uiCache.set(locale, map);
  return map;
}

/** 写入一批覆盖项；值为空串表示删除覆盖、恢复默认 */
export async function setUiOverrides(locale: string, entries: Record<string, string>) {
  await transaction(async () => {
    for (const [key, value] of Object.entries(entries)) {
      if (value.trim()) await db.insert(uiTranslations).values({ locale, key, value }).onConflictDoUpdate({ target: [uiTranslations.locale, uiTranslations.key], set: { value } });
      else await db.delete(uiTranslations).where(and(eq(uiTranslations.locale, locale), eq(uiTranslations.key, key)));
    }
  });
  uiCache.delete(locale);
}
