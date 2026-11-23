/**
 * 主题管理：主题库、切换与回退、版本、配置、ZIP 导入校验、信任分级。
 *
 * 内置主题在程序目录 themes/{id}/，随程序发布，受信任。
 * 上传的主题在数据目录 data/themes/{id}/{version}/，每个版本一个目录：
 * 升级不覆盖旧版本，回滚只是把指针指回去。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import { ENGINE_VERSION, REQUIRED_TEMPLATES, THEME_ID_PATTERN, buildTheme, clearThemeCache, isValidSettingValue, readManifest, renderWith, resolveConfig, setThemeResolver, type ThemeManifest } from '../theme/engine.ts';
import { getSettings, updateSettings } from './settings.ts';

const { themeState, themeLog, users } = schema;

const uploadedRoot = path.join(config.dataDir, 'themes');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const ALLOWED_EXT = new Set(['.liquid', '.json', '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.md', '.txt']);
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 60 * 1024 * 1024;
const MAX_FILES = 600;

type State = typeof themeState.$inferSelect;
const states = new Map<string, State>();

const builtinDir = (id: string) => path.join(config.themesDir, id);
const isBuiltin = (id: string) => THEME_ID_PATTERN.test(id) && fs.existsSync(path.join(builtinDir(id), 'theme.json'));
const versionDir = (id: string, version: string) => path.join(uploadedRoot, id, version);

function listVersions(id: string): string[] {
  const dir = path.join(uploadedRoot, id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((v) => VERSION_PATTERN.test(v) && fs.existsSync(path.join(dir, v, 'theme.json')))
    .sort(compareVersions)
    .reverse();
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return a.localeCompare(b);
}

/** theme.json 的 requires（如 ">=1.0.0"）与当前主题规范版本是否兼容 */
export function checkCompatibility(requires: string | undefined): { ok: boolean; message: string } {
  if (!requires) return { ok: true, message: '' };
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(requires.trim());
  if (!match) return { ok: false, message: `无法识别的版本要求“${requires}”，请写成 ">=1.0.0" 的形式` };
  return compareVersions(ENGINE_VERSION, match[1]) >= 0 ? { ok: true, message: '' } : { ok: false, message: `该主题需要主题规范 ${match[1]} 或更高，当前系统为 ${ENGINE_VERSION}` };
}

/** 应用启动时调用：载入状态，并告诉引擎去哪里找主题文件 */
export async function initThemes() {
  states.clear();
  for (const row of await db.select().from(themeState)) states.set(row.themeId, row);
  setThemeResolver((id, version) => {
    if (!THEME_ID_PATTERN.test(id)) return null;
    if (isBuiltin(id)) return { dir: builtinDir(id), version: '' };
    const v = version && VERSION_PATTERN.test(version) ? version : states.get(id)?.activeVersion;
    if (!v) return null;
    const dir = versionDir(id, v);
    return fs.existsSync(path.join(dir, 'theme.json')) ? { dir, version: v } : null;
  });
}

async function saveState(themeId: string, patch: Partial<State>) {
  const now = Date.now();
  await db.insert(themeState).values({ themeId, updatedAt: now, ...patch }).onConflictDoUpdate({ target: themeState.themeId, set: { ...patch, updatedAt: now } });
  states.set(themeId, (await db.select().from(themeState).where(eq(themeState.themeId, themeId)).get())!);
  clearThemeCache();
}

const log = (themeId: string, action: string, detail: string, userId: number | null) => db.insert(themeLog).values({ themeId, action, detail, userId, createdAt: Date.now() });
const parseJson = (raw: string | undefined): Record<string, unknown> => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name), `${rel}${entry.name}/`);
      else if (entry.name.endsWith('.js')) out.push(rel + entry.name);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

/* ---------- 主题库 ---------- */

function describe(id: string, live: string, previous: string) {
  const builtin = isBuiltin(id);
  const state = states.get(id);
  const versions = builtin ? [] : listVersions(id);
  const activeVersion = builtin ? '' : state?.activeVersion && versions.includes(state.activeVersion) ? state.activeVersion : (versions[0] ?? '');
  const dir = builtin ? builtinDir(id) : versionDir(id, activeVersion);
  let manifest: ThemeManifest;
  let broken = '';
  try {
    manifest = readManifest(dir);
  } catch (err) {
    manifest = { id, name: id, version: activeVersion };
    broken = `theme.json 无法读取：${(err as Error).message}`;
  }
  const compat = checkCompatibility(manifest.requires);
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author ?? '',
    description: manifest.description ?? '',
    source: builtin ? ('builtin' as const) : ('uploaded' as const),
    // 内置主题随程序发布，始终受信任
    trusted: builtin || !!state?.trusted,
    compatible: compat.ok && !broken,
    problem: broken || compat.message,
    isActive: id === live,
    isPrevious: id === previous,
    versions,
    activeVersion,
    previousVersion: !builtin && state?.previousVersion && versions.includes(state.previousVersion) ? state.previousVersion : '',
    scripts: scriptFiles(path.join(dir, 'assets')),
    hasSettings: !!manifest.settings?.length,
    hasScreenshot: fs.existsSync(path.join(dir, 'assets', 'screenshot.png')),
    installedAt: fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : 0,
  };
}

function allIds(): string[] {
  const builtin = fs.existsSync(config.themesDir) ? fs.readdirSync(config.themesDir).filter(isBuiltin) : [];
  const uploaded = fs.existsSync(uploadedRoot) ? fs.readdirSync(uploadedRoot).filter((id) => THEME_ID_PATTERN.test(id) && !builtin.includes(id) && listVersions(id).length > 0) : [];
  return [...builtin, ...uploaded];
}

export async function listThemes() {
  const s = await getSettings();
  return allIds().map((id) => describe(id, s.activeTheme, s.previousTheme));
}

async function requireTheme(id: string) {
  const s = await getSettings();
  if (!allIds().includes(id)) throw notFound('主题');
  return describe(id, s.activeTheme, s.previousTheme);
}

export async function getTheme(id: string) {
  const info = await requireTheme(id);
  const manifest = readManifest(info.source === 'builtin' ? builtinDir(id) : versionDir(id, info.activeVersion));
  const state = states.get(id);
  const logs = await db
    .select({ id: themeLog.id, action: themeLog.action, detail: themeLog.detail, createdAt: themeLog.createdAt, user: users.displayName })
    .from(themeLog)
    .leftJoin(users, eq(users.id, themeLog.userId))
    .where(eq(themeLog.themeId, id))
    .orderBy(desc(themeLog.id))
    .limit(30);
  const applied = parseJson(state?.configApplied);
  const draft = parseJson(state?.configDraft);
  return {
    ...info,
    settings: manifest.settings ?? [],
    config: {
      applied: resolveConfig(manifest, applied),
      draft: resolveConfig(manifest, { ...applied, ...draft }),
      hasDraft: JSON.stringify(resolveConfig(manifest, { ...applied, ...draft })) !== JSON.stringify(resolveConfig(manifest, applied)),
      canRevert: state?.configPrevious != null && state.configPrevious !== state.configApplied,
    },
    logs,
  };
}

/* ---------- 前台渲染用 ---------- */

/** 当前对访客生效的主题；主题损坏时自动退回内置的 default，保证站点始终可访问 */
export async function liveTheme(): Promise<{ id: string; config: Record<string, unknown>; trusted: boolean }> {
  const s = await getSettings();
  const id = allIds().includes(s.activeTheme) ? s.activeTheme : 'default';
  return { id, config: parseJson(states.get(id)?.configApplied), trusted: isBuiltin(id) || !!states.get(id)?.trusted };
}

/** 管理员预览：指定主题（可指定版本），使用配置草稿 */
export function previewTheme(id: string, version?: string): { id: string; version?: string; config: Record<string, unknown>; trusted: boolean } | null {
  if (!allIds().includes(id)) return null;
  if (version && !listVersions(id).includes(version)) return null;
  const state = states.get(id);
  return { id, version: version || undefined, config: { ...parseJson(state?.configApplied), ...parseJson(state?.configDraft) }, trusted: isBuiltin(id) || !!state?.trusted };
}

/* ---------- 切换与回退 ---------- */

/** 启用前确认主题真的能加载、能渲染，坏主题不会被换上线 */
async function assertUsable(id: string, version?: string) {
  const info = await requireTheme(id);
  if (!info.compatible && !version) throw badRequest(`该主题与当前系统不兼容：${info.problem}`);
  const dir = info.source === 'builtin' ? builtinDir(id) : versionDir(id, version ?? info.activeVersion);
  const problems = await trialRender(dir);
  if (problems.length) throw badRequest(`主题无法正常渲染，未切换：${problems[0]}`, { errors: problems });
}

export async function activateTheme(id: string, userId: number) {
  const s = await getSettings();
  if (s.activeTheme === id) return;
  await assertUsable(id);
  await updateSettings({ previousTheme: s.activeTheme, activeTheme: id });
  await log(id, 'activate', `从 ${s.activeTheme} 切换`, userId);
  clearThemeCache();
}

/** 回退到上一个使用的主题 */
export async function rollbackTheme(userId: number) {
  const s = await getSettings();
  if (!s.previousTheme || !allIds().includes(s.previousTheme)) throw badRequest('没有可以回退的上一个主题');
  const target = s.previousTheme;
  await assertUsable(target);
  await updateSettings({ previousTheme: s.activeTheme, activeTheme: target });
  await log(target, 'rollback', `从 ${s.activeTheme} 回退`, userId);
  clearThemeCache();
  return target;
}

/** 切换已上传主题使用的版本（升级到新版本，或回滚到旧版本） */
export async function setThemeVersion(id: string, version: string, userId: number) {
  const info = await requireTheme(id);
  if (info.source === 'builtin') throw badRequest('内置主题随程序升级，不能单独切换版本');
  if (!info.versions.includes(version)) throw notFound('该版本');
  if (version === info.activeVersion) return;
  const compat = checkCompatibility(readManifest(versionDir(id, version)).requires);
  if (!compat.ok) throw badRequest(compat.message);
  await assertUsable(id, version);
  await saveState(id, { previousVersion: info.activeVersion, activeVersion: version });
  await log(id, 'version', `${info.activeVersion} → ${version}`, userId);
}

export async function setTrusted(id: string, trusted: boolean, userId: number) {
  const info = await requireTheme(id);
  if (info.source === 'builtin') throw badRequest('内置主题始终受信任');
  await saveState(id, { trusted: trusted ? 1 : 0 });
  await log(id, 'trust', trusted ? '标记为受信任，允许运行主题脚本' : '取消信任，主题脚本被禁用', userId);
}

/* ---------- 配置 ---------- */

export async function saveConfigDraft(id: string, values: Record<string, unknown>) {
  await requireTheme(id);
  const { settings } = await getTheme(id);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const setting = settings.find((s) => s.key === key);
    if (!setting) continue; // 主题没有声明的项直接忽略（升级后被移除的旧配置）
    if (!isValidSettingValue(setting, value)) throw badRequest(`“${setting.label}”的值不合法`);
    clean[key] = value;
  }
  await saveState(id, { configDraft: JSON.stringify(clean) });
  return getTheme(id);
}

export async function applyConfig(id: string, userId: number) {
  await requireTheme(id);
  const state = states.get(id);
  const applied = state?.configApplied ?? '{}';
  const next = JSON.stringify({ ...parseJson(applied), ...parseJson(state?.configDraft) });
  await saveState(id, { configPrevious: applied, configApplied: next, configDraft: '{}' });
  await log(id, 'config_apply', '', userId);
  return getTheme(id);
}

/** 回退到上一次应用的配置（再点一次可以换回来） */
export async function revertConfig(id: string, userId: number) {
  await requireTheme(id);
  const state = states.get(id);
  if (!state) throw badRequest('没有可以回退的配置');
  await saveState(id, { configApplied: state.configPrevious, configPrevious: state.configApplied, configDraft: '{}' });
  await log(id, 'config_revert', '', userId);
  return getTheme(id);
}

export async function resetConfig(id: string, userId: number) {
  await requireTheme(id);
  await saveState(id, { configPrevious: states.get(id)?.configApplied ?? '{}', configApplied: '{}', configDraft: '{}' });
  await log(id, 'config_reset', '', userId);
  return getTheme(id);
}

/* ---------- 导入校验 ---------- */

export interface PackageReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: ThemeManifest | null;
  fileCount: number;
  totalBytes: number;
  scripts: string[];
  /** 已安装同一主题时：这是一次升级 */
  installedVersions: string[];
  isUpgrade: boolean;
  isLive: boolean;
}

/** 解压到内存并做路径与类型检查。返回 相对路径 → 内容 */
function unpack(zip: Buffer, errors: string[]): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  if (zip.length > MAX_ZIP_BYTES) {
    errors.push(`安装包超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 上限`);
    return files;
  }
  let total = 0;
  let count = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(new Uint8Array(zip), {
      filter(file) {
        if (file.name.endsWith('/')) return false;
        total += file.originalSize;
        count += 1;
        // 在真正解压之前按声明的大小拦截，防止压缩炸弹
        if (total > MAX_UNPACKED_BYTES || count > MAX_FILES) throw new Error('too-big');
        return true;
      },
    });
  } catch (err) {
    errors.push((err as Error).message === 'too-big' ? `安装包解压后超过 ${MAX_UNPACKED_BYTES / 1024 / 1024}MB 或 ${MAX_FILES} 个文件的上限` : '不是有效的 ZIP 文件');
    return files;
  }
  const names = Object.keys(raw).map((n) => n.replace(/\\/g, '/'));
  // 允许整个主题包在一个顶层文件夹里
  const top = names.length && names.every((n) => n.includes('/')) ? names[0].split('/')[0] : '';
  const strip = top && names.every((n) => n.startsWith(`${top}/`)) && !names.includes('theme.json') ? `${top}/` : '';
  for (const [name, data] of Object.entries(raw)) {
    const rel = name.replace(/\\/g, '/').slice(strip.length);
    if (!rel || rel.startsWith('__MACOSX/') || rel.endsWith('.DS_Store')) continue;
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
      errors.push(`非法的文件路径：${name}`);
      continue;
    }
    if (!/^[A-Za-z0-9._\-/]+$/.test(rel)) {
      errors.push(`文件名只能包含字母、数字、点、下划线和连字符：${rel}`);
      continue;
    }
    if (!ALLOWED_EXT.has(path.extname(rel).toLowerCase())) {
      errors.push(`不允许的文件类型：${rel}`);
      continue;
    }
    files.set(rel, data);
  }
  return files;
}

function validateManifest(files: Map<string, Uint8Array>, errors: string[], warnings: string[]): ThemeManifest | null {
  const raw = files.get('theme.json');
  if (!raw) {
    errors.push('缺少 theme.json');
    return null;
  }
  let m: ThemeManifest;
  try {
    m = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    errors.push('theme.json 不是合法的 JSON');
    return null;
  }
  if (typeof m.id !== 'string' || !THEME_ID_PATTERN.test(m.id)) errors.push('theme.json 的 id 需为 2–40 位小写字母、数字或连字符');
  else if (isBuiltin(m.id)) errors.push(`“${m.id}”是内置主题的标识，请换一个 id`);
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('theme.json 缺少 name');
  if (typeof m.version !== 'string' || !VERSION_PATTERN.test(m.version)) errors.push('theme.json 的 version 需为 1.2.3 这样的三段版本号');
  const compat = checkCompatibility(m.requires);
  if (!compat.ok) errors.push(compat.message);
  if (!m.requires) warnings.push('theme.json 没有声明 requires，无法判断兼容性');
  if (m.settings != null) {
    if (!Array.isArray(m.settings)) errors.push('theme.json 的 settings 必须是数组');
    else {
      const seen = new Set<string>();
      for (const s of m.settings) {
        if (!s || typeof s.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s.key)) errors.push(`配置项的 key 不合法：${JSON.stringify(s?.key)}`);
        else if (seen.has(s.key)) errors.push(`配置项重复：${s.key}`);
        else seen.add(s.key);
        if (!['color', 'text', 'select', 'boolean', 'number'].includes(s?.type)) errors.push(`配置项 ${s?.key} 的 type 不受支持：${s?.type}`);
        else if (s.type === 'select' && !(Array.isArray(s.options) && s.options.length)) errors.push(`配置项 ${s.key} 是 select 类型，必须提供 options`);
        else if (s.default !== undefined && !isValidSettingValue(s, s.default)) errors.push(`配置项 ${s.key} 的默认值与它的类型不符`);
        if (typeof s?.label !== 'string' || !s.label) errors.push(`配置项 ${s?.key} 缺少 label`);
      }
    }
  }
  return m;
}

/** 试渲染用的样例数据：覆盖各模板会用到的全部字段 */
function sampleContext(template: string) {
  const post = { id: 1, title: '示例文章 Sample post', subtitle: '副标题', excerpt: '这是一段示例摘要。', cover: '', url: '/posts/sample', date: 1760000000000, updated: 1760500000000, author: '作者', views: 12, pinned: false, featured: true, reading_minutes: 3, words: 800 };
  const cat = { id: 1, name: '分类', url: '/category/a', description: '', depth: 1, count: 2, children: [{ id: 2, name: '子分类', url: '/category/a/b', description: '', depth: 2, count: 1, children: [] }] };
  const pagination = { page: 1, pages: 2, total: 12, prev_url: null, next_url: '/posts?page=2' };
  return {
    site: { name: '示例站点', tagline: '标语', description: '介绍', url: '', locale: 'zh-CN', prefix: '', timezone: 'Asia/Shanghai', appearance: 'auto', icp: '', footer_text: '', year: 2026, feed_url: '/feed.xml', categories: [cat] },
    nav: { header: [{ label: '首页', url: '/', new_tab: false, external: false, current: true }], footer: [] },
    languages: [
      { code: 'zh-CN', name: '简体中文', current: true, available: true, href: '' },
      { code: 'en', name: 'English', current: false, available: false, href: '/en' },
    ],
    hreflang: [],
    query: template === 'search' ? '示例' : '',
    _ui: {},
    page: { title: '示例', description: '描述', type: template, canonical: '', image: '', noindex: false },
    posts: [post, { ...post, id: 2, pinned: true, cover: '/uploads/sample.png' }],
    featured: [post],
    categories: [cat],
    tags: [{ name: '标签', url: '/tag/a', count: 3 }],
    pagination,
    heading: '全部文章',
    intro: '',
    crumbs: [{ name: '分类', url: '/category/a' }],
    category: { ...cat, self_only: false, self_count: 1, self_url: '/category/a?scope=self', has_children: true },
    collection: { title: '系列', description: '介绍', cover: '', kind: 'series', is_series: true, url: '/series/a' },
    years: [{ year: '2026', count: 1, posts: [{ title: post.title, url: post.url, date: post.date }] }],
    total: 1,
    results: [{ ...post, title_html: '示例<mark>文章</mark>', excerpt_html: '示例<mark>摘要</mark>' }],
    suggestions: [post],
    post: { ...post, html: '<h2 id="a">小节</h2><p>正文</p>', toc: [{ depth: 2, id: 'a', text: '小节' }, { depth: 3, id: 'b', text: '小小节' }], show_toc: true, archived: false, show_updated: true, categories: [{ name: '分类', url: '/category/a' }], tags: [{ name: '标签', url: '/tag/a' }] },
    series: { title: '系列', url: '/series/a', position: 1, total: 2, chapters: [{ title: '第一章', url: '/posts/sample', current: true }, { title: '第二章', url: '/posts/b', current: false }], prev: null, next: { title: '第二章', url: '/posts/b' } },
    prev: null,
    next: { title: '下一篇', url: '/posts/b' },
    preview: false,
    content: { title: '页面', html: '<p>页面正文</p>' },
  };
}

/** 用样例数据把每个必需模板渲染一遍，返回发现的问题（模板语法错误、未知过滤器、缺少片段等） */
async function trialRender(dir: string): Promise<string[]> {
  const problems: string[] = [];
  let theme;
  try {
    theme = buildTheme(dir);
  } catch (err) {
    return [(err as Error).message];
  }
  for (const template of REQUIRED_TEMPLATES) {
    if (template === 'layout') continue; // 布局随其他页面一起被渲染
    try {
      const html = await renderWith(theme, template, sampleContext(template));
      if (!/<html[\s>]/i.test(html)) problems.push(`templates/${template}.liquid 渲染结果不是完整的页面（是否忘了 {% layout 'layout' %}？）`);
    } catch (err) {
      problems.push(`templates/${template}.liquid：${(err as Error).message.split('\n')[0]}`);
    }
  }
  return problems;
}

function writeFiles(dir: string, files: Map<string, Uint8Array>) {
  for (const [rel, data] of files) {
    const target = path.join(dir, rel);
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) throw new Error(`非法路径：${rel}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

async function examine(zip: Buffer): Promise<{ report: PackageReport; files: Map<string, Uint8Array> }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files = unpack(zip, errors);
  const manifest = files.size ? validateManifest(files, errors, warnings) : null;
  const scripts = [...files.keys()].filter((f) => f.endsWith('.js'));
  const totalBytes = [...files.values()].reduce((n, d) => n + d.length, 0);

  for (const name of REQUIRED_TEMPLATES) if (files.size && !files.has(`templates/${name}.liquid`)) errors.push(`缺少必需模板 templates/${name}.liquid`);
  for (const f of files.keys()) {
    if (f.startsWith('locales/') && f.endsWith('.json')) {
      try {
        JSON.parse(Buffer.from(files.get(f)!).toString('utf8'));
      } catch {
        errors.push(`${f} 不是合法的 JSON`);
      }
    }
    if (f.endsWith('.js') && !f.startsWith('assets/')) errors.push(`脚本只能放在 assets/ 目录：${f}`);
    if (f.endsWith('.svg') && /<script|on\w+\s*=/i.test(Buffer.from(files.get(f)!).toString('utf8'))) errors.push(`SVG 文件里不能包含脚本：${f}`);
  }

  // 前面的检查都通过后，解压到临时目录做一次真实的试渲染
  if (!errors.length && manifest) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-theme-'));
    try {
      writeFiles(tmp, files);
      errors.push(...(await trialRender(tmp)));
    } catch (err) {
      errors.push((err as Error).message);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const installedVersions = manifest?.id && THEME_ID_PATTERN.test(manifest.id) ? listVersions(manifest.id) : [];
  if (manifest && installedVersions.includes(manifest.version)) errors.push(`版本 ${manifest.version} 已经安装。升级主题请先提高 theme.json 里的 version`);
  if (scripts.length) warnings.push(`主题包含 ${scripts.length} 个脚本文件。安装后默认不会运行，需要你确认来源可信并手动标记为“受信任”`);
  if (!files.has('locales/zh-CN.json') && !files.has('locales/en.json')) warnings.push('主题没有自带语言包，界面文字将显示为键名，需要在“界面文案”里逐条填写');
  const s = await getSettings();
  return {
    files,
    report: { ok: errors.length === 0, errors, warnings, manifest, fileCount: files.size, totalBytes, scripts, installedVersions, isUpgrade: installedVersions.length > 0, isLive: !!manifest && s.activeTheme === manifest.id },
  };
}

/** 只检查、不安装 */
export const inspectPackage = async (zip: Buffer) => (await examine(zip)).report;

/** 校验通过才落盘；任何一步失败都不影响已安装的主题和线上站点 */
export async function installPackage(zip: Buffer, userId: number) {
  const { report, files } = await examine(zip);
  if (!report.ok || !report.manifest) throw new HttpError(400, `主题校验未通过：${report.errors[0]}`, report);
  const { id, version } = report.manifest;
  const target = versionDir(id, version);
  const staging = `${target}.installing`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    writeFiles(staging, files);
    fs.renameSync(staging, target); // 写完整了再一次性就位
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new HttpError(500, `写入主题文件失败：${(err as Error).message}`);
  }
  const state = states.get(id);
  if (!report.isUpgrade || !state) {
    await saveState(id, { activeVersion: version, previousVersion: '', trusted: 0 });
    await log(id, 'install', `安装 ${version}`, userId);
  } else if (report.isLive) {
    // 正在线上使用的主题：新版本只安装不启用，由管理员预览后再手动切换
    await log(id, 'upgrade', `已安装 ${version}，线上仍使用 ${state.activeVersion}`, userId);
    clearThemeCache();
  } else {
    await saveState(id, { previousVersion: state.activeVersion, activeVersion: version });
    await log(id, 'upgrade', `${state.activeVersion} → ${version}`, userId);
  }
  return { report, theme: await getTheme(id) };
}

/* ---------- 卸载 ---------- */

export async function uninstallTheme(id: string, userId: number) {
  const info = await requireTheme(id);
  if (info.source === 'builtin') throw badRequest('内置主题不能卸载');
  if (info.isActive) throw badRequest('该主题正在使用，请先切换到其他主题再卸载');
  fs.rmSync(path.join(uploadedRoot, id), { recursive: true, force: true });
  await db.delete(themeState).where(eq(themeState.themeId, id));
  states.delete(id);
  const s = await getSettings();
  if (s.previousTheme === id) await updateSettings({ previousTheme: '' });
  await log(id, 'uninstall', `卸载全部版本（${info.versions.join('、')}）`, userId);
  clearThemeCache();
}

export async function removeVersion(id: string, version: string, userId: number) {
  const info = await requireTheme(id);
  if (info.source === 'builtin' || !info.versions.includes(version)) throw notFound('该版本');
  if (version === info.activeVersion) throw badRequest('不能删除正在使用的版本');
  fs.rmSync(versionDir(id, version), { recursive: true, force: true });
  if (info.previousVersion === version) await saveState(id, { previousVersion: '' });
  await log(id, 'version', `删除版本 ${version}`, userId);
}

export async function recentLogs(limit = 30) {
  return db
    .select({ id: themeLog.id, themeId: themeLog.themeId, action: themeLog.action, detail: themeLog.detail, createdAt: themeLog.createdAt, user: users.displayName })
    .from(themeLog)
    .leftJoin(users, eq(users.id, themeLog.userId))
    .orderBy(desc(themeLog.id))
    .limit(limit);
}
