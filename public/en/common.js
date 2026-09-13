/* Shared front-end helpers (English site) */
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
      location.href = '/en/login';
      throw new Error('Not signed in');
    }
    throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
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
    return new Date(iso).toLocaleString('en-US', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  // 1) Clipboard API (needs a secure context: https / localhost)
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* fall through */ }
  // 2) Temporary textarea + execCommand('copy') for http / old browsers
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
  } catch (e) { /* returns false below */ }
  return false;
}

/* ---------- Google Analytics (GA4) ---------- */
/* Site-wide traffic stats. If www.googletagmanager.com is blocked on the network,
   events are merely queued here and never block rendering; reporting starts only
   once gtag.js loads. */
(function () {
  var GA_ID = 'G-ZNQCX7BSM0';
  var HOST = location.hostname;
  var isLocal = !HOST || HOST === 'localhost' || HOST === '127.0.0.1'
    || /^192\.168\./.test(HOST) || /^10\./.test(HOST) || /\.local$/i.test(HOST);
  /* GA4 is not loaded on localhost / LAN by default so debug traffic cannot pollute
     the stats. To verify tracking locally, open the page with ?ga=1,
     e.g. http://localhost:3000/en/?ga=1 */
  var on = !isLocal || /[?&]ga=1/.test(location.search);

  if (window.gtag) return;                                   // already injected
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

/* ---------- Button click tracking ---------- */
/* Event delegation: any element carrying data-ga="event_name" (plus an optional
   data-ga-pos="position") is reported on click — no onclick needed per button.
   lang / page_path ride along so you can break results down per site and page. */
(function () {
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-ga]') : null;
    if (!el) return;
    var params = {
      position: el.getAttribute('data-ga-pos') || 'unknown',
      lang: document.documentElement.lang || 'en',
      page_path: location.pathname
    };
    var ctx = window.GA_CTX;   // context injected by the page (e.g. the trial flag); merged in when present
    if (ctx) for (var k in ctx) {
      if (Object.prototype.hasOwnProperty.call(ctx, k)) params[k] = ctx[k];
    }
    window.gtag('event', el.getAttribute('data-ga'), params);
  }, true);
})();

/* Entry point for events the page fires itself (e.g. a successful form submit) */
function gaEvent(name, params) {
  try { window.gtag('event', name, params || {}); } catch (e) { /* ignore */ }
}
