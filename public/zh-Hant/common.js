/* 公共前端工具（繁體中文站） */
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    if (res.status === 401 && !/\/auth\//.test(url)) {
      location.href = '/zh-Hant/login';
      throw new Error('尚未登入');
    }
    throw new Error((data && data.error) || ('請求失敗(' + res.status + ')'));
  }
  return data;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

function toast(msg, type) {
  let box = document.getElementById('toastBox');
  if (!box) { box = document.createElement('div'); box.id = 'toastBox'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
}

async function copyText(t) {
  // 方式1: Clipboard API(需 https / localhost 安全環境)
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 繼續走相容方案 */ }
  // 方式2: 暫時 textarea + execCommand('copy'), 相容 http 及舊瀏覽器
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, t.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (e) { /* 下面回傳 false */ }
  return false;
}

/* ---------- Google Analytics (GA4) ---------- */
/* 全站造訪統計。即使 www.googletagmanager.com 被網路封鎖, 這裡也只是把事件排入佇列,
   不會阻擋頁面渲染; gtag.js 載入成功後才真正上報。 */
(function () {
  var GA_ID = 'G-ZNQCX7BSM0';
  var HOST = location.hostname;
  var isLocal = !HOST || HOST === 'localhost' || HOST === '127.0.0.1'
    || /^192\.168\./.test(HOST) || /^10\./.test(HOST) || /\.local$/i.test(HOST);
  /* 本地/內網預設不載入 GA4, 免得除錯流量污染統計;
     想在本地驗證埋點, 用 ?ga=1 開啟, 例如 http://localhost:3000/zh-Hant/?ga=1 */
  var on = !isLocal || /[?&]ga=1/.test(location.search);

  if (window.gtag) return;                                   // 已注入過就不重複
  window.dataLayer = window.dataLayer || [];
  window.gtag = on ? function () { window.dataLayer.push(arguments); } : function () {};

  if (!on) return;

  window.gtag('js', new Date());
  window.gtag('config', GA_ID);
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);
})();

/* ---------- 按鈕點擊埋點 ---------- */
/* 事件委派: 元素上寫 data-ga="事件名"(可選 data-ga-pos="位置") 就會被上報,
   不用替每個按鈕掛 onclick。附帶 lang / page_path, 方便依語言站與頁面拆開看。 */
(function () {
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-ga]') : null;
    if (!el) return;
    var params = {
      position: el.getAttribute('data-ga-pos') || 'unknown',
      lang: document.documentElement.lang || 'zh-Hant',
      page_path: location.pathname
    };
    var ctx = window.GA_CTX;   // 頁面注入的上下文(如體驗帳號標誌), 有就一併上報
    if (ctx) for (var k in ctx) {
      if (Object.prototype.hasOwnProperty.call(ctx, k)) params[k] = ctx[k];
    }
    window.gtag('event', el.getAttribute('data-ga'), params);
  }, true);
})();

/* 頁面自己觸發的埋點入口(如表單送出成功) */
function gaEvent(name, params) {
  try { window.gtag('event', name, params || {}); } catch (e) { /* 忽略 */ }
}
