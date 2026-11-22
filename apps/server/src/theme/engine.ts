/**
 * 主题引擎：主题 = Liquid 模板 + 静态资源。
 * Liquid 是受限模板语言，不能执行服务器代码、读写文件或访问数据库，
 * 只能使用这里提供的数据与过滤器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Liquid } from 'liquidjs';
import { config } from '../config.ts';

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

const REQUIRED_TEMPLATES = ['layout', 'home', 'post-list', 'post', '404'];
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
  liquid.registerFilter('t', function (this: any, key: string, vars?: Record<string, unknown>) {
    const locale = String(this.context.getSync(['site', 'locale']) ?? 'zh-CN');
    let text = locales[locale]?.[key] ?? locales['zh-CN']?.[key] ?? key;
    if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  });
  liquid.registerFilter('date_fmt', function (this: any, value: number, style: 'long' | 'medium' | 'short' = 'long') {
    if (!value) return '';
    const locale = String(this.context.getSync(['site', 'locale']) ?? 'zh-CN');
    const timeZone = String(this.context.getSync(['site', 'timezone']) ?? 'UTC');
    return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone }).format(new Date(value));
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
  return theme.liquid.renderFile(template, { ...context, theme: { ...theme.manifest, asset_base: assetBase } });
}

/** 主题静态资源目录（只暴露 assets/，模板与配置不可下载） */
export function themeAssetsDir(id: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const dir = path.join(config.themesDir, id, 'assets');
  return fs.existsSync(dir) ? dir : null;
}
