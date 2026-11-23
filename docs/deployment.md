# 部署与运维

两种部署方式功能完全一样，选一种即可：

| | Docker Compose（推荐） | systemd |
|---|---|---|
| 适合 | 新服务器、希望省心 | 已有 Nginx / 宝塔面板、不想装 Docker |
| 需要 | Docker 与 Docker Compose 插件 | Node.js 24（最低 22.5）、git |
| HTTPS | 自带 Caddy，自动申请证书 | 用你自己的 Caddy 或 Nginx |
| 数据目录 | 仓库里的 `./data` | `/var/lib/nexemcblog` |

服务器最低 1 核 1G，推荐 2 核 2G。所有数据（数据库、图片、已上传的主题、备份）都在数据目录里，**备份和迁移服务器只需要这一个目录**。

## 方式一：Docker Compose

```bash
git clone https://github.com/inspoaibox/Nextnoteblog.git && cd Nextnoteblog
cp .env.example .env          # 把 DOMAIN 改成已解析到这台服务器的域名
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d --build
```

打开 `https://你的域名`，会进入安装向导。80 和 443 端口需要在防火墙 / 云安全组里放行。

升级：

```bash
git pull && docker compose up -d --build
```

数据库结构的变化会在启动时自动迁移。

## 方式二：systemd

```bash
git clone https://github.com/inspoaibox/Nextnoteblog.git && cd Nextnoteblog
sudo bash deploy/install.sh
```

脚本会构建程序，安装到 `/opt/nexemcblog`，创建 `nexemcblog` 系统用户和 `/var/lib/nexemcblog` 数据目录，然后启动服务。服务只监听 `127.0.0.1:3000`，还需要配一个反向代理对外提供 HTTPS：

- **Caddy**：参考 `deploy/Caddyfile.systemd`，证书自动申请。
- **Nginx / 宝塔**：参考 `deploy/nginx.conf`，证书用 certbot 或面板申请。注意 `client_max_body_size` 要放到 64m，否则导入和上传主题包会失败。

升级：

```bash
git pull && sudo bash deploy/install.sh
```

升级前会自动备份；新版本启动失败会自动换回旧版本。

常用命令：

```bash
systemctl status nexemcblog
journalctl -u nexemcblog -f        # 实时日志
systemctl restart nexemcblog
```

## 备份与恢复

**自动备份**：服务每天自动备份一次，保留最近 7 份。备份包含数据库的完整快照、所有媒体文件和已上传的主题，存在数据目录的 `backups/` 里。设置环境变量 `AUTO_BACKUP=0` 可以关闭。

**手动备份**：后台“工具 → 备份与恢复”，或者命令行：

```bash
# Docker
docker compose exec blog node apps/server/dist/cli.js backup "改版前"
# systemd
sudo -u nexemcblog env DATA_DIR=/var/lib/nexemcblog node /opt/nexemcblog/apps/server/dist/cli.js backup "改版前"
```

备份都在同一台服务器上，硬盘坏了就一起没了。**请定期把备份下载到别处**（后台可直接下载，或用 rsync / 对象存储同步 `backups/` 目录）。

**恢复**：后台点“恢复”后服务会自动重启，几秒后完成。恢复前系统会先把当前状态再备份一份，被替换下来的数据文件也会保留在数据目录的 `replaced-*` 文件夹里，确认无误后可以手动删除。

后台进不去时用命令行恢复：

```bash
node apps/server/dist/cli.js list-backups
node apps/server/dist/cli.js restore backup-2026-11-23-...zip
# 然后重启服务，恢复在启动时完成
```

从别的服务器恢复：把备份文件拷进数据目录的 `backups/`，刷新后台即可看到。

> 恢复依赖服务被自动拉起：Docker Compose 已配置 `restart: unless-stopped`，systemd 服务配置了 `Restart=always`。如果你是直接用 `node` 命令运行的，点恢复后需要手动重新启动。

## 迁移到新服务器

1. 在旧服务器停止服务，打包数据目录：`tar czf blog-data.tgz -C /var/lib/nexemcblog .`（Docker 方式是 `./data`）。
2. 在新服务器按上面的步骤部署，**先不要访问安装向导**。
3. 停止服务，把数据解压进新的数据目录，修正属主（Docker 为 `1000:1000`，systemd 为 `nexemcblog`），再启动。

也可以只拷一个备份文件过去，按“从别的服务器恢复”操作。

## 从其他博客迁移内容

后台“工具 → 导入”支持 Markdown 文件和 ZIP 包。Hexo、Hugo、Jekyll 等静态博客的 `source/_posts`、`content/posts` 目录可以直接打包上传：

- Front Matter 的 `title`、`date`、`tags`、`categories`、`description`、`draft` 会被识别，其余字段原样保存。
- 文件名形如 `2024-01-02-标题.md` 时，日期会作为发布日期。
- 正文里的相对路径图片只要一起打进压缩包，就会自动存入媒体库并改成站内地址。
- 旧站的地址可以在“工具 → 重定向”里逐条映射到新地址，保住搜索引擎收录和外部链接。

导入前会先做一次检查，列出每个文件的元信息、地址冲突和缺失的图片，确认后才写入。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口（也可用 `--port=`） |
| `HOST` | `0.0.0.0` | 监听地址；systemd 方式为 `127.0.0.1` |
| `DATA_DIR` | `./data` | 数据目录（也可用 `--data-dir=`） |
| `APP_ROOT` | 自动判断 | 程序根目录，一般不用设 |
| `NODE_ENV` | — | 设为 `production` 启用模板与静态资源缓存 |
| `AUTO_BACKUP` | 开启 | 设为 `0` 关闭每日自动备份 |

## 安全建议

- 后台地址是 `/admin`。登录连续失败 5 次会锁定该 IP 15 分钟，修改密码会让所有旧会话失效。
- 忘记密码：`node apps/server/dist/cli.js reset-password <用户名> <新密码>`。
- 服务应当只通过反向代理对外，不要把 3000 端口直接暴露到公网。
- 第三方主题默认禁止运行脚本；只有确认来源可信后才在后台标记为“受信任”。
- 后台“工具 → 操作日志”记录了登录、发布、删除、导入、备份恢复、主题切换等操作。
