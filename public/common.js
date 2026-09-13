/* 公共前端工具 */
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
      location.href = '/login';
      throw new Error('未登录');
    }
    throw new Error((data && data.error) || ('请求失败(' + res.status + ')'));
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
    return new Date(iso).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  // 方式1: Clipboard API(需 https / localhost 安全上下文)
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 继续走兼容方案 */ }
  // 方式2: 临时 textarea + execCommand('copy'), 兼容 http 及旧浏览器
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
  } catch (e) { /* 下面返回 false */ }
  return false;
}

/* ---------- Google Analytics (GA4) ---------- */
/* 全站访问统计。即使 www.googletagmanager.com 被网络屏蔽, 这里也只是把事件入队,
   不会阻塞页面渲染; gtag.js 加载成功后才真正上报。 */
(function () {
  var GA_ID = 'G-ZNQCX7BSM0';
  var HOST = location.hostname;
  var isLocal = !HOST || HOST === 'localhost' || HOST === '127.0.0.1'
    || /^192\.168\./.test(HOST) || /^10\./.test(HOST) || /\.local$/i.test(HOST);
  /* 本地/内网默认不加载 GA4, 免得调试流量污染统计;
     想在本地验证埋点, 用 ?ga=1 打开, 例如 http://localhost:3000/?ga=1 */
  var on = !isLocal || /[?&]ga=1/.test(location.search);

  if (window.gtag) return;                                   // 已注入过就不重复
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

/* ---------- 按钮点击埋点 ---------- */
/* 事件委托: 元素上写 data-ga="事件名"(可选 data-ga-pos="位置") 就会被上报,
   不用给每个按钮挂 onclick。附带 lang / page_path, 方便按语言站和页面拆开看。 */
(function () {
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-ga]') : null;
    if (!el) return;
    var params = {
      position: el.getAttribute('data-ga-pos') || 'unknown',
      lang: document.documentElement.lang || 'zh-CN',
      page_path: location.pathname
    };
    var ctx = window.GA_CTX;   // 页面注入的上下文(如体验账号标志), 有就一并上报
    if (ctx) for (var k in ctx) {
      if (Object.prototype.hasOwnProperty.call(ctx, k)) params[k] = ctx[k];
    }
    window.gtag('event', el.getAttribute('data-ga'), params);
  }, true);
})();

/* 页面自己触发的埋点入口(如表单提交成功) */
function gaEvent(name, params) {
  try { window.gtag('event', name, params || {}); } catch (e) { /* 忽略 */ }
}
