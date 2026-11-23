/**
 * M3 验收：同一篇文章的中英文版本互相切换正确；未发布的译文不会被公开。
 * 以及语言管理、分类 / 导航 / 页面的多语言、界面文案、订阅与站点地图。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexemc-m3-'));
process.env.DATA_DIR = dataDir;

const { buildApp } = await import('./app.ts');
const { sqlite } = await import('./db/index.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

const api = async (method: string, url: string, body?: unknown, locale?: string) => {
  const res = await app.inject({ method: method as 'GET', url: `/admin/api${url}`, payload: body as object | undefined, headers: { 'x-nb-csrf': '1', cookie, ...(locale ? { 'x-nb-locale': locale } : {}) } });
  return { status: res.statusCode, body: res.body ? res.json() : null, res };
};
const page = (url: string) => app.inject({ method: 'GET', url: encodeURI(url) });
const draft = (over: Record<string, unknown>) => ({ title: '', subtitle: '', excerpt: '', cover: '', markdown: '', frontMatter: '', meta: {}, ...over });

before(async () => {
  app = await buildApp({ logger: false });
  const res = await api('POST', '/setup', { siteName: '多语言测试', username: 'admin', password: 'correct-horse' });
  cookie = String(res.res.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let zh = 0; // 中文版本 id
let en = 0; // 英文版本 id
let zhOnly = 0;

test('语言管理：初始语言、未启用的语言不可访问、添加与校验', async () => {
  const langs = (await api('GET', '/languages')).body as { code: string; enabled: boolean; isDefault: boolean; prefix: string }[];
  assert.deepEqual(langs.map((l) => [l.code, l.enabled, l.isDefault, l.prefix]), [['zh-CN', true, true, ''], ['en', false, false, 'en']]);
  assert.equal((await page('/en/')).statusCode, 404, '未启用的语言没有前台地址');
  assert.ok(!(await page('/')).body.includes('lang-switch'), '只有一种启用语言时不显示切换器');

  assert.equal((await api('POST', '/languages', { code: 'not a code', name: 'x' })).status, 400);
  assert.equal((await api('POST', '/languages', { code: 'admin', name: 'x' })).status, 400, '不能与系统地址冲突');
  assert.equal((await api('POST', '/languages', { code: 'EN', name: 'x' })).status, 400, '不能重复');
  assert.equal((await api('POST', '/languages', { code: 'ja', name: '日本語' })).status, 200);
  assert.equal((await api('PATCH', '/languages/zh-CN', { enabled: false })).status, 400, '默认语言不能停用');
  assert.equal((await api('DELETE', '/languages/ja')).status, 200);
  assert.equal((await api('PATCH', '/languages/en', { enabled: true })).status, 200);
  assert.equal((await page('/en/')).statusCode, 200);
});

test('只有中文版本时：英文地址不存在，切换器提示缺少译文', async () => {
  zh = (await api('POST', '/posts', { title: '你好，世界' })).body.id;
  await api('PUT', `/posts/${zh}/draft`, draft({ title: '你好，世界', markdown: '中文正文第一版。[^1]\n\n[^1]: 注', baseVersion: 0 }));
  await api('POST', `/posts/${zh}/publish`, {});
  zhOnly = (await api('POST', '/posts', { title: '只有中文' })).body.id;
  await api('PUT', `/posts/${zhOnly}/draft`, draft({ title: '只有中文', markdown: '没有译文的文章。', baseVersion: 0 }));
  await api('POST', `/posts/${zhOnly}/publish`, {});

  assert.equal((await page('/en/posts/ni-hao-shi-jie')).statusCode, 404, '没有英文版本就不能用英文地址访问中文内容');
  const html = (await page('/posts/ni-hao-shi-jie')).body;
  assert.match(html, /<html lang="zh-CN"/);
  assert.match(html, /<a href="\/en" hreflang="en" lang="en" data-lang="en" data-missing/, '缺少译文时指向英文首页并标记');
  assert.doesNotMatch(html, /<link rel="alternate" hreflang="en"/, '没有译文就不输出 hreflang');
  assert.doesNotMatch((await page('/en/')).body, /你好，世界/, '英文首页不混入中文文章');
});

test('创建译文：草稿阶段不公开', async () => {
  const created = await api('POST', `/posts/${zh}/translate`, { locale: 'en' });
  assert.equal(created.status, 200);
  en = created.body.id;
  assert.equal((await api('POST', `/posts/${zh}/translate`, { locale: 'en' })).status, 409, '同一语言只能有一个版本');
  assert.equal((await api('POST', `/posts/${zh}/translate`, { locale: 'fr' })).status, 400, '目标语言必须已登记');

  const edit = await api('GET', `/posts/${en}`);
  assert.equal(edit.body.translation.locale, 'en');
  assert.equal(edit.body.translation.status, 'draft');
  assert.equal(edit.body.draft.markdown.startsWith('中文正文第一版'), true, '以原文为底稿');
  assert.equal(edit.body.source.stale, false);
  assert.deepEqual(edit.body.siblings.map((s: { locale: string }) => s.locale).sort(), ['en', 'zh-CN']);

  assert.equal((await page('/en/posts/ni-hao-shi-jie')).statusCode, 404, '未发布的译文不公开');
  assert.match((await page('/posts/ni-hao-shi-jie')).body, /data-missing/, '中文页仍把英文视为缺失');
  assert.doesNotMatch((await page('/sitemap.xml')).body, /\/en\/posts\//, '未发布的译文不进站点地图');
});

test('发布译文后：中英文互相切换，语言、地址、界面文案都对应', async () => {
  await api('PUT', `/posts/${en}/draft`, draft({ title: 'Hello, World', markdown: 'English body.[^1]\n\n```js\n1\n```\n\n[^1]: note', baseVersion: 0 }));
  assert.equal((await api('PATCH', `/posts/${en}/meta`, { slug: 'hello-world' })).status, 200);
  assert.equal((await api('POST', `/posts/${en}/publish`, {})).status, 200);

  const enPage = await page('/en/posts/hello-world');
  assert.equal(enPage.statusCode, 200);
  assert.equal(enPage.headers['content-language'], 'en');
  assert.match(enPage.body, /<html lang="en"/);
  assert.match(enPage.body, /English body\./);
  assert.doesNotMatch(enPage.body, /中文正文/);
  assert.match(enPage.body, /min read/, '界面文案是英文');
  assert.match(enPage.body, /class="code-copy" type="button">Copy</, '正文里的按钮文字也随语言变化');
  assert.match(enPage.body, /Footnotes/);
  assert.match(enPage.body, /<a href="\/posts\/ni-hao-shi-jie" hreflang="zh-CN" lang="zh-CN" data-lang="zh-CN">/, '英文页切回中文指向对应的中文文章');
  assert.match(enPage.body, /<a class="brand" href="\/en">/, '站内链接带语言前缀');
  assert.match(enPage.body, /action="\/en\/search"/);
  assert.match(enPage.body, /href="\/en\/feed\.xml"/);

  const zhPage = (await page('/posts/ni-hao-shi-jie')).body;
  assert.match(zhPage, /<a href="\/en\/posts\/hello-world" hreflang="en" lang="en" data-lang="en">/, '中文页切到英文指向对应的英文文章');
  assert.match(zhPage, /<link rel="alternate" hreflang="en" href="\/en\/posts\/hello-world">/);
  assert.match(zhPage, /<link rel="alternate" hreflang="zh-CN" href="\/posts\/ni-hao-shi-jie">/);
  assert.match(zhPage, /脚注/);

  const enHome = (await page('/en/')).body;
  assert.match(enHome, /href="\/en\/posts\/hello-world"/);
  assert.match(enHome, /min read/, '模板片段里的文案也是英文');
  assert.doesNotMatch(enHome, /分钟读完/);
  assert.doesNotMatch(enHome, /只有中文/, '英文列表只有英文文章');
  assert.match((await page('/posts/zhi-you-zhong-wen')).body, /data-missing/);
});

test('原文再次发布后提示译文待更新；确认后消除', async () => {
  const cur = await api('GET', `/posts/${zh}`);
  await api('PUT', `/posts/${zh}/draft`, draft({ title: '你好，世界', markdown: '中文正文第二版。', baseVersion: cur.body.translation.lockVersion }));
  assert.equal((await api('GET', `/posts/${en}`)).body.source.stale, false, '原文只是改了草稿，还不算更新');
  await api('POST', `/posts/${zh}/publish`, {});
  assert.equal((await api('GET', `/posts/${en}`)).body.source.stale, true);
  assert.match((await page('/en/posts/hello-world')).body, /English body\./, '不会自动覆盖已发布的译文');
  assert.equal((await api('POST', `/posts/${en}/synced`)).body.source.stale, false);
});

test('后台按内容语言分开：列表、计数、缺失译文', async () => {
  const zhList = await api('GET', '/posts');
  assert.equal(zhList.body.total, 2);
  assert.deepEqual(zhList.body.items.find((p: { id: number }) => p.id === zh).translations.map((t: { locale: string }) => t.locale).sort(), ['en', 'zh-CN']);

  const enList = await api('GET', '/posts', undefined, 'en');
  assert.equal(enList.body.total, 1);
  assert.equal(enList.body.items[0].title, 'Hello, World');
  assert.equal(enList.body.counts.untranslated, 1);

  const missing = await api('GET', '/posts?filter=untranslated', undefined, 'en');
  assert.deepEqual(missing.body.items.map((p: { title: string }) => p.title), ['只有中文']);
  const created = await api('POST', '/posts', { title: 'English only' }, 'en');
  assert.equal((await api('GET', `/posts/${created.body.id}`)).body.translation.locale, 'en', '新建文章使用当前内容语言');
  await api('POST', `/posts/${created.body.id}/trash`);
});

test('分类：结构各语言一致，名称与地址按语言；未翻译时回退', async () => {
  const dev = (await api('POST', '/categories', { name: '开发' })).body.id;
  const web = (await api('POST', '/categories', { name: '前端', parentId: dev })).body.id;
  const postId = (await api('GET', `/posts/${zh}`)).body.translation.postId;
  await api('PUT', `/posts/${zh}/taxonomy`, { primaryCategoryId: web, categoryIds: [], tags: ['入门'] });

  type Node = { id: number; name: string; path: string; translated: boolean; children: Node[] };
  let enTree = (await api('GET', '/categories', undefined, 'en')).body.tree as Node[];
  assert.equal(enTree[0].name, '开发', '没有译名时显示默认语言的名称');
  assert.equal(enTree[0].translated, false);
  assert.equal((await page('/en/category/kai-fa/qian-duan')).statusCode, 200, '回退的地址可用');

  await api('PATCH', `/categories/${dev}`, { name: 'Development', slug: 'dev' }, 'en');
  await api('PATCH', `/categories/${web}`, { name: 'Frontend', slug: 'frontend' }, 'en');
  enTree = (await api('GET', '/categories', undefined, 'en')).body.tree;
  assert.equal(enTree[0].children[0].path, 'dev/frontend');
  assert.equal(enTree[0].translated, true);
  const zhTree = (await api('GET', '/categories')).body.tree as Node[];
  assert.equal(zhTree[0].children[0].path, 'kai-fa/qian-duan', '中文名称与地址不受影响');

  const enCat = await page('/en/category/dev/frontend');
  assert.equal(enCat.statusCode, 200);
  assert.match(enCat.body, /Frontend/);
  assert.match(enCat.body, /href="\/en\/posts\/hello-world"/);
  assert.match(enCat.body, /class="crumbs"[\s\S]*href="\/en\/category\/dev">Development</, '面包屑是英文且带前缀');
  assert.match(enCat.body, /class="crumbs"[\s\S]*<a href="\/en">Home<\/a>/, '面包屑里的首页链接也跟随语言');
  assert.match(enCat.body, /<a href="\/category\/kai-fa\/qian-duan" hreflang="zh-CN"/, '切换语言停留在同一个分类');
  assert.match((await page('/category/kai-fa/qian-duan')).body, /<a href="\/en\/category\/dev\/frontend" hreflang="en"/);
  assert.match((await page('/en/posts/hello-world')).body, /class="crumbs"[\s\S]*\/en\/category\/dev\/frontend/, '文章面包屑也跟随语言');

  // 标签：英文下看到的是回退名，补上译名后各走各的地址
  const tag = ((await api('GET', '/tags', undefined, 'en')).body as { id: number; name: string; translated: boolean }[])[0];
  assert.deepEqual([tag.name, tag.translated], ['入门', false]);
  await api('PATCH', `/tags/${tag.id}`, { name: 'Basics', slug: 'basics' }, 'en');
  assert.match((await page('/en/tag/basics')).body, /hello-world/);
  assert.match((await page('/tag/ru-men')).body, /<a href="\/en\/tag\/basics" hreflang="en"/);
  void postId;
});

test('导航名称、站点文案、界面文案按语言分别维护', async () => {
  const tree = (await api('GET', '/categories')).body.tree as { id: number }[];
  const saved = await api('PUT', '/nav/header', { items: [{ type: 'home' }, { type: 'category', targetId: tree[0].id, label: '技术' }] });
  const items = saved.body as { id: number; type: string; targetId: number | null }[];
  // 在英文下改名并调换顺序：中文名称必须保留
  await api('PUT', '/nav/header', { items: [{ id: items[1].id, type: 'category', targetId: tree[0].id, label: 'Tech' }, { id: items[0].id, type: 'home' }] }, 'en');
  const zhNav = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec((await page('/')).body)![0];
  const enNav = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec((await page('/en/')).body)![0];
  assert.match(zhNav, /href="\/category\/kai-fa">技术<\/a><a href="\/"[^>]*>首页</, '结构共用：顺序在两种语言里一起变');
  assert.match(enNav, /href="\/en\/category\/dev">Tech<\/a><a href="\/en"[^>]*>Home</, '内置项的名称随语言变化');

  await api('PUT', '/site-texts', { siteName: 'Multilingual Test', tagline: 'Notes in English' }, 'en');
  assert.match((await page('/en/')).body, /<title>Multilingual Test - Notes in English<\/title>/);
  assert.match((await page('/')).body, /<title>多语言测试<\/title>/);

  const strings = (await api('GET', '/ui-strings', undefined, 'en')).body;
  assert.equal(strings.isDefault, false);
  assert.equal(strings.items.find((i: { key: string }) => i.key === 'all_posts').builtin, 'All posts');
  await api('PUT', '/ui-strings', { entries: { all_posts: 'Everything' } }, 'en');
  assert.match((await page('/en/posts')).body, /<h1[^>]*>Everything<\/h1>/);
  assert.match((await page('/posts')).body, /<h1[^>]*>全部文章<\/h1>/);
  await api('PUT', '/ui-strings', { entries: { all_posts: '' } }, 'en');
  assert.match((await page('/en/posts')).body, /<h1[^>]*>All posts<\/h1>/, '清空覆盖后恢复主题自带文字');
});

test('自定义页面的译文', async () => {
  const id = (await api('POST', '/pages', { title: '关于' })).body.id;
  await api('PUT', `/pages/${id}`, { slug: 'about', markdown: '中文介绍' });
  await api('POST', `/pages/${id}/publish`);
  assert.equal((await api('POST', '/pages', { title: 'x', slug: 'en' })).status, 400, '页面地址不能占用语言前缀');

  const listed = (await api('GET', '/pages', undefined, 'en')).body as { pageId: number; translated: boolean; id: number | null }[];
  assert.deepEqual([listed[0].translated, listed[0].id], [false, null]);
  assert.equal((await page('/en/about')).statusCode, 404, '没有英文译文时不回退显示中文页面');

  const enId = (await api('POST', '/pages/translate', { pageId: listed[0].pageId }, 'en')).body.id;
  await api('PUT', `/pages/${enId}`, { title: 'About', markdown: 'English intro' });
  assert.equal((await page('/en/about')).statusCode, 404, '译文草稿不公开');
  await api('POST', `/pages/${enId}/publish`);
  assert.match((await page('/en/about')).body, /English intro/);
  assert.match((await page('/about')).body, /<a href="\/en\/about" hreflang="en"/);
});

test('订阅、站点地图、搜索都按语言区分', async () => {
  const enFeed = await page('/en/feed.xml');
  assert.match(String(enFeed.headers['content-type']), /atom\+xml/);
  assert.match(enFeed.body, /xml:lang="en"/);
  assert.match(enFeed.body, /<title>Hello, World<\/title>/);
  assert.doesNotMatch(enFeed.body, /只有中文/);
  assert.match((await page('/feed.xml')).body, /只有中文/);

  const sitemap = (await page('/sitemap.xml')).body;
  assert.match(sitemap, /<loc>http:\/\/[^<]+\/en\/posts\/hello-world<\/loc>/);
  assert.match(sitemap, /<xhtml:link rel="alternate" hreflang="zh-CN" href="http:\/\/[^"]+\/posts\/ni-hao-shi-jie"\/>/);
  assert.doesNotMatch(sitemap, /\/en\/posts\/zhi-you-zhong-wen/);
  assert.match((await page('/robots.txt')).body, /Sitemap: http/);

  assert.match((await page('/en/search?q=english')).body, /hello-world/);
  assert.doesNotMatch((await page('/search?q=english')).body, /hello-world/, '中文站内搜不到英文文章');
});

test('回退策略为“隐藏”时，没有译文的页面不显示该语言；停用语言后其地址失效', async () => {
  await api('PUT', '/settings', { langFallback: 'hide' });
  assert.doesNotMatch((await page('/posts/zhi-you-zhong-wen')).body, /data-lang="en"/);
  assert.match((await page('/posts/ni-hao-shi-jie')).body, /data-lang="en"/, '有译文的页面仍显示');

  await api('PATCH', '/languages/en', { enabled: false });
  assert.equal((await page('/en/posts/hello-world')).statusCode, 404);
  assert.doesNotMatch((await page('/posts/ni-hao-shi-jie')).body, /hreflang="en"/);
  assert.doesNotMatch((await page('/sitemap.xml')).body, /\/en\//);
});
