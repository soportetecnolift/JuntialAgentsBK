import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, pool: true, maxConnections: 5 })
  : null;

export async function sendMail({ to, subject, html, text }) {
  if (!transport) { logger.warn({ to, subject }, '[mail] SMTP no configurado — email no enviado (dev)'); return; }
  await transport.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
}

export const layout = (title, body, cta) => `<!doctype html><html><body style="margin:0;background:#eef1f4;font-family:Manrope,Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#16324f;color:#fff;padding:18px 28px;font-weight:700;font-size:18px">JuntialAgents</td></tr>
<tr><td style="padding:28px;color:#1d2733;font-size:15px;line-height:1.6"><h2 style="margin:0 0 12px;font-size:20px">${title}</h2>${body}
${cta ? `<p style="margin:24px 0 0"><a href="${cta.url}" style="background:#0e7c86;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600">${cta.label}</a></p>` : ''}
</td></tr><tr><td style="padding:16px 28px;color:#7a8794;font-size:12px;border-top:1px solid #e5e9ee">Recibes este correo por tu cuenta en JuntialAgents. Puedes gestionar tus avisos desde Ajustes.</td></tr>
</table></td></tr></table></body></html>`;
