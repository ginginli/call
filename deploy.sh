#!/usr/bin/env bash
# ============================================================
#  班级喊话系统 · 一键 / 自动更新脚本
#
#  用法(在服务器上执行):
#    bash deploy.sh              立即更新一次(拉取 GitHub 最新代码并重启服务)
#    bash deploy.sh cron         开启自动更新(每分钟检查一次, 有新提交就自动更新)
#    bash deploy.sh stop         关闭自动更新
#    bash deploy.sh status       查看版本 / 自动更新状态 / 发卡口令状态
#    bash deploy.sh key 新口令    修改发卡后台口令并重启(存到 .env, 永久生效)
#    bash deploy.sh mail         「申请激活卡号」邮件通知的配置/自检(见下方 mail 子命令)
#    bash deploy.sh https 域名   一键配好 HTTPS(装 nginx/certbot + 签发证书 + 自动写配置 + 重载 + 验证)
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

ENVF="$APP_DIR/.env"
# 写入 / 删除 .env 里的配置项(.env 不提交仓库, 也不会被自动更新覆盖)
env_set() {
  local tmp="$APP_DIR/.env.tmp"
  touch "$ENVF"
  grep -v "^[[:space:]]*$1=" "$ENVF" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$ENVF"
  chmod 600 "$ENVF" 2>/dev/null
}
env_del() {
  [ -f "$ENVF" ] || return 0
  local tmp="$APP_DIR/.env.tmp"
  grep -v "^[[:space:]]*$1=" "$ENVF" > "$tmp" || true
  mv "$tmp" "$ENVF"
  chmod 600 "$ENVF" 2>/dev/null
}
# 删除某一前缀的全部配置项(批量清理用, 如 SMTP_)
env_del_prefix() {
  [ -f "$ENVF" ] || return 0
  grep -q "^[[:space:]]*$1" "$ENVF" || return 0
  local tmp="$APP_DIR/.env.tmp"
  grep -v "^[[:space:]]*$1" "$ENVF" > "$tmp" || true
  mv "$tmp" "$ENVF"
  chmod 600 "$ENVF" 2>/dev/null
}

# 历史遗留的邮件配置: 早期版本支持过 SMTP_* / RESEND_API_KEY / MAIL_WEBHOOK_URL,
# 现在发信只走 EmailJS, 这些键留在 .env 里既不生效也不报错, 顺手清掉。
# 幂等: 没有这些键就直接返回, 不会碰 .env; 真清理过会留一份 .env.legacy.bak
LEGACY_MAIL_KEYS="RESEND_API_KEY MAIL_WEBHOOK_URL"
clean_legacy_env() {
  [ -f "$ENVF" ] || return 0
  local n k
  n="$(grep -c '^[[:space:]]*SMTP_' "$ENVF" 2>/dev/null || true)"
  for k in $LEGACY_MAIL_KEYS; do
    n=$(( n + $(grep -c "^[[:space:]]*${k}=" "$ENVF" 2>/dev/null || true) ))
  done
  [ "$n" -gt 0 ] 2>/dev/null || return 0
  cp -a "$ENVF" "$ENVF.legacy.bak" 2>/dev/null
  env_del_prefix 'SMTP_'
  for k in $LEGACY_MAIL_KEYS; do env_del "$k"; done
  log "已清理 .env 里 $n 行失效的邮件配置(SMTP_* / RESEND_API_KEY / MAIL_WEBHOOK_URL), 备份: .env.legacy.bak"
}
mask() { [ -n "$1" ] && echo "已设置" || echo "未设置"; }

cd "$APP_DIR" || exit 1

# ---------------- 载入 .env (发卡口令等配置) ----------------
# .env 不会被 git 更新覆盖, 所以配置能永久保留
if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$APP_DIR/.env"
  set +a
fi

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
    if [ -n "${CARD_KEY:-}" ]; then
      echo "发卡口令: 已自定义(保存在 .env 里)"
    else
      echo "发卡口令: 未设置(还是默认 siyunx-admin, 建议: bash deploy.sh key 新口令)"
    fi
    if [ -d /etc/letsencrypt/live ] && [ "$(ls -1 /etc/letsencrypt/live 2>/dev/null | wc -l)" -gt 0 ]; then
      echo "HTTPS:    已签发证书($(ls -1 /etc/letsencrypt/live 2>/dev/null | tr '\n' ' '))"
    else
      echo "HTTPS:    未配置(可执行: bash deploy.sh https 你的域名)"
    fi
    echo "最近更新记录:"
    if [ -f "$LOG" ]; then tail -n 8 "$LOG"; else echo "  (还没有更新过)"; fi
    exit 0
    ;;
  key)
    NEWKEY="${2:-}"
    if [ -z "$NEWKEY" ]; then
      echo "用法: bash deploy.sh key 你的新口令"
      exit 1
    fi
    env_set CARD_KEY "$NEWKEY"
    echo "已把新发卡口令写入 $APP_DIR/.env"
    echo "(.env 不会提交到仓库, 也不会被自动更新覆盖)"
    echo "正在重启服务让它生效 ..."
    exec bash "$0" force
    ;;

  mail)
    # 老师提交「申请激活卡号」后, 自动发一封通知邮件到站长邮箱
    mail_usage() {
      echo "用法:"
      echo "  bash deploy.sh mail                                    查看当前邮件通知配置"
      echo "  bash deploy.sh mail to 收件邮箱                         只改收件邮箱"
      echo "  bash deploy.sh mail emailjs 服务ID 模板ID 公钥 [私钥]    配置 EmailJS 发信(私钥可选)"
      echo "  bash deploy.sh mail off                                关闭邮件通知"
      echo "  bash deploy.sh mail test                               发一封测试邮件看看收不收得到"
      echo ""
      echo "EmailJS: 在 https://www.emailjs.com 建好 Service 和 Template, 模板字段见 .env.example,"
      echo "         正文里要有 {{text}}(或 {{{html_content}}}), 收件人写 {{to_email}}。"
      echo "         还需在 Account → Security 打开 non-browser 调用, 否则服务端发信会被 403 拒绝。"
    }
    mail_show() {
      echo "收件邮箱(MAIL_TO):    ${MAIL_TO:-${CARD_EMAIL:-ladyiney25@gmail.com}(默认)}"
      echo "发信服务:             EmailJS(唯一方式)"
      echo "  Service ID:         ${EMAILJS_SERVICE_ID:-未配置}"
      echo "  Template ID:        ${EMAILJS_TEMPLATE_ID:-未配置}"
      echo "  公钥 / 私钥:        $(mask "${EMAILJS_PUBLIC_KEY:-}") / $(mask "${EMAILJS_PRIVATE_KEY:-}")"
      echo "站点地址(BASE_URL):   ${PUBLIC_BASE_URL:-自动推断}"
    }
    case "${2:-}" in
      '')
        mail_usage; echo ""; echo "当前配置:"; mail_show
        exit 0 ;;
      to)
        [ -n "${3:-}" ] || { mail_usage; exit 1; }
        env_set MAIL_TO "$3"
        echo "收件邮箱已改为: $3"
        echo "正在重启服务让它生效 ..."
        exec bash "$0" force ;;
      emailjs)
        E_SVC="${3:-}"; E_TPL="${4:-}"; E_PUB="${5:-}"; E_PRV="${6:-}"
        if [ -z "$E_SVC" ] || [ -z "$E_TPL" ] || [ -z "$E_PUB" ]; then mail_usage; exit 1; fi
        env_set EMAILJS_SERVICE_ID "$E_SVC"
        env_set EMAILJS_TEMPLATE_ID "$E_TPL"
        env_set EMAILJS_PUBLIC_KEY "$E_PUB"
        if [ -n "$E_PRV" ]; then env_set EMAILJS_PRIVATE_KEY "$E_PRV"; else env_del EMAILJS_PRIVATE_KEY; fi
        echo "已配置 EmailJS 发信 (Service $E_SVC / Template $E_TPL)$( [ -n "$E_PRV" ] && echo ' + 私钥' )"
        echo "提醒: EmailJS 后台模板里要有 {{to_email}} {{subject}} {{from_name}} {{reply_to}} 和 {{text}}(或 {{{html_content}}})"
        echo "正在重启服务让它生效 ..."
        exec bash "$0" force ;;
      off)
        for k in EMAILJS_SERVICE_ID EMAILJS_TEMPLATE_ID EMAILJS_PUBLIC_KEY EMAILJS_PRIVATE_KEY; do env_del "$k"; done
        echo "已关闭邮件通知(申请仍会记录在发卡后台)"
        echo "正在重启服务让它生效 ..."
        exec bash "$0" force ;;
      test)
        MAIL_TO_NOW="${MAIL_TO:-${CARD_EMAIL:-ladyiney25@gmail.com}}"
        echo "正在给 $MAIL_TO_NOW 发测试邮件 ..."
        RES="$(curl -s -m 30 -X POST "http://127.0.0.1:${PORT:-3000}/api/cards/test-mail" \
          -H 'Content-Type: application/json' \
          -d "{\"adminKey\":\"${CARD_KEY:-}\"}")"
        echo "$RES"
        case "$RES" in
          *'"ok":true'*) echo "发送成功, 请查看收件箱(可能在垃圾邮件里)";;
          *non-browser*)
            echo "发送失败: EmailJS 默认禁止服务端(Node)调用。"
            echo "请打开 https://dashboard.emailjs.com/admin/account/security"
            echo "勾选 Allow EmailJS API for non-browser applications, 然后重跑本命令。";;
          *nvalid*)
            echo "发送失败: 凭据不对。Service ID 形如 service_xxxxxxx(不是 Service 的名字);"
            echo "Public Key 到 Account → General 复制。核对后重跑: bash deploy.sh mail emailjs ...";;
          *) echo "发送失败, 上面的原因如果提到未配置, 先执行: bash deploy.sh mail emailjs 服务ID 模板ID 公钥";;
        esac
        exit 0 ;;
      *)
        mail_usage; exit 1 ;;
    esac
    ;;

  https)
    # ============================================================
    #  HTTPS 一条命令搞定(可重复执行, 每次都得到同样的结果):
    #   1) 检测/安装 nginx 与 certbot
    #   2) 先写一份只监听 80 的临时配置(含 ACME 校验目录)并签发证书
    #   3) 写入正式配置: 80 → 301 跳 https, 443 反代到本机服务并转发 WebSocket 升级头
    #   4) nginx -t 通过才 reload(失败自动回滚), 最后回环自测 http/https/socket.io
    #  用法: bash deploy.sh https [域名]
    #        域名不填时依次取 .env 的 SITE_DOMAIN / PUBLIC_BASE_URL, 再退回 callclass.site
    #  强制重签证书: FORCE_RENEW=1 bash deploy.sh https [域名]
    # ============================================================
    DOMAIN="${2:-${SITE_DOMAIN:-}}"
    if [ -z "$DOMAIN" ] && [ -n "${PUBLIC_BASE_URL:-}" ]; then
      DOMAIN="$(printf '%s' "$PUBLIC_BASE_URL" | sed -e 's#^https://##' -e 's#^http://##' -e 's#/.*$##' -e 's#:.*$##')"
    fi
    [ -n "$DOMAIN" ] || DOMAIN="callclass.site"
    APP_PORT="${PORT:-3000}"
    CERT_EMAIL="${CERTBOT_EMAIL:-${SSL_EMAIL:-${MAIL_TO:-${CARD_EMAIL:-}}}}"
    FORCE_RENEW="${FORCE_RENEW:-0}"

    echo "===== 配置 HTTPS (域名 $DOMAIN) ====="
    echo "反代目标:  127.0.0.1:$APP_PORT"
    echo "证书邮箱:  ${CERT_EMAIL:-未提供(certbot 不绑定邮箱, 收不到续期提醒)}"

    if [ "$(id -u)" != "0" ]; then
      echo ""
      echo "需要 root 权限(装软件 / 写 /etc/nginx / 签发证书), 请改用:"
      echo "  sudo bash deploy.sh https $DOMAIN"
      exit 1
    fi

    # ---- 1/6 nginx ----
    if command -v nginx >/dev/null 2>&1; then
      echo "[1/6] nginx 已安装: $(nginx -v 2>&1)"
    else
      echo "[1/6] 未检测到 nginx, 正在安装 ..."
      if command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
        DEBIAN_FRONTEND=noninteractive apt-get install -y nginx || { echo "nginx 安装失败, 请手动安装后重跑"; exit 1; }
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y nginx || { echo "nginx 安装失败, 请手动安装后重跑"; exit 1; }
      else
        echo "本机既没有 apt-get 也没有 dnf, 请手动安装 nginx 后重跑"
        exit 1
      fi
      echo "      nginx 安装完成"
    fi

    # ---- 2/6 certbot ----
    if command -v certbot >/dev/null 2>&1; then
      echo "[2/6] certbot 已安装: $(certbot --version 2>&1)"
    else
      echo "[2/6] 未检测到 certbot, 正在安装 ..."
      if command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y certbot || { echo "certbot 安装失败"; exit 1; }
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y certbot || { echo "certbot 安装失败"; exit 1; }
      else
        echo "请手动安装 certbot 后重跑"
        exit 1
      fi
      echo "      certbot 安装完成"
    fi

    # ---- 3/6 环境检查: 校验目录 / 防火墙 / 本机服务 / DNS ----
    mkdir -p /var/www/certbot
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
      ufw allow 80/tcp >/dev/null 2>&1 || true
      ufw allow 443/tcp >/dev/null 2>&1 || true
      echo "[3/6] 已放行防火墙 80/443 (ufw)"
    else
      echo "[3/6] 未见启用的 ufw; 用云服务器的话请确认安全组已放行 80、443"
    fi
    CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/health" 2>/dev/null)"
    if [ "$CODE" != "200" ]; then
      echo "      提醒: 本机 $APP_PORT 端口健康检查返回 ${CODE:-无响应}, 反代会 502, 先跑一次 bash deploy.sh"
    fi
    if command -v getent >/dev/null 2>&1; then
      DNS_IP="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -n 1)"
      [ -n "$DNS_IP" ] && echo "      $DOMAIN 当前解析到 $DNS_IP (必须指向本台服务器, 否则签发会失败)"
    fi

    # ---- 4/6 选好配置文件位置 ----
    if [ -d /etc/nginx/sites-available ] && grep -q 'sites-enabled' /etc/nginx/nginx.conf 2>/dev/null; then
      CONF="/etc/nginx/sites-available/$DOMAIN.conf"
      LINK="/etc/nginx/sites-enabled/$DOMAIN.conf"
    else
      CONF="/etc/nginx/conf.d/$DOMAIN.conf"
      LINK=""
    fi
    echo "[4/6] 配置文件: $CONF"

    # $1=yes → 正式配置(80 跳转 + 443 + WebSocket); $1=no → 临时配置(只监听 80, 供首次签发用)
    nginx_write() {
      if [ "$1" = "yes" ]; then
        cat > "$CONF" <<NGINXEOF
# 由 bash deploy.sh https 自动生成, 重跑会覆盖本文件(手改会被冲掉)
map \$http_upgrade \$cls_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # certbot 续期的校验目录, 删了证书就续不上
    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    location / { return 301 https://\$server_name\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 10m;
    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;

    # 教室端实时通道(通知弹窗/在线状态): 必须转发升级头并放宽超时, 否则长连接会被掐断
    location /socket.io/ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$cls_upgrade;
        proxy_read_timeout 7d;
        proxy_send_timeout 7d;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }
}
NGINXEOF
      else
        cat > "$CONF" <<NGINXEOF
# 由 bash deploy.sh https 自动生成的临时配置(证书签发完成后会被正式配置覆盖)
map \$http_upgrade \$cls_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$cls_upgrade;
        proxy_read_timeout 7d;
        proxy_buffering off;
    }
}
NGINXEOF
      fi
    }

    nginx_reload() {
      if command -v systemctl >/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || systemctl start nginx 2>/dev/null || return 1
      else
        nginx -s reload 2>/dev/null || return 1
      fi
    }

    # 写配置 → nginx -t 校验 → reload; 校验不过就回滚到改动前的文件, 不会把站点搞挂
    nginx_apply() {
      [ -f "$CONF" ] && cp -a "$CONF" "$CONF.bak"
      nginx_write "$1"
      [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
      if ! OUT="$(nginx -t 2>&1)"; then
        echo "      nginx 配置检查失败:"
        printf '%s\n' "$OUT" | tail -n 6
        if [ -f "$CONF.bak" ]; then mv -f "$CONF.bak" "$CONF"; else rm -f "$CONF"; fi
        nginx -t >/dev/null 2>&1 && nginx_reload >/dev/null 2>&1
        echo "      已回滚到改动前的配置, 站点不受影响"
        return 1
      fi
      rm -f "$CONF.bak"
      nginx_reload || { echo "      nginx 重载失败, 请手动执行 nginx -t 查看"; return 1; }
      echo "      配置校验通过, nginx 已重载"
      return 0
    }

    # ---- 5/6 签发证书(已签发且未到期则直接复用, 不重复签) ----
    if [ -d "/etc/letsencrypt/live/$DOMAIN" ] && [ "$FORCE_RENEW" != "1" ]; then
      echo "[5/6] 证书已存在, 跳过签发 (需要重签: FORCE_RENEW=1 bash deploy.sh https $DOMAIN)"
    else
      echo "[5/6] 先用临时配置提供 ACME 校验, 再签发证书 ..."
      nginx_apply no || exit 1
      if [ -n "$CERT_EMAIL" ]; then
        MAIL_ARG="--email $CERT_EMAIL"
      else
        MAIL_ARG="--register-unsafely-without-email"
      fi
      if [ "$FORCE_RENEW" = "1" ]; then KEEP_ARG="--force-renewal"; else KEEP_ARG="--keep-until-expiring"; fi
      # shellcheck disable=SC2086
      if certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
           --non-interactive --agree-tos $MAIL_ARG $KEEP_ARG; then
        echo "      证书签发成功: /etc/letsencrypt/live/$DOMAIN/"
      else
        echo ""
        echo "证书签发失败。常见原因:"
        echo "  · 域名没有解析到本台服务器(改好 DNS 等几分钟再试)"
        echo "  · 云服务器安全组 / 系统防火墙没放行 80、443"
        echo "  · 国内服务器未备案或运营商封了 80 端口"
        echo "现在站点仍能用 http://$DOMAIN 访问; 条件具备后重跑: sudo bash deploy.sh https $DOMAIN"
        exit 1
      fi
    fi

    # ---- 6/6 写入正式配置并验证 ----
    echo "[6/6] 写入 HTTPS 配置(80 跳转 + 443 + WebSocket 头) ..."
    nginx_apply yes || exit 1

    echo ""
    echo "===== 验证 ====="
    C1="$(curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/" 2>/dev/null)"
    C2="$(curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null)"
    C3="$(curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/socket.io/?EIO=4&transport=polling" 2>/dev/null)"
    echo "  http  →  期望 301, 实际 $C1"
    echo "  https →  期望 200, 实际 $C2"
    echo "  socket.io 握手 → 期望 200, 实际 $C3"
    EXP="$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/cert.pem" 2>/dev/null | cut -d= -f2)"
    [ -n "$EXP" ] && echo "  证书到期: $EXP"
    echo "  (上面用 --resolve 指向 127.0.0.1 验证本机配置; 外部能否访问取决于 DNS 是否指向本机)"

    if systemctl list-timers 2>/dev/null | grep -q certbot; then
      echo "  自动续期: certbot.timer 已启用, 到期前会自动续"
    else
      echo "  自动续期: 未发现 certbot.timer, 请确认 certbot 的定时任务已启用"
    fi

    if [ "${PUBLIC_BASE_URL:-}" != "https://$DOMAIN" ]; then
      env_set PUBLIC_BASE_URL "https://$DOMAIN"
      # 本命令要用 sudo 跑, 把 .env 属主还回去, 免得之后普通用户改不了它
      [ -n "${SUDO_USER:-}" ] && chown "$SUDO_USER" "$ENVF" 2>/dev/null
      echo ""
      echo "已写入 .env: PUBLIC_BASE_URL=https://$DOMAIN (邮件里的后台入口链接; 重启后生效: bash deploy.sh force)"
    fi

    if [ -d /etc/nginx/sites-enabled ]; then
      DUP="$(grep -rl "127.0.0.1:$APP_PORT" /etc/nginx/sites-enabled/ 2>/dev/null | grep -v "^$CONF$" || true)"
      [ -n "$DUP" ] && echo "提醒: 这些旧配置也反代到 $APP_PORT, 建议删掉以免重复: $(echo $DUP | tr '\n' ' ')"
    fi

    echo ""
    echo "完成: https://$DOMAIN"
    echo "教室屏(桌面端)的服务地址填 https://$DOMAIN 即可, 证书有效就不会再提示不安全。"
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

# ---------------- 清理 .env 里历史遗留的失效邮件配置 ----------------
# 放在这里: 不管这次是新版本还是「已是最新」, 只要跑过 deploy.sh 就会清一遍(幂等)
clean_legacy_env

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
OLD="$(git rev-parse --verify --quiet HEAD || true)"
FORCE=0
[ "${1:-}" = "force" ] && FORCE=1

if [ -n "$OLD" ] && [ "$OLD" = "$NEW" ] && [ "$FORCE" = "0" ]; then
  # 没有新代码: 静默退出(避免 cron 日志无限增长); 手动运行时给个提示
  [ -t 1 ] && echo "已是最新版本 (${NEW:0:7}), 无需更新"
  exit 0
fi

if [ "$OLD" = "$NEW" ]; then
  log "强制重启服务 (版本 ${NEW:0:7})"
elif [ -z "$OLD" ]; then
  log "首次部署: 更新到 ${NEW:0:7}"
else
  log "发现新版本: ${OLD:0:7} -> ${NEW:0:7}"
fi

# ---------------- 3. 备份数据 ----------------
mkdir -p backups
if [ -f data/db.json ]; then
  cp -a data/db.json "backups/db-$(date +%Y%m%d-%H%M%S).json"
  ls -t backups/db-*.json 2>/dev/null | tail -n +11 | while read -r f; do rm -f "$f"; done
  log "已备份数据库到 backups/"
fi

# ---------------- 4. 更新代码(不碰 data/ 和 .env) ----------------
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
  pm2 restart all --update-env >>"$LOG" 2>&1
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
