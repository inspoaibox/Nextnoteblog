import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, computeStats, plainExcerpt } from './index.ts';

test('标题生成锚点与目录', async () => {
  const r = await renderMarkdown('# 一级\n\n## 第二节 Intro\n\n### 小节\n');
  assert.deepEqual(r.toc.map((t) => t.depth), [2, 3]);
  assert.match(r.html, /<h2 id="第二节-intro"/);
  assert.match(r.html, /class="heading-anchor"/);
});

test('原始 HTML 与脚本不会输出', async () => {
  const r = await renderMarkdown('hello <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
  assert.doesNotMatch(r.html, /<script|onerror|javascript:/i);
});

test('代码块高亮并带语言与复制按钮', async () => {
  const r = await renderMarkdown('```ts\nconst a: number = 1;\nconsole.log(a)\n```');
  assert.match(r.html, /class="code-block" data-lang="ts" data-lines="2"/);
  assert.match(r.html, /class="shiki/);
  assert.match(r.html, /code-copy/);
});

test('未知语言回退为纯文本而不是报错', async () => {
  const r = await renderMarkdown('```nosuchlang\nabc\n```');
  assert.match(r.html, /data-lang="nosuchlang"/);
});

test('GFM：表格、任务清单、删除线、脚注', async () => {
  const r = await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] 完成\n- [ ] 待办\n\n~~删~~ 文本[^1]\n\n[^1]: 脚注内容');
  assert.match(r.html, /class="table-wrap"><table>/);
  assert.match(r.html, /type="checkbox"[^>]*checked/);
  assert.match(r.html, /<del>删<\/del>/);
  // 脚注引用与定义的 id 必须对得上
  const ref = /href="#([^"]*fn-1)"/.exec(r.html);
  assert.ok(ref, '应有脚注引用');
  assert.ok(r.html.includes(`id="${ref![1]}"`), '脚注锚点应存在');
});

test('容器语法与未知容器', async () => {
  const r = await renderMarkdown(':::warning[注意]\n内容\n:::\n\n:::details[展开]\n隐藏\n:::\n\n:::foo\nx\n:::');
  assert.match(r.html, /class="callout callout-warning"/);
  assert.match(r.html, /class="callout-title">注意/);
  assert.match(r.html, /<details><summary>展开<\/summary>/);
  assert.match(r.html, /md-unsupported/);
});

test('冒号开头的普通文本不被当作指令吞掉', async () => {
  const r = await renderMarkdown('时间:abc 以及 a:b[c] 结束\n\n::leaf\n');
  assert.match(r.html, /时间:abc 以及 a:b\[c\] 结束/);
  assert.match(r.html, /::leaf/);
});

test('图片：收集引用、懒加载、带说明的 figure', async () => {
  const r = await renderMarkdown('![替代](/uploads/a.png "图片说明")\n\n行内 ![b](/uploads/b.png) 图');
  assert.deepEqual(r.images, ['/uploads/a.png', '/uploads/b.png']);
  assert.match(r.html, /<figure class="md-figure"><img[^>]*loading="lazy"[^>]*><figcaption>图片说明<\/figcaption><\/figure>/);
});

test('外链加安全属性，站内链接被收集', async () => {
  const r = await renderMarkdown('[外](https://example.com) [内](/posts/hello)');
  assert.match(r.html, /target="_blank" rel="noopener noreferrer nofollow"/);
  assert.deepEqual(r.links, ['/posts/hello']);
});

test('sourceLines 给顶层块标注行号', async () => {
  const r = await renderMarkdown('第一段\n\n第二段\n\n```js\n1\n```\n', { sourceLines: true });
  assert.match(r.html, /<p data-line="1">/);
  assert.match(r.html, /<p data-line="3">/);
  assert.match(r.html, /class="code-block"[^>]*data-line="5"/);
});

test('Front Matter 不渲染进正文', async () => {
  const r = await renderMarkdown('---\ntitle: x\n---\n\n正文');
  assert.doesNotMatch(r.html, /title: x/);
});

test('统计与摘要', () => {
  const s = computeStats('你好世界 hello world\n\n第二段');
  assert.equal(s.words, 9);
  assert.equal(s.paragraphs, 2);
  assert.equal(s.readingMinutes, 1);
  assert.equal(plainExcerpt('# 标题\n\n这是**正文**，[链接](http://a.b)。'), '标题 这是正文，链接。');
  assert.equal(plainExcerpt('开头[^1]\n\n| 功能 | 状态 |\n| --- | --- |\n| a | b |\n\n- [x] 写文章\n- [ ] 发布\n\n---\n\n[^1]: 脚注'), '开头 写文章 发布');
});
