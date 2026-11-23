/**
 * 主题引擎：主题 = Liquid 模板 + 静态资源。
 * Liquid 是受限模板语言，不能执行服务器代码、读写文件或访问数据库，
 * 只能使用这里提供的数据与过滤器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Liquid } from 'liquidjs';
import { config } from '../config.ts';
import { defaultLocaleSync } from '../services/i18n.ts';

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
}

interface LoadedTheme {
  manifest: ThemeManifest;
  dir: string;
  liquid: Liquid;
  locales: Record<string, Record<string, string>>;
}

function lookup(locales: Record<string, Record<string, string>>, locale: string, key: string): string {
  const base = locale.split('-')[0];
  return locales[locale]?.[key] ?? locales[base]?.[key] ?? locales[defaultLocaleSync()]?.[key] ?? locales['zh-CN']?.[key] ?? key;
}

/** 服务端代码里取主题文案（页面标题等），规则与模板里的 t 过滤器一致 */
export function translate(themeId: string, locale: string, key: string, overrides: Record<string, string> = {}, vars: Record<string, string | number> = {}): string {
  let text = overrides[key] ?? lookup(loadTheme(themeId).locales, locale, key);
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

/** 主题某个语言包的全部文案（后台“界面文案”页用） */
export function themeStrings(themeId: string, locale: string): Record<string, string> {
  const { locales } = loadTheme(themeId);
  return locales[locale] ?? locales[locale.split('-')[0]] ?? {};
}

const REQUIRED_TEMPLATES = ['layout', 'home', 'post-list', 'post', 'category', 'tags', 'collection', 'archive', 'search', 'page', '404'];
const loaded = new Map<string, LoadedTheme>();

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadTheme(id: string): LoadedTheme {
  const cached = loaded.get(id);
  if (cached && config.isProd) return cached;

  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`非法的主题标识：${id}`);
  const dir = path.join(config.themesDir, id);
  const manifest = readJson(path.join(dir, 'theme.json')) as ThemeManifest;
  const templates = path.join(dir, 'templates');
  for (const name of REQUIRED_TEMPLATES) {
    if (!fs.existsSync(path.join(templates, `${name}.liquid`))) throw new Error(`主题 ${id} 缺少必需模板 ${name}.liquid`);
  }

  const locales: LoadedTheme['locales'] = {};
  const localesDir = path.join(dir, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const file of fs.readdirSync(localesDir)) {
      if (file.endsWith('.json')) locales[path.basename(file, '.json')] = readJson(path.join(localesDir, file));
    }
  }

  const liquid = new Liquid({
    root: templates,
    partials: templates,
    layouts: templates,
    extname: '.liquid',
    cache: config.isProd,
    outputEscape: 'escape', // 默认转义输出；可信的 HTML 需显式使用 raw 过滤器
    strictFilters: true,
    relativeReference: false,
  });

  const assetBase = `/theme/${manifest.id}/${manifest.version}`;
  liquid.registerFilter('asset_url', (file: string) => `${assetBase}/${String(file).replace(/^\/+/, '')}`);
  // 文案查找顺序：后台覆盖 → 主题当前语言 → 主题默认语言 → 主题 zh-CN → 键名本身
  liquid.registerFilter('t', function (this: any, key: string) {
    const locale = String(this.context.getSync(['site', 'locale']) ?? 'zh-CN');
    const overrides = (this.context.getSync(['_ui']) ?? {}) as Record<string, string>;
    return overrides[key] ?? lookup(locales, locale, key);
  });
  // 站内地址加上当前语言的前缀：{{ '/posts' | url }}
  liquid.registerFilter('url', function (this: any, path: string) {
    const prefix = String(this.context.getSync(['site', 'prefix']) ?? '');
    return prefix + (path === '/' && prefix ? '' : path) || '/';
  });
  // style：long / medium / short 为完整日期；year 只取年份；md 只取“月日”（用于按年分组的索引）
  liquid.registerFilter('date_fmt', function (this: any, value: number, style: 'long' | 'medium' | 'short' | 'year' | 'md' = 'long') {
    if (!value) return '';
    const locale = String(this.context.getSync(['site', 'locale']) ?? 'zh-CN');
    const timeZone = String(this.context.getSync(['site', 'timezone']) ?? 'UTC');
    const options: Intl.DateTimeFormatOptions = style === 'year' ? { year: 'numeric' } : style === 'md' ? { month: 'short', day: 'numeric' } : { dateStyle: style };
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(value));
  });
  liquid.registerFilter('date_iso', (value: number) => (value ? new Date(value).toISOString() : ''));
  liquid.registerFilter('num', function (this: any, value: number) {
    const locale = String(this.context.getSync(['site', 'locale']) ?? 'zh-CN');
    return new Intl.NumberFormat(locale).format(Number(value) || 0);
  });

  const theme: LoadedTheme = { manifest, dir, liquid, locales };
  loaded.set(id, theme);
  return theme;
}

export async function renderPage(themeId: string, template: string, context: Record<string, unknown>): Promise<string> {
  const theme = loadTheme(themeId);
  const assetBase = `/theme/${theme.manifest.id}/${theme.manifest.version}`;
  const themeInfo = { ...theme.manifest, asset_base: assetBase };
  // render 引入的片段有独立作用域：把语言相关的数据作为全局量传入，片段里的 t / url / 日期过滤器才能拿到当前语言
  return theme.liquid.renderFile(template, { ...context, theme: themeInfo }, { globals: { site: context.site, _ui: context._ui, theme: themeInfo } });
}

/** 主题静态资源目录（只暴露 assets/，模板与配置不可下载） */
export function themeAssetsDir(id: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const dir = path.join(config.themesDir, id, 'assets');
  return fs.existsSync(dir) ? dir : null;
}
