#!/usr/bin/env bash
# ============================================================
#  班级喊话系统 · 一键 / 自动更新脚本
#
#  用法(在服务器上执行):
#    bash deploy.sh         立即更新一次(拉取 GitHub 最新代码并重启服务)
#    bash deploy.sh cron    开启自动更新(每分钟检查一次, 有新提交就自动更新)
#    bash deploy.sh stop    关闭自动更新
#    bash deploy.sh status  查看当前版本 / 自动更新状态 / 最近更新记录
#
#  放心: 数据文件 data/db.json 不会被动, 而且每次更新前会自动备份到 backups/
# ============================================================
set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-https://github.com/ginginli/call.git}"
MIRROR="${MIRROR:-https://ghfast.top/https://github.com/ginginli/call.git}"
BRANCH="${BRANCH:-main}"
LOG="$APP_DIR/deploy.log"
HASH_FILE="$APP_DIR/.deploy-pkg-hash"
SERVER_LOG="$APP_DIR/server.log"

log() { echo "[$(date '+%F %T')] $*"; }
hash_of() {
  if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | awk '{print $1}';
  else md5 -q "$1"; fi
}

cd "$APP_DIR" || exit 1

# ---------------- 子命令 ----------------
case "${1:-}" in
  cron)
    if ! command -v crontab >/dev/null 2>&1; then
      echo "本机没有 crontab, 无法开启自动更新"; exit 1
    fi
    ( crontab -l 2>/dev/null | grep -v 'deploy\.sh'
      echo "* * * * * /bin/bash $APP_DIR/deploy.sh >> $LOG 2>&1" ) | crontab - || exit 1
    echo "已开启自动更新: 每分钟检查一次 GitHub, 有新代码就自动更新并重启"
    echo "关闭方法: bash deploy.sh stop"
    exit 0
    ;;
  stop)
    ( crontab -l 2>/dev/null | grep -v 'deploy\.sh' ) | crontab - 2>/dev/null
    echo "已关闭自动更新"
    exit 0
    ;;
  status)
    echo "目录:     $APP_DIR"
    V="$(git rev-parse --short HEAD 2>/dev/null)"
    echo "当前版本: ${V:-未初始化为 git 仓库}"
    if crontab -l 2>/dev/null | grep -q 'deploy\.sh'; then
      echo "自动更新: 已开启(每分钟)"
    else
      echo "自动更新: 未开启"
    fi
    echo "最近更新记录:"
    if [ -f "$LOG" ]; then tail -n 8 "$LOG"; else echo "  (还没有更新过)"; fi
    exit 0
    ;;
esac

# ---------------- 1. 确保当前目录是 git 仓库 ----------------
if [ ! -d .git ]; then
  log "首次运行: 把当前目录初始化为 git 仓库"
  git init -q || exit 1
  git remote add origin "$REPO" 2>/dev/null || git remote set-url origin "$REPO"
  git config core.fileMode false
fi

# ---------------- 2. 拉取最新代码 ----------------
if ! git fetch -q origin "$BRANCH" 2>/dev/null; then
  log "直连 GitHub 失败, 改用加速镜像重试"
  git remote set-url origin "$MIRROR"
  if ! git fetch -q origin "$BRANCH"; then
    log "拉取失败: 服务器访问 GitHub 有问题, 本次跳过"
    exit 1
  fi
fi

NEW="$(git rev-parse FETCH_HEAD)"
OLD="$(git rev-parse HEAD 2>/dev/null || true)"

if [ -n "$OLD" ] && [ "$OLD" = "$NEW" ]; then
  # 没有新代码: 静默退出(避免 cron 日志无限增长); 手动运行时给个提示
  [ -t 1 ] && echo "已是最新版本 (${NEW:0:7}), 无需更新"
  exit 0
fi

log "发现新版本: ${OLD:0:7} -> ${NEW:0:7}"

# ---------------- 3. 备份数据 ----------------
mkdir -p backups
if [ -f data/db.json ]; then
  cp -a data/db.json "backups/db-$(date +%Y%m%d-%H%M%S).json"
  ls -t backups/db-*.json 2>/dev/null | tail -n +11 | while read -r f; do rm -f "$f"; done
  log "已备份数据库到 backups/"
fi

# ---------------- 4. 更新代码(不碰 data/) ----------------
if ! git reset -q --hard "$NEW"; then
  log "代码更新失败"
  exit 1
fi
log "代码已更新到 ${NEW:0:7}"

# ---------------- 5. 依赖有变化才安装 ----------------
H="$(hash_of package.json)"
if [ ! -f "$HASH_FILE" ]; then
  echo "$H" > "$HASH_FILE"
  log "首次运行, 跳过依赖安装(若启动报缺模块, 请手动跑一次 npm install)"
elif [ "$H" != "$(cat "$HASH_FILE")" ]; then
  log "检测到依赖变化, 正在 npm install ..."
  if npm install --omit=dev --no-audit --no-fund >>"$LOG" 2>&1; then
    echo "$H" > "$HASH_FILE"
    log "依赖安装完成"
  else
    log "依赖安装失败, 请看 $LOG"
  fi
fi

# ---------------- 6. 重启服务 ----------------
if [ "${NO_RESTART:-0}" = "1" ]; then
  log "NO_RESTART=1, 跳过重启"
  exit 0
fi

if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q 'index\.js'; then
  pm2 restart all >>"$LOG" 2>&1
  log "已用 pm2 重启服务"
else
  pkill -f 'server/index.js' 2>/dev/null
  sleep 1
  nohup node server/index.js >>"$SERVER_LOG" 2>&1 &
  log "已用 nohup 重启服务 (运行日志: $SERVER_LOG)"
fi

# ---------------- 7. 健康检查 ----------------
sleep 2
CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT:-3000}/api/health")"
if [ "$CODE" = "200" ]; then
  log "健康检查通过 (HTTP 200)"
else
  log "注意! 健康检查返回 HTTP $CODE, 服务可能没起来"
fi
