/**
 * M5 验收：含标题、代码块、表格、图片和 Front Matter 的 Markdown 导入后可原样导出；
 * 内容与媒体可以整体导出。以及冲突处理、备份恢复、重定向、日志与 SEO 补全。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexemc-m5-'));
process.env.DATA_DIR = dataDir;
process.env.NB_NO_EXIT = '1';

const { buildApp } = await import('./app.ts');
const { sqlite } = await import('./db/index.ts');
const { splitFrontMatter, buildFrontMatter, joinFrontMatter } = await import('./lib/frontmatter.ts');
const { applyPendingRestore } = await import('./lib/restore.ts');
const sharp = (await import('sharp')).default;

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

const api = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url: `/admin/api${url}`, payload: body as object | undefined, headers: { 'x-nb-csrf': '1', cookie } });
  let json: any = null;
  try {
    json = res.body ? res.json() : null;
  } catch {
    /* 下载类接口不是 JSON */
  }
  return { status: res.statusCode, body: json, text: res.body, raw: res.rawPayload, headers: res.headers };
};
const page = (url: string) => app.inject({ method: 'GET', url: encodeURI(url) });

async function upload(url: string, files: { name: string; data: Buffer | string }[]) {
  const boundary = '----nb' + Math.random().toString(16).slice(2);
  const parts = files.flatMap((f) => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${encodeURIComponent(f.name)}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8'), Buffer.from('\r\n')]);
  const res = await app.inject({ method: 'POST', url: `/admin/api${url}`, payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), headers: { cookie, 'x-nb-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: res.json() };
}

// 一篇有代表性的文章：Front Matter（含系统不认识的字段和注释）、代码块、表格、图片
const BODY = ['# 部署笔记', '', '正文第一段，行尾有两个空格  ', '用来强制换行。', '', '```bash', 'docker compose up -d   # 注意缩进', '\tindented-with-tab', '```', '', '| 项目 | 值 |', '| :--- | ---: |', '| 端口 | 3000 |', '', '![架构图](./images/arch.png "系统架构")', '', '![缺失的图](missing.png)', '', '参见[另一篇](./other.md)。', '', '- [x] 完成', '', '结尾没有换行'].join('\n');
const FRONT = ['title: 部署笔记', 'slug: deploy-notes', 'date: 2024-03-05T08:00:00.000Z', '# 这一行注释也要保留', 'tags: [Docker, 运维]', 'categories:', '  - 开发/运维', 'series_order: 3', 'custom:', '  nested: true'].join('\n');
const SOURCE = `---\n${FRONT}\n---\n\n${BODY}`;

before(async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/admin/api/setup', payload: { siteName: '迁移测试', username: 'admin', password: 'correct-horse' }, headers: { 'x-nb-csrf': '1' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Front Matter：拆分与拼回不改动正文；未知字段、注释和顺序保留', () => {
  const { raw, body } = splitFrontMatter(SOURCE);
  assert.equal(body, BODY);
  assert.equal(joinFrontMatter(raw!, body), SOURCE, '原样拼回');

  const rebuilt = buildFrontMatter(raw!, { title: '新标题', draft: true, tags: undefined, slug: null });
  assert.match(rebuilt, /^title: 新标题$/m);
  assert.match(rebuilt, /# 这一行注释也要保留/);
  assert.match(rebuilt, /series_order: 3/);
  assert.match(rebuilt, /nested: true/);
  assert.match(rebuilt, /tags: \[Docker, 运维\]/, 'undefined 的键不动');
  assert.doesNotMatch(rebuilt, /^slug:/m, 'null 的键被删除');
  assert.ok(rebuilt.indexOf('title:') < rebuilt.indexOf('series_order'), '字段顺序不变');

  assert.equal(splitFrontMatter('没有 Front Matter\n---\n不是分隔线').raw, null);
  assert.equal(splitFrontMatter('﻿---\na: 1\n---\nx').body, 'x', '去掉 BOM');
  const crlf = splitFrontMatter('---\r\na: 1\r\n---\r\n\r\n正文\r\n第二行');
  assert.equal(crlf.body, '正文\r\n第二行', 'CRLF 换行原样保留');
});

let imported = 0;

test('导入预检：读出元信息，指出相对路径图片、相对链接与未知字段，不写入任何内容', async () => {
  const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#224466' } }).png().toBuffer();
  const zip = Buffer.from(zipSync({ 'notes/deploy.md': strToU8(SOURCE), 'notes/images/arch.png': new Uint8Array(png), 'notes/broken.md': strToU8('---\ntitle: [unclosed\n---\nx'), 'notes/empty.md': strToU8('---\ntitle: 空文\n---\n') }));
  const res = await upload('/import/inspect', [{ name: 'notes.zip', data: zip }]);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.imageFiles, 1);
  const item = res.body.items.find((i: { file: string }) => i.file === 'notes/deploy.md');
  assert.equal(item.title, '部署笔记');
  assert.equal(item.slug, 'deploy-notes');
  assert.equal(item.date, Date.parse('2024-03-05T08:00:00.000Z'));
  assert.deepEqual(item.tags, ['Docker', '运维']);
  assert.deepEqual(item.categories, ['开发/运维']);
  assert.deepEqual(item.unknownKeys, ['series_order', 'custom']);
  assert.deepEqual(item.images, [{ ref: './images/arch.png', found: true }, { ref: 'missing.png', found: false }]);
  assert.ok(item.warnings.some((w: string) => /1 张相对路径的图片没有一起上传/.test(w)));
  assert.ok(item.warnings.some((w: string) => /相对路径链接/.test(w)));
  assert.equal(item.conflict, null);
  assert.match(res.body.items.find((i: { file: string }) => i.file === 'notes/broken.md').errors[0], /Front Matter 解析失败/);
  assert.match(res.body.items.find((i: { file: string }) => i.file === 'notes/empty.md').errors[0], /正文为空/);
  assert.equal((await api('GET', '/posts')).body.total, 0, '预检不写入');
  assert.equal((await api('GET', '/media')).body.total, 0);

  // 正式导入并发布
  const run = await upload('/import/run?publish=1', [{ name: 'notes.zip', data: zip }]);
  assert.equal(run.body.created, 1);
  assert.equal(run.body.failed, 2, '有问题的文件各自失败，不影响其他文件');
  imported = run.body.results.find((r: { status: string }) => r.status === 'created').id;
});

test('导入结果：元信息、分类路径、标签、发布日期与图片都到位', async () => {
  const edit = (await api('GET', `/posts/${imported}`)).body;
  assert.equal(edit.translation.slug, 'deploy-notes');
  assert.equal(edit.translation.status, 'published');
  assert.equal(edit.translation.firstPublishedAt, Date.parse('2024-03-05T08:00:00.000Z'), '沿用原来的发布日期');
  assert.equal(edit.draft.frontMatter, FRONT, 'Front Matter 原文保留');

  const tx = (await api('GET', `/posts/${imported}/taxonomy`)).body;
  assert.deepEqual(tx.tags.sort(), ['Docker', '运维']);
  const tree = (await api('GET', '/categories')).body.tree;
  assert.equal(tree[0].name, '开发');
  assert.equal(tree[0].children[0].name, '运维', '按路径逐级创建分类');
  assert.equal(tx.primaryCategoryId, tree[0].children[0].id);

  const media = (await api('GET', '/media')).body;
  assert.equal(media.total, 1, '压缩包里的图片进了媒体库');
  assert.ok(edit.draft.markdown.includes(`![架构图](${media.items[0].url} "系统架构")`), '图片引用改成站内地址');
  assert.ok(edit.draft.markdown.includes('![缺失的图](missing.png)'), '找不到的图片引用保持原样');
  // 除了那一处图片地址，正文其余部分一个字符都没变
  assert.equal(edit.draft.markdown.replace(media.items[0].url, './images/arch.png'), BODY);

  const live = await page('/posts/deploy-notes');
  assert.equal(live.statusCode, 200);
  assert.match(live.body, /indented-with-tab/);
  assert.match(live.body, /<table>/);
  assert.match(live.body, /2024/);
});

test('导出单篇：正文与保存的内容逐字一致，未知的 Front Matter 字段原样带回', async () => {
  const edit = (await api('GET', `/posts/${imported}`)).body;
  const res = await api('GET', `/export/posts/${imported}`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-disposition']), /deploy-notes\.md/);
  const exported = splitFrontMatter(res.text);
  assert.equal(exported.body, edit.draft.markdown, '导出的正文 === 编辑器里保存的源码');
  assert.match(exported.raw!, /series_order: 3/);
  assert.match(exported.raw!, /# 这一行注释也要保留/);
  assert.match(exported.raw!, /nested: true/);
  assert.match(exported.raw!, /^lang: zh-CN$/m);
  assert.match(exported.raw!, /开发\/运维/);
  assert.doesNotMatch(exported.raw!, /^draft:/m, '已发布的文章不带 draft');

  // 手写的各种“容易被悄悄改掉”的内容：导出后必须原样
  const tricky = '行尾空格  \n\n\n\n连续空行\n\t制表符开头\n<div>原始 HTML</div>\n\n* 星号列表\n+ 加号列表\n\n标题\n===\n\n\\*转义\\*  &amp; &nbsp;\n```\n未标语言的代码\n```\n';
  const created = (await api('POST', '/posts', { title: '原样测试' })).body.id;
  await api('PUT', `/posts/${created}/draft`, { title: '原样测试', subtitle: '', excerpt: '', cover: '', markdown: tricky, frontMatter: '', meta: {}, baseVersion: 0 });
  const out = splitFrontMatter((await api('GET', `/export/posts/${created}`)).text);
  assert.equal(out.body, tricky);
  assert.match(out.raw!, /^draft: true$/m, '未发布的文章标记为草稿');

  // 导出的文件再导入：正文仍然一致（完整往返）
  await api('POST', `/posts/${created}/trash`);
  await api('DELETE', `/posts/${created}`);
  const again = await upload('/import/run', [{ name: 'yuan-yang-ce-shi.md', data: (await api('GET', `/export/posts/${imported}`)).text.replace('slug: deploy-notes', 'slug: deploy-notes-copy') }]);
  assert.equal(again.body.created, 1);
  assert.equal((await api('GET', `/posts/${again.body.results[0].id}`)).body.draft.markdown, edit.draft.markdown);
  assert.equal((await api('GET', `/posts/${again.body.results[0].id}`)).body.translation.status, 'draft', '未选择发布时保持草稿');
});

test('地址冲突：跳过、改名另存、存为已有文章的新草稿', async () => {
  const file = [{ name: 'deploy.md', data: SOURCE.replace('正文第一段', '改动过的第一段') }];
  const inspected = await upload('/import/inspect', file);
  assert.equal(inspected.body.items[0].conflict.id, imported);
  assert.equal(inspected.body.conflicts, 1);

  const skipped = await upload('/import/run?onConflict=skip', file);
  assert.deepEqual([skipped.body.created, skipped.body.skipped], [0, 1]);

  const renamed = await upload('/import/run?onConflict=rename', file);
  assert.equal(renamed.body.created, 1);
  assert.match(renamed.body.results[0].slug, /^deploy-notes-\d+$/);

  const over = await upload('/import/run?onConflict=overwrite&publish=1', file);
  assert.equal(over.body.updated, 1);
  const edit = (await api('GET', `/posts/${imported}`)).body;
  assert.match(edit.draft.markdown, /改动过的第一段/);
  assert.equal(edit.hasPendingChanges, true);
  assert.doesNotMatch((await page('/posts/deploy-notes')).body, /改动过的第一段/, '覆盖只进草稿，线上不变');

  // 内容完全相同的文件能被识别出来
  const dup = await upload('/import/inspect', [{ name: 'another-name.md', data: `---\ntitle: 别的标题\n---\n\n${edit.draft.markdown}` }]);
  assert.equal(dup.body.items[0].duplicateOf.id, imported);
});

test('全站导出：文章、结构数据与媒体文件整体打包', async () => {
  await api('POST', '/pages', { title: '关于' });
  const res = await api('GET', '/export/site');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /zip/);
  const zip = unzipSync(new Uint8Array(res.raw));
  const names = Object.keys(zip);
  assert.ok(names.includes('posts/zh-CN/deploy-notes.md'));
  assert.ok(names.includes('pages/zh-CN/guan-yu.md'));
  for (const f of ['posts/index.json', 'data/zh-CN/categories.json', 'data/zh-CN/tags.json', 'data/zh-CN/nav.json', 'data/settings.json', 'data/redirects.json', 'media/manifest.json', 'README.txt']) assert.ok(names.includes(f), `应包含 ${f}`);
  const manifest = JSON.parse(Buffer.from(zip['media/manifest.json']).toString('utf8'));
  assert.equal(manifest.length, 1);
  assert.ok(names.includes(manifest[0].file), '媒体文件本体也在包里');
  assert.match(Buffer.from(zip['posts/zh-CN/deploy-notes.md']).toString('utf8'), /series_order: 3/);
  assert.doesNotMatch(Buffer.from(zip['data/settings.json']).toString('utf8'), /password|session/i, '不导出任何凭据');

  const light = unzipSync(new Uint8Array((await api('GET', '/export/site?media=0')).raw));
  assert.ok(!Object.keys(light).some((n) => n.startsWith('media/files/')), '可以选择不带媒体文件');
  const tree = (await api('GET', '/categories')).body.tree;
  const part = unzipSync(new Uint8Array((await api('GET', `/export/site?categoryId=${tree[0].id}&media=0`)).raw));
  assert.ok(Object.keys(part).includes('posts/zh-CN/deploy-notes.md'), '按分类导出包含下级分类的文章');
  assert.ok(!Object.keys(part).some((n) => n.startsWith('pages/')));
});

test('备份与恢复：备份包含数据库快照与媒体；恢复先留底、再在重启时替换', async () => {
  const created = await api('POST', '/backups', { note: '测试备份' });
  assert.equal(created.status, 200);
  const name = created.body.name as string;
  assert.equal(created.body.manifest.mediaFiles, 1);
  assert.ok(created.body.manifest.posts >= 2);

  const list = (await api('GET', '/backups')).body.backups;
  assert.equal(list[0].name, name);
  const zip = unzipSync(new Uint8Array((await api('GET', `/backups/${name}`)).raw));
  assert.equal(Buffer.from(zip['blog.db'].subarray(0, 15)).toString('latin1'), 'SQLite format 3');
  assert.ok(Object.keys(zip).some((n) => n.startsWith('uploads/')));
  assert.equal((await api('GET', '/backups/..%2Fblog.db')).status, 400, '不能借备份接口读取其他文件');

  // 备份之后又写了新内容，然后恢复
  await api('POST', '/posts', { title: '备份之后新建的' });
  const restore = await api('POST', `/backups/${name}/restore`);
  assert.equal(restore.status, 200);
  assert.match(restore.body.safetyBackup, /^backup-/, '恢复前自动把当前状态留底');
  assert.equal((await api('GET', '/backups')).body.backups.length, 2);
  const pending = path.join(dataDir, 'restore-pending');
  assert.ok(fs.existsSync(path.join(pending, 'blog.db')));
  assert.ok(fs.readdirSync(path.join(pending, 'uploads')).length > 0);

  // 落地步骤在进程启动、数据库打开之前执行；这里用一个独立目录模拟
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'nexemc-restore-'));
  fs.writeFileSync(path.join(fake, 'blog.db'), 'OLD');
  fs.writeFileSync(path.join(fake, 'blog.db-wal'), 'OLD-WAL');
  fs.mkdirSync(path.join(fake, 'uploads'));
  fs.writeFileSync(path.join(fake, 'uploads', 'old.txt'), 'old');
  fs.cpSync(pending, path.join(fake, 'restore-pending'), { recursive: true });
  const replaced = applyPendingRestore(fake)!;
  assert.equal(fs.readFileSync(path.join(fake, 'blog.db')).subarray(0, 15).toString('latin1'), 'SQLite format 3', '数据库已换成备份里的');
  assert.ok(!fs.existsSync(path.join(fake, 'blog.db-wal')), '旧的 WAL 不会套到新库上');
  assert.ok(!fs.existsSync(path.join(fake, 'uploads', 'old.txt')));
  assert.equal(fs.readFileSync(path.join(replaced, 'blog.db'), 'utf8'), 'OLD', '被替换的数据保留在 replaced-* 目录');
  assert.ok(!fs.existsSync(path.join(fake, 'restore-pending')));
  assert.equal(applyPendingRestore(fake), null, '没有待恢复内容时什么都不做');
  fs.rmSync(fake, { recursive: true, force: true });
  fs.rmSync(pending, { recursive: true, force: true });

  assert.equal((await api('DELETE', `/backups/${name}`)).status, 200);
});

test('重定向管理与操作日志', async () => {
  assert.equal((await api('POST', '/redirects', { from: 'no-slash', to: '/x' })).status, 400);
  assert.equal((await api('POST', '/redirects', { from: '/admin/x', to: '/x' })).status, 400);
  assert.equal((await api('POST', '/redirects', { from: '/a', to: 'javascript:alert(1)' })).status, 400);
  assert.equal((await api('POST', '/redirects', { from: '/old-blog/deploy/', to: '/posts/deploy-notes' })).status, 200);
  const old = await page('/old-blog/deploy');
  assert.equal(old.statusCode, 301);
  assert.equal(old.headers.location, '/posts/deploy-notes');

  const list = (await api('GET', '/redirects?q=old-blog')).body;
  assert.equal(list.total, 1);
  await api('DELETE', `/redirects/${list.items[0].id}`);
  assert.equal((await page('/old-blog/deploy')).statusCode, 404);

  const audit = (await api('GET', '/audit')).body;
  const actions = audit.items.map((i: { action: string }) => i.action);
  for (const a of ['import', 'export', 'backup_create', 'backup_restore', 'redirect_create', 'redirect_delete']) assert.ok(actions.includes(a), `日志应记录 ${a}`);
  assert.equal((await api('GET', '/audit?action=backup')).body.items.every((i: { action: string }) => i.action.startsWith('backup')), true);
});

test('SEO 与安全补全：结构化数据、全站禁止收录、后台防嵌入、搜索限速', async () => {
  const post = (await page('/posts/deploy-notes')).body;
  const ld = /<script type="application\/ld\+json">(.+?)<\/script>/.exec(post);
  assert.ok(ld, '文章页输出结构化数据');
  const data = JSON.parse(ld![1]);
  assert.equal(data[0]['@type'], 'BlogPosting');
  assert.equal(data[0].headline, '部署笔记');
  assert.equal(data[0].datePublished, '2024-03-05T08:00:00.000Z');
  assert.match(post, /<meta name="twitter:card"/);

  await api('PUT', '/settings', { siteNoindex: true });
  assert.match((await page('/robots.txt')).body, /Disallow: \/\n$/);
  assert.match((await page('/')).body, /<meta name="robots" content="noindex">/);
  await api('PUT', '/settings', { siteNoindex: false });
  assert.doesNotMatch((await page('/')).body, /name="robots"/);

  const admin = await page('/admin/api/status');
  assert.equal(admin.headers['x-frame-options'], 'DENY');
  assert.match(String(admin.headers['x-robots-tag']), /noindex/);

  let last = 200;
  for (let i = 0; i < 45; i++) last = (await page('/search?q=x')).statusCode;
  assert.equal(last, 429, '同一 IP 短时间内大量搜索会被限速');
});
