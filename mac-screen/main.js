/**
 * 班级喊话 · 跨平台教室演示屏(Electron 桌面端,支持 macOS / Windows)
 *  - 启动即全屏加载教室端大屏页面(room.html)
 *  - 服务地址优先级: 命令行 --server <url> / 环境变量 CALL_SERVER > 已保存配置 > 内置云端地址 https://callclass.site
 *  - 开发模式指向本机服务时, 若服务未启动会自动用 node 拉起 server/index.js
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, powerSaveBlocker } = require('electron');
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

/* ---------------- 服务地址 ---------------- */
function normalizeServer(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/room$/i, '').replace(/\/$/,'');
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
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
    // 迁移: 老版本存的是 http://callclass.site, 校园网封 80 会连不上, 自动升级为 https
    if (saved.toLowerCase() === 'http://callclass.site') {
      serverUrl = 'https://callclass.site';
      saveConfig({ server: serverUrl });
      return serverUrl;
    }
    return saved;
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
    }
  });
  win.on('closed', () => { win = null; });
  createTray();
}

/* ---------------- 系统托盘 ---------------- */
/* 演示屏藏到任务栏后, 用户能从托盘恢复窗口; 托盘菜单提供"显示/退出"两个入口 */
function createTray() {
  if (tray) return;
  try {
    // 优先用打包资源的 tray 图标; 找不到就用空图(避免 macOS 报错)
    const iconPath = path.join(__dirname, '..', 'mac-screen', 'build', 'tray.png');
    let img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    if (img.isEmpty()) {
      // 退化: 用窗口图标
      try { img = win ? win.getIcon() : nativeImage.createEmpty(); } catch (e) {}
    }
    tray = new Tray(img);
    tray.setToolTip('班级喊话 · 教室演示屏');
    const menu = Menu.buildFromTemplate([
      { label: '📢 显示演示屏', click: () => showFromTray() },
      { label: '⏻ 退出', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    // 单击托盘图标 = 切回窗口
    tray.on('click', () => {
      if (!win || win.isDestroyed()) return;
      win.isVisible() ? win.hide() : showFromTray();
    });
  } catch (e) {
    console.log('[tray] init failed:', e && e.message);
  }
}
function showFromTray() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setFullScreen(true);
  win.focus();
}

/* ---------------- IPC ---------------- */
ipcMain.on('quit', () => app.quit());
ipcMain.on('window-minimize', () => {
  if (!win || win.isDestroyed()) return;
  // 改用 hide() 替代 minimize(): 渲染进程不会被 Windows 节流/挂起, socket 长连接保持
  // (配合 server 的 standbyClasses, 即使 socket 后续断开, 教室端仍判在线)
  const doHide = () => { if (win && !win.isDestroyed()) win.hide(); };
  if (win.isFullScreen()) {
    let fired = false;
    const handler = () => {
      if (fired) return;
      fired = true;
      win.removeListener('leave-full-screen', handler);
      setTimeout(doHide, 120);
    };
    win.once('leave-full-screen', handler);
    win.setFullScreen(false);
    setTimeout(handler, 900);
  } else {
    doHide();
  }
});
ipcMain.on('window-pulse', () => {
  if (!win || win.isDestroyed()) return;
  const raise = () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.setFullScreen(true);
      win.focus();
    }
  };
  if (win.isMinimized()) {
    win.restore();      // 先取消最小化
    setTimeout(raise, 350); // 等窗口回到屏幕再进全屏
  } else {
    raise();
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
ipcMain.handle('save-server', (e, raw) => {
  const s = normalizeServer(raw);
  if (!s) return { ok: false, error: '地址需以 http:// 或 https:// 开头, 例如 http://192.168.1.5:3000' };
  serverUrl = s;
  saveConfig({ server: s });
  return { ok: true, server: s };
});

/* ---------------- 生命周期 ---------------- */
serverUrl = initialServerUrl();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
// 用户从托盘"退出"或 Cmd+Q 时, 允许真正退出进程
app.on('before-quit', () => { isQuitting = true; });
}
