# 主题开发说明

主题规范版本：**1.0.0**

一个主题是一组 [Liquid](https://liquidjs.com/) 模板加上静态资源（样式、脚本、图片、字体）。主题决定前台的外观和布局，不能改动文章、分类等内容，也不能执行服务器代码、访问数据库或读写文件。

最快的上手方式：复制 `examples/theme-example/`，改 `theme.json` 里的 `id` 和 `name`，然后改样式和模板。

## 目录结构

```text
my-theme/
├─ theme.json              主题信息与可配置项（必需）
├─ templates/              页面模板（必需）
│  ├─ layout.liquid        公共外壳：<head>、页头、页脚
│  ├─ home.liquid          首页
│  ├─ post-list.liquid     文章列表、标签下的文章
│  ├─ post.liquid          文章详情
│  ├─ category.liquid      分类页
│  ├─ tags.liquid          标签总览
│  ├─ collection.liquid    专题 / 系列
│  ├─ archive.liquid       归档
│  ├─ search.liquid        搜索
│  ├─ page.liquid          自定义页面
│  ├─ 404.liquid           页面不存在
│  └─ partials/            自定义的模板片段（可选，任意命名）
├─ assets/                 静态资源，通过 /theme/{id}/{version}/… 访问
│  ├─ style.css
│  └─ main.js              脚本只能放在 assets/ 下
└─ locales/                界面文字（建议至少提供 zh-CN.json）
   ├─ zh-CN.json
   └─ en.json
```

上面列出的 11 个模板缺一不可，导入时会逐个检查并用样例数据试渲染。

## theme.json

```json
{
  "id": "my-theme",
  "name": "我的主题",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "一句话说明",
  "requires": ">=1.0.0",
  "settings": [
    { "key": "accent", "type": "color", "label": "强调色", "default": "#0b6bcb" },
    { "key": "width", "type": "select", "label": "正文宽度", "default": "46rem",
      "options": [{ "value": "40rem", "label": "窄" }, { "value": "46rem", "label": "适中" }] },
    { "key": "show_cover", "type": "boolean", "label": "列表显示封面", "default": true }
  ]
}
```

| 字段 | 要求 |
|---|---|
| `id` | 2–40 位小写字母、数字、连字符。不能与内置主题（`default`、`docs`、`magazine`、`riso`、`aurora`、`zine`）相同。同一个 `id` 再次上传视为升级 |
| `version` | 三段版本号，如 `1.2.0`。升级时必须提高版本号 |
| `requires` | 需要的主题规范版本，写成 `>=1.0.0` |
| `settings` | 管理员可调整的选项，后台据此生成配置表单 |

### 配置项类型

| type | 值 | 备注 |
|---|---|---|
| `color` | `#rgb` 或 `#rrggbb` | |
| `select` | `options` 中某一项的 `value` | 必须提供 `options` |
| `boolean` | `true` / `false` | |
| `number` | 数字 | 可用 `min`、`max` 限定范围 |
| `text` | 不超过 500 字的文本 | |

模板里用 `{{ theme.config.accent }}` 读取。系统会按类型校验管理员填写的值，`color`、`select`、`number`、`boolean` 可以放心写进 `<style>`：

```liquid
<style>:root { --accent: {{ theme.config.accent }}; }</style>
```

`text` 类型只应作为文字输出，不要写进样式或属性里。升级后被删掉的配置项会自动忽略，保留下来的项沿用管理员之前的设置。

## 模板基础

每个页面模板以布局开头，把内容放进 `content` 块：

```liquid
{% layout 'layout' %}
{% block content %}
  <h1>{{ heading }}</h1>
{% endblock %}
```

`layout.liquid` 里用 `{% block content %}{% endblock %}` 留出位置。引入片段用 `{% render 'partials/card', post: post %}`；片段有独立作用域，需要的变量要显式传入（`site`、`theme` 以及下面的过滤器在片段里始终可用）。

**输出默认会做 HTML 转义。** 只有系统已经处理过的 HTML 才用 `raw` 输出：`post.html`、`content.html`、搜索结果的 `title_html` 与 `excerpt_html`。

### 过滤器

| 过滤器 | 作用 | 示例 |
|---|---|---|
| `asset_url` | 主题资源地址 | `{{ 'style.css' \| asset_url }}` |
| `url` | 给站内地址加上当前语言前缀 | `{{ '/posts' \| url }}` → `/en/posts` |
| `t` | 取界面文字（见“多语言”） | `{{ 'all_posts' \| t }}` |
| `date_fmt` | 按当前语言和时区格式化日期。参数：`long`（默认）、`medium`、`short`、`year`、`md` | `{{ post.date \| date_fmt: 'medium' }}` |
| `date_iso` | ISO 时间，用于 `<time datetime>` | `{{ post.date \| date_iso }}` |
| `num` | 按当前语言格式化数字 | `{{ post.views \| num }}` |

Liquid 自带的过滤器和标签（`if`、`for`、`assign`、`capture`、`replace`、`slice` 等）都可以使用。使用不存在的过滤器会导致导入失败。

### 所有页面都有的变量

| 变量 | 内容 |
|---|---|
| `site` | `name`、`tagline`、`description`、`url`、`locale`、`prefix`、`timezone`、`appearance`（`light` / `dark` / `auto`）、`icp`、`footer_text`、`year`、`feed_url`、`categories`（完整分类树） |
| `theme` | `id`、`name`、`version`、`config`（配置值） |
| `page` | `title`、`description`、`type`、`canonical`、`image`、`noindex` |
| `nav.header` / `nav.footer` | 导航项：`label`、`url`、`current`、`new_tab`、`external` |
| `languages` | 语言切换：`code`、`name`、`current`、`available`、`href`。只有一种语言时为空数组 |
| `hreflang` | `code`、`href`，输出到 `<head>` |
| `query` | 当前搜索词（非搜索页为空串） |

模板里的地址（`post.url`、`nav` 的 `url`、分页地址等）已经带好语言前缀，直接输出即可。只有模板里写死的地址需要 `| url`。

### 各页面的变量

**文章卡片**（出现在 `posts`、`featured`、`suggestions`、`results` 里）：`id`、`title`、`subtitle`、`excerpt`、`cover`、`url`、`date`、`updated`、`author`、`views`、`pinned`、`featured`、`reading_minutes`、`words`。

| 模板 | 变量 |
|---|---|
| `home` | `posts`、`featured`、`categories`（顶级分类，含 `children`、`count`）、`tags`（`name`、`url`、`count`）、`pagination` |
| `post-list` | `heading`、`intro`、`crumbs`、`posts`、`pagination` |
| `category` | `category`（`name`、`description`、`url`、`count`、`children`、`has_children`、`self_only`、`self_count`、`self_url`）、`crumbs`、`posts`、`pagination` |
| `tags` | `tags` |
| `collection` | `collection`（`title`、`description`、`cover`、`kind`、`is_series`、`url`）、`posts` |
| `archive` | `years`（`year`、`count`、`posts`：`title`、`url`、`date`）、`total` |
| `search` | `query`、`results`（卡片字段加 `title_html`、`excerpt_html`）、`suggestions`、`pagination` |
| `post` | `post`（卡片字段加 `html`、`toc`、`show_toc`、`archived`、`show_updated`、`categories`、`tags`）、`crumbs`、`series`、`prev`、`next`、`preview` |
| `page` | `content`（`title`、`html`）、`preview` |
| `404` | 仅公共变量 |

- `pagination`：`page`、`pages`、`total`、`prev_url`、`next_url`。
- `crumbs`：`name`、`url`，不含“首页”。
- `post.toc`：`depth`（2–4）、`id`、`text`。
- `series`（文章属于某个系列时）：`title`、`url`、`position`、`total`、`chapters`（`title`、`url`、`current`）、`prev`、`next`。

### 正文里的结构

`post.html` 由系统的 Markdown 管线生成，主题需要为这些结构写样式：

| 结构 | 标记 |
|---|---|
| 标题锚点 | `<h2 id="…">标题<a class="heading-anchor" href="#…">#</a></h2>` |
| 代码块 | `<div class="code-block" data-lang="ts" data-lines="12"><div class="code-head"><span class="code-lang">…</span><button class="code-copy">…</button></div><pre class="shiki …">…</pre></div>`，每行是 `<span class="line">` |
| 表格 | `<div class="table-wrap"><table>…</table></div>` |
| 带说明的图片 | `<figure class="md-figure"><img …><figcaption>…</figcaption></figure>` |
| 提示块 | `<div class="callout callout-tip"><p class="callout-title">…</p>…</div>`，类型有 `note`、`tip`、`info`、`warning`、`danger` |
| 折叠块 | `<details><summary>…</summary>…</details>` |
| 任务清单 | `<ul class="contains-task-list"><li class="task-list-item">…` |
| 脚注 | `<section class="footnotes">…` |

代码高亮的颜色写在行内样式里，同时带有 `--shiki-dark` 变量。深色模式下用它覆盖：

```css
html[data-mode="dark"] .shiki, html[data-mode="dark"] .shiki span { color: var(--shiki-dark) !important; }
```

## 亮暗模式

亮暗由管理员统一决定，体现在 `<html data-mode="light|dark|auto">`。`auto` 表示跟随访客的系统设置，用 `@media (prefers-color-scheme: dark)` 配合 `html[data-mode="auto"]` 处理。

风格本身就只有一种明暗的主题（例如印刷风格只有浅色、夜空风格只有深色），可以在 `layout.liquid` 里把 `data-mode` 和 `<meta name="color-scheme">` 直接写死为 `light` 或 `dark`，并在主题说明里注明；内置的“孔版印刷”“拼贴”“极光”就是这样做的。

**主题不得提供让访客切换主题或亮暗的控件，也不要保存这类访客偏好。**

## 多语言

`locales/{语言代码}.json` 是一组键值：

```json
{ "all_posts": "全部文章", "minutes": "分钟读完" }
```

`{{ 'all_posts' | t }}` 的查找顺序：管理员在后台填写的覆盖 → 主题当前语言 → 主题默认语言 → 主题 `zh-CN` → 键名本身。

系统在生成页面标题和正文时会用到下面这些键，主题的语言包里应当提供：

`all_posts`、`tags`、`archive`、`search`、`not_found_title`、`nav_home`、`nav_posts`、`footnotes`、`footnote_back`、`copy_code`、`unsupported_block`。

脚本里需要的文字，建议由模板输出到 `data-` 属性上再读取，不要在脚本里写死某种语言。

## 安全边界

- 模板是受限语言，接触不到服务器、数据库和文件系统。
- 上传的主题默认**未受信任**：浏览器的内容安全策略会禁用它的全部脚本，模板和样式照常生效。管理员确认后可以把主题标记为受信任。所以请保证**没有脚本时页面依然可用**（导航、目录、分页都应是普通链接）。
- 任何情况下都不允许内联脚本（`<script>…</script>`、`onclick="…"`）和外站脚本，只能用 `<script src="{{ 'main.js' | asset_url }}" defer>` 引入自己 `assets/` 里的文件。
- 外站的字体、样式表会被拦截，请把字体文件放进 `assets/`。图片不受限制。
- 允许的文件类型：`.liquid`、`.json`、`.css`、`.js`、`.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.svg`、`.woff`、`.woff2`、`.ttf`、`.md`、`.txt`。SVG 里不能有脚本。
- 安装包不超过 20MB，解压后不超过 60MB、600 个文件。文件名只能用字母、数字、点、下划线和连字符。

## 打包、检查与安装

把主题目录打成 ZIP（`theme.json` 在压缩包根目录，或者整个主题在一个顶层文件夹里都可以）：

```bash
pnpm --filter @nexemc/server exec tsx scripts/pack-theme.ts ../../examples/theme-example ../../my-theme.zip
```

打包脚本会先做一遍与后台完全相同的检查，有问题直接列出来。也可以单独检查一个已有的压缩包：

```bash
pnpm --filter @nexemc/server exec tsx src/cli.ts theme-check ../../my-theme.zip
```

然后在后台“主题 → 上传主题包”里上传。系统会展示主题信息、校验结果和脚本清单，确认后安装。安装不等于启用：先“预览”（只有你的浏览器能看到），满意后再“启用”。

### 升级与回滚

提高 `theme.json` 的 `version` 后重新打包上传即可。旧版本会保留，在“配置与管理 → 版本”里可以预览任意版本、切换或回滚。正在线上使用的主题安装新版本后不会自动切换。

## 开发时预览

用独立的数据目录起一个带示例内容的站点，把开发中的主题目录放进 `themes/` 就会作为内置主题被识别，改模板和样式后刷新即可看到（开发模式不缓存）：

```bash
pnpm --filter @nexemc/server exec tsx src/server.ts --port=3200 --data-dir=../../data-demo
pnpm --filter @nexemc/server exec tsx scripts/seed-demo.ts http://localhost:3200
```

发布前记得把它从 `themes/` 里移走，打包成 ZIP 再上传，以确认它能通过导入检查。

## 上线前自查

- [ ] 11 个必需模板齐全，`theme-check` 通过
- [ ] 手机、平板、桌面三种宽度下没有横向滚动
- [ ] 长标题、中英文混排、没有封面的文章、没有文章的空状态都看过
- [ ] 代码块、表格、图片、提示块、任务清单、脚注在亮色和暗色下都能正常阅读
- [ ] 禁用脚本后页面仍然可以浏览
- [ ] 启用第二种语言后，语言切换器显示正常，写死的地址都用了 `| url`
- [ ] 页面里没有主题切换或亮暗切换控件
