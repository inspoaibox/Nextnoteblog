/** 友链与开源项目 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema, transaction } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { isValidSlug, slugify } from '../lib/slug.ts';
import { pickTranslation } from './taxonomy.ts';
import { addRedirect } from './posts.ts';

const { links, projects, projectTranslations: prT } = schema;

const URL_PATTERN = /^https?:\/\/[^\s]+$/i;
/** 图片地址：站内上传的文件（/uploads/…）或外部 http(s) 地址 */
const IMAGE_PATTERN = /^(https?:\/\/[^\s]+|\/uploads\/[^\s]+)$/i;
const checkUrl = (value: string | undefined, label: string, pattern = URL_PATTERN) => {
  if (value && !pattern.test(value)) throw badRequest(`${label}需以 http:// 或 https:// 开头`);
};

/* ====================== 友链 ====================== */

export interface LinkInput {
  name?: string;
  url?: string;
  description?: string;
  avatar?: string;
  groupName?: string;
  sort?: number;
  visible?: boolean;
}

export const listLinks = () => db.select().from(links).orderBy(asc(links.sort), asc(links.id));

export async function createLink(input: LinkInput) {
  const name = input.name?.trim() ?? '';
  const url = input.url?.trim() ?? '';
  if (!name) throw badRequest('名称不能为空');
  if (!url) throw badRequest('地址不能为空');
  checkUrl(url, '地址');
  checkUrl(input.avatar?.trim(), '头像地址', IMAGE_PATTERN);
  const last = await db.select({ sort: links.sort }).from(links).orderBy(desc(links.sort)).get();
  const row = await db
    .insert(links)
    .values({ name, url, description: input.description?.trim() ?? '', avatar: input.avatar?.trim() ?? '', groupName: input.groupName?.trim() ?? '', sort: input.sort ?? (last ? last.sort + 1 : 0), visible: input.visible === false ? 0 : 1, createdAt: Date.now() })
    .returning({ id: links.id })
    .get();
  return row.id;
}

export async function updateLink(id: number, patch: LinkInput) {
  const cur = await db.select().from(links).where(eq(links.id, id)).get();
  if (!cur) throw notFound('友链');
  const set: Partial<typeof links.$inferInsert> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw badRequest('名称不能为空');
    set.name = patch.name.trim();
  }
  if (patch.url !== undefined) {
    checkUrl(patch.url.trim() || '-', '地址');
    set.url = patch.url.trim();
  }
  if (patch.avatar !== undefined) {
    checkUrl(patch.avatar.trim(), '头像地址', IMAGE_PATTERN);
    set.avatar = patch.avatar.trim();
  }
  if (patch.description !== undefined) set.description = patch.description.trim();
  if (patch.groupName !== undefined) set.groupName = patch.groupName.trim();
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.visible !== undefined) set.visible = patch.visible ? 1 : 0;
  if (Object.keys(set).length) await db.update(links).set(set).where(eq(links.id, id));
}

export const deleteLink = (id: number) => db.delete(links).where(eq(links.id, id));

/** 按给定顺序重排 */
export async function reorderLinks(ids: number[]) {
  await transaction(async () => {
    for (const [sort, id] of ids.entries()) await db.update(links).set({ sort }).where(eq(links.id, id));
  });
}

/** 前台用：可见的友链按分组整理。没有分组名的排在最前（它不显示组名，放在后面会被误看成上一组的一部分），其余分组按组内第一条的位置 */
export async function publicLinkGroups() {
  const rows = (await listLinks()).filter((l) => l.visible);
  const groups = new Map<string, typeof rows>(rows.some((r) => !r.groupName) ? [['', []]] : []);
  for (const row of rows) groups.set(row.groupName, [...(groups.get(row.groupName) ?? []), row]);
  return [...groups.entries()].map(([name, list]) => ({
    name,
    links: list.map((l) => ({ name: l.name, url: l.url, description: l.description, avatar: l.avatar, initial: [...l.name][0] ?? '' })),
  }));
}

/* ====================== 开源项目 ====================== */

export const PROJECT_STATUSES = ['active', 'maintained', 'experimental', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const projectPath = (slug: string) => `/projects/${slug}`;

export interface ProjectInput {
  name?: string;
  slug?: string;
  tagline?: string;
  markdown?: string;
  repoUrl?: string;
  homepage?: string;
  docsUrl?: string;
  downloadUrl?: string;
  license?: string;
  language?: string;
  logo?: string;
  status?: ProjectStatus;
  featured?: boolean;
  sort?: number;
  visible?: boolean;
  tagId?: number | null;
  stars?: number;
  forks?: number;
  latestVersion?: string;
}

async function assertProjectSlug(slug: string, excludeId?: number) {
  if (!isValidSlug(slug)) throw badRequest('地址标识只能包含小写字母、数字和连字符');
  const clash = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (clash && clash.id !== excludeId) throw badRequest('该地址标识已被其他项目使用');
}

const translationsOf = async (ids?: number[]) => {
  const all = await db.select().from(prT);
  return ids ? all.filter((t) => ids.includes(t.projectId)) : all;
};

/** 后台列表：当前编辑语言的名称（没有译文时用其他语言的，并标出来） */
export async function listProjects(locale: string) {
  const rows = await db.select().from(projects).orderBy(desc(projects.featured), asc(projects.sort), asc(projects.id));
  const pick = pickTranslation(await translationsOf(), (t) => t.projectId, locale);
  return rows.map((p) => {
    const tr = pick(p.id);
    return { ...p, featured: !!p.featured, visible: !!p.visible, name: tr?.name ?? '', tagline: tr?.tagline ?? '', translated: tr?.locale === locale, url: projectPath(p.slug) };
  });
}

/** 后台编辑：当前语言的译文；没有时带出其他语言的内容作为起点 */
export async function getProject(id: number, locale: string) {
  const p = await db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw notFound('项目');
  const tr = pickTranslation(await translationsOf([id]), (t) => t.projectId, locale)(id);
  return { ...p, featured: !!p.featured, visible: !!p.visible, name: tr?.name ?? '', tagline: tr?.tagline ?? '', markdown: tr?.markdown ?? '', translated: tr?.locale === locale, url: projectPath(p.slug) };
}

function validateLinks(input: ProjectInput) {
  checkUrl(input.repoUrl?.trim(), '仓库地址');
  checkUrl(input.homepage?.trim(), '项目主页');
  checkUrl(input.docsUrl?.trim(), '文档地址');
  checkUrl(input.downloadUrl?.trim(), '下载地址');
  checkUrl(input.logo?.trim(), '图标地址', IMAGE_PATTERN);
  if (input.status && !PROJECT_STATUSES.includes(input.status)) throw badRequest('不支持的项目状态');
}

export async function createProject(locale: string, input: ProjectInput) {
  const name = input.name?.trim() ?? '';
  if (!name) throw badRequest('项目名称不能为空');
  validateLinks(input);
  return transaction(async () => {
    let slug = input.slug?.trim() || slugify(name) || 'project';
    if (!input.slug?.trim()) {
      const base = slug;
      for (let n = 2; await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get(); n++) slug = `${base}-${n}`;
    }
    await assertProjectSlug(slug);
    const now = Date.now();
    const row = await db
      .insert(projects)
      .values({
        slug,
        repoUrl: input.repoUrl?.trim() ?? '',
        homepage: input.homepage?.trim() ?? '',
        docsUrl: input.docsUrl?.trim() ?? '',
        downloadUrl: input.downloadUrl?.trim() ?? '',
        license: input.license?.trim() ?? '',
        language: input.language?.trim() ?? '',
        logo: input.logo?.trim() ?? '',
        status: input.status ?? 'active',
        featured: input.featured ? 1 : 0,
        sort: input.sort ?? 0,
        visible: input.visible === false ? 0 : 1,
        tagId: input.tagId ?? null,
        stars: input.stars ?? 0,
        forks: input.forks ?? 0,
        latestVersion: input.latestVersion?.trim() ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: projects.id })
      .get();
    await db.insert(prT).values({ projectId: row.id, locale, name, tagline: input.tagline?.trim() ?? '', markdown: input.markdown ?? '' });
    return row.id;
  });
}

export async function updateProject(id: number, locale: string, patch: ProjectInput) {
  validateLinks(patch);
  await transaction(async () => {
    const cur = await getProject(id, locale);
    const set: Partial<typeof projects.$inferInsert> = { updatedAt: Date.now() };
    if (patch.slug !== undefined && patch.slug.trim() !== cur.slug) {
      await assertProjectSlug(patch.slug.trim(), id);
      set.slug = patch.slug.trim();
      await addRedirect(projectPath(cur.slug), projectPath(set.slug)); // 旧地址自动跳转
    }
    const text = ['repoUrl', 'homepage', 'docsUrl', 'downloadUrl', 'license', 'language', 'logo', 'latestVersion'] as const;
    for (const key of text) if (patch[key] !== undefined) set[key] = patch[key]!.trim();
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.featured !== undefined) set.featured = patch.featured ? 1 : 0;
    if (patch.visible !== undefined) set.visible = patch.visible ? 1 : 0;
    if (patch.sort !== undefined) set.sort = patch.sort;
    if (patch.tagId !== undefined) set.tagId = patch.tagId;
    if (patch.stars !== undefined) set.stars = patch.stars;
    if (patch.forks !== undefined) set.forks = patch.forks;
    await db.update(projects).set(set).where(eq(projects.id, id));

    if (patch.name !== undefined || patch.tagline !== undefined || patch.markdown !== undefined) {
      const name = (patch.name ?? cur.name).trim();
      if (!name) throw badRequest('项目名称不能为空');
      // 只写当前语言：没有这个语言的译文时，以带出的内容为基础新建一份
      const values = { name, tagline: (patch.tagline ?? cur.tagline).trim(), markdown: patch.markdown ?? cur.markdown };
      await db
        .insert(prT)
        .values({ projectId: id, locale, ...values })
        .onConflictDoUpdate({ target: [prT.projectId, prT.locale], set: values });
    }
  });
}

export const deleteProject = (id: number) => db.delete(projects).where(eq(projects.id, id));

/* ---------- 前台 ---------- */

const STATUS_KEYS: Record<string, string> = { active: 'project_active', maintained: 'project_maintained', experimental: 'project_experimental', archived: 'project_archived' };

/** 卡片与详情共用的字段（模板里使用下划线命名） */
function projectView(p: typeof projects.$inferSelect, tr: typeof prT.$inferSelect | undefined) {
  const name = tr?.name || p.slug;
  return {
    id: p.id,
    slug: p.slug,
    name,
    initial: [...name][0] ?? '',
    tagline: tr?.tagline ?? '',
    url: projectPath(p.slug),
    repo_url: p.repoUrl,
    repo_host: hostOf(p.repoUrl),
    homepage: p.homepage,
    docs_url: p.docsUrl,
    download_url: p.downloadUrl,
    license: p.license,
    language: p.language,
    logo: p.logo,
    status: p.status,
    status_key: STATUS_KEYS[p.status] ?? 'project_active',
    featured: !!p.featured,
    stars: p.stars,
    forks: p.forks,
    version: p.latestVersion,
    release_url: p.releaseUrl,
    released_at: p.releasedAt,
    updated_at: p.updatedAt,
  };
}
export type ProjectView = ReturnType<typeof projectView>;

function hostOf(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'github.com' ? 'GitHub' : host === 'gitee.com' ? 'Gitee' : host === 'gitlab.com' ? 'GitLab' : host;
  } catch {
    return '';
  }
}

export async function listPublicProjects(locale: string): Promise<ProjectView[]> {
  const rows = await db.select().from(projects).where(eq(projects.visible, 1)).orderBy(desc(projects.featured), asc(projects.sort), asc(projects.id));
  const pick = pickTranslation(await translationsOf(), (t) => t.projectId, locale);
  return rows.map((p) => projectView(p, pick(p.id)));
}

export async function getPublicProject(locale: string, slug: string) {
  const p = await db.select().from(projects).where(and(eq(projects.slug, slug), eq(projects.visible, 1))).get();
  if (!p) return null;
  const tr = pickTranslation(await translationsOf([p.id]), (t) => t.projectId, locale)(p.id);
  return { view: projectView(p, tr), markdown: tr?.markdown ?? '', tagId: p.tagId, translatedIn: tr?.locale ?? '' };
}

/* ---------- 从 GitHub 同步星标、派生、许可证、最新版本 ---------- */

export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
/** 测试用：替换网络请求 */
export const setGithubFetcher = (fn: Fetcher | null) => {
  fetcher = fn ?? ((url, init) => fetch(url, init));
};

export async function syncProject(id: number) {
  const p = await db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw notFound('项目');
  const gh = githubRepoOf(p.repoUrl);
  if (!gh) throw badRequest('只有 GitHub 仓库地址的项目可以同步');
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'nexemcblog' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const get = async (path: string) => {
    const res = await fetcher(`https://api.github.com/repos/${gh.owner}/${gh.repo}${path}`, { headers, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(res.status === 403 ? 'GitHub 接口请求过于频繁，请稍后再试（可设置环境变量 GITHUB_TOKEN 提高额度）' : `GitHub 接口返回 ${res.status}`);
    return res.json();
  };
  try {
    const repo = await get('');
    if (!repo) throw new Error('GitHub 上找不到这个仓库（可能是私有仓库或地址有误）');
    const release = await get('/releases/latest');
    const set: Partial<typeof projects.$inferInsert> = {
      stars: Number(repo.stargazers_count) || 0,
      forks: Number(repo.forks_count) || 0,
      syncedAt: Date.now(),
      syncError: '',
    };
    // 只补空白字段，不覆盖管理员手填的内容
    if (!p.license && repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION') set.license = String(repo.license.spdx_id);
    if (!p.language && repo.language) set.language = String(repo.language);
    if (!p.homepage && typeof repo.homepage === 'string' && URL_PATTERN.test(repo.homepage)) set.homepage = repo.homepage;
    if (repo.archived && p.status !== 'archived') set.status = 'archived';
    if (release?.tag_name) {
      set.latestVersion = String(release.tag_name);
      set.releaseUrl = typeof release.html_url === 'string' ? release.html_url : '';
      set.releasedAt = release.published_at ? Date.parse(release.published_at) || null : null;
    }
    await db.update(projects).set(set).where(eq(projects.id, id));
    // 一句话介绍为空的语言，用仓库描述补上
    if (repo.description) {
      for (const tr of await translationsOf([id])) if (!tr.tagline) await db.update(prT).set({ tagline: String(repo.description).slice(0, 300) }).where(eq(prT.id, tr.id));
    }
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError' ? '连接 GitHub 超时' : (err as Error).message;
    await db.update(projects).set({ syncError: message, syncedAt: Date.now() }).where(eq(projects.id, id));
    throw badRequest(`同步失败：${message}`);
  }
}

/** 同步所有 GitHub 项目；单个失败不影响其他 */
export async function syncAllProjects() {
  let ok = 0;
  let failed = 0;
  for (const p of await db.select({ id: projects.id, repoUrl: projects.repoUrl }).from(projects)) {
    if (!githubRepoOf(p.repoUrl)) continue;
    try {
      await syncProject(p.id);
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}
