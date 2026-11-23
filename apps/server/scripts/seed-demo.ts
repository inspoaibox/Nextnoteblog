/**
 * 向一个【全新的】站点灌入示例文章，用于开发和检查主题效果。
 * 用法：tsx scripts/seed-demo.ts http://localhost:3200
 * 只应对演示用的数据目录执行（配合 --data-dir=），不要对正式站点执行。
 */
import sharp from 'sharp';

const base = process.argv[2] || 'http://localhost:3200';
let cookie = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}/admin/api${url}`, {
    method,
    headers: { 'x-nb-csrf': '1', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${json.error}`);
  return json;
}

async function uploadCover(name: string, svg: string) {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${name}.png`);
  const res = await fetch(`${base}/admin/api/media?name=${name}`, { method: 'POST', headers: { 'x-nb-csrf': '1', cookie }, body: form });
  return (await res.json()).url as string;
}

const cover = (a: string, b: string, shape: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${a}"/>${shape.replaceAll('$', b)}</svg>`;

const day = 86400_000;
const now = Date.now();

const longBody = `写博客这件事，我断断续续做了很多年。换过好几套系统，最后发现真正留下来的只有那些 **Markdown 文件**。

## 为什么是纯文本

纯文本不会过期。十年前写的 \`.md\` 文件今天照样能打开，而十年前的富文本编辑器，大多已经找不到了。

> 工具会换，文字会留下来。把稿子握在自己手里，比任何功能都重要。

### 可以放进版本库

每一次修改都有记录，可以对比，可以回退：

\`\`\`bash
git log --oneline -- posts/hello.md
git diff HEAD~1 -- posts/hello.md
\`\`\`

### 可以用任何编辑器

不被某一个软件绑住。今天用 VS Code，明天换别的，稿子不用动。

## 这个博客怎么处理一篇文章

| 阶段 | 发生了什么 | 访客能看到吗 |
| --- | --- | --- |
| 草稿 | 自动保存，随时可改 | 不能 |
| 已发布 | 线上固定为发布时的版本 | 能 |
| 再次编辑 | 改的是草稿，线上不变 | 仍是上一版 |

:::tip[小提示]
改完已发布的文章后，需要再点一次“发布新版本”，线上才会更新。
:::

渲染部分用 TypeScript 写成，编辑器预览和线上页面走的是同一段代码：

\`\`\`ts
export async function renderMarkdown(markdown: string): Promise<RenderResult> {
  const file = await pipeline.process(markdown);
  return { html: String(file), toc: collectHeadings(file) };
}
\`\`\`

## 接下来

- [x] 文章与修订
- [x] 发布与回退
- [ ] 分类与标签
- [ ] 多语言

写到这里，先发布[^1]。

---

下一篇聊聊分类应该怎么设计。

[^1]: 发布之后发现错别字也没关系，改完再发一次就好。
`;

const posts: { title: string; subtitle?: string; excerpt?: string; markdown: string; daysAgo: number; pinned?: boolean; featured?: boolean; cover?: [string, string, string] }[] = [
  {
    title: '把稿子握在自己手里：我为什么只用 Markdown 写作',
    subtitle: '工具会换，文字会留下来',
    excerpt: '换过好几套博客系统之后，真正留下来的只有那些 .md 文件。这篇文章讲讲纯文本写作的好处，以及这个博客是怎么处理一篇文章的。',
    markdown: longBody,
    daysAgo: 1,
    featured: true,
    cover: ['#1d2a3a', '#ffe14d', '<rect x="150" y="210" width="620" height="54" fill="$"/><rect x="150" y="330" width="900" height="26" fill="#f5f6f3" opacity=".85"/><rect x="150" y="400" width="820" height="26" fill="#f5f6f3" opacity=".85"/><rect x="150" y="470" width="700" height="26" fill="#f5f6f3" opacity=".85"/><rect x="150" y="540" width="420" height="26" fill="#f5f6f3" opacity=".85"/>'],
  },
  { title: '关于这个博客', excerpt: '这里记录我在写代码、做产品和读书时想明白的一些事。', markdown: '这里记录我在写代码、做产品和读书时想明白的一些事。\n\n## 更新频率\n\n想清楚了再写，不追求数量。', daysAgo: 400, pinned: true },
  { title: '多级分类应该怎么设计', excerpt: '分类是给读者找东西用的，不是给作者归档用的。三层以内，名字要短，宁可少不要重叠。', markdown: '分类是给读者找东西用的，不是给作者归档用的。\n\n## 三个原则\n\n1. 三层以内\n2. 名字要短\n3. 宁可少，不要重叠', daysAgo: 6, featured: true },
  {
    title: 'SQLite 足够撑起一个个人博客吗',
    excerpt: '读多写少、单机部署、备份就是拷贝一个文件。对个人博客来说，SQLite 不是将就，而是合适。',
    markdown: '读多写少、单机部署、备份就是拷贝一个文件。\n\n## WAL 模式\n\n```sql\nPRAGMA journal_mode = WAL;\n```\n\n开启之后，读和写互不阻塞。',
    daysAgo: 19,
    cover: ['#e9ebe5', '#151b23', '<circle cx="600" cy="400" r="210" fill="none" stroke="$" stroke-width="26"/><rect x="390" y="388" width="420" height="24" fill="#ffe14d"/>'],
  },
  { title: '读《排版的基本原理》笔记', excerpt: '行长、行距、字号三者是一起定的。先定行长，再让行距跟着字体的性格走。', markdown: '行长、行距、字号三者是一起定的。\n\n> 排版的目的是让人忘记排版。', daysAgo: 47, featured: true },
  { title: '给自己的服务器配上自动 HTTPS', excerpt: '用 Caddy 做反向代理，证书申请和续期都不用管。', markdown: '用 Caddy 做反向代理，证书申请和续期都不用管。\n\n```\nblog.example.com {\n\treverse_proxy blog:3000\n}\n```', daysAgo: 88 },
  { title: '一次把博客从旧系统迁出来的经历，以及我从中学到的关于数据可携带性的几件事', markdown: '导出、清洗、重新导入，前后花了两个周末。\n\n## 教训\n\n选系统之前，先看它怎么导出。', daysAgo: 210 },
  { title: '2025 年读过的书', excerpt: '今年读得不多，值得再读的有五本。', markdown: '今年读得不多，值得再读的有五本。', daysAgo: 330 },
  { title: '第一篇：你好，世界', excerpt: '博客开张。', markdown: '博客开张。', daysAgo: 520 },
];

await api('POST', '/setup', { siteName: '字里行间', username: 'demo', password: 'demo-demo-demo', timezone: 'Asia/Shanghai' });
await api('PUT', '/settings', { tagline: '写代码，也写字', description: '一个用原生 Markdown 写成的个人博客，记录开发、产品和阅读中想明白的事。', footerText: '用 Markdown 写成', icp: '京ICP备00000000号', postsPerPage: 8 });

// 分类树（三级）、每篇文章的归属与标签；下标与上面 posts 数组一一对应
const cat = async (name: string, parentId: number | null = null, description = '') => (await api('POST', '/categories', { name, parentId, description })).id as number;
const writing = await cat('写作', null, '关于写作工具、流程和排版。');
const dev = await cat('开发', null, '写代码过程中的记录。');
const backend = await cat('后端', dev);
const database = await cat('数据库', backend, 'SQLite、PostgreSQL 与数据建模。');
const ops = await cat('运维', dev);
const reading = await cat('阅读');
const taxonomy: { primary: number | null; extra?: number[]; tags: string[] }[] = [
  { primary: writing, extra: [dev], tags: ['Markdown', '写作', '工具'] },
  { primary: null, tags: [] },
  { primary: writing, tags: ['信息架构', '博客'] },
  { primary: database, tags: ['SQLite', '博客'] },
  { primary: reading, extra: [writing], tags: ['排版', '读书笔记'] },
  { primary: ops, tags: ['Caddy', 'HTTPS'] },
  { primary: dev, tags: ['博客', '迁移'] },
  { primary: reading, tags: ['读书笔记'] },
  { primary: null, tags: [] },
];
const postIds: number[] = [];

for (const [i, p] of posts.entries()) {
  const { id, postId } = await api('POST', '/posts', { title: p.title });
  postIds.push(postId);
  await api('PUT', `/posts/${id}/taxonomy`, { primaryCategoryId: taxonomy[i].primary, categoryIds: taxonomy[i].extra ?? [], tags: taxonomy[i].tags });
  const coverUrl = p.cover ? await uploadCover(`demo-cover-${i}`, cover(...p.cover)) : '';
  await api('PUT', `/posts/${id}/draft`, { title: p.title, subtitle: p.subtitle ?? '', excerpt: p.excerpt ?? '', cover: coverUrl, markdown: p.markdown, frontMatter: '', meta: {}, baseVersion: 0 });
  await api('POST', `/posts/${id}/publish`, {});
  await api('PATCH', `/posts/${id}/meta`, { firstPublishedAt: now - p.daysAgo * day, pinned: !!p.pinned, featured: !!p.featured });
}

// 系列、专题、页面、导航
const series = await api('POST', '/collections', { kind: 'series', title: '从零搭一个博客', description: '从选型、建模到部署，按顺序读下来就是完整的一遍。' });
await api('PATCH', `/collections/${series.id}`, { postIds: [postIds[0], postIds[2], postIds[3], postIds[5]] });
const topic = await api('POST', '/collections', { kind: 'topic', title: '读书', description: '读过并且愿意推荐的书。' });
await api('PATCH', `/collections/${topic.id}`, { postIds: [postIds[4], postIds[7]] });

const about = await api('POST', '/pages', { title: '关于' });
await api('PUT', `/pages/${about.id}`, { slug: 'about', markdown: '我是一名开发者，平时写后端，也喜欢琢磨排版。\n\n## 这个站点\n\n全部内容都用 Markdown 写成，源文件随时可以导出带走。\n\n## 联系\n\n有想法欢迎来信：`hello@example.com`。' });
await api('POST', `/pages/${about.id}/publish`, {});

await api('PUT', '/nav/header', {
  items: [{ type: 'home' }, { type: 'posts' }, { type: 'category', targetId: dev }, { type: 'collection', targetId: series.id, label: '系列' }, { type: 'archive' }, { type: 'page', targetId: about.id }],
});
await api('PUT', '/nav/footer', { items: [{ type: 'archive' }, { type: 'page', targetId: about.id }, { type: 'url', url: 'https://github.com', label: 'GitHub', newTab: true }] });


// ---------- 英文：启用语言，翻译两篇文章、部分分类、页面与站点文案 ----------
const inEn = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}/admin/api${url}`, { method, headers: { 'x-nb-csrf': '1', 'x-nb-locale': 'en', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`[en] ${method} ${url} → ${res.status} ${json.error}`);
  return json;
};
await api('PATCH', '/languages/en', { enabled: true });
await inEn('PUT', '/site-texts', { siteName: 'Between the Lines', tagline: 'Writing code, and writing', description: 'A personal blog written in plain Markdown: notes on development, product and reading.', footerText: 'Written in Markdown' });
await inEn('PATCH', `/categories/${writing}`, { name: 'Writing', slug: 'writing', description: 'Tools, workflow and typography.' });
await inEn('PATCH', `/categories/${dev}`, { name: 'Development', slug: 'dev' });
await inEn('PATCH', `/categories/${backend}`, { name: 'Backend', slug: 'backend' });
await inEn('PATCH', `/categories/${database}`, { name: 'Databases', slug: 'databases' });

const list = (await api('GET', '/posts?pageSize=50')).items as { id: number; postId: number }[];
const tidOf = (postId: number) => list.find((p) => p.postId === postId)!.id;
const translations: [number, string, string, string, string][] = [
  [postIds[0], 'own-your-words', 'Own your words: why I only write in Markdown', 'After several blog engines, the only thing that survived was a folder of .md files.', 'I have been blogging on and off for years. Engines came and went; the **Markdown files** stayed.\n\n## Why plain text\n\nPlain text does not expire. A `.md` file from ten years ago still opens today.\n\n> Tools change. Words stay.\n\n## What happens to a post here\n\n| Stage | What happens | Visible to readers |\n| --- | --- | --- |\n| Draft | Autosaved, editable any time | No |\n| Published | Frozen at the published version | Yes |\n\n```ts\nexport async function renderMarkdown(markdown: string) {\n  return pipeline.process(markdown);\n}\n```\n'],
  [postIds[3], 'is-sqlite-enough', 'Is SQLite enough for a personal blog?', 'Read-heavy, single machine, and a backup is just copying one file. For a personal blog SQLite is not a compromise.', 'Read-heavy, single machine, and a backup is just copying one file.\n\n## WAL mode\n\n```sql\nPRAGMA journal_mode = WAL;\n```\n\nReaders and the writer no longer block each other.'],
];
for (const [postId, slug, title, excerpt, markdown] of translations) {
  const created = await api('POST', `/posts/${tidOf(postId)}/translate`, { locale: 'en' });
  const source = await api('GET', `/posts/${tidOf(postId)}`);
  await api('PUT', `/posts/${created.id}/draft`, { title, subtitle: '', excerpt, cover: source.draft.cover, markdown, frontMatter: '', meta: {}, baseVersion: 0 });
  await api('PATCH', `/posts/${created.id}/meta`, { slug });
  await api('POST', `/posts/${created.id}/publish`, {});
}
const enAbout = await inEn('POST', '/pages/translate', { pageId: (await api('GET', `/pages/${about.id}`)).pageId });
await api('PUT', `/pages/${enAbout.id}`, { title: 'About', markdown: 'I am a developer who mostly writes backend code and cares about typography.\n\n## This site\n\nEverything here is written in Markdown, and the source files can be exported at any time.' });
await api('POST', `/pages/${enAbout.id}/publish`, {});

console.log(`已写入 ${posts.length} 篇示例文章（其中 2 篇有英文版）、6 个分类、1 个系列、1 个专题和 1 个页面：${base}/`);
