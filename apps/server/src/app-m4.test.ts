/**
 * M4 验收：导入新主题 → 校验 → 管理员预览 → 正式切换 → 全站统一 → 回滚；访客端没有切换控件。
 * 以及内置主题切换、主题配置的草稿 / 应用 / 回退、版本升级与回滚、信任分级、坏主题兜底。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexemc-m4-'));
process.env.DATA_DIR = dataDir;

const { buildApp } = await import('./app.ts');
const { sqlite } = await import('./db/index.ts');
const { config } = await import('./config.ts');

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

const api = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url: `/admin/api${url}`, payload: body as object | undefined, headers: { 'x-nb-csrf': '1', cookie } });
  const set = res.headers['set-cookie'];
  return { status: res.statusCode, body: res.body ? res.json() : null, setCookie: Array.isArray(set) ? set.join('; ') : String(set ?? '') };
};
const page = (url: string, cookies = '') => app.inject({ method: 'GET', url, headers: cookies ? { cookie: cookies } : {} });

/** 以默认主题为底，生成一个可改动的主题文件集合 */
function themeFiles(overrides: Record<string, string | null> = {}, manifest: Record<string, unknown> = {}) {
  const files: Record<string, Uint8Array> = {};
  const root = path.join(config.themesDir, 'default');
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else files[rel + entry.name] = new Uint8Array(fs.readFileSync(path.join(dir, entry.name)));
    }
  };
  walk(root, '');
  files['theme.json'] = strToU8(JSON.stringify({ id: 'paper', name: '纸页', version: '1.0.0', author: '测试', description: '测试主题', requires: '>=1.0.0', settings: [{ key: 'tone', type: 'color', label: '色调', default: '#112233' }], ...manifest }));
  // 在页面里留一个可识别的标记，用来确认渲染的确实是这个主题的这个版本
  const layout = Buffer.from(files['templates/layout.liquid']).toString('utf8');
  files['templates/layout.liquid'] = strToU8(layout.replace('<body ', `<body data-theme-mark="paper-${String(manifest.version ?? '1.0.0')}" data-tone="{{ theme.config.tone }}" `));
  for (const [name, content] of Object.entries(overrides)) {
    if (content === null) delete files[name];
    else files[name] = strToU8(content);
  }
  return files;
}
const zip = (files: Record<string, Uint8Array>) => Buffer.from(zipSync(files));

async function upload(endpoint: 'inspect' | 'install', buf: Buffer) {
  const boundary = '----nb' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="theme.zip"\r\nContent-Type: application/zip\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url: `/admin/api/themes/${endpoint}`, payload, headers: { cookie, 'x-nb-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: res.json() };
}

before(async () => {
  app = await buildApp({ logger: false });
  const res = await api('POST', '/setup', { siteName: '主题测试', username: 'admin', password: 'correct-horse' });
  cookie = res.setCookie.split(';')[0];
  const created = await api('POST', '/posts', { title: 'Hello Theme' });
  await api('PUT', `/posts/${created.body.id}/draft`, { title: 'Hello Theme', subtitle: '', excerpt: '', cover: '', markdown: '## 小节\n\n正文内容。\n\n### 更小的节\n\n结尾。', frontMatter: '', meta: {}, baseVersion: 0 });
  await api('POST', `/posts/${created.body.id}/publish`, {});
});
after(async () => {
  await app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const BUILTIN = ['aurora', 'default', 'docs', 'magazine', 'riso', 'zine'];

test('主题库：六套内置主题，默认主题生效；访客页面没有任何主题切换控件', async () => {
  const lib = (await api('GET', '/themes')).body;
  assert.deepEqual(lib.themes.map((t: { id: string }) => t.id).sort(), BUILTIN);
  assert.equal(lib.active, 'default');
  assert.ok(lib.themes.every((t: { source: string; trusted: boolean; compatible: boolean }) => t.source === 'builtin' && t.trusted && t.compatible));

  const home = await page('/');
  assert.doesNotMatch(home.body, /theme-switch|data-theme-select|切换主题/);
  assert.doesNotMatch(String(home.headers['set-cookie'] ?? ''), /theme/i, '不给访客写任何主题相关的 Cookie');
  for (const id of BUILTIN) assert.equal((await page(`/theme/${id}/1.0.0/style.css`)).statusCode, 200);
});

test('切换内置主题：全站统一生效，内容与地址不变；可一键回退', async () => {
  assert.equal((await api('POST', '/themes/docs/activate')).status, 200);
  const home = (await page('/')).body;
  assert.match(home, /class="shell"/, '技术文档主题的布局');
  assert.match(home, /\/theme\/docs\//);
  const post = await page('/posts/hello-theme');
  assert.equal(post.statusCode, 200);
  assert.match(post.body, /正文内容/);
  assert.match(post.body, /class="side"/, '文章页也是同一套主题');

  await api('POST', '/themes/magazine/activate');
  assert.match((await page('/')).body, /class="masthead-bar"/);
  assert.match((await page('/posts/hello-theme')).body, /正文内容/);
  assert.equal((await page('/no-such')).statusCode, 404);

  const rolled = await api('POST', '/themes/rollback');
  assert.equal(rolled.body.active, 'docs', '回退到上一个主题');
  await api('POST', '/themes/default/activate');
  assert.equal((await api('GET', '/themes')).body.previous, 'docs');
  assert.equal((await api('POST', '/themes/nope/activate')).status, 404);
});

test('视觉主题：孔版印刷、极光、拼贴都能启用，明暗固定，配置项生效，文章内容不变', async () => {
  // 管理员把外观设成深色：始终浅色的主题不能被带成深色
  await api('PUT', '/settings', { appearance: 'dark' });
  const cases: [string, RegExp, string][] = [
    ['riso', /class="rmast"/, 'light'],
    ['aurora', /class="sky"/, 'dark'],
    ['zine', /class="ticker"/, 'light'],
  ];
  for (const [id, marker, mode] of cases) {
    assert.equal((await api('POST', `/themes/${id}/activate`)).status, 200, `${id} 可以启用`);
    const home = (await page('/')).body;
    assert.match(home, marker);
    assert.match(home, new RegExp(`<html lang="zh-CN" data-mode="${mode}">`), `${id} 固定为 ${mode}`);
    const post = (await page('/posts/hello-theme')).body;
    assert.match(post, /正文内容/);
    assert.match(post, /class="post-content"/);
    assert.equal((await page('/no-such')).statusCode, 404);
    assert.equal((await page(`/theme/${id}/1.0.0/style.css`)).statusCode, 200);
  }

  // 配置项：拼贴的背景色、关闭滚动字幕；极光换配色、关闭流动；孔版印刷关闭颗粒
  await api('PUT', '/themes/zine/config', { values: { bg: '#00aa55', ticker: false } });
  await api('POST', '/themes/zine/config/apply');
  await api('POST', '/themes/zine/activate');
  let html = (await page('/')).body;
  assert.match(html, /--bg: #00aa55/);
  assert.doesNotMatch(html, /class="ticker"/);
  await api('PUT', '/themes/aurora/config', { values: { palette: 'sunset', motion: false } });
  await api('POST', '/themes/aurora/config/apply');
  await api('POST', '/themes/aurora/activate');
  html = (await page('/')).body;
  assert.match(html, /palette-sunset/);
  assert.match(html, / still/);
  await api('PUT', '/themes/riso/config', { values: { grain: false, duotone: false } });
  await api('POST', '/themes/riso/config/apply');
  await api('POST', '/themes/riso/activate');
  assert.doesNotMatch((await page('/')).body, /<body class="page-home[^"]*grain/);

  await api('PUT', '/settings', { appearance: 'auto' });
  await api('POST', '/themes/default/activate');
});

test('主题配置：草稿不影响线上，预览可见，应用后生效，可回退与恢复默认', async () => {
  const info = (await api('GET', '/themes/default')).body;
  assert.equal(info.config.applied.marker, '#ffe14d');
  assert.equal((await api('PUT', '/themes/default/config', { values: { marker: 'red; } body { display:none' } })).status, 400, '颜色值必须是合法的十六进制');
  assert.equal((await api('PUT', '/themes/default/config', { values: { measure: '99rem' } })).status, 400, '枚举值必须在声明的选项里');

  const draft = await api('PUT', '/themes/default/config', { values: { marker: '#00ff88', hash_marks: false, unknown_key: 'x' } });
  assert.equal(draft.body.config.draft.marker, '#00ff88');
  assert.equal(draft.body.config.hasDraft, true);
  assert.equal('unknown_key' in draft.body.config.draft, false);
  assert.doesNotMatch((await page('/')).body, /#00ff88/, '草稿不影响线上');

  const preview = await api('POST', '/themes/default/preview', {});
  const previewCookie = `${cookie}; ${preview.setCookie.split(';')[0]}`;
  const previewed = await page('/', previewCookie);
  assert.match(previewed.body, /#00ff88/, '管理员预览使用配置草稿');
  assert.match(previewed.body, /正在预览主题/);
  assert.equal(previewed.headers['cache-control'], 'no-store');

  await api('POST', '/themes/default/config/apply');
  const live = (await page('/')).body;
  assert.match(live, /--marker: #00ff88/);
  assert.match(live, /no-hash/);
  assert.match((await api('POST', '/themes/default/config/revert')).body.config.applied.marker, /#ffe14d/);
  assert.doesNotMatch((await page('/')).body, /#00ff88/);
  await api('POST', '/themes/default/config/revert');
  assert.match((await page('/')).body, /#00ff88/, '再次回退换回刚才的配置');
  assert.equal((await api('POST', '/themes/default/config/reset')).body.config.applied.marker, '#ffe14d');
});

test('导入校验：各类不合格的安装包都被拒绝，并说明原因；线上不受影响', async () => {
  const check = async (buf: Buffer, pattern: RegExp) => {
    const res = await upload('inspect', buf);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.errors.some((e: string) => pattern.test(e)), `应包含 ${pattern}，实际：${res.body.errors.join(' | ')}`);
    assert.equal((await upload('install', buf)).status, 400, '安装接口同样拒绝');
  };
  await check(Buffer.from('this is not a zip'), /不是有效的 ZIP/);
  await check(zip(themeFiles({ 'theme.json': null })), /缺少 theme\.json/);
  await check(zip(themeFiles({ 'templates/search.liquid': null })), /缺少必需模板 templates\/search\.liquid/);
  await check(zip(themeFiles({}, { id: 'default' })), /内置主题的标识/);
  await check(zip(themeFiles({}, { id: 'Bad ID' })), /id 需为/);
  await check(zip(themeFiles({}, { version: 'v1' })), /三段版本号/);
  await check(zip(themeFiles({}, { requires: '>=9.0.0' })), /需要主题规范 9\.0\.0/);
  await check(zip(themeFiles({ 'assets/shell.php': '<?php echo 1;' })), /不允许的文件类型/);
  await check(zip({ ...themeFiles(), '../evil.liquid': strToU8('x') }), /非法的文件路径/);
  await check(zip(themeFiles({ 'templates/evil.js': 'alert(1)' })), /脚本只能放在 assets/);
  await check(zip(themeFiles({ 'assets/icon.svg': '<svg onload="alert(1)"></svg>' })), /SVG 文件里不能包含脚本/);
  await check(zip(themeFiles({ 'templates/home.liquid': "{% layout 'layout' %}{% block content %}{% if %}{% endblock %}" })), /templates\/home\.liquid/);
  await check(zip(themeFiles({ 'templates/tags.liquid': "{% layout 'layout' %}{% block content %}{{ 'x' | no_such_filter }}{% endblock %}" })), /templates\/tags\.liquid/);
  await check(zip(themeFiles({ 'templates/archive.liquid': '<p>没有布局</p>' })), /不是完整的页面/);
  await check(zip(themeFiles({}, { settings: [{ key: 'c', type: 'color', label: 'x', default: 'blue' }] })), /默认值与它的类型不符/);

  assert.equal((await api('GET', '/themes')).body.themes.length, BUILTIN.length, '没有任何东西被安装');
  assert.equal(fs.existsSync(path.join(dataDir, 'themes', 'paper')), false);
  assert.equal((await page('/')).statusCode, 200);
});

test('导入 → 预览 → 切换：新主题默认不受信任，脚本被禁用', async () => {
  const pkg = zip(themeFiles());
  const report = (await upload('inspect', pkg)).body;
  assert.equal(report.ok, true);
  assert.equal(report.manifest.id, 'paper');
  assert.deepEqual(report.scripts, ['assets/main.js']);
  assert.ok(report.warnings.some((w: string) => /脚本文件/.test(w)), '提示包含脚本');
  assert.equal((await api('GET', '/themes')).body.themes.length, BUILTIN.length, '检查不会安装');

  // 包在一个顶层文件夹里的压缩包同样可以安装
  const wrapped = Object.fromEntries(Object.entries(themeFiles()).map(([k, v]) => [`paper-theme/${k}`, v]));
  const installed = await upload('install', zip(wrapped));
  assert.equal(installed.status, 200);
  assert.equal(installed.body.theme.source, 'uploaded');
  assert.equal(installed.body.theme.trusted, false);
  assert.equal(installed.body.theme.activeVersion, '1.0.0');
  assert.doesNotMatch((await page('/')).body, /data-theme-mark/, '安装不等于启用');

  // 预览：只有带管理员会话的浏览器能看到
  const preview = await api('POST', '/themes/paper/preview', {});
  const previewOnly = preview.setCookie.split(';')[0];
  assert.match((await page('/', `${cookie}; ${previewOnly}`)).body, /data-theme-mark="paper-1\.0\.0"/);
  assert.doesNotMatch((await page('/', previewOnly)).body, /data-theme-mark/, '访客伪造预览 Cookie 无效');
  assert.doesNotMatch((await page('/')).body, /data-theme-mark/);

  assert.equal((await api('POST', '/themes/paper/activate')).status, 200);
  const live = await page('/');
  assert.match(live.body, /data-theme-mark="paper-1\.0\.0"/);
  assert.match(live.body, /data-tone="#112233"/, '主题声明的配置项默认值可用');
  assert.match(String(live.headers['content-security-policy']), /script-src 'none'/, '未受信任的主题不能运行脚本');
  assert.equal((await page('/theme/paper/1.0.0/style.css')).statusCode, 200);
  assert.equal((await page('/theme/paper/1.0.0/../theme.json')).statusCode, 404);
  assert.match((await page('/posts/hello-theme')).body, /正文内容/, '文章内容不受主题影响');

  assert.equal((await api('POST', '/themes/paper/trust', { trusted: true })).body.trusted, true);
  assert.match(String((await page('/')).headers['content-security-policy']), /script-src 'self'/);
  assert.equal((await api('POST', '/themes/default/trust', { trusted: false })).status, 400);
});

test('版本升级与回滚：线上主题升级不自动生效，旧版本保留', async () => {
  assert.equal((await upload('install', zip(themeFiles()))).status, 400, '相同版本不能重复安装');

  const v11 = await upload('install', zip(themeFiles({}, { version: '1.1.0', settings: [{ key: 'tone', type: 'color', label: '色调', default: '#445566' }] })));
  assert.equal(v11.status, 200);
  assert.equal(v11.body.report.isUpgrade, true);
  assert.deepEqual(v11.body.theme.versions, ['1.1.0', '1.0.0']);
  assert.equal(v11.body.theme.activeVersion, '1.0.0', '正在线上使用的主题不会被自动升级');
  assert.equal(v11.body.theme.trusted, true, '升级保留信任状态');
  assert.match((await page('/')).body, /paper-1\.0\.0/);

  // 先预览新版本，再切换
  const preview = await api('POST', '/themes/paper/preview', { version: '1.1.0' });
  assert.match((await page('/', `${cookie}; ${preview.setCookie.split(';')[0]}`)).body, /paper-1\.1\.0/);
  const switched = await api('POST', '/themes/paper/version', { version: '1.1.0' });
  assert.equal(switched.body.activeVersion, '1.1.0');
  assert.equal(switched.body.previousVersion, '1.0.0');
  assert.match((await page('/')).body, /paper-1\.1\.0/);
  assert.match((await page('/')).body, /data-tone="#445566"/);

  // 保存过的配置在升级后仍然保留
  await api('PUT', '/themes/paper/config', { values: { tone: '#abcdef' } });
  await api('POST', '/themes/paper/config/apply');
  assert.equal((await api('POST', '/themes/paper/version', { version: '1.0.0' })).body.activeVersion, '1.0.0', '回滚到旧版本');
  const rolled = (await page('/')).body;
  assert.match(rolled, /paper-1\.0\.0/);
  assert.match(rolled, /data-tone="#abcdef"/, '回滚后配置仍在');
  assert.equal((await api('DELETE', '/themes/paper/versions/1.0.0')).status, 400, '不能删除正在使用的版本');
  assert.equal((await api('POST', '/themes/paper/version', { version: '9.9.9' })).status, 404);
});

test('主题损坏时自动用默认主题兜底，站点保持可访问', async () => {
  const broken = path.join(dataDir, 'themes', 'paper', '1.0.0', 'templates', 'post.liquid');
  const original = fs.readFileSync(broken, 'utf8');
  fs.writeFileSync(broken, "{% layout 'layout' %}{% block content %}{{ post.title | no_such_filter }}{% endblock %}");
  const res = await page('/posts/hello-theme');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /正文内容/);
  assert.doesNotMatch(res.body, /data-theme-mark/, '这一次请求改用了默认主题');
  assert.equal((await api('POST', '/themes/default/activate')).status, 200);
  assert.equal((await api('POST', '/themes/paper/activate')).status, 400, '渲染不通过的主题不能被启用');
  fs.writeFileSync(broken, original);
});

test('卸载：使用中的主题不能卸载；切走后可以卸载，文件与状态一并清除', async () => {
  await api('POST', '/themes/paper/activate');
  assert.equal((await api('DELETE', '/themes/paper')).status, 400);
  assert.equal((await api('DELETE', '/themes/docs')).status, 400, '内置主题不能卸载');

  assert.equal((await api('POST', '/themes/rollback')).body.active, 'default');
  assert.equal((await api('DELETE', '/themes/paper/versions/1.1.0')).status, 200);
  assert.equal((await api('DELETE', '/themes/paper')).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'themes', 'paper')), false);
  const lib = (await api('GET', '/themes')).body;
  assert.equal(lib.themes.length, BUILTIN.length);
  assert.equal(lib.previous, '', '被卸载的主题不再是“上一个主题”');
  assert.ok(lib.logs.some((l: { action: string; themeId: string }) => l.action === 'uninstall' && l.themeId === 'paper'), '操作有记录');
  assert.equal((await page('/')).statusCode, 200);
  assert.match((await page('/posts/hello-theme')).body, /正文内容/, '整个过程中文章始终可访问');
});
