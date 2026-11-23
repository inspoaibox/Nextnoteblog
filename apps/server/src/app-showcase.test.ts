/**
 * 内置页面与开源项目：安装后就有“关于”页面和完整导航；友链、开源项目的管理与前台展示；
 * GitHub 同步；以及没有这些模板的旧主题也能正常显示。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexemc-showcase-'));
process.env.DATA_DIR = dataDir;

const { buildApp } = await import('./app.ts');
const { sqlite } = await import('./db/index.ts');
const showcase = await import('./services/showcase.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: method as 'GET', url: `/admin/api${url}`, payload: body as object | undefined, headers: { 'x-nb-csrf': '1', cookie, ...headers } });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};
const page = (url: string) => app.inject({ method: 'GET', url: encodeURI(url) });

before(async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/admin/api/setup', payload: { siteName: '项目测试', username: 'admin', password: 'correct-horse' }, headers: { 'x-nb-csrf': '1' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
after(async () => {
  showcase.setGithubFetcher(null);
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('安装后就有“关于”页面，顶部导航包含开源项目、友链和关于', async () => {
  const about = await page('/about');
  assert.equal(about.statusCode, 200);
  assert.match(about.body, /这里是 <strong>项目测试<\/strong>/);
  const home = (await page('/')).body;
  const nav = home.slice(home.indexOf('class="site-nav"'), home.indexOf('</nav>', home.indexOf('class="site-nav"')));
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ['首页', '文章', '开源项目', '归档', '友链', '关于']);
  // 起步内容只放一次：删掉“关于”后重启不会再出现
  const pages = (await api('GET', '/pages')).body;
  const aboutRow = (pages.items ?? pages).find((p: { slug: string }) => p.slug === 'about');
  assert.ok(aboutRow, '后台页面列表里有“关于”');
  assert.match((await api('GET', '/settings')).body.linksIntro ?? (await page('/links')).body, /交换友链/);
});

test('友链：添加、分组、隐藏、排序，前台按分组显示，说明可编辑', async () => {
  assert.equal((await page('/links')).statusCode, 200);
  assert.match((await page('/links')).body, /还没有友链/);
  assert.equal((await api('POST', '/links', { name: '坏链接', url: 'javascript:alert(1)' })).status, 400, '只接受 http(s) 地址');
  const a = (await api('POST', '/links', { name: '甲站', url: 'https://a.example', description: '甲的博客', groupName: '朋友' })).body.id;
  const b = (await api('POST', '/links', { name: '乙站', url: 'https://b.example' })).body.id;
  const c = (await api('POST', '/links', { name: '丙站', url: 'https://c.example', groupName: '朋友' })).body.id;
  let html = (await page('/links')).body;
  assert.match(html, /class="link-group-name">朋友</);
  assert.ok(html.indexOf('乙站') < html.indexOf('甲站'), '没有分组的排在最前');
  assert.match(html, /href="https:\/\/a.example" target="_blank" rel="noopener"/);

  await api('PATCH', `/links/${c}`, { visible: false });
  assert.doesNotMatch((await page('/links')).body, /丙站/);
  await api('POST', '/links/reorder', { ids: [c, b, a] });
  assert.deepEqual((await api('GET', '/links')).body.links.map((l: { id: number }) => l.id), [c, b, a]);

  await api('PUT', '/links/intro', { intro: '想交换友链请**留言**。' });
  html = (await page('/links')).body;
  assert.match(html, /想交换友链请<strong>留言<\/strong>/);
  await api('DELETE', `/links/${a}`);
  assert.doesNotMatch((await page('/links')).body, /甲站/);
});

test('开源项目：列表、详情、相关文章、多语言名称、改地址自动跳转', async () => {
  assert.match((await page('/projects')).body, /还没有发布开源项目/);
  assert.equal((await api('POST', '/projects', { name: '坏项目', repoUrl: 'ftp://x' })).status, 400);

  // 一篇带“发布说明”标签的文章，作为项目的相关文章
  const postId = (await api('POST', '/posts', { title: 'Tool 1.0 发布' })).body.id;
  await api('PUT', `/posts/${postId}/draft`, { title: 'Tool 1.0 发布', subtitle: '', excerpt: '', cover: '', markdown: '正文', frontMatter: '', meta: {}, baseVersion: 0 });
  await api('PUT', `/posts/${postId}/taxonomy`, { primaryCategoryId: null, categoryIds: [], tags: ['发布说明'] });
  assert.equal((await api('POST', `/posts/${postId}/publish`, {})).status, 200);
  const tag = (await api('GET', '/tags')).body.find((t: { name: string }) => t.name === '发布说明');

  const id = (await api('POST', '/projects', { name: 'Tool', tagline: '一个小工具', repoUrl: 'https://github.com/acme/tool', license: 'MIT', language: 'Go', featured: true, tagId: tag.id, markdown: '## 安装\n\n```bash\ngo install acme/tool@latest\n```' })).body.id;
  await api('POST', '/projects', { name: '旧项目', status: 'archived' });
  const hidden = (await api('POST', '/projects', { name: '草稿项目', visible: false })).body.id;

  const list = (await page('/projects')).body;
  assert.match(list, /共 2 个项目/);
  assert.ok(list.indexOf('Tool') < list.indexOf('旧项目'), '置顶的排在前面');
  assert.match(list, /status-archived">已归档/);
  assert.doesNotMatch(list, /草稿项目/);

  const detail = await page('/projects/tool');
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body, /<h1 class="project-title">Tool<\/h1>/);
  assert.match(detail.body, /href="https:\/\/github.com\/acme\/tool"[^>]*>源代码 · GitHub/);
  assert.match(detail.body.replace(/<[^>]+>/g, ''), /go install acme\/tool@latest/, '项目介绍按 Markdown 渲染（代码有高亮）');
  assert.match(detail.body, /class="project-posts"[\s\S]*Tool 1.0 发布/, '相关文章');
  assert.equal((await page(`/projects/${(await api('GET', `/projects/${hidden}`)).body.slug}`)).statusCode, 404, '隐藏的项目不公开');

  // 英文名称：没有英文介绍时用中文的，填了之后各用各的
  await api('PATCH', '/languages/en', { enabled: true });
  assert.match((await page('/en/projects/tool')).body, /一个小工具/);
  await api('PATCH', `/projects/${id}`, { name: 'Tool', tagline: 'A tiny tool' }, { 'x-nb-locale': 'en' });
  assert.match((await page('/en/projects/tool')).body, /A tiny tool/);
  assert.match((await page('/projects/tool')).body, /一个小工具/);

  await api('PATCH', `/projects/${id}`, { slug: 'acme-tool' });
  const moved = await page('/projects/tool');
  assert.equal(moved.statusCode, 301);
  assert.equal(moved.headers.location, '/projects/acme-tool');

  const sitemap = (await page('/sitemap.xml')).body;
  assert.match(sitemap, /\/projects\/acme-tool/);
  assert.match(sitemap, /\/links</);
});

test('GitHub 同步：更新星标、版本，只补空白字段；失败时记录原因', async () => {
  const id = (await api('POST', '/projects', { name: 'Synced', repoUrl: 'https://github.com/acme/synced', language: '手填语言' })).body.id;
  showcase.setGithubFetcher(async (url) => {
    if (url.endsWith('/releases/latest')) return { ok: true, status: 200, json: async () => ({ tag_name: 'v2.1.0', html_url: 'https://github.com/acme/synced/releases/tag/v2.1.0', published_at: '2026-01-02T00:00:00Z' }) };
    return { ok: true, status: 200, json: async () => ({ stargazers_count: 4321, forks_count: 87, license: { spdx_id: 'Apache-2.0' }, language: 'Rust', description: '仓库描述', homepage: 'https://synced.dev' }) };
  });
  const synced = (await api('POST', `/projects/${id}/sync`, {})).body;
  assert.equal(synced.stars, 4321);
  assert.equal(synced.forks, 87);
  assert.equal(synced.latestVersion, 'v2.1.0');
  assert.equal(synced.license, 'Apache-2.0', '空白的许可证被补上');
  assert.equal(synced.language, '手填语言', '手填的语言不被覆盖');
  assert.equal(synced.homepage, 'https://synced.dev');
  assert.equal(synced.tagline, '仓库描述', '空白的介绍用仓库描述补上');
  const html = (await page('/projects/synced')).body;
  assert.match(html, /4,321/);
  assert.match(html, /href="https:\/\/github.com\/acme\/synced\/releases\/tag\/v2.1.0"[^>]*>v2.1.0/);

  showcase.setGithubFetcher(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  const failed = await api('POST', `/projects/${id}/sync`, {});
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /找不到这个仓库/);
  assert.match((await api('GET', `/projects/${id}`)).body.syncError, /找不到这个仓库/);
  assert.equal((await api('POST', `/projects/${(await api('POST', '/projects', { name: '无仓库' })).body.id}/sync`, {})).status, 400, '非 GitHub 项目不能同步');
});

test('没有友链 / 项目模板的旧主题：内容套进它自己的页面模板显示，文案用默认主题的', async () => {
  // 用默认主题的必需模板做一个最小的上传主题（不带 links / projects / project 模板，也没有新文案）
  const files: Record<string, Uint8Array> = {};
  const src = path.resolve(import.meta.dirname, '../../../themes/default');
  for (const name of ['layout', 'home', 'post-list', 'post', 'category', 'tags', 'collection', 'archive', 'search', 'page', '404']) files[`templates/${name}.liquid`] = fs.readFileSync(path.join(src, 'templates', `${name}.liquid`));
  for (const name of fs.readdirSync(path.join(src, 'templates', 'partials')).filter((f) => !/-body\.liquid$/.test(f))) files[`templates/partials/${name}`] = fs.readFileSync(path.join(src, 'templates', 'partials', name));
  files['theme.json'] = strToU8(JSON.stringify({ id: 'legacy', name: '旧主题', version: '1.0.0', requires: '>=1.0.0' }));
  files['locales/zh-CN.json'] = strToU8(JSON.stringify({ nav_home: '首页' }));
  const boundary = '----nb' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="legacy.zip"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.from(zipSync(files)), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url: '/admin/api/themes/install', payload: body, headers: { cookie, 'x-nb-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.statusCode, 200, res.body);
  await api('POST', '/themes/legacy/activate', {});

  const list = (await page('/projects')).body;
  assert.match(list, /class="post-content"/, '套进主题自己的 page 模板');
  assert.match(list, /class="project-grid"/);
  assert.match(list, /<h1[^>]*>开源项目<\/h1>/, '文案缺失时用默认主题的');
  assert.equal((list.match(/<h1[ >]/g) || []).length, 1, '标题不重复');
  assert.match((await page('/links')).body, /class="link-grid"/);
  assert.match((await page('/projects/acme-tool')).body, /class="project-hero"/);
  await api('POST', '/themes/default/activate', {});
});
