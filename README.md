# nexemcblog

原生 Markdown 个人博客系统。需求见 [博客开发需求文档.md](博客开发需求文档.md)，整体设计见 [博客系统完整解决方案.md](博客系统完整解决方案.md)。

当前进度：**M1 内容闭环**（安装向导、登录、文章与修订、发布状态机、Markdown 编辑器、图片上传、默认主题的首页 / 列表 / 详情）。

## 目录结构

```text
apps/server        服务端（Fastify + SQLite + Liquid 主题引擎）
apps/admin         管理后台（React + CodeMirror 6）
packages/markdown  Markdown 渲染管线，服务端与后台预览共用
themes/default     内置主题「极简阅读」
deploy/            Caddy 配置
data/              运行时数据（数据库、上传文件），不进版本库
```

## 本地开发

需要 Node.js 24 与 pnpm 10。

```bash
pnpm install
pnpm dev          # 服务端 :3000，后台开发服务器 :5173
```

开发时访问 `http://localhost:5173/admin/`（带热更新）；前台访问 `http://localhost:3000/`。
3000 端口被占用时可指定端口：`pnpm --filter @nexemc/server exec tsx src/server.ts --port=3100`。

```bash
pnpm test         # Markdown 管线测试 + 服务端端到端测试
pnpm typecheck
pnpm build        # 构建后台与服务端
pnpm start        # 以构建产物运行，后台位于 /admin
```

修改 `apps/server/src/db/schema.ts` 后执行 `pnpm --filter @nexemc/server db:generate` 生成迁移文件；服务启动时会自动执行迁移。

## Linux 部署（Docker Compose）

```bash
cp .env.example .env            # 把 DOMAIN 改成已解析到本机的域名
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d --build
```

首次访问站点会进入安装向导。Caddy 自动申请并续期 HTTPS 证书。

- **备份 / 迁移**：所有数据都在 `./data`，拷贝该目录即可。
- **升级**：`git pull && docker compose up -d --build`，数据库迁移在启动时自动执行。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口（也可用 `--port=` 参数） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录 |
| `NODE_ENV` | — | 设为 `production` 时启用模板与静态资源缓存 |

## 运维命令

后台无法登录时，可在服务器上重置密码：

```bash
docker compose exec blog node apps/server/dist/cli.js reset-password <用户名> <新密码>
docker compose exec blog node apps/server/dist/cli.js list-users
```
