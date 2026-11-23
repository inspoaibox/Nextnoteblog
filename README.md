# nexemcblog

原生 Markdown 个人博客系统。需求见 [博客开发需求文档.md](博客开发需求文档.md)，整体设计见 [博客系统完整解决方案.md](博客系统完整解决方案.md)。

当前进度：

- **M1 内容闭环**（已完成）：安装向导、登录、文章与修订、发布状态机、Markdown 编辑器、图片上传、默认主题。
- **M2 组织与前台**（已完成）：多级分类树、标签、专题与系列、自定义页面、导航菜单、站内搜索（中文分词）、归档、面包屑，以及文章批量操作。
- **M3 多语言**（已完成）：语言管理、各语言独立的文章 / 分类 / 标签 / 专题 / 页面 / 导航、语言切换与 hreflang、界面文案翻译、多语言订阅与站点地图。默认语言的地址不带前缀，其他语言带前缀（如 `/en/…`）。
- **M4 主题系统**（已完成）：六套内置主题（极简阅读、技术文档、杂志卡片，以及视觉风格的孔版印刷、极光、拼贴），后台切换与回退、管理员预览、主题配置、ZIP 导入校验、版本升级与回滚、信任分级。自己做主题见 [docs/theme-development.md](docs/theme-development.md)。
- **M5 导入导出与运维**（已完成）：Markdown 导入（Front Matter、冲突检测、相对路径图片）、单篇 / 分类 / 全站导出、备份与恢复（每日自动备份）、重定向管理、操作日志、结构化数据，以及 systemd 部署方式。

## 目录结构

```text
apps/server        服务端（Fastify + SQLite + Liquid 主题引擎）
apps/admin         管理后台（React + CodeMirror 6）
packages/markdown  Markdown 渲染管线，服务端与后台预览共用
themes/            内置主题：default 极简阅读、docs 技术文档、magazine 杂志卡片、riso 孔版印刷、aurora 极光、zine 拼贴
examples/          示例主题（做自己主题的起点）
docs/              主题开发说明、部署与运维说明
deploy/            Caddy 配置
data/              运行时数据（数据库、上传文件），不进版本库
```

## 本地开发

需要 Node.js 24 与 pnpm 10。

```bash
pnpm install
pnpm dev          # 服务端 :3100，后台开发服务器 :5173
```

开发时统一访问 `http://localhost:5173/`：`/admin/` 是带热更新的后台，其余地址由开发服务器转给服务端，所以“查看站点”、文章预览、主题预览等链接都能直接用。
开发模式固定用 3100 端口，避开常被其他程序占用的 3000；要换端口可改 `apps/server/package.json` 的 `dev` 脚本，并用环境变量 `BLOG_BACKEND` 告诉后台开发服务器。

```bash
pnpm test         # Markdown 管线测试 + 服务端端到端测试
pnpm typecheck
pnpm build        # 构建后台与服务端
pnpm start        # 以构建产物运行，后台位于 /admin
```

要一个带示例内容的站点来调主题，可以用独立的数据目录起一个演示站再灌数据（不影响 `data/`）：

```bash
pnpm --filter @nexemc/server exec tsx src/server.ts --port=3200 --data-dir=../../data-demo
pnpm --filter @nexemc/server exec tsx scripts/seed-demo.ts http://localhost:3200
```

内置主题的样式由“公共基础 + 各主题专属样式”合成：改了 `themes/default/assets/style.css`（公共基础）或 `themes/_src/*.css`（各主题专属）之后，运行 `node scripts/build-themes.mjs` 重新生成。

修改 `apps/server/src/db/schema.ts` 后执行 `pnpm --filter @nexemc/server db:generate` 生成迁移文件；服务启动时会自动执行迁移。

## Linux 部署

Docker Compose（推荐）：

```bash
cp .env.example .env            # 把 DOMAIN 改成已解析到本机的域名
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d --build
```

不用 Docker 时：`sudo bash deploy/install.sh`，以 systemd 服务运行，再用 Caddy 或 Nginx 反向代理。

首次访问站点会进入安装向导。所有数据都在数据目录里，备份、迁移只需要它。两种方式的详细步骤、升级、备份恢复、迁移见 [docs/deployment.md](docs/deployment.md)。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口（也可用 `--port=` 参数） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录 |
| `NODE_ENV` | — | 设为 `production` 时启用模板与静态资源缓存 |
| `AUTO_BACKUP` | 开启 | 设为 `0` 关闭每日自动备份 |

## 运维命令

后台无法登录时，可在服务器上操作（Docker 方式在前面加 `docker compose exec blog`）：

```bash
node apps/server/dist/cli.js reset-password <用户名> <新密码>
node apps/server/dist/cli.js list-users
node apps/server/dist/cli.js backup [备注]
node apps/server/dist/cli.js list-backups
node apps/server/dist/cli.js restore <备份文件名>     # 之后重启服务
node apps/server/dist/cli.js theme-check <主题包.zip>
```
