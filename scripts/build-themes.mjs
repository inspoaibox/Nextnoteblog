/**
 * 合成内置主题的样式文件。
 *
 * “极简阅读”（themes/default）的 style.css 是所有内置主题的公共基础；
 * 其余主题各自的配色与布局写在 themes/_src/{id}.css。
 * 本脚本把两者拼成 themes/{id}/assets/style.css，这样每个主题目录仍然是自包含的
 * （符合主题规范、可以单独打包），而公共部分只需要改一处。
 *
 * 用法：node scripts/build-themes.mjs
 * 改了 themes/default/assets/style.css 或 themes/_src/*.css 之后运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const themes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'themes');
const MARK = '/* @theme-overrides */';
const base = fs.readFileSync(path.join(themes, 'default', 'assets', 'style.css'), 'utf8');
if (!base.trimEnd().endsWith(MARK)) throw new Error(`themes/default/assets/style.css 必须以 ${MARK} 结尾`);

// 这些主题不使用悬挂的 # 记号：标题锚点统一为“悬停时出现在标题后面”
const ANCHOR_RESET = `
.hash::before { display: none; }
@media (min-width: 900px) {
  .frame .post-content a.heading-anchor { position: static; padding: 0; margin-left: 0.4em; font-size: inherit; opacity: 0; }
  .frame .post-content a.heading-anchor::before { content: none; }
  .frame .post-content :is(h1, h2, h3, h4, h5, h6):hover > a.heading-anchor { opacity: 1; }
}
`;

for (const file of fs.readdirSync(path.join(themes, '_src')).filter((f) => f.endsWith('.css') && !f.startsWith('_'))) {
  const id = path.basename(file, '.css');
  // 以下划线开头的文件是片段，用 /* @include _xxx.css */ 引入（三个桌面系统风格的主题共用窗口骨架）
  const own = fs.readFileSync(path.join(themes, '_src', file), 'utf8').replace(/\/\* @include (_[\w-]+\.css) \*\//g, (_m, name) => fs.readFileSync(path.join(themes, '_src', name), 'utf8').trim());
  // 桌面系统风格的主题共用一份窗口管理脚本
  if (own.includes('/* desktop-shell */')) fs.copyFileSync(path.join(themes, '_src', '_desktop.js'), path.join(themes, id, 'assets', 'main.js'));
  const out = `${base.trimEnd()}\n${ANCHOR_RESET}\n${own.trim()}\n`;
  fs.writeFileSync(path.join(themes, id, 'assets', 'style.css'), out);
  console.log(`${id}: ${out.split('\n').length} 行`);
}
