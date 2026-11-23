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

/** 主题规范的版本：主题在 theme.json 的 requires 里声明自己需要的最低版本 */
export const ENGINE_VERSION = '1.0.0';
export const REQUIRED_TEMPLATES = ['layout', 'home', 'post-list', 'post', 'category', 'tags', 'collection', 'archive', 'search', 'page', '404'];
/** 可选模板：主题没有时，内容用默认主题的同名片段渲染，再套进本主题的 page 模板 */
export const OPTIONAL_TEMPLATES = ['links', 'projects', 'project'];
export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

export interface ThemeSetting {
  key: string;
  type: 'color' | 'text' | 'select' | 'boolean' | 'number';
  label: string;
  hint?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** 需要的主题规范版本，如 ">=1.0.0" */
  requires?: string;
  /** 管理员可以调整的外观选项，后台据此生成配置表单 */
  settings?: ThemeSetting[];
}

export interface LoadedTheme {
  manifest: ThemeManifest;
  dir: string;
  liquid: Liquid;
  locales: Record<string, Record<string, string>>;
}

/** 主题目录的位置由主题服务决定（内置目录，或数据目录里某个已安装的版本） */
type Resolver = (id: string, version?: string) => { dir: string; version: string } | null;
let resolver: Resolver = (id) => (THEME_ID_PATTERN.test(id) && fs.existsSync(path.join(config.themesDir, id, 'theme.json')) ? { dir: path.join(config.themesDir, id), version: '' } : null);
export function setThemeResolver(fn: Resolver) {
  resolver = fn;
  loaded.clear();
}

function lookup(locales: Record<string, Record<string, string>>, locale: string, key: string): string {
  const base = locale.split('-')[0];
  return locales[locale]?.[key] ?? locales[base]?.[key] ?? locales[defaultLocaleSync()]?.[key] ?? locales['zh-CN']?.[key] ?? key;
}

/** 服务端代码里取主题文案（页面标题等），规则与模板里的 t 过滤器一致 */
export function translate(themeId: string, locale: string, key: string, overrides: Record<string, string> = {}, vars: Record<string, string | number> = {}): string {
  let text = overrides[key] ?? lookup(loadTheme(themeId).locales, locale, key);
  // 较早做的主题可能没有后来新增的文案（例如友链、开源项目）：用内置默认主题的文案补上
  if (text === key && themeId !== 'default') text = lookup(loadTheme('default').locales, locale, key);
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

/** 主题某个语言包的全部文案（后台“界面文案”页用） */
export function themeStrings(themeId: string, locale: string): Record<string, string> {
  const { locales } = loadTheme(themeId);
  return locales[locale] ?? locales[locale.split('-')[0]] ?? {};
}

const loaded = new Map<string, LoadedTheme>();
export const clearThemeCache = () => loaded.clear();

export function readManifest(dir: string): ThemeManifest {
  return JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')) as ThemeManifest;
}

/** 从一个目录构造主题（不走缓存）。导入校验时也用它对解压出来的临时目录做试渲染 */
export function buildTheme(dir: string): LoadedTheme {
  const manifest = readManifest(dir);
  const templates = path.join(dir, 'templates');
  for (const name of REQUIRED_TEMPLATES) {
    if (!fs.existsSync(path.join(templates, `${name}.liquid`))) throw new Error(`缺少必需模板 templates/${name}.liquid`);
  }

  const locales: LoadedTheme['locales'] = {};
  const localesDir = path.join(dir, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const file of fs.readdirSync(localesDir)) {
      if (file.endsWith('.json')) locales[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
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

  const ctx = (self: any, name: string[], fallback: string) => String(self.context.getSync(name) ?? fallback);
  liquid.registerFilter('asset_url', function (this: any, file: string) {
    return `${ctx(this, ['theme', 'asset_base'], '')}/${String(file).replace(/^\/+/, '')}`;
  });
  // 文案查找顺序：后台覆盖 → 主题当前语言 → 主题默认语言 → 主题 zh-CN → 键名本身
  liquid.registerFilter('t', function (this: any, key: string) {
    const overrides = (this.context.getSync(['_ui']) ?? {}) as Record<string, string>;
    const locale = ctx(this, ['site', 'locale'], 'zh-CN');
    const text = overrides[key] ?? lookup(locales, locale, key);
    // 主题缺少某条文案（多半是系统后来新增的）：用内置默认主题的补上，而不是把键名显示给访客
    return text === key && manifest.id !== 'default' ? lookup(loadTheme('default').locales, locale, key) : text;
  });
  // 站内地址加上当前语言的前缀：{{ '/posts' | url }}
  liquid.registerFilter('url', function (this: any, p: string) {
    const prefix = ctx(this, ['site', 'prefix'], '');
    return prefix + (p === '/' && prefix ? '' : p) || '/';
  });
  // style：long / medium / short 为完整日期；year 只取年份；md 只取“月日”（用于按年分组的索引）
  liquid.registerFilter('date_fmt', function (this: any, value: number, style: 'long' | 'medium' | 'short' | 'year' | 'md' = 'long') {
    if (!value) return '';
    const options: Intl.DateTimeFormatOptions = style === 'year' ? { year: 'numeric' } : style === 'md' ? { month: 'short', day: 'numeric' } : { dateStyle: style };
    return new Intl.DateTimeFormat(ctx(this, ['site', 'locale'], 'zh-CN'), { ...options, timeZone: ctx(this, ['site', 'timezone'], 'UTC') }).format(new Date(value));
  });
  liquid.registerFilter('date_iso', (value: number) => (value ? new Date(value).toISOString() : ''));
  liquid.registerFilter('num', function (this: any, value: number) {
    return new Intl.NumberFormat(ctx(this, ['site', 'locale'], 'zh-CN')).format(Number(value) || 0);
  });

  return { manifest, dir, liquid, locales };
}

export function loadTheme(id: string, version?: string): LoadedTheme {
  const where = resolver(id, version);
  if (!where) throw new Error(`主题不存在：${id}${version ? `@${version}` : ''}`);
  const key = `${id}@${where.version}`;
  const cached = loaded.get(key);
  if (cached && config.isProd) return cached;
  const theme = buildTheme(where.dir);
  loaded.set(key, theme);
  return theme;
}

/** 合并主题声明的默认值与管理员保存的配置；未声明的键一律丢弃 */
export function resolveConfig(manifest: ThemeManifest, saved: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const setting of manifest.settings ?? []) {
    const value = saved[setting.key];
    out[setting.key] = isValidSettingValue(setting, value) ? (value as string | number | boolean) : (setting.default ?? (setting.type === 'boolean' ? false : ''));
  }
  return out;
}

/** 配置值会被主题写进页面（包括 <style>），因此按类型严格校验 */
export function isValidSettingValue(setting: ThemeSetting, value: unknown): boolean {
  switch (setting.type) {
    case 'color':
      return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (setting.min == null || value >= setting.min) && (setting.max == null || value <= setting.max);
    case 'select':
      return typeof value === 'string' && !!setting.options?.some((o) => o.value === value);
    case 'text':
      return typeof value === 'string' && value.length <= 500;
    default:
      return false;
  }
}

export async function renderWith(theme: LoadedTheme, template: string, context: Record<string, unknown>, themeConfig: Record<string, unknown> = {}): Promise<string> {
  const themeInfo = { ...theme.manifest, settings: undefined, asset_base: `/theme/${theme.manifest.id}/${theme.manifest.version}`, config: resolveConfig(theme.manifest, themeConfig) };
  // render 引入的片段有独立作用域：把语言相关的数据作为全局量传入，片段里的 t / url / 日期过滤器才能拿到当前语言
  return theme.liquid.renderFile(template, { ...context, theme: themeInfo }, { globals: { site: context.site, _ui: context._ui, theme: themeInfo } });
}

export function renderPage(themeId: string, template: string, context: Record<string, unknown>, opts: { version?: string; config?: Record<string, unknown> } = {}): Promise<string> {
  return renderWith(loadTheme(themeId, opts.version), template, context, opts.config);
}

/** 主题是否提供某个模板。友链、开源项目等后来新增的页面是可选模板，没有时系统用通用方式渲染 */
export function themeHasTemplate(id: string, name: string, version?: string): boolean {
  const where = resolver(id, version);
  return !!where && fs.existsSync(path.join(where.dir, 'templates', `${name}.liquid`));
}

/** 主题静态资源目录（只暴露 assets/，模板与配置不可下载） */
export function themeAssetsDir(id: string, version?: string): string | null {
  if (!THEME_ID_PATTERN.test(id)) return null;
  const where = resolver(id, version);
  if (!where) return null;
  const dir = path.join(where.dir, 'assets');
  return fs.existsSync(dir) ? dir : null;
}
