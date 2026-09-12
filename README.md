# 班级喊话系统(复刻演示)

> 📖 **给使用者看的操作说明见 [`使用说明.md`](./使用说明.md)**;技术细节见本文档。

参考《班级喊话使用手册》复刻的可运行版本:老师/办公室在**网页端**发通知,绑定到班级的**教室端**自动**全屏弹窗 + 中文语音播报**。

本项目含一个 **跨平台桌面演示屏**(`mac-screen/`,Electron,支持 **macOS / Windows**):全屏扮演"教室端",在 Mac 或 Windows 大屏上接收并播报通知。构建命令:`npm run dist:mac`(Mac) / `npm run dist:win`(Windows,生成单文件 exe)。

## 运行

```bash
npm install
npm start
```

启动后访问:

| 入口 | 地址 | 说明 |
|---|---|---|
| 登录/注册 | http://localhost:3000/ | 注册需激活卡号, 含演示卡号 |
| 后台管理 | http://localhost:3000/app | 建班级/绑定码/发通知/协同老师 |
| 教室端 | http://localhost:3000/room | 教室电脑绑定后全屏播报 |

**演示账号**:`demo / demo123`,对应演示绑定码 **`DEMO8YQZ`**。

建议用两个浏览器标签页体验完整闭环:
1. `/` 用 `demo` 登录 → `/app` 查看"示例班级·三2班"的绑定码;
2. 另一个标签打开 `/room` 输入绑定码 → 回到 `/app` 发送通知 → 教室端自动全屏 + 朗读。

## 已实现功能(对照手册)

- 激活卡号注册:普通激活卡(自带 2 个班级)/ 协同授权码(CO- 开头,协同账号不能建班级)
- 登录 / 退出 / 忘记密码(用户名 + 注册时激活卡号)
- 新建班级、重命名、删除;班级配额校验
- 绑定码生成 / 重新生成(原码立即失效,教室端自动被要求重绑)
- 发送通知(文本 + 语音开关 + 弹窗颜色),实时推送到教室端
- 通知记录列表、删除记录、测试播报
- 协同老师:邀请(需对方先注册协同账号)→ 接受/拒绝 → 加入后多人可发;主账号可移除
- 教室端:绑定码长效保存(刷新/重启自动重连)、开机记忆、声音开关、解绑、全屏
- 教室在线/离线状态实时显示;发送时教室离线会提示
- 「申请激活卡号」提交后自动发邮件通知站长(可选, 见「申请通知邮件」)

## 模拟"客服发卡"

正式系统里激活卡需付费购买,这里提供模拟客服接口(演示方便加班级额度用):

```bash
curl -X POST http://localhost:3000/api/cards/generate \
  -H "Content-Type: application/json" \
  -d '{"adminKey":"siyunx-admin","type":"owner","count":2}'
```

- 默认发卡口令 `siyunx-admin`,可用环境变量 `CARD_KEY` 修改
- 启动时若库为空会自动生成演示卡并在控制台打印

### 网页版发卡后台

也可以直接在浏览器里发卡,不用敲命令:打开 **`/admin`**

1. 输入发卡口令(即 `CARD_KEY`),点「验证并查看库存」;
2. 选择卡类型(普通激活卡 / 协同授权码)和数量(1~50),点「生成卡号」;
3. 生成的卡号可单个复制或「复制全部」,发给老师即可。

> 安全提醒:口令务必通过环境变量 `CARD_KEY` 改掉默认值;不对外演示时建议用 `DEMO=off` 关闭演示卡接口 `/api/auth/demo-cards`(它会把未使用的卡号列出来)。

## 申请通知邮件

老师(在落地页或注册页)提交「申请激活卡号」后, 服务端会给站长邮箱发一封通知邮件, 内容含联系邮箱、补充说明、提交时间、来源 IP 和发卡后台入口链接;老师填的邮箱会作为 `Reply-To`, 直接回复即可。

邮件发送是**可选的**:不配置时申请照旧记录在 `/admin`, 只是不发信。发信走 **EmailJS**(唯一方式), 需要 `EMAILJS_SERVICE_ID` `EMAILJS_TEMPLATE_ID` `EMAILJS_PUBLIC_KEY`, 后台开了 Strict Mode 再加 `EMAILJS_PRIVATE_KEY`;不用域名、不用邮箱授权码, HTTP API 免费额度 200 封/月, 接口限速 1 封/秒。

两个必踩的坑:`EMAILJS_SERVICE_ID` 形如 `service_xxxxxxx`(是 Services 列表里的 ID, 不是 Service 的名字);并且必须到 Account → Security 打开 **Allow EmailJS API for non-browser applications**, 否则服务端 Node 调用会被 403 拒绝(`API access from non-browser environments is currently disabled`)。

邮件版式住在 EmailJS 后台的模板里, 代码只负责传变量;模板字段按下面填, 正文两个占位符可同时写(一个给纯文本客户端, 一个给 HTML):

| 模板字段 | 填什么 |
|---|---|
| To Email | `{{to_email}}` |
| Subject | `{{subject}}` |
| From Name | `{{from_name}}` |
| Reply To | `{{reply_to}}` |
| 正文 | `{{text}}`(纯文本)和/或 `{{{html_content}}}`(三花括号 = 原样输出 HTML) |

收件邮箱默认 `CARD_EMAIL`(即 `ladyiney25@gmail.com`), 可用 `MAIL_TO` 覆盖;邮件里的后台入口按访问请求头自动推断, 也可用 `PUBLIC_BASE_URL` 固定。

在服务器上用 `deploy.sh` 配置最省事:

```bash
bash deploy.sh mail                                  # 查看当前配置
bash deploy.sh mail emailjs 服务ID 模板ID 公钥 [私钥]   # 配置 EmailJS(不用域名, 也不用邮箱授权码)
bash deploy.sh mail to 收件邮箱                       # 只改收件邮箱
bash deploy.sh mail test                             # 发一封测试邮件验证
bash deploy.sh mail off                              # 关闭邮件通知
```

配好后提交一次申请即可验证;启动日志和提交时的日志都会显示发信结果(`✉ 申请通知邮件已发送/未发送`), 发送结果也会记录在 `data/db.json` 里每条申请的 `mail` 字段上。发信失败不会影响「申请已提交」的响应。

## HTTPS(在服务器上一条命令)

把域名解析到服务器后,执行一次即可(可重复执行,每次都得到同样的结果):

```bash
sudo bash deploy.sh https callclass.site
```

它会依次做:检测/安装 `nginx` 与 `certbot` → 先写一份只监听 80 的临时配置并签发 Let's Encrypt 证书 → 换成正式配置(80 全部 301 跳 https,443 反代到本机 `PORT`,并转发 WebSocket 升级头,长连接超时放宽到 7 天)→ `nginx -t` 通过才 reload(失败自动回滚,不会把站点搞挂)→ 最后回环自测并打印结果:

```
===== 验证 =====
  http  →  期望 301, 实际 301
  https →  期望 200, 实际 200
  socket.io 握手 → 期望 200, 实际 200
  证书到期: Nov 10 12:00:00 2026 GMT
```

- 域名不填时依次取 `.env` 的 `SITE_DOMAIN`、`PUBLIC_BASE_URL`,再退回 `callclass.site`
- 证书邮箱取 `CERTBOT_EMAIL`(没填则用 `MAIL_TO` / `CARD_EMAIL`);不填也能签,但收不到续期提醒
- 需要强制重签:`FORCE_RENEW=1 sudo bash deploy.sh https 域名`
- 证书自动续期由 `certbot.timer` 负责;续期依赖配置里的 `/.well-known/acme-challenge/` 目录,别删
- 云服务器记得在安全组放行 80 / 443(脚本只会自动放行 ufw 防火墙)
- 配置文件位置:`/etc/nginx/sites-available/<域名>.conf`(无 sites-enabled 的系统则放 `/etc/nginx/conf.d/`),由脚本生成,手改会被下次执行覆盖
- 想确认是否已配好:`bash deploy.sh status`

## 数据与配置

- 数据存于 `data/db.json`(首次运行自动生成),删除该文件即重置
- 环境变量:`PORT`(默认 3000)、`CARD_KEY`、`DEMO=off` 关闭演示种子/演示卡;邮件通知见上一节;`PUBLIC_BASE_URL` 固定邮件里的站点链接(HTTPS 一节会写入)
- 早期版本用过的 `SMTP_*`、`RESEND_API_KEY`、`MAIL_WEBHOOK_URL` 已废弃(发信只走 EmailJS),留在 `.env` 里不生效也不报错;服务器上每次执行 `bash deploy.sh` 都会自动清掉,清理前留一份 `.env.legacy.bak`

## 目录

```
server/          Express + Socket.IO 服务端
  index.js       REST 接口 + 实时推送
  store.js       JSON 持久化
public/          前端(原生 JS, 移动端可用, 可添加到主屏幕)
  index.html     登录/注册/忘记密码
  app.html       老师后台
  room.html      教室端
mac-screen/      跨平台教室演示屏(Electron 桌面端, macOS / Windows)
  main.js        主进程: 全屏加载 room 页 + 服务地址默认内置云端 callclass.site(可 --server / 设置弹窗覆盖) + 开发模式自动拉起本地服务
  preload.js     桌面桥接(退出/重连/读取并保存服务地址)
  error.html     连不上服务时的地址设置/引导页
  (dist/)        npm run dist:mac / dist:win 产物
```

## 已知边界(演示性质)

- 教室端为网页版;正式产品是 Windows 安装包。本版可把 `/room` 用浏览器"安装为应用/全屏"模拟教室电脑,或在教室电脑用 Chrome/Edge 打开后按 F11。
- 数据持久化为单文件 JSON,适合班级级演示;多人并发上线需换成数据库。
- 浏览器要求:语音播报使用 Web Speech 中文语音,需 Chrome/Edge(Windows/安卓)或 Safari;首次需点击一次解锁声音(浏览器自动播放策略)。
