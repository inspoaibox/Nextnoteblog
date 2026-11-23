#!/usr/bin/env bash
# 在 Linux 服务器上以 systemd 方式安装 / 升级 nexemcblog。
#
# 用法（在仓库根目录、以 root 或 sudo 运行）：
#   sudo bash deploy/install.sh
#
# 做的事情：
#   1. 检查 Node.js 版本（需要 22.5 或更高，推荐 24）
#   2. 安装依赖并构建
#   3. 把程序复制到 /opt/nexemcblog（数据目录 /var/lib/nexemcblog 不会被动到）
#   4. 安装并启动 systemd 服务
# 再次运行即为升级：会先自动备份，构建成功后才替换程序；服务启动失败会自动换回旧版本。
set -euo pipefail

APP_DIR=/opt/nexemcblog
DATA_DIR=/var/lib/nexemcblog
SERVICE=nexemcblog
USER_NAME=nexemcblog
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 或 sudo 运行"
command -v node >/dev/null || die "没有找到 Node.js。请先安装 Node.js 24：https://nodejs.org/en/download"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  die "Node.js 版本过低（当前 $(node -v)），需要 22.5 或更高，推荐 24"
fi
command -v pnpm >/dev/null || { say "安装 pnpm"; corepack enable && corepack prepare pnpm@10 --activate; }

say "安装依赖并构建"
cd "$SRC_DIR"
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nexemc/server deploy --prod --legacy "$SRC_DIR/.deploy-server" >/dev/null

say "准备运行用户与数据目录"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DATA_DIR"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"

UPGRADE=0
if [ -f "$APP_DIR/apps/server/dist/server.js" ]; then
  UPGRADE=1
  say "检测到已安装的版本，升级前先备份数据"
  runuser -u "$USER_NAME" -- env DATA_DIR="$DATA_DIR" APP_ROOT="$APP_DIR" NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    node "$APP_DIR/apps/server/dist/cli.js" backup "升级前自动备份" || say "（旧版本不支持命令行备份，跳过；数据目录不会被改动）"
fi

say "安装程序到 $APP_DIR"
STAGE="$APP_DIR.new"
rm -rf "$STAGE"
mkdir -p "$STAGE/apps/server" "$STAGE/apps/admin"
cp -r "$SRC_DIR/.deploy-server/node_modules" "$STAGE/apps/server/node_modules"
cp -r "$SRC_DIR/apps/server/dist" "$SRC_DIR/apps/server/drizzle" "$STAGE/apps/server/"
cp -r "$SRC_DIR/apps/admin/dist" "$STAGE/apps/admin/"
cp -r "$SRC_DIR/themes" "$STAGE/themes"
rm -rf "$SRC_DIR/.deploy-server"
if [ -d "$APP_DIR" ]; then rm -rf "$APP_DIR.old"; mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$STAGE" "$APP_DIR"
chown -R root:root "$APP_DIR"

say "安装 systemd 服务"
install -m 644 "$SRC_DIR/deploy/nexemcblog.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

say "等待服务启动"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; then
    say "服务已启动"
    [ "$UPGRADE" -eq 1 ] && rm -rf "$APP_DIR.old"
    echo
    echo "  程序目录：$APP_DIR"
    echo "  数据目录：$DATA_DIR（备份、迁移只需要它）"
    echo "  查看日志：journalctl -u $SERVICE -f"
    echo
    echo "  服务只监听 127.0.0.1:3000，请用 Caddy 或 Nginx 对外提供 HTTPS，"
    echo "  配置示例见 deploy/Caddyfile.systemd 与 deploy/nginx.conf。"
    [ "$UPGRADE" -eq 0 ] && echo "  首次访问你的域名会进入安装向导。"
    exit 0
  fi
  sleep 1
done

if [ "$UPGRADE" -eq 1 ] && [ -d "$APP_DIR.old" ]; then
  say "新版本启动失败，换回旧版本"
  rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed"; mv "$APP_DIR.old" "$APP_DIR"
  systemctl restart "$SERVICE"
  die "升级失败，已换回旧版本。新版本保留在 $APP_DIR.failed，日志：journalctl -u $SERVICE -n 100"
fi
die "服务没有正常启动，请查看日志：journalctl -u $SERVICE -n 100"
