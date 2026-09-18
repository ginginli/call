/**
 * 班级喊话 · 跨平台教室演示屏(Electron 桌面端,支持 macOS / Windows)
 *  - 启动即全屏加载教室端大屏页面(room.html)
 *  - 服务地址优先级: 命令行 --server <url> / 环境变量 CALL_SERVER > 已保存配置 > 内置云端地址 https://callclass.site
 *  - 开发模式指向本机服务时, 若服务未启动会自动用 node 拉起 server/index.js
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, powerSaveBlocker, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

app.disableHardwareAcceleration(); // 演示屏稳定性优先, 避免部分显卡花屏
// 阻止 OS 进入 Modern Standby / 挂起, 保持 socket 长连接不被打断(配合后端 standbyClasses)
try { powerSaveBlocker.start('prevent-app-suspension'); } catch (e) { /* 旧版本 Electron 无此 API, 忽略 */ }

const DEFAULT_SERVER = 'https://callclass.site'; // 内置云端默认服务地址: 强制 HTTPS(443), 校园网常封 HTTP 80 端口导致连不上
const SERVER_PORT = 3000;
// 以下仅开发模式用于"自动拉起本机服务";打包后的独立 exe/app 不包含 node, 需连接已运行的服务
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const SERVER_CWD = path.join(__dirname, '..');
const MAX_WAIT_SERVER = 15000;

let win = null;
let tray = null;
let isQuitting = false;
let startingServer = false;
let serverUrl = DEFAULT_SERVER;
/* 待命形态 = 收成右下角小窗(方案B): 让出屏幕但始终可见, 不再"最小化后找不到大屏" */
let isMini = false;
const MINI_W = 320, MINI_H = 180, MINI_MARGIN = 16;

/* ---------------- 服务地址 ---------------- */
function normalizeServer(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/room$/i, '').replace(/\/$/,'');
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

// 是否允许保留的服务地址(默认站点/内网): 其余一律重置成默认, 老师无需手动删 settings.json
function isLocalishServer(u) {
  if (!u) return false;
  const s = u.toLowerCase();
  if (s === 'https://callclass.site') return true;       // 默认站点: 永远保留
  if (/\.local(\/|:|$)/.test(s) || /\.lan(\/|:|$)/.test(s)) return true; // 内网域名
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(s)) return true; // 本机
  if (/^https?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?(\/|$)/.test(s)) return true; // 内网 IP
  return false;
}

function configPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) { /* 忽略写入失败 */ }
}

function initialServerUrl() {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].indexOf('--server=') === 0) {
      const s = normalizeServer(argv[i].split('=')[1]);
      if (s) return s;
    }
    if (argv[i] === '--server' && argv[i + 1]) {
      const s = normalizeServer(argv[i + 1]);
      if (s) return s;
    }
  }
  const envVal = process.env.CALL_SERVER || String(process.env.ROOM_URL || '').replace(/\/room$/i, '');
  const fromEnv = normalizeServer(envVal);
  if (fromEnv) return fromEnv;
  const saved = normalizeServer(loadConfig().server);
  if (saved) {
    // 默认站点 / 局域网地址: 保留, 不动
    if (isLocalishServer(saved)) return saved;
    // 迁移: 老版本存的是 http://callclass.site, 校园网封 80 会连不上, 自动升级为 https
    if (saved.toLowerCase() === 'http://callclass.site') {
      serverUrl = 'https://callclass.site';
      saveConfig({ server: serverUrl });
      return serverUrl;
    }
    // 其他(外网/杂乱/测试地址): 一律重置成默认, 老师无需手动删 settings.json
    console.warn('[config] 忽略非允许地址:', saved, '→ 重置为', DEFAULT_SERVER);
    saveConfig({ server: DEFAULT_SERVER });
    serverUrl = DEFAULT_SERVER;
    return serverUrl;
  }
  return DEFAULT_SERVER;
}

/* ---------------- 工具 ---------------- */
function httpGetJson(url, timeout) {
  return new Promise((resolve) => {
    const lib = /^https:/i.test(url) ? https : http;
    const req = lib.get(url, { timeout: timeout || 1000 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 400 }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

function isServerUp(base) {
  // 3 秒超时: 教室机器冷启动后首次 DNS 解析/建连可能很慢, 900ms 容易误判失败
  return httpGetJson(base + '/api/health', 3000).then((r) => r.ok);
}

function isLocalUrl(base) {
  return /localhost|127\.0\.0\.1|\[::1\]/.test(base);
}

/* 开发模式自动拉起本机服务 */
function startServer() {
  return new Promise((resolve) => {
    if (startingServer) return;
    startingServer = true;
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: 'ignore',
    });
    child.on('error', () => resolve({ ok: false, reason: '启动服务进程失败' }));
    child.on('exit', () => { startingServer = false; });
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (await isServerUp(serverUrl)) {
        clearInterval(timer);
        resolve({ ok: true });
      } else if (Date.now() - t0 > MAX_WAIT_SERVER) {
        clearInterval(timer);
        resolve({ ok: false, reason: '等待服务启动超时' });
      }
    }, 400);
  });
}

/* ---------------- 窗口 ---------------- */
function loadRoom() {
  if (!win) return;
  win.loadURL(normalizeServer(serverUrl) + '/room');
}

function loadErrorPage(reason) {
  if (!win) return;
  win.loadFile(path.join(__dirname, 'error.html'), { query: { reason: encodeURIComponent(reason || '') } });
}

async function boot() {
  // 先试一次, 失败再重试一次(防教室网络冷启动抖动), 两次都失败才报错
  if (await isServerUp(serverUrl)) { loadRoom(); return; }
  await new Promise((r) => setTimeout(r, 800));
  if (await isServerUp(serverUrl)) { loadRoom(); return; }
  const isDevLocal = !app.isPackaged && isLocalUrl(serverUrl) && fs.existsSync(SERVER_ENTRY);
  if (isDevLocal) {
    const r = await startServer();
    if (r.ok) { loadRoom(); return; }
    loadErrorPage(r.reason || '服务不可用');
  } else {
    loadErrorPage('无法连接服务 ' + serverUrl + '\n请检查教室网络是否能上网, 或在下方填写正确的服务地址。');
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    title: '班级喊话 · 教室演示屏',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'error.html')); // 先占位, boot 成功后跳教室端
  // 关闭 Chromium 后台节流: 教室端窗口最小化时, 渲染进程仍按正常速率运行
  // (setInterval/visibilitychange/fetch 都不被压到 1 分钟/次). 否则教室端最小化后会被服务端误判离线.
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('did-finish-load', () => {
    console.log('[boot] loaded:', win.webContents.getURL());
  });
  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.log('[boot] load-fail:', code, desc);
  });
  win.webContents.on('render-process-gone', (e, det) => {
    console.log('[boot] render-gone:', det && det.reason);
  });
  boot();
  // 关闭按钮 = 收到任务栏(托盘常驻), 真正退出走托盘菜单的"退出"
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      notifyHidden();
    }
  });
  // 从任务栏点回来(或任何方式 restore)后自动回到全屏, 保持教室屏形态
  win.on('restore', () => {
    if (win && !win.isDestroyed()) { try { win.setFullScreen(true); } catch (e) { /* 忽略 */ } }
  });
  // 任何方式回到全屏(托盘/快捷键/双击 exe)后, 退出小窗形态
  win.on('enter-full-screen', () => { isMini = false; });
  win.on('closed', () => { win = null; });
  createTray();
}

/* ---------------- 系统托盘 ---------------- */
/* 演示屏藏到任务栏后, 用户能从托盘恢复窗口; 托盘菜单提供"显示/退出"两个入口 */
/* 纯代码绘制 32x32 托盘图标(靛蓝圆底 + 广播波纹):
   不依赖外部图片资源, 避免图标文件缺失导致托盘空白、用户找不到大屏 */
function buildTrayIcon() {
  try {
    const S = 32;
    const buf = Buffer.alloc(S * S * 4); // BGRA
    const put = (x, y, b, g, r) => {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      const i = (y * S + x) * 4;
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;
    };
    const c = 15.5, R = 15;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x - c, dy = y - c;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= R) put(x, y, 241, 102, 99);                 // #6366F1 靛蓝圆底
        if (d <= 10 && d >= 8) put(x, y, 255, 255, 255);     // 外圈波纹
        if (d <= 3.5) put(x, y, 255, 255, 255);              // 中心点
      }
    }
    return nativeImage.createFromBuffer(buf, { width: S, height: S, scaleFactor: 1 });
  } catch (e) {
    return nativeImage.createEmpty();
  }
}
function createTray() {
  if (tray) return;
  try {
    // 图标优先级: 外部图标文件(便于后续替换成美术图) > 代码内置图标(保证托盘永远有可见图形)
    const candidates = [
      path.join(__dirname, 'build', 'tray.png'),                     // 打包后: resources/app.asar/build/tray.png
      path.join(__dirname, '..', 'mac-screen', 'build', 'tray.png'), // 开发态
    ];
    let img = nativeImage.createEmpty();
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          const t = nativeImage.createFromPath(p);
          if (!t.isEmpty()) { img = t; break; }
        }
      } catch (e) { /* 尝试下一个候选 */ }
    }
    if (img.isEmpty()) img = buildTrayIcon();
    if (img.isEmpty()) {
      try { img = win ? win.getIcon() : nativeImage.createEmpty(); } catch (e) {}
    }
    tray = new Tray(img);
    tray.setToolTip('班级喊话 · 教室演示屏');
    const menu = Menu.buildFromTemplate([
      { label: '📢 显示演示屏', click: () => showFromTray() },
      { label: '⏻ 退出', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    // 单击托盘图标 = 切回窗口; 最小化状态 isVisible() 仍为 true, 必须单独判断, 否则点托盘反而会藏起来
    tray.on('click', () => {
      if (!win || win.isDestroyed()) return;
      // 小窗待命 / 最小化 / 已收进托盘 → 一律恢复全屏; 已是全屏 → 收进托盘
      if (isMini || win.isMinimized() || !win.isVisible()) showFromTray();
      else win.hide();
    });
  } catch (e) {
    console.log('[tray] init failed:', e && e.message);
  }
}
function showFromTray() {
  if (!win || win.isDestroyed()) return;
  isMini = false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setFullScreen(true);
  win.focus();
}

/* ---------------- IPC ---------------- */
ipcMain.on('quit', () => app.quit());
/* 点"关闭"藏进托盘后给出提示: 托盘图标小且可能被折叠进 ^ , 用户常因此"找不到大屏" */
function notifyHidden() {
  if (process.platform !== 'win32' || !tray) return;
  try {
    tray.displayBalloon({
      title: '已收起到托盘, 仍在后台接收通知',
      content: '双击桌面「班级喊话演示屏」图标, 或点击右下角托盘图标, 即可重新打开大屏。',
    });
  } catch (e) { /* 部分系统不支持气泡通知, 忽略 */ }
}
/* 退全屏是异步的: 必须等窗口真正离开全屏后再改尺寸, 否则 setBounds 会被驱动还原 */
function afterLeaveFullScreen(fn) {
  if (!win || win.isDestroyed()) return;
  let done = false;
  const run = () => { if (done) return; done = true; setTimeout(fn, 120); };
  if (!win.isFullScreen()) { run(); return; }
  win.once('leave-full-screen', run);
  try { win.setFullScreen(false); } catch (e) { run(); }
  setTimeout(run, 900); // 兜底: 个别环境不触发 leave-full-screen
}
/* 待命形态: 缩成右下角小窗(方案B).
   历史教训: ① hide() → 任务栏和 Alt+Tab 都没有, 老师找不到;
             ② win.minimize() → 全屏跑在投影屏时, 任务栏在笔记本屏幕上, 老师同样找不到.
   小窗贴在自己那块屏的右下角, 始终可见可点, 收到通知再由 showFromTray() 弹回全屏.
   保活: 窗口并未最小化, 页面 visibilitychange 不触发; 由前端心跳(2 分钟) + 后端 standby TTL(30 分钟) 兜底. */
function enterMini() {
  if (!win || win.isDestroyed()) return;
  afterLeaveFullScreen(() => {
    if (!win || win.isDestroyed()) return;
    try {
      // workArea 已排除任务栏/程序坞; 多屏时跟随窗口原来所在的那块屏
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setBounds({
        width: MINI_W,
        height: MINI_H,
        x: Math.round(wa.x + wa.width - MINI_W - MINI_MARGIN),
        y: Math.round(wa.y + wa.height - MINI_H - MINI_MARGIN),
      });
    } catch (e) { /* 至少已退出全屏, 窗口仍然可见 */ }
    try { win.show(); win.focus(); } catch (e) { /* 忽略 */ }
    isMini = true;
  });
}
ipcMain.on('window-minimize', () => enterMini());
ipcMain.on('window-pulse', () => {
  if (!win || win.isDestroyed()) return;
  // 收到通知一律弹回全屏: 小窗待命 / 最小化 / 收进托盘 都要能弹出来
  if (win.isMinimized()) {
    win.restore();                // 先取消最小化
    setTimeout(showFromTray, 350); // 等窗口回到屏幕再进全屏
  } else {
    showFromTray();
  }
});
ipcMain.handle('get-auto-launch', () => {
  try { return { ok: true, value: app.getLoginItemSettings().openAtLogin }; }
  catch (e) { return { ok: false, error: '无法读取开机自启设置' }; }
});
ipcMain.handle('set-auto-launch', (e, enable) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enable });
    return { ok: true, value: app.getLoginItemSettings().openAtLogin };
  } catch (err) { return { ok: false, error: '设置失败:' + ((err && err.message) || err) }; }
});
ipcMain.on('retry', () => { if (win) boot(); });
ipcMain.on('reload', () => { if (win) win.reload(); });
ipcMain.handle('get-server', () => serverUrl);

/* ---------------- 生命周期 ---------------- */
serverUrl = initialServerUrl();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次双击 exe 时唤起已有窗口.
    // 关键: 用户点过"关闭/最小化"后窗口处于 hide() 状态, 此时 isMinimized() 返回 false,
    // 旧代码只做 restore()+focus() 对隐藏窗口无效 → 用户看到"双击毫无反应", 却仍在后台收通知.
    // 统一走 showFromTray(): 它已包含 restore + show + 全屏 + focus.
    if (!win || win.isDestroyed()) { createWindow(); return; }
    showFromTray();
  });
  app.whenReady().then(() => {
    createWindow();
    // 兜底出口: 窗口被收进托盘、而用户又找不到托盘图标时, 用 Ctrl/Cmd+Shift+9 把大屏喊回来
    try {
      globalShortcut.register('CommandOrControl+Shift+9', () => showFromTray());
    } catch (e) { console.log('[shortcut] register failed:', e && e.message); }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* 忽略 */ } });
// 用户从托盘"退出"或 Cmd+Q 时, 允许真正退出进程
app.on('before-quit', () => { isQuitting = true; });
}
