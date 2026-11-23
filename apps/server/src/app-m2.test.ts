/**
 * M2 验收：
 *   三级以上分类的路径与面包屑正确；批量移动后统计一致；
 *   删除分类 / 媒体前能看到影响范围；以及标签、专题系列、页面、导航、搜索。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexemc-m2-'));
process.env.DATA_DIR = dataDir;

const { buildApp } = await import('./app.ts');
const { sqlite } = await import('./db/index.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

const api = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url: `/admin/api${url}`, payload: body as object | undefined, headers: { 'x-nb-csrf': '1', cookie } });
  return { status: res.statusCode, body: res.body ? res.json() : null, res };
};
const page = (url: string) => app.inject({ method: 'GET', url: encodeURI(url), headers: {} });

/** 新建并发布一篇文章，返回语言版本 id */
async function publishPost(title: string, markdown: string, taxonomy?: { primaryCategoryId: number | null; categoryIds?: number[]; tags?: string[] }) {
  const created = await api('POST', '/posts', { title });
  const id = created.body.id as number;
  await api('PUT', `/posts/${id}/draft`, { title, subtitle: '', excerpt: '', cover: '', markdown, frontMatter: '', meta: {}, baseVersion: 0 });
  if (taxonomy) {
    const res = await api('PUT', `/posts/${id}/taxonomy`, { primaryCategoryId: taxonomy.primaryCategoryId, categoryIds: taxonomy.categoryIds ?? [], tags: taxonomy.tags ?? [] });
    assert.equal(res.status, 200);
  }
  assert.equal((await api('POST', `/posts/${id}/publish`, {})).status, 200);
  return id;
}

type Node = { id: number; name: string; path: string; url: string; depth: number; postCount: number; publishedCount: number; totalPublished: number; children: Node[] };
const findNode = (nodes: Node[], id: number): Node | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
};
const tree = async () => (await api('GET', '/categories')).body.tree as Node[];

before(async () => {
  app = await buildApp({ logger: false });
  const res = await api('POST', '/setup', { siteName: '组织测试', username: 'admin', password: 'correct-horse' });
  cookie = String(res.res.headers['set-cookie']).split(';')[0];
  // 这里测的是页面与导航本身：去掉安装时自动放入的“关于”页面和导航（起步内容另有 app-showcase.test.ts）
  for (const p of (await api('GET', '/pages')).body as { id: number }[]) await api('DELETE', `/pages/${p.id}`);
  await api('PUT', '/nav/header', { items: [] });
});
after(async () => {
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cat: Record<string, number> = {};
const post: Record<string, number> = {};

test('创建四级分类：路径、层级与地址正确', async () => {
  cat.dev = (await api('POST', '/categories', { name: '开发' })).body.id;
  cat.web = (await api('POST', '/categories', { name: '前端', parentId: cat.dev })).body.id;
  cat.css = (await api('POST', '/categories', { name: 'CSS', parentId: cat.web })).body.id;
  cat.layout = (await api('POST', '/categories', { name: '布局', parentId: cat.css })).body.id;
  cat.life = (await api('POST', '/categories', { name: '生活' })).body.id;

  const node = findNode(await tree(), cat.layout)!;
  assert.equal(node.depth, 4);
  assert.equal(node.path, 'kai-fa/qian-duan/css/bu-ju');
  assert.equal(node.url, '/category/kai-fa/qian-duan/css/bu-ju');

  assert.equal((await api('POST', '/categories', { name: '前端', parentId: cat.dev, slug: 'qian-duan' })).status, 400, '同级不允许相同地址标识');
  assert.equal((await api('POST', '/categories', { name: '前端', slug: 'qian-duan' })).status, 200, '不同层级可以同名');
});

test('文章归属：主分类、附加分类、标签；父分类汇总下级文章', async () => {
  post.grid = await publishPost('Grid 布局入门', '用 CSS Grid 做二维布局。', { primaryCategoryId: cat.layout, categoryIds: [cat.life], tags: ['CSS', '布局'] });
  post.flex = await publishPost('Flex 对齐技巧', '弹性盒子的对齐方式。', { primaryCategoryId: cat.css, tags: ['css', '前端'] });
  post.node = await publishPost('Node 流处理', '可读流与可写流。', { primaryCategoryId: cat.dev, tags: ['Node'] });
  post.draft = (await api('POST', '/posts', { title: '未发布草稿' })).body.id;
  await api('PUT', `/posts/${post.draft}/taxonomy`, { primaryCategoryId: cat.css, categoryIds: [], tags: [] });

  const t = await tree();
  const css = findNode(t, cat.css)!;
  assert.equal(css.postCount, 2, '直接归属含草稿');
  assert.equal(css.publishedCount, 1);
  assert.equal(css.totalPublished, 2, '汇总下级分类');
  assert.equal(findNode(t, cat.dev)!.totalPublished, 3);

  const tags = (await api('GET', '/tags')).body as { name: string; postCount: number }[];
  assert.equal(tags.find((x) => x.name === 'CSS')!.postCount, 2, '标签名不区分大小写，不重复创建');
  assert.equal(tags.length, 4);
});

test('前台分类页：面包屑、下级分类、仅本级切换', async () => {
  const res = await page('/category/kai-fa/qian-duan/css');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /class="crumbs"[\s\S]*href="\/category\/kai-fa"[\s\S]*href="\/category\/kai-fa\/qian-duan"/, '面包屑是完整的上级路径');
  assert.match(res.body, /Grid 布局入门/);
  assert.match(res.body, /Flex 对齐技巧/);
  assert.doesNotMatch(res.body, /未发布草稿/);
  assert.match(res.body, /href="\/category\/kai-fa\/qian-duan\/css\/bu-ju"/, '列出下级分类');

  const self = await page('/category/kai-fa/qian-duan/css?scope=self');
  assert.match(self.body, /Flex 对齐技巧/);
  assert.doesNotMatch(self.body, /Grid 布局入门/, '仅本级时不含下级分类的文章');
  assert.equal((await page('/category/kai-fa/no-such')).statusCode, 404);
});

test('文章页：主分类面包屑、分类与标签链接', async () => {
  const res = await page('/posts/grid-bu-ju-ru-men');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /class="crumbs"[\s\S]*kai-fa\/qian-duan\/css\/bu-ju/);
  assert.match(res.body, /href="\/tag\/css"/);
  assert.match(res.body, /href="\/category\/sheng-huo"/, '附加分类也显示');
  const tagPage = await page('/tag/css');
  assert.match(tagPage.body, /Grid 布局入门/);
  assert.match(tagPage.body, /Flex 对齐技巧/);
  assert.match((await page('/tags')).body, /href="\/tag\/node"/);
});

test('移动分类：防止循环、展示影响、旧地址 301', async () => {
  assert.equal((await api('POST', `/categories/${cat.dev}/move`, { parentId: cat.css })).status, 400, '不能移到自己的下级');
  const impact = await api('GET', `/categories/${cat.css}/impact`);
  assert.equal(impact.body.postCount, 2);
  assert.equal(impact.body.descendantCount, 1);
  assert.equal(impact.body.samplePosts.length, 2);

  // 把 CSS（连同下级“布局”）移到顶级
  assert.equal((await api('POST', `/categories/${cat.css}/move`, { parentId: null, index: 0 })).status, 200);
  const t = await tree();
  assert.equal(t[0].id, cat.css, '按指定位置排序');
  assert.equal(findNode(t, cat.layout)!.url, '/category/css/bu-ju');
  const old = await page('/category/kai-fa/qian-duan/css/bu-ju');
  assert.equal(old.statusCode, 301);
  assert.equal(old.headers.location, '/category/css/bu-ju');
  assert.equal((await page('/posts/grid-bu-ju-ru-men')).statusCode, 200, '文章地址不受分类移动影响');
  assert.equal(findNode(await tree(), cat.dev)!.totalPublished, 1, '移走后父分类统计随之变化');
});

test('批量迁移文章分类后统计一致', async () => {
  const res = await api('POST', '/posts/bulk', { ids: [post.grid, post.flex, post.draft], action: 'setCategory', categoryId: cat.dev });
  assert.equal(res.body.done, 3);
  const t = await tree();
  assert.equal(findNode(t, cat.dev)!.postCount, 4);
  assert.equal(findNode(t, cat.dev)!.publishedCount, 3);
  assert.equal(findNode(t, cat.css)!.postCount, 0);
  assert.equal(findNode(t, cat.layout)!.postCount, 0);
  assert.equal(findNode(t, cat.life)!.postCount, 1, '附加分类保留');

  const list = await api('GET', `/posts?categoryId=${cat.dev}`);
  assert.equal(list.body.total, 4);
  assert.ok(list.body.items.every((p: { primaryCategoryId: number }) => p.primaryCategoryId === cat.dev));
  assert.match((await page('/category/kai-fa')).body, /Grid 布局入门/);
});

test('删除分类：有子分类或文章时必须先说明去向', async () => {
  const withChildren = await api('DELETE', `/categories/${cat.css}`);
  assert.equal(withChildren.status, 409);
  assert.equal(withChildren.body.data.childCount, 1);

  const withPosts = await api('DELETE', `/categories/${cat.dev}`);
  assert.equal(withPosts.status, 409, '子分类“前端”仍在');
  await api('DELETE', `/categories/${cat.web}`);
  const blocked = await api('DELETE', `/categories/${cat.dev}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.data.postCount, 4, '返回受影响的文章数');

  // 合并：文章迁移到“生活”，Grid 那篇原本就在“生活”，不能重复，且应成为主分类
  const merged = await api('DELETE', `/categories/${cat.dev}?moveTo=${cat.life}`);
  assert.equal(merged.status, 200);
  assert.equal(merged.body.moved, 4);
  const life = findNode(await tree(), cat.life)!;
  assert.equal(life.postCount, 4);
  const tx = await api('GET', `/posts/${post.grid}/taxonomy`);
  assert.equal(tx.body.primaryCategoryId, cat.life);
  assert.deepEqual(tx.body.categoryIds, []);
  assert.equal((await page('/category/kai-fa')).statusCode, 301, '被合并分类的地址跳转到目标分类');
});

test('标签：改名冲突、合并、清理空标签', async () => {
  const tags = (await api('GET', '/tags')).body as { id: number; name: string }[];
  const id = (name: string) => tags.find((t) => t.name === name)!.id;
  assert.equal((await api('PATCH', `/tags/${id('前端')}`, { name: 'CSS' })).status, 400);
  assert.equal((await api('POST', '/tags/merge', { sourceIds: [id('前端'), id('布局')], targetId: id('CSS') })).status, 200);
  const after = (await api('GET', '/tags')).body as { name: string; postCount: number }[];
  assert.deepEqual(after.map((t) => t.name).sort(), ['CSS', 'Node']);
  assert.equal(after.find((t) => t.name === 'CSS')!.postCount, 2);
  assert.equal((await page('/tag/qian-duan')).statusCode, 301);

  await api('POST', '/tags', { name: '空标签' });
  assert.equal((await api('POST', '/tags/cleanup')).body.removed, 1);
});

test('搜索：中文分词、标签命中、高亮、无结果与下线同步', async () => {
  let res = await page('/search?q=布局');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Grid <mark>布局<\/mark>入门/);
  assert.doesNotMatch(res.body, /Node 流处理/);
  assert.equal(res.headers['x-robots-tag'], 'noindex');

  assert.match((await page('/search?q=可读流')).body, /href="\/posts\/node-liu-chu-li"/, '正文可被搜索');
  assert.match((await page('/search?q=flex')).body, /<mark>Flex<\/mark> 对齐技巧/, '英文不区分大小写');
  assert.match((await page('/search?q=gri')).body, /grid-bu-ju-ru-men/, '英文前缀匹配');
  assert.doesNotMatch((await page('/search?q=草稿')).body, /未发布草稿/, '草稿不进索引');

  res = await page('/search?q=量子计算');
  assert.match(res.body, /没有找到相关文章/);
  assert.match(res.body, /Node 流处理/, '无结果时给出最新文章');
  const terms = (await api('GET', '/search/terms')).body as { term: string; results: number }[];
  assert.equal(terms.find((t) => t.term === '量子计算')!.results, 0);

  await api('POST', `/posts/${post.node}/unpublish`);
  assert.doesNotMatch((await page('/search?q=可读流')).body, /node-liu-chu-li/, '下线后立即从搜索结果消失');
  await api('POST', `/posts/${post.node}/publish`, {});
  assert.match((await page('/search?q=<script>alert(1)</script>')).body, /value="&lt;script&gt;/, '搜索词被转义');
});

test('系列：章节顺序、文章页导航；专题页', async () => {
  const created = await api('POST', '/collections', { kind: 'series', title: '从零学布局', description: '循序渐进。' });
  const sid = created.body.id;
  const ids = async (tid: number) => (await api('GET', `/posts/${tid}`)).body.translation.postId as number;
  const [grid, flex, node] = [await ids(post.grid), await ids(post.flex), await ids(post.node)];
  const saved = await api('PATCH', `/collections/${sid}`, { postIds: [flex, grid, node] });
  assert.deepEqual(saved.body.items.map((i: { postId: number }) => i.postId), [flex, grid, node]);

  const seriesPage = await page('/series/cong-ling-xue-bu-ju');
  assert.equal(seriesPage.statusCode, 200);
  assert.ok(seriesPage.body.indexOf('Flex 对齐技巧') < seriesPage.body.indexOf('Grid 布局入门'), '按设定的章节顺序');

  const article = await page('/posts/grid-bu-ju-ru-men');
  assert.match(article.body, /系列第 2 \/ 3 篇/);
  assert.match(article.body, /上一章<\/span><strong>Flex 对齐技巧/);
  assert.match(article.body, /下一章<\/span><strong>Node 流处理/);

  const topic = await api('POST', '/collections', { kind: 'topic', title: '样式专题', slug: 'styles' });
  await api('PATCH', `/collections/${topic.body.id}`, { postIds: [grid], visible: false });
  assert.equal((await page('/topic/styles')).statusCode, 404, '未公开的专题不可访问');
  await api('PATCH', `/collections/${topic.body.id}`, { visible: true });
  assert.match((await page('/topic/styles')).body, /Grid 布局入门/);
  assert.equal((await page('/series/styles')).statusCode, 404, '专题不能用系列的地址访问');
});

test('自定义页面：草稿不公开、发布后可见、修改不影响线上、保留字', async () => {
  assert.equal((await api('POST', '/pages', { title: '管理', slug: 'admin' })).status, 400);
  const created = await api('POST', '/pages', { title: '关于我' });
  const id = created.body.id;
  await api('PUT', `/pages/${id}`, { markdown: '我是站长。\n\n## 联系方式\n\n邮箱见页脚。', slug: 'about' });
  assert.equal((await page('/about')).statusCode, 404, '草稿不公开');
  assert.equal((await page(`/preview/page/${id}`)).statusCode, 404, '匿名不能预览');

  assert.equal((await api('POST', `/pages/${id}/publish`)).status, 200);
  const live = await page('/about');
  assert.equal(live.statusCode, 200);
  assert.match(live.body, /我是站长/);

  const edited = await api('PUT', `/pages/${id}`, { markdown: '改过的内容' });
  assert.equal(edited.body.hasPendingChanges, true);
  assert.match((await page('/about')).body, /我是站长/, '未再次发布前线上不变');

  await api('PUT', `/pages/${id}`, { slug: 'about-me' });
  assert.equal((await page('/about')).statusCode, 301);
  await api('POST', `/pages/${id}/unpublish`);
  assert.equal((await page('/about-me')).statusCode, 404);
  await api('POST', `/pages/${id}/publish`);
});

test('导航：默认菜单、自定义菜单、失效目标自动隐藏', async () => {
  const home = await page('/');
  assert.match(home.body, /class="site-nav"[\s\S]*href="\/archive"/, '未配置时使用默认菜单');

  const pages = (await api('GET', '/pages')).body as { id: number }[];
  const res = await api('PUT', '/nav/header', {
    items: [
      { type: 'home' },
      { type: 'category', targetId: cat.life, label: '日常' },
      { type: 'page', targetId: pages[0].id },
      { type: 'url', url: 'https://example.com', label: '外站', newTab: true },
      { type: 'category', targetId: 99999 },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body[4].resolvedUrl, null, '后台能看到失效项');
  assert.equal((await api('PUT', '/nav/header', { items: [{ type: 'url', url: 'javascript:alert(1)' }] })).status, 400);

  const html = (await page('/')).body;
  const nav = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec(html)![0];
  assert.match(nav, /href="\/category\/sheng-huo">日常</, '自定义名称');
  assert.match(nav, /href="\/about-me">关于我</, '默认用目标自己的名称');
  assert.match(nav, /href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">外站</);
  assert.equal((nav.match(/<a /g) || []).length, 4, '失效的导航项不输出');
  assert.doesNotMatch(nav, /href="\/archive"/);

  await api('PUT', '/nav/footer', { items: [{ type: 'archive' }] });
  assert.match((await page('/')).body, /class="footer-nav"[\s\S]*href="\/archive"/);
});

test('归档页与首页的分类标签区', async () => {
  const archive = await page('/archive');
  assert.equal(archive.statusCode, 200);
  assert.match(archive.body, /共 3 篇/);
  assert.match(archive.body, /Flex 对齐技巧/);
  const home = (await page('/')).body;
  assert.match(home, /class="cat-list"[\s\S]*href="\/category\/sheng-huo"/);
  assert.match(home, /class="tag-cloud"[\s\S]*href="\/tag\/css"/);
});
