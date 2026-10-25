import express, { Router } from 'express';
import { Bot, WorkerApproval, Tenant } from '../../models/index.js';
import { layout, sendMail } from '../../lib/mailer.js';
import { notify } from '../notifications/service.js';
import { Q } from '../../lib/queues.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { decrypt, hmac, sha256, randomToken } from '../../lib/crypto.js';
import { getBotRuntime } from '../../telegram/runtime.js';
import { safeUrl } from '../crm/net.js';

/**
 * Canales del empleado digital. Un mismo aviso o aprobación llega a TODOS los canales activos
 * (panel, email, Telegram opcional, webhook) y se puede decidir desde cualquiera; la decisión se refleja en los demás.
 * Los enlaces de email/webhook usan un token de un solo uso ligado a la aprobación (se guarda su hash) y abren una
 * página de confirmación: los antivirus de correo que "abren" enlaces no pueden aprobar nada por accidente.
 */
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const newDecisionToken = () => { const raw = `apr_${randomToken(24)}`; return { raw, hash: sha256(raw) }; };
export const decisionLinks = (raw) => { const page = `${env.PUBLIC_API_URL}/a/${raw}`; return { page, approve: `${page}?d=approve`, reject: `${page}?d=reject`, decide: page }; };
const wants = (cfg, ev) => cfg?.enabled && (cfg.events || []).includes(ev);

/* Cada canal devuelve { channel, ok, info | error }. direct=true envía en el momento (pruebas), sin pasar por la cola. */
async function panelSend(bot, { title, body, link }) {
  if (bot.worker?.reporting?.notifyPanel === false) return { channel: 'panel', ok: true, info: 'Visible en el panel (aviso en la campana desactivado)' };
  try {
    const t = await Tenant.findById(bot.tenantId).lean();
    await notify(t.ownerId, 'crm.workflow', { title: String(title).slice(0, 140), body: String(body || '').slice(0, 500), link });
    return { channel: 'panel', ok: true, info: 'Aviso en la campana' };
  } catch (e) { return { channel: 'panel', ok: false, error: e.message }; }
}
async function telegramSend(bot, html, markup) {
  const rep = bot.worker?.reporting;
  if (!rep?.telegramBotId || !rep?.chatId) return { channel: 'telegram', ok: false, skipped: true, error: 'No configurado' };
  const rt = await getBotRuntime(rep.telegramBotId).catch(() => null);
  if (!rt?.api) return { channel: 'telegram', ok: false, error: 'El bot de Telegram no está conectado' };
  if (String(rt.bot.tenantId) !== String(bot.tenantId)) return { channel: 'telegram', ok: false, error: 'El bot no pertenece a tu cuenta' };
  try {
    const m = await rt.api.call('sendMessage', { chat_id: rep.chatId, text: html.slice(0, 4000), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) });
    return { channel: 'telegram', ok: true, info: `Enviado al chat ${rep.chatId}`, messageId: m?.message_id };
  } catch (e) {
    const hint = /chat not found/i.test(e.message) ? ' — el bot no tiene acceso a ese chat: escríbele desde allí o añádelo al grupo' : /blocked/i.test(e.message) ? ' — el usuario bloqueó al bot' : /rights|not enough/i.test(e.message) ? ' — el bot no tiene permiso para escribir en el grupo' : '';
    logger.warn({ err: e.message }, 'Aviso Telegram fallido'); return { channel: 'telegram', ok: false, error: `${e.message}${hint}` };
  }
}
async function emailSend(bot, { subject, title, html }, { direct } = {}) {
  const cfg = bot.worker?.reporting?.email;
  const to = (cfg?.to || []).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)).slice(0, 10);
  if (!to.length) return { channel: 'email', ok: false, error: 'No hay destinatarios válidos' };
  if (!env.SMTP_HOST) return { channel: 'email', ok: false, error: 'El servidor no tiene SMTP configurado (SMTP_HOST, SMTP_USER, SMTP_PASS y MAIL_FROM en el .env de la API y del worker)' };
  const full = layout(title, html, null);
  if (!direct) { await Promise.all(to.map((t) => Q.email.add('send', { to: t, subject, html: full }, { attempts: 4, backoff: { type: 'exponential', delay: 5000 } }))); return { channel: 'email', ok: true, info: `En cola para ${to.join(', ')}` }; }
  const errs = [];
  for (const t of to) { try { await sendMail({ to: t, subject, html: full, text: full.replace(/<[^>]+>/g, ' ') }); } catch (e) { errs.push(`${t}: ${e.message}`); } }
  return errs.length ? { channel: 'email', ok: false, error: errs.join(' · ') } : { channel: 'email', ok: true, info: `Enviado a ${to.join(', ')}` };
}
async function postWebhook(botId, event, body) {
  const bot = await Bot.findById(botId).select('+worker.reporting.webhook.secretEnc').lean(); const w = bot?.worker?.reporting?.webhook; if (!w?.url) throw new Error('Sin URL');
  await safeUrl(w.url);
  const t = Math.floor(Date.now() / 1000); const sig = hmac(decrypt(w.secretEnc) || 'none', `${t}.${body}`);
  const r = await fetch(w.url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'user-agent': 'JuntialAgents-Workers/1.0', 'x-juntialagents-event': event, 'x-juntialagents-signature': `t=${t},v1=${sig}` } });
  if (!r.ok) throw new Error(`El servidor respondió HTTP ${r.status}`);
  return r.status;
}
async function webhookSend(bot, event, data, { direct } = {}) {
  const w = bot.worker?.reporting?.webhook; if (!w?.enabled || !w.url) return { channel: 'webhook', ok: false, skipped: true, error: 'No configurado' };
  const body = JSON.stringify({ event, worker: { id: String(bot._id), name: bot.name, title: bot.worker?.title }, ...data, sentAt: new Date().toISOString() });
  if (!direct) { await Q.webhooks.add('wk-hook', { botId: String(bot._id), event, body }, { attempts: 6, backoff: { type: 'exponential', delay: 10000 } }); return { channel: 'webhook', ok: true, info: 'En cola' }; }
  try { const st = await postWebhook(bot._id, event, body); return { channel: 'webhook', ok: true, info: `Entregado (HTTP ${st})` }; }
  catch (e) {
    const m = e.message || ''; const code = e.cause?.code || '';
    const friendly = /ENOTFOUND/.test(m + code) ? 'No existe ese dominio: revisa la URL' : /ECONNREFUSED/.test(m + code) ? 'El servidor rechazó la conexión' : /timeout|aborted/i.test(m) ? 'El servidor no respondió en 15 s' : /CERT|SSL|TLS/i.test(m + code) ? 'Certificado HTTPS no válido' : m;
    return { channel: 'webhook', ok: false, error: friendly };
  }
}
/** Entrega firmada de los webhooks del empleado (cola webhook-out, con reintentos). */
export async function deliverWorkerHook(job) { const { botId, event, body } = job.data; await postWebhook(botId, event, body); }

const btn = (href, label, bg) => `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;margin:4px 6px 4px 0;border-radius:10px;background:${bg};color:#fff;font-weight:700;text-decoration:none">${label}</a>`;
const CAT = { data: 'Cambiar datos', external: 'Comunicarse con clientes', destructive: 'Acción irreversible', read: 'Consultar', internal: 'Avisar' };

/** Aprobación nueva → todos los canales activos. Devuelve el resultado de cada canal. */
export async function fanOutApproval(bot, a, raw, { direct = false, policy = false } = {}) {
  const rep = bot.worker?.reporting || {}; const L = decisionLinks(raw); const who = bot.worker?.title || bot.name; const results = [];
  results.push(await panelSend(bot, { title: `🟡 ${who} necesita tu aprobación`, body: a.label, link: `${env.WEB_URL}/bots/${bot._id}?tab=approvals` }));
  const chain = policy && a.steps?.length ? `\n\n🔐 <b>${esc(a.policyName)}</b> · ${a.steps.map((s, i) => `${i + 1}. ${esc(s.name)}`).join(' → ')}\nDecide quien tenga el paso actual (Telegram vinculado en Juntial Center).` : '';
  const tg = await telegramSend(bot, `🟡 <b>${esc(who)} necesita tu aprobación</b>\n${esc(a.label)}${a.reason ? `\n\n<i>Motivo:</i> ${esc(a.reason.slice(0, 600))}` : ''}${chain}`,
    { inline_keyboard: [[{ text: '✅ Aprobar', callback_data: `a|${a._id}|y` }, { text: '❌ Rechazar', callback_data: `a|${a._id}|n` }]] });
  if (!tg.skipped) results.push(tg);
  if (tg.messageId) await WorkerApproval.updateOne({ _id: a._id }, { tg: { botId: rep.telegramBotId, chatId: rep.chatId, messageId: tg.messageId } });
  if (!policy && wants(rep.email, 'approvals')) results.push(await emailSend(bot, { subject: `🟡 Aprobación pendiente: ${a.label.slice(0, 90)}`, title: `${who} necesita tu aprobación`,
    html: `<p style="font-size:16px;font-weight:700;margin:0 0 8px">${esc(a.label)}</p><p style="margin:0 0 6px;color:#5b6673">Tipo: ${esc(CAT[a.category] || a.category)}</p>${a.reason ? `<p style="margin:0 0 16px"><i>Motivo:</i> ${esc(a.reason.slice(0, 800))}</p>` : ''}
      <p>${btn(`${L.approve}&via=email`, '✅ Aprobar', '#0E7C86')}${btn(`${L.reject}&via=email`, '❌ Rechazar', '#B42318')}</p>
      <p style="font-size:12px;color:#5b6673">Se abrirá una página para confirmar. Caduca el ${new Date(a.expiresAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}. También puedes decidir desde JuntialAgents.</p>` }, { direct }));
  if (wants(rep.webhook, 'approvals')) results.push(await webhookSend(bot, 'approval.requested', { approval: { id: String(a._id), label: a.label, reason: a.reason, category: a.category, tool: a.tool, args: a.args, expiresAt: a.expiresAt, test: a.tool === 'test_approval' },
    decide: { url: L.decide, method: 'POST', body: { decision: 'approve | reject', feedback: 'opcional', decidedBy: 'opcional' }, links: { approve: `${L.approve}&via=webhook`, reject: `${L.reject}&via=webhook` } } }, { direct }));
  if (policy) results.push({ channel: 'email', ok: true, info: 'Enlaces personales enviados a cada aprobador' });
  await WorkerApproval.updateOne({ _id: a._id }, { channels: results.filter((r) => r.ok).map((r) => r.channel) });
  return results;
}

/** Informe o pregunta → canales activos (Telegram con botones de respuesta si es una pregunta). */
export async function fanOutReport(bot, { title, body, urgent, kind = 'reports', markup }, { direct = false } = {}) {
  const rep = bot.worker?.reporting || {}; const who = bot.worker?.title || bot.name; const results = [];
  results.push(await panelSend(bot, { title: `${who}: ${String(title).slice(0, 120)}`, body, link: `${env.WEB_URL}/bots/${bot._id}?tab=${kind === 'questions' ? 'chat' : 'activity'}` }));
  const tg = await telegramSend(bot, `${urgent ? '🚨 ' : kind === 'questions' ? '❓ ' : '🤖 '}<b>${esc(who)}</b>\n<b>${esc(title)}</b>\n${esc(body)}`, markup); if (!tg.skipped) results.push(tg);
  if (wants(rep.email, kind)) results.push(await emailSend(bot, { subject: `${urgent ? '🚨 ' : ''}${who}: ${String(title).slice(0, 100)}`, title: String(title).slice(0, 140), html: `<p style="white-space:pre-wrap">${esc(body)}</p><p>${btn(`${env.WEB_URL}/bots/${bot._id}?tab=${kind === 'questions' ? 'chat' : 'activity'}`, 'Abrir en JuntialAgents', '#16324F')}</p>` }, { direct }));
  if (wants(rep.webhook, kind)) results.push(await webhookSend(bot, kind === 'questions' ? 'worker.question' : 'worker.report', { title, body, urgent: !!urgent }, { direct }));
  return results;
}

/** Tras decidir (desde cualquier canal), el resto se actualiza: se quitan los botones de Telegram y se avisa al webhook. */
export async function syncDecision(a, { status, by, via, result, error }) {
  const bot = await Bot.findById(a.botId).lean(); if (!bot) return;
  if (a.tg?.messageId && via !== 'telegram') {
    const rt = await getBotRuntime(a.tg.botId).catch(() => null);
    const txt = status === 'executed' ? `✅ Aprobada por ${by} (${via}) y ejecutada` : status === 'failed' ? `⚠️ Aprobada por ${by} (${via}), pero falló: ${error}` : `❌ Rechazada por ${by} (${via})`;
    rt?.api?.call('editMessageReplyMarkup', { chat_id: a.tg.chatId, message_id: a.tg.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    rt?.api?.call('sendMessage', { chat_id: a.tg.chatId, text: txt, reply_parameters: { message_id: a.tg.messageId, allow_sending_without_reply: true } }).catch(() => {});
  }
  if (wants(bot.worker?.reporting?.webhook, 'decisions')) await webhookSend(bot, 'approval.decided', { approval: { id: String(a._id), label: a.label, status, decidedBy: by, via, result: result || error || null, feedback: a.feedback || null } });
}

/* ───────── Página pública de decisión /a/:token (enlaces de email y webhook) ───────── */
const page = (title, inner) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>:root{--bg:#f4f6f8;--card:#fff;--ink:#1d2733;--soft:#5b6673;--line:#e3e8ee;--ok:#0E7C86;--bad:#B42318}@media(prefers-color-scheme:dark){:root{--bg:#0f1720;--card:#16212c;--ink:#e6edf3;--soft:#9aa7b4;--line:#263442}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
.c{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:520px;width:100%;padding:26px}h1{font-size:19px;margin:0 0 6px}.s{color:var(--soft);font-size:14px;margin:0 0 16px}
.l{font-size:16px;font-weight:700;margin:12px 0}.r{background:var(--bg);border-radius:10px;padding:12px;font-size:14px;margin:0 0 14px}textarea{width:100%;min-height:80px;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;background:var(--card);color:var(--ink)}
.b{display:flex;gap:10px;margin-top:14px}button{flex:1;min-height:48px;border:0;border-radius:12px;font-weight:700;font-size:15px;color:#fff;cursor:pointer}.a{background:var(--ok)}.x{background:var(--bad)}.sel{outline:3px solid var(--ink);outline-offset:2px}
details{font-size:13px;color:var(--soft)}pre{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:10px;border-radius:8px}.badge{display:inline-block;padding:3px 10px;border-radius:99px;background:var(--bg);font-size:12px;font-weight:700}</style></head><body><div class="c">${inner}<p class="s" style="margin:18px 0 0;font-size:12px">JuntialAgents · decisión segura de un solo uso</p></div></body></html>`;

export const approvalPublic = Router();
approvalPublic.use(express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }));
async function load(token) {
  if (!/^apr_[\w-]{20,}$/.test(token)) return null;
  const h = sha256(token);
  let a = await WorkerApproval.findOne({ tokenHash: h }).lean(); let memberId = null;
  if (!a) { a = await WorkerApproval.findOne({ 'approverTokens.hash': h }).select('+approverTokens').lean(); memberId = a?.approverTokens?.find((x) => x.hash === h)?.memberId || null; if (a) delete a.approverTokens; }
  if (!a) return null; a.__memberId = memberId;
  if (a.status === 'pending' && a.expiresAt < new Date()) { await WorkerApproval.updateOne({ _id: a._id, status: 'pending' }, { status: 'expired' }); a.status = 'expired'; }
  return a;
}
const STATUS_ES = { executed: '✅ Aprobada y ejecutada', approved: '✅ Aprobada', rejected: '❌ Rechazada', failed: '⚠️ Aprobada, pero la ejecución falló', expired: '⏱ Caducada' };
approvalPublic.get('/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
  const a = await load(req.params.token); if (!a) return res.status(404).send(page('No encontrada', '<h1>Enlace no válido</h1><p class="s">La aprobación no existe o el enlace es incorrecto.</p>'));
  const bot = await Bot.findById(a.botId).select('name worker.title').lean();
  const chain = a.steps?.length ? `<div class="r"><b>${esc(a.policyName)}</b><br>${a.steps.map((s, i) => `${i < a.currentStep || s.status === 'approved' ? '✅' : i === a.currentStep ? '🟡' : '⏳'} ${i + 1}. ${esc(s.name)}${s.decisions?.length ? ` — ${s.decisions.map((d) => `${esc(d.name)} ${d.decision === 'approve' ? '✓' : '✗'}`).join(', ')}` : ''}`).join('<br>')}</div>` : '';
  const head = `<h1>${esc(bot?.worker?.title || bot?.name)} necesita tu aprobación</h1><p class="s">${esc(CAT[a.category] || a.category)} · ${new Date(a.createdAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}</p><p class="l">${esc(a.label)}</p>${a.reason ? `<div class="r"><b>Motivo:</b> ${esc(a.reason)}</div>` : ''}${chain}<details><summary>Detalles técnicos</summary><pre>${esc(JSON.stringify(a.args, null, 2))}</pre></details>`;
  if (a.status !== 'pending') return res.send(page('Ya decidida', `${head}<p class="l"><span class="badge">${STATUS_ES[a.status] || a.status}</span></p><p class="s">${a.decidedBy ? `Por ${esc(a.decidedBy)}${a.decidedVia ? ` (${esc(a.decidedVia)})` : ''}` : ''}</p>`));
  const pre = req.query.d === 'reject' ? 'reject' : req.query.d === 'approve' ? 'approve' : '';
  res.send(page('Aprobación pendiente', `${head}<form method="post" action=""><input type="hidden" name="via" value="${esc(req.query.via || 'enlace')}">
    <label for="fb" class="s" style="display:block;margin:14px 0 6px">Comentario (si rechazas, explícale por qué: aprenderá)</label><textarea id="fb" name="feedback" maxlength="1000"></textarea>
    <div class="b"><button class="x ${pre === 'reject' ? 'sel' : ''}" name="decision" value="reject">❌ Rechazar</button><button class="a ${pre === 'approve' ? 'sel' : ''}" name="decision" value="approve">✅ Aprobar</button></div></form>`));
});
approvalPublic.post('/:token', async (req, res) => {
  const json = req.is('application/json'); res.set('Cache-Control', 'no-store');
  const a = await load(req.params.token);
  if (!a) return json ? res.status(404).json({ ok: false, error: 'Aprobación no encontrada' }) : res.status(404).send(page('No encontrada', '<h1>Enlace no válido</h1>'));
  const d = String(req.body.decision || '').toLowerCase(); if (!['approve', 'reject'].includes(d)) return json ? res.status(400).json({ ok: false, error: 'decision debe ser approve o reject' }) : res.redirect(303, req.originalUrl);
  const via = json ? 'webhook' : (['email', 'webhook'].includes(req.body.via) ? req.body.via : 'enlace');
  const by = String(req.body.decidedBy || (via === 'email' ? 'Enlace de email' : via === 'webhook' ? 'Sistema externo' : 'Enlace')).slice(0, 80);
  const { decideApproval } = await import('./engine.js');
  if (a.steps?.length && !a.__memberId && !(json && req.body.decidedBy)) return json ? res.status(403).json({ ok: false, error: 'Esta aprobación sigue una política: decide con tu enlace personal o indica decidedBy (email del aprobador)' }) : res.status(403).send(page('Enlace no personal', '<h1>Usa tu enlace personal</h1><p class="s">Esta aprobación sigue una política con aprobadores concretos. Revisa el email que te llegó a tu nombre o decide en Juntial Center.</p>'));
  const out = await decideApproval(a._id, { approve: d === 'approve', by, via, feedback: req.body.feedback ? String(req.body.feedback).slice(0, 1000) : undefined, actor: a.__memberId ? { memberId: a.__memberId } : req.body.decidedBy ? { email: req.body.decidedBy } : undefined });
  if (out.ok && out.status === 'pending') return json ? res.json(out) : res.send(page('Voto registrado', `<h1>Voto registrado</h1><p class="l">${esc(a.label)}</p><p class="s">${esc(out.info)}</p><p class="s">Ya puedes cerrar esta página.</p>`));
  if (json) return res.status(out.ok || out.status === 'failed' ? 200 : 409).json(out);
  const fresh = await WorkerApproval.findById(a._id).lean();
  res.send(page('Decisión registrada', `<h1>${out.ok || out.status === 'failed' ? 'Decisión registrada' : 'No se pudo registrar'}</h1><p class="l">${esc(a.label)}</p><p class="l"><span class="badge">${STATUS_ES[fresh?.status] || esc(out.error)}</span></p>${out.error && out.status === 'failed' ? `<p class="s">${esc(out.error)}</p>` : ''}<p class="s">Ya puedes cerrar esta página.</p>`));
});
