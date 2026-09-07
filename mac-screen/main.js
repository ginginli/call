/**
 * 班级喊话 · Mac 教室演示屏(主进程)
 *  - 启动即全屏加载教室端页面(room.html)
 *  - 若本机服务(3000)未运行, 自动用 node 拉起 server/index.js
 *  - 支持 ROOM_URL 环境变量指向局域网/云端服务地址
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

app.disableHardwareAcceleration(); // 演示屏稳定性优先, 避免部分 Mac 显卡驱动花屏

const SERVER_URL = 'http://127.0.0.1:3000';
const ROOM_URL = process.env.ROOM_URL || SERVER_URL + '/room';
const SERVER_PORT = 3000;
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const SERVER_CWD = path.join(__dirname, '..');
const MAX_WAIT_SERVER = 15000; // 自动拉起服务后最多等待毫秒

let win = null;
let startingServer = false;

/* ---------------- 工具 ---------------- */
function httpGetJson(url, timeout) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeout || 1000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        res.statusCode < 400 ? resolve({ ok: true }) : resolve({ ok: false });
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

function isServerUp() {
  return httpGetJson(SERVER_URL + '/api/health', 800).then((r) => r.ok);
}

function startServer() {
  return new Promise((resolve) => {
    if (startingServer) return; // 已在拉起中
    startingServer = true;
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: 'ignore',
      detached: false,
    });
    child.on('error', () => resolve({ ok: false, reason: '启动服务进程失败' }));
    child.on('exit', () => { startingServer = false; });
    // 轮询等待服务就绪
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (await isServerUp()) {
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
  win.loadURL(ROOM_URL);
}

function loadErrorPage(reason) {
  if (!win) return;
  win.loadFile(path.join(__dirname, 'error.html'), { query: { reason: encodeURIComponent(reason || '') } });
}

async function boot() {
  if (await isServerUp()) { loadRoom(); return; }
  const r = await startServer();
  if (r.ok) loadRoom();
  else loadErrorPage(r.reason || '服务不可用');
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
  win.on('closed', () => { win = null; });
}

/* ---------------- IPC ---------------- */
ipcMain.on('quit', () => app.quit());
ipcMain.on('retry', () => { if (win) boot(); });
ipcMain.on('reload', () => { if (win) win.reload(); });

/* ---------------- 生命周期 ---------------- */
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
}
