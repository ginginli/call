/* eslint-disable no-console */
/**
 * 班级喊话系统 · 服务端
 *  - REST API:注册/登录/班级/绑定码/通知/协同老师
 *  - Socket.IO:把通知实时推送给绑定的"教室端"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { db, persist, nextId } = require('./store');
const { sendMail, mailStatus } = require('./mailer');

/* 载入项目根目录的 .env (无需额外依赖)。
   已存在的环境变量优先, 不会被 .env 覆盖;
   这样改完 .env 只要重启服务就生效, 不依赖 PM2 的环境变量快照。 */
(function loadDotEnv() {
  try {
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) return;
      let value = m[2].trim();
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.length > 1 && value[value.length - 1] === quote) {
        value = value.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    });
  } catch (e) { /* 忽略 .env 读取失败 */ }
})();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.CARD_KEY || 'siyunx-admin'; // 模拟"客服发卡"口令
const CARD_REQUEST_EMAIL = process.env.CARD_EMAIL || 'ladyiney25@gmail.com'; // 申请激活卡号收件邮箱
const SHOW_DEMO = process.env.DEMO !== 'off';
const TRIAL_ON = process.env.TRIAL !== 'off'; // 免注册「一键体验」入口, 正式上线可用 TRIAL=off 关闭
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const CODE_SET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------------- 会话 ---------------- */
const sessions = new Map(); // token -> { uid, exp }

function rnd(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_SET[Math.floor(Math.random() * CODE_SET.length)];
  return s;
}
function uniqueBindCode() {
  let code;
  do { code = rnd(8); } while (db.classes.some((c) => c.bindCode === code));
  return code;
}
function uniqueInviteCode() {
  let code;
  do { code = rnd(6); } while (db.invites.some((i) => i.code === code));
  return code;
}
function nowISO() { return new Date().toISOString(); }
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

function findUserById(id) { return db.users.find((u) => u.id === id); }
function findUserByName(raw) {
  const n = String(raw || '').trim().toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === n);
}
function findCard(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return db.cards.find((x) => x.code === c);
}
function publicUser(u) {
  return {
    id: u.id, username: u.username, type: u.type,
    classLimit: u.classLimit || 0, trial: !!u.trial, createdAt: u.createdAt,
  };
}
function newSession(uid) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { uid, exp: Date.now() + SESSION_TTL });
  return token;
}
function uidFromReq(req) {
  const header = req.headers.cookie || '';
  let sid = '';
  header.split(';').forEach((p) => {
    const kv = p.trim().split('=');
    if (kv[0] === 'sid') sid = decodeURIComponent(kv[1] || '');
  });
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(sid); return null; }
  s.exp = Date.now() + SESSION_TTL;
  return s.uid;
}
function auth(req, res, next) {
  const uid = uidFromReq(req);
  const user = uid ? findUserById(uid) : null;
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = user;
  next();
}

/* ---------------- 种子数据(首次启动) ---------------- */
function genCode(type) { return (type === 'co' ? 'CO-' : 'OWN-') + rnd(4) + '-' + rnd(4); }

function seedCards() {
  for (let i = 0; i < 5; i++) db.cards.push({ id: nextId('cd'), code: genCode('owner'), type: 'owner', usedBy: null, createdAt: nowISO() });
  for (let i = 0; i < 3; i++) db.cards.push({ id: nextId('cd'), code: genCode('co'), type: 'co', usedBy: null, createdAt: nowISO() });
  console.log('· 已生成 5 张普通激活卡 + 3 张协同授权码');
}

function seedDemo() {
  const code = genCode('owner');
  const salt = crypto.randomBytes(8).toString('hex');
  const user = {
    id: nextId('u'), username: 'demo', type: 'owner', classLimit: 2,
    salt, hash: hashPw('demo123', salt), cardCode: code, createdAt: nowISO(),
  };
  db.users.push(user);
  db.cards.push({ id: nextId('cd'), code, type: 'owner', usedBy: user.id, usedAt: nowISO(), createdAt: nowISO() });
  db.classes.push({
    id: nextId('cl'), ownerId: user.id, name: '示例班级·三2班', color: '#e11d48',
    bindCode: 'DEMO8YQZ', memberIds: [], createdAt: nowISO(),
  });
  console.log('\n========================================');
  console.log('  演示账号  ->  用户名: demo   密码: demo123');
  console.log('  教室绑定码 ->  DEMO8YQZ');
  console.log('========================================');
}

if (db.cards.length === 0 && SHOW_DEMO) seedCards();
if (db.users.length === 0 && SHOW_DEMO) seedDemo();

/* ---------------- 教室端在线状态 ---------------- */
const classSockets = new Map();      // classId -> Set<socketId> (实际 socket 连接)
const standbyClasses = new Map();   // classId -> expiresAt(ms), 最小化待命中(防止 OS 挂起后被判离线)
const STANDBY_TTL = 30 * 60 * 1000; // 30 分钟无 heartbeat 则清标记

function onlineCount(cid) { return (classSockets.get(cid) || new Set()).size; }
function addPresence(cid, sid) {
  if (!classSockets.has(cid)) classSockets.set(cid, new Set());
  classSockets.get(cid).add(sid);
}
function dropPresence(cid, sid) {
  const set = classSockets.get(cid);
  if (!set) return;
  set.delete(sid);
  if (set.size === 0) classSockets.delete(cid);
}
/* 综合判定: 有 socket 连着 或 在 standby 有效期内 = 都算"在线" */
function isClassOnline(cid) {
  if (onlineCount(cid) > 0) return true;
  const exp = standbyClasses.get(cid);
  if (!exp) return false;
  if (exp > Date.now()) return true;
  standbyClasses.delete(cid); // 过期顺手清
  return false;
}
/* 每分钟扫一遍清过期 standby, 避免内存泄漏 */
setInterval(() => {
  const now = Date.now();
  for (const [cid, exp] of standbyClasses) {
    if (exp <= now) standbyClasses.delete(cid);
  }
}, 60 * 1000).unref();

/* ---------------- 班级序列化 ---------------- */
function membersOf(c) {
  return (c.memberIds || []).map(findUserById).filter(Boolean).map((u) => ({ id: u.id, username: u.username }));
}
function ownedClassesOf(uid) { return db.classes.filter((c) => c.ownerId === uid); }
function visibleClasses(uid) {
  return db.classes.filter((c) => c.ownerId === uid || (c.memberIds || []).includes(uid));
}
function classJSON(c, uid) {
  return {
    id: c.id, name: c.name, color: c.color, isOwner: c.ownerId === uid,
    online: isClassOnline(c.id),
    bindCode: c.ownerId === uid ? c.bindCode : undefined,
    pendingInvites: c.ownerId === uid
      ? db.invites.filter((i) => i.classId === c.id && i.status === 'pending').length : 0,
    members: membersOf(c),
    createdAt: c.createdAt,
  };
}

/* ---------------- App ---------------- */
const app = express();
app.use(express.json({ limit: '200kb' }));

/* 首页 = 落地页(产品介绍 + 申请卡号), 登录页单独放在 /login */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.get('/room', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'room.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

/* 英文站点 (public/en/) */
app.get('/en', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'en', 'index.html')));
app.get('/en/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'en', 'login.html')));
app.get('/en/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'en', 'app.html')));
app.get('/en/room', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'en', 'room.html')));
app.get('/en/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'en', 'admin.html')));

/* 繁體中文站點 (public/zh-Hant/) */
app.get('/zh-Hant', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'zh-Hant', 'index.html')));
app.get('/zh-Hant/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'zh-Hant', 'login.html')));
app.get('/zh-Hant/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'zh-Hant', 'app.html')));
app.get('/zh-Hant/room', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'zh-Hant', 'room.html')));
app.get('/zh-Hant/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'zh-Hant', 'admin.html')));

/* 静态资源: 放在页面路由之后, 避免 /en 被目录形式重定向成 301 */
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ---- 认证 ---- */
app.post('/api/auth/register', (req, res) => {
  const { username, password, cardCode } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[\w\u4e00-\u9fa5·]{2,20}$/.test(name)) return res.status(400).json({ error: '用户名需为 2-20 位中文/字母/数字' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (findUserByName(name)) return res.status(400).json({ error: '用户名已被注册' });
  const card = findCard(cardCode);
  if (!card) return res.status(400).json({ error: '激活卡号无效, 请核对后重试' });
  if (card.usedBy) return res.status(400).json({ error: '该激活卡号已被使用' });
  const salt = crypto.randomBytes(8).toString('hex');
  const user = {
    id: nextId('u'), username: name, type: card.type,
    classLimit: card.type === 'co' ? 0 : 2,
    salt, hash: hashPw(String(password), salt), cardCode: card.code, createdAt: nowISO(),
  };
  db.users.push(user);
  card.usedBy = user.id; card.usedAt = nowISO();
  persist();
  const token = newSession(user.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL, path: '/' });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = findUserByName(username);
  if (!user || !password) return res.status(400).json({ error: '用户名或密码错误' });
  const h = crypto.scryptSync(String(password), user.salt, 32).toString('hex');
  if (h !== user.hash) return res.status(400).json({ error: '用户名或密码错误' });
  const token = newSession(user.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL, path: '/' });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.cookie || '';
  header.split(';').forEach((p) => {
    const kv = p.trim().split('=');
    if (kv[0] === 'sid') sessions.delete(decodeURIComponent(kv[1] || ''));
  });
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.post('/api/auth/forgot', (req, res) => {
  const { username, cardCode, password } = req.body || {};
  const user = findUserByName(username);
  if (!user) return res.status(400).json({ error: '该账号不存在' });
  if (user.cardCode !== String(cardCode || '').trim().toUpperCase()) {
    return res.status(400).json({ error: '激活卡号与注册时不符' });
  }
  if (!password || String(password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  user.salt = crypto.randomBytes(8).toString('hex');
  user.hash = hashPw(String(password), user.salt);
  persist();
  res.json({ ok: true });
});

app.get('/api/auth/demo-cards', (req, res) => {
  if (!SHOW_DEMO) return res.json({ cards: [] });
  const cards = db.cards.filter((c) => !c.usedBy).slice(0, 12).map((c) => ({ code: c.code, type: c.type }));
  res.json({ cards });
});

/* ---- 免注册「一键体验」 ----
   打开 /try 当场生成一个独立体验账号 + 一个体验班级(随机绑定码) + 两条示例通知,
   直接写会话并跳进后台。与演示账号 demo 的区别: 每位访客互相隔离, 24 小时后自动清理。
   正式上线若不希望开放, 设 TRIAL=off(与 DEMO 开关相互独立)。 */
const TRIAL_TTL = 24 * 3600 * 1000;   // 体验账号存活时长
const TRIAL_PER_HOUR = 5;             // 同一 IP 每小时最多开几个体验账号
const trialHits = new Map();          // ip -> [开通时间戳]

function trialRateOk(ip) {
  const now = Date.now();
  const hits = (trialHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (hits.length >= TRIAL_PER_HOUR) return false;
  hits.push(now);
  trialHits.set(ip, hits);
  return true;
}

app.get('/try', (req, res) => {
  // 语言站(/en/、/zh-Hant/)会带 ?to=/en/app, 体验完仍回到对应语言的后台
  const q = String(req.query.to || '');
  const to = /^\/(?:en|zh-Hant)\/app$/.test(q) ? q : '/app';
  if (!TRIAL_ON) return res.redirect(to.replace(/\/app$/, '/login'));
  // 已登录(含已开过体验账号)就不重复创建, 直接回后台
  if (uidFromReq(req)) return res.redirect(to);
  if (!trialRateOk(clientIp(req))) return res.redirect(to.replace(/\/app$/, '/login?trial=busy'));

  let name;
  do { name = '访客' + rnd(4); } while (findUserByName(name));

  const salt = crypto.randomBytes(8).toString('hex');
  const user = {
    id: nextId('u'), username: name, type: 'owner', classLimit: 1,
    salt, hash: hashPw(rnd(16), salt), cardCode: '',
    trial: true, trialExpireAt: new Date(Date.now() + TRIAL_TTL).toISOString(),
    createdAt: nowISO(),
  };
  db.users.push(user);

  const cls = {
    id: nextId('cl'), ownerId: user.id, name: '我的体验班级', color: '#e11d48',
    bindCode: uniqueBindCode(), memberIds: [], createdAt: nowISO(),
  };
  db.classes.push(cls);

  // 预置两条通知, 让后台不是一片空白, 也顺便把"长什么样"演示给用户
  [
    '欢迎体验：在右侧输入一句话，点「发送通知」试试',
    '教室端绑定后会立刻全屏弹出，并语音播报这条通知',
  ].forEach((content, i) => {
    db.notifications.push({
      id: nextId('nt'), classId: cls.id, className: cls.name,
      content, voice: false, color: cls.color,
      fromId: user.id, fromName: '体验助手',
      delivered: false, duration: 0, trial: true,
      createdAt: new Date(Date.now() - (2 - i) * 60000).toISOString(),
    });
  });

  persist();
  const token = newSession(user.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL, path: '/' });
  res.redirect(to);
});

/* 每小时清理一次过期的体验账号(连带它的班级 / 通知 / 定时任务 / 邀请) */
function cleanTrials() {
  const now = Date.now();
  const dead = db.users.filter((u) => u.trial && u.trialExpireAt && Date.parse(u.trialExpireAt) < now);
  if (!dead.length) return;
  const uids = new Set(dead.map((u) => u.id));
  const cids = new Set(db.classes.filter((c) => uids.has(c.ownerId)).map((c) => c.id));
  db.users = db.users.filter((u) => !uids.has(u.id));
  db.classes = db.classes.filter((c) => !cids.has(c.id));
  db.notifications = db.notifications.filter((n) => !cids.has(n.classId));
  db.jobs = db.jobs.filter((j) => !cids.has(j.classId));
  db.invites = db.invites.filter((i) => !cids.has(i.classId));
  sessions.forEach((s, k) => { if (uids.has(s.uid)) sessions.delete(k); });
  persist();
  console.log(`· 已清理 ${dead.length} 个过期体验账号`);
}

/* ---- 激活卡号申请(落地页 / 注册页提交, 无需登录) ---- */
/* 页面语言: zh=简体 / zh-Hant=繁體 / en=English */
const PAGE_LANGS = { zh: '中文', 'zh-Hant': '繁體中文', en: 'English' };
function normLang(v) { return Object.prototype.hasOwnProperty.call(PAGE_LANGS, v) ? v : 'zh'; }
function langLabel(v) { return PAGE_LANGS[normLang(v)]; }

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '';
}

/* 用请求头拼出站点地址, 方便邮件里放后台入口链接 */
function baseUrlOf(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

/* 收到申请后给站长邮箱发一封通知邮件。
   异步发送、失败只记日志, 不影响「申请已提交」的响应。 */
async function notifyCardRequestByMail(rec, req) {
  const base = baseUrlOf(req);
  const adminAt = base ? base + '/admin' : '/admin';
  const time = new Date(rec.createdAt).toLocaleString('zh-CN', {
    timeZone: process.env.TZ || 'Asia/Shanghai', hour12: false,
  });
  const rows = [
    ['联系邮箱', rec.contact],
    ['补充说明', rec.note || '（无）'],
    ['提交时间', time],
    ['页面语言', langLabel(rec.lang)],
    ['来源 IP', rec.ip || '未知'],
    ['申请编号', rec.id],
  ];
  const text = [
    '收到一条新的激活卡号申请：',
    '',
    ...rows.map(([k, v]) => `${k}：${v}`),
    '',
    '处理入口：' + adminAt + '（输入发卡口令后可查看全部申请）',
    '',
    '—— 班级喊话系统 自动通知',
  ].join('\n');
  const html = '<p>收到一条新的<b>激活卡号申请</b>：</p>'
    + '<table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px">'
    + rows.map(([k, v]) => `<tr><td style="color:#6b7280;white-space:nowrap">${k}</td><td><b>${v}</b></td></tr>`).join('')
    + '</table>'
    + `<p style="margin-top:14px">处理入口：<a href="${adminAt}">${adminAt}</a>（输入发卡口令后可查看全部申请）</p>`;

  const r = await sendMail({
    to: CARD_REQUEST_EMAIL,
    subject: `【班级喊话】新的激活卡号申请：${rec.contact}`,
    text,
    html,
    replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.contact) ? rec.contact : undefined,
  });
  rec.mail = r.ok ? { ok: true, via: r.via, at: nowISO() } : { ok: false, error: r.error, at: nowISO() };
  persist();
  if (r.ok) console.log('  ✉ 申请通知邮件已发送 →', CARD_REQUEST_EMAIL, '(via ' + r.via + ')');
  else console.warn('  ✉ 申请通知邮件未发送:', r.error);
}

app.post('/api/card-request', (req, res) => {
  const { contact, note, lang } = req.body || {};
  const c = String(contact || '').trim().slice(0, 60);
  if (c.length < 3) return res.status(400).json({ error: '请填写有效的联系邮箱' });
  const nt = String(note || '').trim().slice(0, 200);
  // 同一邮箱 10 分钟内只记一条, 防止重复提交
  const dup = db.cardRequests.find((r) => r.contact.toLowerCase() === c.toLowerCase()
    && Date.now() - new Date(r.createdAt).getTime() < 10 * 60 * 1000);
  if (!dup) {
    const rec = {
      id: nextId('cr'), contact: c, note: nt,
      lang: normLang(lang), status: 'pending',
      createdAt: nowISO(), ip: clientIp(req),
    };
    db.cardRequests.push(rec);
    persist();
    console.log('· 收到激活卡号申请:', c);
    // 给站长邮箱发通知(不阻塞本次响应)
    notifyCardRequestByMail(rec, req).catch((e) => console.warn('  ✉ 申请通知邮件异常:', e.message));
  }
  res.json({ ok: true, email: CARD_REQUEST_EMAIL });
});

/* ---- 功能建议(落地页提交, 无需登录) ----
   与「申请卡号」共用同一个收件邮箱, 但单独存一份记录, 便于后续在发卡后台查看。 */
async function notifyFeatureRequestByMail(rec, req) {
  const base = baseUrlOf(req);
  const adminAt = base ? base + '/admin' : '/admin';
  const time = new Date(rec.createdAt).toLocaleString('zh-CN', {
    timeZone: process.env.TZ || 'Asia/Shanghai', hour12: false,
  });
  const rows = [
    ['建议内容', rec.idea],
    ['联系邮箱', rec.contact || '（未留）'],
    ['提交时间', time],
    ['页面语言', langLabel(rec.lang)],
    ['来源 IP', rec.ip || '未知'],
    ['记录编号', rec.id],
  ];
  const text = [
    '收到一条新的功能建议：',
    '',
    ...rows.map(([k, v]) => `${k}：${v}`),
    '',
    '处理入口：' + adminAt,
    '',
    '—— 班级喊话系统 自动通知',
  ].join('\n');
  const html = '<p>收到一条新的<b>功能建议</b>：</p>'
    + '<table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px">'
    + rows.map(([k, v]) => `<tr><td style="color:#6b7280;white-space:nowrap">${k}</td><td><b>${v}</b></td></tr>`).join('')
    + '</table>'
    + `<p style="margin-top:14px">处理入口：<a href="${adminAt}">${adminAt}</a></p>`;

  const r = await sendMail({
    to: CARD_REQUEST_EMAIL,
    subject: `【班级喊话】新的功能建议：${String(rec.idea).slice(0, 30)}`,
    text,
    html,
    replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.contact || '') ? rec.contact : undefined,
  });
  rec.mail = r.ok ? { ok: true, via: r.via, at: nowISO() } : { ok: false, error: r.error, at: nowISO() };
  persist();
  if (r.ok) console.log('  ✉ 功能建议邮件已发送 →', CARD_REQUEST_EMAIL, '(via ' + r.via + ')');
  else console.warn('  ✉ 功能建议邮件未发送:', r.error);
}

app.post('/api/feature-request', (req, res) => {
  const { idea, contact, lang } = req.body || {};
  const txt = String(idea || '').trim().slice(0, 500);
  if (txt.length < 5) return res.status(400).json({ error: '请多写几个字，方便我们理解你的需求' });
  const c = String(contact || '').trim().slice(0, 60);
  // 该表单邮箱选填, 无法按邮箱去重, 改为同一 IP 2 分钟内只记一条
  const ip = clientIp(req);
  const dup = db.featureRequests.find((r) => r.ip === ip
    && Date.now() - new Date(r.createdAt).getTime() < 2 * 60 * 1000);
  if (!dup) {
    const rec = {
      id: nextId('fr'), idea: txt, contact: c,
      lang: normLang(lang), status: 'new',
      createdAt: nowISO(), ip,
    };
    db.featureRequests.push(rec);
    persist();
    console.log('· 收到功能建议:', txt.slice(0, 40));
    // 给站长邮箱发通知(不阻塞本次响应)
    notifyFeatureRequestByMail(rec, req).catch((e) => console.warn('  ✉ 功能建议邮件异常:', e.message));
  }
  res.json({ ok: true });
});

/* 发卡后台: 查看功能建议 */
app.post('/api/cards/feature-requests', (req, res) => {
  const { adminKey } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  const list = db.featureRequests.slice().reverse();
  res.json({
    total: list.length,
    pending: list.filter((r) => r.status !== 'done').length,
    requests: list.slice(0, 200),
  });
});

/* 发卡后台: 把某条功能建议标记为已读 */
app.post('/api/cards/feature-requests/done', (req, res) => {
  const { adminKey, id } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  const r = db.featureRequests.find((x) => x.id === id);
  if (!r) return res.status(404).json({ error: '建议不存在' });
  r.status = 'done';
  r.doneAt = nowISO();
  persist();
  res.json({ ok: true });
});

/* 发卡后台: 查看激活卡号申请 */
app.post('/api/cards/requests', (req, res) => {
  const { adminKey } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  const list = db.cardRequests.slice().reverse();
  res.json({
    total: list.length,
    pending: list.filter((r) => r.status === 'pending').length,
    email: CARD_REQUEST_EMAIL,
    requests: list.slice(0, 200),
  });
});

/* 发卡后台: 把某条申请标记为已处理 */
app.post('/api/cards/requests/done', (req, res) => {
  const { adminKey, id } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  const r = db.cardRequests.find((x) => x.id === id);
  if (!r) return res.status(404).json({ error: '申请不存在' });
  r.status = 'done';
  r.doneAt = nowISO();
  persist();
  res.json({ ok: true });
});

/* 发卡后台: 发一封测试邮件, 用来验证邮箱通知配置是否可用 */
app.post('/api/cards/test-mail', async (req, res) => {
  const { adminKey } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  const r = await sendMail({
    to: CARD_REQUEST_EMAIL,
    subject: '【班级喊话】邮件通知测试',
    text: '如果你收到这封邮件，说明「申请通知邮件」配置成功。\n\n之后每次有老师提交激活卡号申请，系统都会自动发一封同样格式的邮件到这个邮箱。',
    html: '<p>如果你收到这封邮件，说明<b>「申请通知邮件」配置成功</b>。</p>'
      + '<p>之后每次有老师提交激活卡号申请，系统都会自动发一封同样格式的邮件到这个邮箱。</p>',
  });
  res.json({ ...r, to: CARD_REQUEST_EMAIL });
});

/* ---- 客服发卡(模拟后台) ---- */
app.post('/api/cards/generate', (req, res) => {
  const { adminKey, type, count } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  if (type !== 'owner' && type !== 'co') return res.status(400).json({ error: '卡类型必须为 owner 或 co' });
  const n = Math.min(Math.max(Number(count) || 1, 1), 50);
  const out = [];
  for (let i = 0; i < n; i++) {
    const code = genCode(type);
    db.cards.push({ id: nextId('cd'), code, type, usedBy: null, delivered: false, createdAt: nowISO() });
    out.push(code);
  }
  persist();
  res.json({ ok: true, codes: out });
});

/* 发卡后台: 卡号明细(需发卡口令)。每张卡都带注册状态: 未使用 / 已注册(绑定到哪个账号)
   以及发放状态: 未发放 / 已发放(是否已经线下交付给客户, 与注册与否无关) */
app.post('/api/cards/list', (req, res) => {
  const { adminKey, q } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  const userById = new Map(db.users.map((u) => [u.id, u]));
  const all = db.cards.slice().reverse().map((c) => {
    const u = c.usedBy ? userById.get(c.usedBy) : null;
    return {
      id: c.id,
      code: c.code,
      type: c.type,
      createdAt: c.createdAt,
      delivered: !!c.delivered,
      deliveredAt: c.deliveredAt || null,
      status: c.usedBy ? 'used' : 'unused',
      usedAt: c.usedAt || null,
      user: u ? { username: u.username, createdAt: u.createdAt, type: u.type } : null,
    };
  });
  const kw = String(q || '').trim().toLowerCase();
  const list = kw
    ? all.filter((c) => c.code.toLowerCase().includes(kw)
      || (c.user && c.user.username.toLowerCase().includes(kw)))
    : all;
  res.json({
    total: all.length,
    used: all.filter((c) => c.status === 'used').length,
    delivered: all.filter((c) => c.delivered).length,
    unusedOwner: all.filter((c) => c.status === 'unused' && c.type !== 'co').length,
    unusedCo: all.filter((c) => c.status === 'unused' && c.type === 'co').length,
    usingDefaultKey: ADMIN_KEY === 'siyunx-admin',
    cards: list.slice(0, 300),
  });
});

/* 发卡后台: 标记某张卡是否已发放给客户。
   delivered 省略或为 true 即标记已发放, 传 false 撤销标记。 */
app.post('/api/cards/deliver', (req, res) => {
  const { adminKey, id, delivered } = req.body || {};
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: '发卡口令错误' });
  const c = db.cards.find((x) => x.id === id);
  if (!c) return res.status(404).json({ error: '卡号不存在' });
  const on = delivered !== false;
  c.delivered = on;
  c.deliveredAt = on ? nowISO() : null;
  persist();
  res.json({ ok: true, delivered: on, deliveredAt: c.deliveredAt });
});

/* ---- 账号与班级 ---- */
app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  const classes = visibleClasses(u.id).map((c) => classJSON(c, u.id));
  classes.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const invites = db.invites
    .filter((i) => i.toUserId === u.id && i.status === 'pending')
    .map((i) => ({ id: i.id, classId: i.classId, className: i.className, ownerName: i.ownerName, createdAt: i.createdAt }));
  res.json({ user: { ...publicUser(u), ownedCount: ownedClassesOf(u.id).length }, classes, invites });
});

app.post('/api/classes', auth, (req, res) => {
  const u = req.user;
  if (u.type === 'co') return res.status(403).json({ error: '协同账号不能新建班级' });
  const owned = ownedClassesOf(u.id);
  if (owned.length >= (u.classLimit || 0)) {
    return res.status(400).json({ error: `账号最多创建 ${u.classLimit} 个班级, 需要增加请联系客服` });
  }
  const name = String((req.body || {}).name || '').trim();
  if (!name || name.length > 20) return res.status(400).json({ error: '班级名称需为 1-20 个字符' });
  let color = (req.body || {}).color || '#e11d48';
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = '#e11d48';
  const cls = {
    id: nextId('cl'), ownerId: u.id, name, color,
    bindCode: uniqueBindCode(), memberIds: [], createdAt: nowISO(),
  };
  db.classes.push(cls);
  persist();
  res.json({ class: classJSON(cls, u.id) });
});

app.patch('/api/classes/:id', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可修改' });
  const { name, color } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n || n.length > 20) return res.status(400).json({ error: '班级名称需为 1-20 个字符' });
    c.name = n;
  }
  if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) c.color = color;
  persist();
  res.json({ class: classJSON(c, req.user.id) });
});

app.delete('/api/classes/:id', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可删除' });
  const idx = db.classes.indexOf(c);
  db.classes.splice(idx, 1);
  db.invites = db.invites.filter((i) => i.classId !== c.id);
  db.notifications = db.notifications.filter((n) => n.classId !== c.id);
  persist();
  res.json({ ok: true });
});

app.post('/api/classes/:id/code', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可重新生成绑定码' });
  c.bindCode = uniqueBindCode();
  persist();
  // 通知已经连上的教室端: 绑定码已变更, 需要重新绑定
  io.to('class:' + c.id).emit('rebind', { reason: '绑定码已更新，请重新绑定' });
  res.json({ bindCode: c.bindCode });
});

app.get('/api/classes/:id/status', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  res.json({ online: isClassOnline(c.id) });
});

app.post('/api/classes/:id/minimize', auth, (req, res) => {
  const c = classForReq(req, res, req.params.id);
  if (!c) return;
  io.to('class:' + c.id).emit('minimize', { reason: '老师远程最小化通知屏' });
  res.json({ ok: true });
});

/* 教室端自身上报"进入/退出待命", 用 bindCode 自鉴权(无需 uid)
 * 注: 老师从后台远程最小化继续走上面的 /api/classes/:id/minimize(那边直推 socket 'minimize' 事件)
 */
app.post('/api/room/:code/standby', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const cls = db.classes.find((c) => c.bindCode.toUpperCase() === code);
  if (!cls) return res.status(404).json({ error: '绑定码无效' });
  standbyClasses.set(cls.id, Date.now() + STANDBY_TTL);
  res.json({ ok: true, ttl: STANDBY_TTL });
});
app.post('/api/room/:code/restore', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const cls = db.classes.find((c) => c.bindCode.toUpperCase() === code);
  if (!cls) return res.status(404).json({ error: '绑定码无效' });
  standbyClasses.delete(cls.id);
  res.json({ ok: true });
});
app.post('/api/room/:code/heartbeat', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const cls = db.classes.find((c) => c.bindCode.toUpperCase() === code);
  if (!cls) return res.status(404).json({ error: '绑定码无效' });
  if (standbyClasses.has(cls.id)) {
    standbyClasses.set(cls.id, Date.now() + STANDBY_TTL);
  }
  res.json({ ok: true });
});

function canUseClass(u, c) {
  return c.ownerId === u.id || (c.memberIds || []).includes(u.id);
}

/* ---- 通知 ---- */
/* 通知记录仅保留每班最近 10 条 */
const NOTIF_KEEP = 10;

function trimNotifsOf(classId) {
  const keep = db.notifications
    .filter((n) => n.classId === classId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, NOTIF_KEEP);
  const keepIds = new Set(keep.map((n) => n.id));
  const before = db.notifications.length;
  db.notifications = db.notifications.filter((n) => n.classId !== classId || keepIds.has(n.id));
  return db.notifications.length !== before;
}

// 新增一条通知记录, 并自动裁剪该班级只保留最近 NOTIF_KEEP 条
function addNotifRecord(record) {
  db.notifications.push(record);
  trimNotifsOf(record.classId);
}
app.get('/api/classes/:id/notifications', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (!canUseClass(req.user, c)) return res.status(403).json({ error: '无权查看该班级' });
  const list = db.notifications
    .filter((n) => n.classId === c.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((n) => ({ ...n, onlineNow: isClassOnline(c.id) }));
  res.json({ notifications: list });
});

app.post('/api/classes/:id/notify', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (!canUseClass(req.user, c)) return res.status(403).json({ error: '您不是该班级的老师, 无权发送' });
  const u = req.user;
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '通知内容不能为空' });
  if (content.length > 500) return res.status(400).json({ error: '通知内容过长(≤500字)' });
  const voice = (req.body || {}).voice !== false;
  let color = (req.body || {}).color || c.color;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = c.color;
  const duration = clampDur((req.body || {}).duration);
  const record = {
    id: nextId('nt'), classId: c.id, className: c.name,
    content, voice, color,
    fromId: u.id, fromName: u.username,
    delivered: isClassOnline(c.id),
    duration, createdAt: nowISO(),
  };
  addNotifRecord(record);
  persist();
  pushNotify(c.id, {
    id: record.id, className: c.name, content, voice, color, fromName: u.username,
    sentAt: record.createdAt, duration,
  });
  res.json({ notification: record });
});

/* ---- 协同老师 ---- */
app.post('/api/classes/:id/invite', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可邀请协同老师' });
  const target = findUserByName((req.body || {}).username);
  if (!target) return res.status(404).json({ error: '没有找到该用户名, 请确认对方已注册协同账号' });
  if (target.type !== 'co') return res.status(400).json({ error: '只能邀请【协同账号】, 请对方通过协同授权码注册' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能邀请自己' });
  if ((c.memberIds || []).includes(target.id)) return res.status(400).json({ error: '该老师已在本班级中' });
  const dup = db.invites.find((i) => i.classId === c.id && i.toUserId === target.id && i.status === 'pending');
  if (dup) return res.status(400).json({ error: '已向该老师发出邀请, 等待对方处理' });
  db.invites.push({
    id: nextId('iv'), classId: c.id, className: c.name,
    ownerId: req.user.id, ownerName: req.user.username,
    toUserId: target.id, toName: target.username,
    status: 'pending', createdAt: nowISO(),
  });
  persist();
  res.json({ ok: true });
});

app.get('/api/classes/:id/invites', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可查看' });
  const codeInv = db.invites.find((i) => i.kind === 'code' && i.classId === c.id);
  res.json({
    members: membersOf(c),
    code: codeInv ? { code: codeInv.code, status: codeInv.status } : null,
    invites: db.invites.filter((i) => i.kind !== 'code' && i.classId === c.id).map((i) => ({
      id: i.id, username: i.toName, status: i.status, createdAt: i.createdAt,
    })),
  });
});

/* 邀请码: 班主任生成 / 协同账号输码加入 */
app.post('/api/classes/:id/invite-code', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可生成邀请码' });
  let inv = db.invites.find((i) => i.kind === 'code' && i.classId === c.id);
  if (inv) {
    // 已存在则重新生成(旧码立即失效)
    inv.code = uniqueInviteCode();
    inv.status = 'active';
    inv.createdAt = nowISO();
  } else {
    inv = {
      id: nextId('iv'), kind: 'code', code: uniqueInviteCode(), classId: c.id,
      className: c.name, ownerName: req.user.username, createdBy: req.user.id,
      status: 'active', createdAt: nowISO(),
    };
    db.invites.push(inv);
  }
  persist();
  res.json({ code: inv.code, status: inv.status });
});

app.delete('/api/classes/:id/invite-code', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可操作' });
  db.invites = db.invites.filter((i) => !(i.kind === 'code' && i.classId === c.id));
  persist();
  res.json({ ok: true });
});

/* 协同账号输入邀请码加入班级(长期有效, 可多人使用; 班主任作废/重生成后失效) */
app.post('/api/invite-code/accept', auth, (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '请输入邀请码' });
  const inv = db.invites.find((i) => i.kind === 'code' && i.code === code && i.status === 'active');
  if (!inv) return res.status(404).json({ error: '邀请码无效或已失效，请核对后重试' });
  const c = db.classes.find((x) => x.id === inv.classId);
  if (!c) return res.status(404).json({ error: '班级不存在或已删除' });
  if (req.user.type !== 'co') return res.status(403).json({ error: '只有协同账号能通过邀请码加入班级' });
  if ((c.memberIds || []).includes(req.user.id)) {
    return res.json({ ok: true, already: true, className: c.name, ownerName: inv.ownerName });
  }
  c.memberIds.push(req.user.id);
  persist();
  res.json({ ok: true, already: false, className: c.name, ownerName: inv.ownerName });
});

app.delete('/api/classes/:id/invites/:inviteId', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  const i = db.invites.find((x) => x.id === req.params.inviteId);
  if (!c || !i || i.classId !== c.id) return res.status(404).json({ error: '记录不存在' });
  if (c.ownerId !== req.user.id) return res.status(403).json({ error: '仅班主任可操作' });
  db.invites = db.invites.filter((x) => x.id !== i.id);
  persist();
  res.json({ ok: true });
});

app.post('/api/invites/:id/accept', auth, (req, res) => {
  const i = db.invites.find((x) => x.id === req.params.id);
  if (!i) return res.status(404).json({ error: '邀请不存在' });
  if (i.toUserId !== req.user.id) return res.status(403).json({ error: '无权处理该邀请' });
  if (i.status !== 'pending') return res.status(400).json({ error: '该邀请已处理' });
  const c = db.classes.find((x) => x.id === i.classId);
  if (!c) return res.status(404).json({ error: '班级已被删除' });
  i.status = 'accepted'; i.handledAt = nowISO();
  if (!(c.memberIds || []).includes(req.user.id)) c.memberIds.push(req.user.id);
  persist();
  res.json({ ok: true });
});

app.post('/api/invites/:id/reject', auth, (req, res) => {
  const i = db.invites.find((x) => x.id === req.params.id);
  if (!i) return res.status(404).json({ error: '邀请不存在' });
  if (i.toUserId !== req.user.id) return res.status(403).json({ error: '无权处理该邀请' });
  if (i.status !== 'pending') return res.status(400).json({ error: '该邀请已处理' });
  i.status = 'rejected'; i.handledAt = nowISO();
  persist();
  res.json({ ok: true });
});

app.delete('/api/classes/:id/members/:userId', auth, (req, res) => {
  const c = db.classes.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  const self = req.params.userId === req.user.id;
  if (!self && c.ownerId !== req.user.id) return res.status(403).json({ error: '无权操作' });
  if (!(c.memberIds || []).includes(req.params.userId)) return res.status(404).json({ error: '该老师不在班级中' });
  c.memberIds = c.memberIds.filter((x) => x !== req.params.userId);
  persist();
  res.json({ ok: true });
});

/* ---------------- 定时喊话(任务调度) ---------------- */
/* 教室弹窗停留时长(秒):
   -1 = 不自动关闭(需手动关), 0 = 教室端按字数自动, >0 = 指定秒数(最长 4 小时) */
function clampDur(d) {
  const n = Math.floor(Number(d));
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return -1;
  return Math.min(n, 14400);
}
function nextDailyTime(time) {
  const [h, m] = String(time).split(':').map((x) => Number(x));
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setTime(d.getTime() + 86400000); // 今天的点已过 → 明天
  return d;
}
function jobJSON(j) {
  const d = new Date(j.runAt);
  const pad = (x) => String(x).padStart(2, '0');
  return {
    id: j.id, classId: j.classId, className: j.className,
    content: j.content, voice: j.voice !== false, color: j.color, duration: j.duration || 0,
    type: j.type, runAt: j.runAt, hm: pad(d.getHours()) + ':' + pad(d.getMinutes()),
    fromId: j.fromId, fromName: j.fromName, createdAt: j.createdAt,
  };
}
function classForReq(req, res, cid) {
  const c = db.classes.find((x) => x.id === cid);
  if (!c) { res.status(404).json({ error: '班级不存在' }); return null; }
  if (!canUseClass(req.user, c)) { res.status(403).json({ error: '无权操作该班级' }); return null; }
  return c;
}

app.get('/api/classes/:id/jobs', auth, (req, res) => {
  const c = classForReq(req, res, req.params.id);
  if (!c) return;
  const list = db.jobs.filter((j) => j.classId === c.id).sort((a, b) => (a.runAt < b.runAt ? -1 : 1));
  res.json({ jobs: list.map(jobJSON) });
});

app.post('/api/classes/:id/jobs', auth, (req, res) => {
  const c = classForReq(req, res, req.params.id);
  if (!c) return;
  const b = req.body || {};
  const content = String(b.content || '').trim();
  if (!content || content.length > 500) return res.status(400).json({ error: '喊话内容需为 1-500 字' });
  const type = b.type === 'daily' ? 'daily' : 'once';
  let runAtISO;
  if (type === 'once') {
    const t = Date.parse(b.runAt);
    if (!Number.isFinite(t)) return res.status(400).json({ error: '请选择正确的定时时间' });
    if (t <= Date.now()) return res.status(400).json({ error: '定时时间需晚于当前时间' });
    runAtISO = new Date(t).toISOString();
  } else {
    if (!/^\d{1,2}:\d{2}$/.test(String(b.time || ''))) return res.status(400).json({ error: '请选择每天的播报时间' });
    runAtISO = nextDailyTime(String(b.time)).toISOString();
  }
  let color = String(b.color || '');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = c.color;
  const job = {
    id: nextId('jb'), classId: c.id, className: c.name,
    content, voice: b.voice !== false, color, duration: clampDur(b.duration), type,
    runAt: runAtISO, fromId: req.user.id, fromName: req.user.username, createdAt: nowISO(),
  };
  db.jobs.push(job);
  persist();
  tickJobs(); // 若设置的时间已到(几乎不可能)立即补执行
  res.json({ job: jobJSON(job) });
});

function canManageJob(user, c, j) {
  return j.fromId === user.id || (c && c.ownerId === user.id);
}

app.delete('/api/classes/:id/jobs/:jobId', auth, (req, res) => {
  const c = classForReq(req, res, req.params.id);
  if (!c) return;
  const j = db.jobs.find((x) => x.id === req.params.jobId && x.classId === c.id);
  if (!j) return res.status(404).json({ error: '任务不存在或已执行' });
  if (!canManageJob(req.user, c, j)) return res.status(403).json({ error: '仅创建者可取消该任务' });
  db.jobs = db.jobs.filter((x) => x.id !== j.id);
  persist();
  res.json({ ok: true });
});

/* 立即喊一次(主要用于预览/补发每日任务;单次任务会执行并移除) */
app.post('/api/classes/:id/jobs/:jobId/run', auth, (req, res) => {
  const c = classForReq(req, res, req.params.id);
  if (!c) return;
  const j = db.jobs.find((x) => x.id === req.params.jobId && x.classId === c.id);
  if (!j) return res.status(404).json({ error: '任务不存在' });
  if (!canManageJob(req.user, c, j)) return res.status(403).json({ error: '仅创建者可操作该任务' });
  const r = executeJob(j);
  res.json({ ok: true, delivered: !!(r && r.delivered) });
});

function executeJob(job) {
  const cls = db.classes.find((x) => x.id === job.classId);
  if (!cls) {
    db.jobs = db.jobs.filter((x) => x.id !== job.id);
    persist();
    return null;
  }
  const record = {
    id: nextId('nt'), classId: cls.id, className: cls.name,
    content: job.content, voice: job.voice !== false, color: job.color || cls.color,
    fromId: job.fromId, fromName: job.fromName,
    delivered: isClassOnline(cls.id), duration: job.duration || 0,
    schedule: job.type, createdAt: nowISO(),
  };
  addNotifRecord(record);
  pushNotify(cls.id, {
    id: record.id, className: cls.name, content: record.content, voice: record.voice,
    color: record.color, fromName: record.fromName, sentAt: record.createdAt, duration: record.duration,
  });
  if (job.type === 'once') {
    db.jobs = db.jobs.filter((x) => x.id !== job.id);
  } else {
    let t = Date.parse(job.runAt) + 86400000;
    while (t <= Date.now()) t += 86400000; // 中间错过则只补最近一次, 不追发多天
    job.runAt = new Date(t).toISOString();
  }
  persist();
  return record;
}
function tickJobs() {
  const due = db.jobs.filter((j) => Date.parse(j.runAt) <= Date.now());
  if (!due.length) return;
  due.forEach((j) => { try { executeJob(j); } catch (e) { console.error('定时喊话执行失败:', e.message); } });
}

/* ---------------- Socket.IO ---------------- */
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  /* 教室端网页与老师端同源访问 */
});

function pushNotify(cid, payload) {
  io.to('class:' + cid).emit('notify', payload);
}

io.on('connection', (socket) => {
  socket.on('bind', (payload) => {
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const cls = db.classes.find((c) => c.bindCode.toUpperCase() === code);
    if (!cls) {
      socket.emit('bound', { ok: false, error: '绑定码无效，请核对后重试' });
      return;
    }
    if (socket.data.classId) {
      socket.leave('class:' + socket.data.classId);
      dropPresence(socket.data.classId, socket.id);
    }
    socket.data.classId = cls.id;
    socket.join('class:' + cls.id);
    addPresence(cls.id, socket.id);
    socket.emit('bound', { ok: true, className: cls.name, color: cls.color });
  });

  socket.on('disconnect', () => {
    if (socket.data.classId) {
      socket.leave('class:' + socket.data.classId);
      dropPresence(socket.data.classId, socket.id);
    }
  });
});

/* 启动时清理一次历史通知: 每个班级仅保留最近 10 条 */
(() => {
  let dirty = false;
  db.classes.forEach((c) => { if (trimNotifsOf(c.id)) dirty = true; });
  if (dirty) persist();
})();

httpServer.listen(PORT, () => {
  console.log('');
  console.log('  班级喊话系统 · 服务已启动');
  setInterval(tickJobs, 10000); // 定时喊话调度
  tickJobs();
  setInterval(cleanTrials, 3600 * 1000); // 过期体验账号清理
  cleanTrials();
  console.log(`  网页端(老师端): http://localhost:${PORT}/`);
  console.log(`  后台管理:       http://localhost:${PORT}/app`);
  console.log(`  教室端(教室电脑): http://localhost:${PORT}/room`);
  console.log('');
  console.log(`  演示账号: demo / demo123 · 演示绑定码 DEMO8YQZ`);
  console.log(TRIAL_ON
    ? `  一键体验:       http://localhost:${PORT}/try  (免注册, 24 小时后自动清理)`
    : '  一键体验:       已关闭 (TRIAL=off)');
  console.log(`  客服发卡接口口令(CARD_KEY): ${ADMIN_KEY}  (POST /api/cards/generate)`);
  const ms = mailStatus();
  console.log(ms.configured
    ? `  申请通知邮件: 已开启(${ms.via} → ${CARD_REQUEST_EMAIL})`
    : `  申请通知邮件: 未配置(可选, 见 .env.example; 配好后提交申请会自动邮件通知 ${CARD_REQUEST_EMAIL})`);
  if (db.cards.length) {
    const list = db.cards.filter((c) => !c.usedBy).slice(0, 8).map((c) => `${c.code}(${c.type === 'co' ? '协同' : '普通'})`);
    console.log(`  可用演示激活卡: ${list.join(', ')}`);
  }
  console.log('');
});
