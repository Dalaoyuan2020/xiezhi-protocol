import nodemailer from 'nodemailer';

export function smtpConfigured(values = {}) {
  const port = Number(values.SMTP_PORT);
  return Boolean(typeof values.SMTP_HOST === 'string' && values.SMTP_HOST.trim() && !/[\s\x00-\x1f\x7f]/.test(values.SMTP_HOST)
    && Number.isInteger(port) && port >= 1 && port <= 65535
    && typeof values.SMTP_FROM === 'string' && values.SMTP_FROM.trim() && !/[\r\n]/.test(values.SMTP_FROM)
    && values.SMTP_USER && values.SMTP_PASS && ['true', 'false'].includes(values.SMTP_SECURE || 'false'));
}

/** Only called following an explicit send-code request. Never logs SMTP credentials or messages. */
export async function sendClaimCode({ credentials, email, code }) {
  const values = credentials();
  if (!smtpConfigured(values)) throw new Error('SMTP_NOT_CONFIGURED');
  const port = Number(values.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['true', 'false'].includes(values.SMTP_SECURE || 'false')) throw new Error('SMTP_INVALID');
  const transport = nodemailer.createTransport({
    host: values.SMTP_HOST, port, secure: values.SMTP_SECURE === 'true', requireTLS: values.SMTP_SECURE !== 'true',
    auth: { user: values.SMTP_USER, pass: values.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  try {
    const delivered = await transport.sendMail({ from: values.SMTP_FROM, to: email,
      subject: '学术体检 · 认领材料邮箱验证码',
      text: `你的邮箱验证码是：${code}\n10 分钟内有效。仅用于验证此邮箱的控制权，不代表平台确认论文作者身份。\n如果不是你发起的操作，请忽略本邮件。`,
    });
    if (!delivered.accepted?.length || delivered.rejected?.length) throw new Error('SMTP_RECIPIENT_NOT_ACCEPTED');
  } finally { transport.close(); }
}
