/**
 * 端到端验证 M1 验收项：
 *   安装 → 登录 → 写文章 → 发布 → 前台阅读；
 *   改已发布文章不影响线上；草稿匿名不可访问。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexemc-test-'));
process.env.DATA_DIR = dataDir;

const { buildApp } = await import('./app.ts');
const { sqlite } = await import('./db/index.ts');
const sharp = (await import('sharp')).default;

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

before(async () => {
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method: string, url: string, body?: unknown, opts: { anonymous?: boolean; csrf?: boolean } = {}) => {
  const res = await app.inject({
    method: method as 'GET',
    url: `/admin/api${url}`,
    payload: body as object | undefined,
    headers: { ...(opts.csrf === false ? {} : { 'x-nb-csrf': '1' }), ...(opts.anonymous ? {} : { cookie }) },
  });
  return { status: res.statusCode, body: res.body ? res.json() : null, res };
};
const page = (url: string, withCookie = false) => app.inject({ method: 'GET', url, headers: withCookie ? { cookie } : {} });

const draft = (over: Record<string, unknown>) => ({ title: '', subtitle: '', excerpt: '', cover: '', markdown: '', frontMatter: '', meta: {}, mode: 'manual', ...over });

test('未安装时前台跳转到安装向导', async () => {
  const res = await page('/');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/setup');
});

test('安装向导：校验、创建管理员、只能执行一次', async () => {
  assert.equal((await api('POST', '/setup', { siteName: '测试博客', username: 'admin', password: 'short' }, { anonymous: true })).status, 400);
  const res = await api('POST', '/setup', { siteName: '测试博客', username: 'admin', password: 'correct-horse' }, { anonymous: true });
  assert.equal(res.status, 200);
  const setCookie = String(res.res.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  cookie = setCookie.split(';')[0];
  assert.equal((await api('POST', '/setup', { siteName: 'x', username: 'evil', password: 'correct-horse' }, { anonymous: true })).status, 409);
});

test('鉴权：匿名 401、缺少校验头 403、错误密码 401', async () => {
  assert.equal((await api('GET', '/posts', undefined, { anonymous: true })).status, 401);
  assert.equal((await api('POST', '/posts', {}, { csrf: false })).status, 403);
  assert.equal((await api('POST', '/login', { username: 'admin', password: 'wrong-password' }, { anonymous: true })).status, 401);
  const ok = await api('POST', '/login', { username: 'admin', password: 'correct-horse' }, { anonymous: true });
  assert.equal(ok.status, 200);
  const status = await api('GET', '/status');
  assert.equal(status.body.installed, true);
  assert.equal(status.body.user.username, 'admin');
});

let tid = 0;

test('新建草稿：中文标题生成拼音地址，匿名不可访问', async () => {
  const created = await api('POST', '/posts', { title: '你好，世界' });
  assert.equal(created.status, 200);
  assert.equal(created.body.slug, 'ni-hao-shi-jie');
  tid = created.body.id;

  assert.equal((await page('/posts/ni-hao-shi-jie')).statusCode, 404, '草稿不应公开');
  assert.equal((await page(`/preview/post/${tid}`)).statusCode, 404, '匿名不能看草稿预览');
  const preview = await page(`/preview/post/${tid}`, true);
  assert.equal(preview.statusCode, 200);
  assert.match(preview.body, /草稿预览/);
  assert.equal(preview.headers['cache-control'], 'no-store');
});

test('保存草稿：自动保存原地覆盖，乐观锁发现冲突', async () => {
  const a = await api('PUT', `/posts/${tid}/draft`, draft({ title: '你好，世界', markdown: '第一版', baseVersion: 0, mode: 'auto' }));
  assert.equal(a.status, 200);
  assert.equal(a.body.lockVersion, 1);
  const b = await api('PUT', `/posts/${tid}/draft`, draft({ title: '你好，世界', markdown: '第一版 改', baseVersion: 1, mode: 'auto' }));
  assert.equal(b.body.revisionId, a.body.revisionId, '连续自动保存应复用同一条修订');

  const stale = await api('PUT', `/posts/${tid}/draft`, draft({ title: 'x', markdown: '过期窗口', baseVersion: 1, mode: 'auto' }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.data.draft.markdown, '第一版 改', '冲突时返回服务器当前内容');
  const forced = await api('PUT', `/posts/${tid}/draft`, draft({ title: '你好，世界', markdown: '## 小节\n\n第一版正文', baseVersion: 1, force: true }));
  assert.equal(forced.status, 200);
});

test('发布前检查：空标题或空正文不能发布', async () => {
  const empty = await api('POST', '/posts', {});
  const res = await api('POST', `/posts/${empty.body.id}/publish`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /标题不能为空/);
  await api('POST', `/posts/${empty.body.id}/trash`);
});

test('发布后前台可读，且带安全响应头', async () => {
  const res = await api('POST', `/posts/${tid}/publish`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.translation.status, 'published');
  assert.equal(res.body.hasPendingChanges, false);

  const post = await page('/posts/ni-hao-shi-jie');
  assert.equal(post.statusCode, 200);
  assert.match(post.body, /第一版正文/);
  assert.match(post.body, /<h2 id="小节"/);
  assert.match(String(post.headers['content-security-policy']), /script-src 'self'/);
  assert.equal(post.headers['x-content-type-options'], 'nosniff');

  const home = await page('/');
  assert.match(home.body, /你好，世界/);
  assert.match((await page('/posts')).body, /ni-hao-shi-jie/);
});

test('修改已发布文章：线上仍是上一版，再次发布后才更新', async () => {
  const cur = await api('GET', `/posts/${tid}`);
  const saved = await api('PUT', `/posts/${tid}/draft`, draft({ title: '你好，世界（修订）', markdown: '第二版正文', baseVersion: cur.body.translation.lockVersion }));
  assert.equal(saved.status, 200);
  assert.notEqual(saved.body.revisionId, cur.body.draft.id, '不能改写线上修订');

  const after1 = await api('GET', `/posts/${tid}`);
  assert.equal(after1.body.hasPendingChanges, true);
  let post = await page('/posts/ni-hao-shi-jie');
  assert.match(post.body, /第一版正文/);
  assert.doesNotMatch(post.body, /第二版正文/);
  assert.match((await page(`/preview/post/${tid}`, true)).body, /第二版正文/);

  await api('POST', `/posts/${tid}/publish`, {});
  post = await page('/posts/ni-hao-shi-jie');
  assert.match(post.body, /第二版正文/);
  assert.match((await page('/')).body, /你好，世界（修订）/, '首页缓存应随发布失效');
});

test('回退上一发布版本；恢复旧修订只进草稿', async () => {
  const rolled = await api('POST', `/posts/${tid}/rollback`);
  assert.equal(rolled.status, 200);
  assert.match((await page('/posts/ni-hao-shi-jie')).body, /第一版正文/);
  assert.equal(rolled.body.hasPendingChanges, true, '草稿仍是第二版');

  const revs = await api('GET', `/posts/${tid}/revisions`);
  const oldest = revs.body.at(-1);
  const restored = await api('POST', `/posts/${tid}/revisions/${oldest.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.draft.kind, 'restore');
  assert.match((await page('/posts/ni-hao-shi-jie')).body, /第一版正文/, '恢复旧版不得静默改动线上');
});

test('修改地址标识：校验、冲突、旧地址 301', async () => {
  assert.equal((await api('PATCH', `/posts/${tid}/meta`, { slug: 'Bad Slug' })).status, 400);
  assert.equal((await api('PATCH', `/posts/${tid}/meta`, { slug: 'admin' })).status, 400);
  const res = await api('PATCH', `/posts/${tid}/meta`, { slug: 'hello-world', pinned: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.post.pinned, 1);
  const old = await page('/posts/ni-hao-shi-jie');
  assert.equal(old.statusCode, 301);
  assert.equal(old.headers.location, '/posts/hello-world');
  assert.equal((await page('/posts/hello-world')).statusCode, 200);

  const other = await api('POST', '/posts', { title: 'Hello World' });
  assert.equal(other.body.slug, 'hello-world-2', '地址冲突时自动加序号');
  await api('POST', `/posts/${other.body.id}/trash`);
});

test('下线、归档、回收站', async () => {
  await api('POST', `/posts/${tid}/unpublish`);
  assert.equal((await page('/posts/hello-world')).statusCode, 404);
  assert.doesNotMatch((await page('/')).body, /hello-world/);

  await api('POST', `/posts/${tid}/publish`, {});
  await api('POST', `/posts/${tid}/archive`);
  assert.equal((await page('/posts/hello-world')).statusCode, 200, '归档文章仍可访问');
  assert.doesNotMatch((await page('/posts')).body, /hello-world/, '归档文章不进列表');

  await api('POST', `/posts/${tid}/publish`, {});
  assert.equal((await api('DELETE', `/posts/${tid}`)).status, 400, '未进回收站不能永久删除');
  await api('POST', `/posts/${tid}/trash`);
  assert.equal((await page('/posts/hello-world')).statusCode, 404);
  const list = await api('GET', '/posts?filter=trash');
  assert.ok(list.body.items.some((p: { id: number }) => p.id === tid));
  assert.equal(list.body.counts.trash, 3);
  await api('POST', `/posts/${tid}/restore`);
  assert.equal((await page('/posts/hello-world')).statusCode, 200, '恢复后回到原状态');
});

test('图片上传：识别真实格式、去重、引用保护', async () => {
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#b4532a' } }).png().toBuffer();
  const upload = (buf: Buffer, filename: string, name = '') => {
    const boundary = '----nb' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: 'POST', url: `/admin/api/media?name=${name}`, payload, headers: { cookie, 'x-nb-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` } });
  };

  const bad = await upload(Buffer.from('<script>alert(1)</script>'), 'evil.png');
  assert.equal(bad.statusCode, 400, '伪装成图片的文件必须拒绝');

  const first = await upload(png, '截图.png', 'hello-world-1');
  assert.equal(first.statusCode, 200);
  const m = first.json();
  assert.match(m.url, /^\/uploads\/\d{4}\/\d{2}\/hello-world-1-[0-9a-f]{8}\.png$/);
  assert.equal(m.width, 40);
  assert.equal((await upload(png, 'again.png')).json().duplicate, true);

  const served = await page(m.url);
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');

  const cur = await api('GET', `/posts/${tid}`);
  await api('PUT', `/posts/${tid}/draft`, draft({ title: '带图', markdown: `![图](${m.url})`, baseVersion: cur.body.translation.lockVersion }));
  const blocked = await api('DELETE', `/media/${m.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.data.usages[0].id, tid);
  assert.equal((await api('DELETE', `/media/${m.id}?force=1`)).status, 200);
  assert.equal((await page(m.url)).statusCode, 404);
});

test('无标题新建：占位地址在首次发布前随标题更新，发布后不再自动变', async () => {
  const created = await api('POST', '/posts', {});
  assert.match(created.body.slug, /^post-[a-z0-9]+$/);
  const saved = await api('PUT', `/posts/${created.body.id}/draft`, draft({ title: '占位地址测试', markdown: '正文', baseVersion: 0 }));
  assert.equal(saved.body.slug, 'zhan-wei-di-zhi-ce-shi');
  await api('POST', `/posts/${created.body.id}/publish`, {});
  const again = await api('PUT', `/posts/${created.body.id}/draft`, draft({ title: '改了标题', markdown: '正文', baseVersion: saved.body.lockVersion }));
  assert.equal(again.body.slug, 'zhan-wei-di-zhi-ce-shi', '已发布文章的地址不能悄悄改变');
  await api('POST', `/posts/${created.body.id}/trash`);
  await api('DELETE', `/posts/${created.body.id}`);
});

test('设置、404 与静态资源边界', async () => {
  assert.equal((await api('PUT', '/settings', { timezone: 'Mars/Olympus' })).status, 400);
  const res = await api('PUT', '/settings', { siteName: '新站名', appearance: 'dark', icp: '京ICP备00000000号' });
  assert.equal(res.status, 200);
  const home = await page('/');
  assert.match(home.body, /data-mode="dark"/);
  assert.match(home.body, /京ICP备00000000号/);

  const nf = await page('/no-such-page');
  assert.equal(nf.statusCode, 404);
  assert.match(nf.body, /页面不存在/);
  assert.equal((await page('/theme/default/1.0.0/style.css')).statusCode, 200);
  assert.deepEqual((await page('/healthz')).json(), { ok: true });
  assert.equal((await page('/theme/default/1.0.0/../theme.json')).statusCode, 404, '主题模板与配置不可下载');
  assert.ok([403, 404].includes((await page('/theme/default/1.0.0/..%2Ftemplates%2Flayout.liquid')).statusCode));
});

test('修改密码后旧会话失效', async () => {
  const old = cookie;
  const res = await api('POST', '/account/password', { current: 'correct-horse', next: 'battery-staple-9' });
  assert.equal(res.status, 200);
  const fresh = String(res.res.headers['set-cookie']).split(';')[0];
  cookie = old;
  assert.equal((await api('GET', '/posts')).status, 401);
  cookie = fresh;
  assert.equal((await api('GET', '/posts')).status, 200);
});
