/**
 * 邮件发送(零依赖, 只走 EmailJS)。
 * 老师提交「申请激活卡号」后, 服务端会给站长邮箱发一封通知邮件。
 *
 * EmailJS 把「邮件长什么样」放在它自己的后台模板里, 这里只负责把变量喂过去:
 *   {{to_email}} {{subject}} {{from_name}} {{reply_to}} {{text}} {{{html_content}}}
 * 没配置时只打印日志, 不影响申请流程。
 *
 * 配置见项目根目录 .env.example;
 * 服务器上可用: bash deploy.sh mail emailjs 服务ID 模板ID 公钥 [私钥]
 */
const TIMEOUT = Number(process.env.MAIL_TIMEOUT || 15000);
const EMAILJS_API = 'https://api.emailjs.com/api/v1.0/email/send';

function config() {
  return {
    serviceId: (process.env.EMAILJS_SERVICE_ID || '').trim(),
    templateId: (process.env.EMAILJS_TEMPLATE_ID || '').trim(),
    publicKey: (process.env.EMAILJS_PUBLIC_KEY || '').trim(),
    // 在 EmailJS 后台开启 Strict Mode(推荐)时才需要私钥
    privateKey: (process.env.EMAILJS_PRIVATE_KEY || '').trim(),
    fromName: (process.env.MAIL_FROM_NAME || '班级喊话系统').trim(),
    to: (process.env.MAIL_TO || process.env.CARD_EMAIL || '').trim(),
  };
}

/* ---------------- 对外接口 ---------------- */

async function httpSend(payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(EMAILJS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const raw = await res.text();
    // 成功是 200 "OK"; 失败是 400 + 一句英文原因(如 The Public Key is invalid.)
    if (!res.ok) throw new Error('EmailJS HTTP ' + res.status + ' ' + raw.slice(0, 200));
    return raw;
  } finally { clearTimeout(timer); }
}

/**
 * 发送一封邮件。
 * @returns {Promise<{ok:boolean, via?:string, error?:string}>} 失败不抛异常
 */
async function sendMail(mail) {
  const c = config();
  const to = (mail.to || c.to || '').trim();
  if (!to) return { ok: false, error: '未配置收件邮箱(MAIL_TO)' };
  if (!c.serviceId || !c.templateId || !c.publicKey) {
    return { ok: false, via: 'emailjs', error: '未配置 EmailJS(EMAILJS_SERVICE_ID / EMAILJS_TEMPLATE_ID / EMAILJS_PUBLIC_KEY)' };
  }

  const msg = { to, subject: mail.subject || '(无主题)', text: mail.text || '', html: mail.html || '', replyTo: mail.replyTo };

  /* template_params 的键名要和 EmailJS 后台模板里的占位符一一对应:
     To Email={{to_email}} Subject={{subject}} From Name={{from_name}} Reply To={{reply_to}}
     正文用 {{text}}(纯文本) 或 {{{html_content}}}(三花括号 = 原样输出 HTML) */
  try {
    await httpSend({
      service_id: c.serviceId,
      template_id: c.templateId,
      user_id: c.publicKey,                                   // Public Key
      ...(c.privateKey ? { accessToken: c.privateKey } : {}), // Private Key(Strict Mode)
      template_params: {
        to_email: to,
        subject: msg.subject,
        text: msg.text,
        html_content: msg.html,
        from_name: c.fromName,
        reply_to: msg.replyTo || '',
      },
    });
    return { ok: true, via: 'emailjs' };
  } catch (e) {
    return { ok: false, via: 'emailjs', error: e.message };
  }
}

/** 当前邮件配置状态(用于启动日志 / 自检) */
function mailStatus() {
  const c = config();
  if (c.serviceId && c.templateId && c.publicKey) {
    return { configured: true, via: 'emailjs', to: c.to, template: c.templateId };
  }
  return { configured: false, via: 'none', to: c.to };
}

module.exports = { sendMail, mailStatus };
