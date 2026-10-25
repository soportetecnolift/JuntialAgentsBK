import { Router } from 'express';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Bot, WebConversation } from '../../models/index.js';
import { redis, takeToken, acquireLock, releaseLock, extendLock } from '../../lib/redis.js';
import { decrypt, sha256, randomToken } from '../../lib/crypto.js';
import { AppError, asyncH, badRequest, forbidden, notFound, tooMany, unauthorized } from '../../lib/errors.js';
import { getBotRuntime } from '../../telegram/runtime.js';
import { consumeMessage } from '../plans/limits.js';
import { emitEvent } from '../webhooks/dispatcher.js';
import { speechToText } from '../../ai/voice.js';
import { runWebTurn } from './agent.js';
import { saveLead } from './tools.js';
import { logger } from '../../config/logger.js';

/**
 * API pública del widget (la llama el navegador del VISITANTE desde la web del cliente).
 * Seguridad: dominios permitidos por agente (Origin), token de visitante firmado (24 h),
 * límites por visitante / IP / agente, cuota del plan y un turno a la vez por conversación.
 */
const r = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_FILE = path.resolve(__dirname, '../../../public/widget.js');
const PURPOSE = 'widget';

const originAllowed = (bot, origin) => {
  if (!origin) return false;
  if (origin === env.WEB_URL) return true; // vista previa desde el panel
  return (bot.web?.allowedOrigins || []).some((o) => {
    if (o === origin) return true;
    if (o.includes('*')) return new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+')}$`).test(origin);
    return false;
  });
};
function cors(req, res) {
  const o = req.headers.origin;
  if (o) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}
r.use((req, res, next) => { cors(req, res); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });

async function botByKey(pk) {
  const ck = `web:pk:${pk}`; let id = await redis.get(ck);
  if (!id) { const b = await Bot.findOne({ 'web.publicKey': pk, kind: 'web' }).select('_id').lean(); if (!b) throw notFound('Agente'); id = String(b._id); await redis.set(ck, id, 'EX', 300); }
  const rt = await getBotRuntime(id); if (!rt || rt.bot.kind !== 'web') throw notFound('Agente');
  return rt;
}
function guardOrigin(req, bot) { if (!originAllowed(bot, req.headers.origin)) throw forbidden('Este dominio no está autorizado para usar el agente. Añádelo en el panel → Instalar.'); }

/* ── Script del widget ── */
r.get('/widget.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(WIDGET_FILE);
});

/* ── Configuración pública (sin secretos) ── */
r.get('/agents/:pk/config', asyncH(async (req, res) => {
  const { bot } = await botByKey(req.params.pk); guardOrigin(req, bot);
  const w = bot.web || {}; const v = w.voice || {};
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: bot.status, name: w.appearance?.title || bot.name, appearance: w.appearance, greeting: w.greeting, suggestions: w.suggestions || [],
    leadForm: w.leadForm?.enabled ? { preChat: !!w.leadForm.preChat, title: w.leadForm.title, fields: w.leadForm.fields } : null,
    voice: v.enabled ? { mode: v.mode, language: v.language || 'es-ES', silenceMs: v.silenceMs || 800, bargeIn: v.bargeIn !== false } : null,
    images: true, branding: true,
  });
}));

/* ── Sesión de visitante ── */
r.post('/agents/:pk/session', express.json({ limit: '16kb' }), asyncH(async (req, res) => {
  const rt = await botByKey(req.params.pk); const { bot } = rt; guardOrigin(req, bot);
  if ((await takeToken(`web:sess:ip:${req.ip}`, 20 / 3600, 20)) > 0) throw tooMany();
  // Reanudar conversación si el token anterior sigue siendo válido
  const prev = req.body?.token;
  if (prev) {
    try {
      const p = jwt.verify(prev, env.JWT_ACCESS_SECRET);
      if (p.purpose === PURPOSE && p.aid === String(bot._id)) {
        const conv = await WebConversation.findById(p.cid).lean();
        if (conv) return res.json({ token: prev, conversationId: p.cid, messages: conv.messages.slice(-30).map((m) => ({ role: m.role, text: m.text })), lead: !!(conv.lead?.email || conv.lead?.phone) });
      }
    } catch { /* token caducado: nueva sesión */ }
  }
  const page = req.body?.page || {};
  const conv = await WebConversation.create({ botId: bot._id, tenantId: bot.tenantId, visitorId: String(req.body?.visitorId || randomToken(12)).slice(0, 40),
    meta: { url: String(page.url || '').slice(0, 500), title: String(page.title || '').slice(0, 200), referrer: String(page.referrer || '').slice(0, 500), userAgent: String(req.headers['user-agent'] || '').slice(0, 300), lang: String(req.body?.lang || '').slice(0, 20), ipHash: sha256(req.ip).slice(0, 16) },
    lastMessageAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400000) });
  emitEvent(bot, 'conversation.started', { conversationId: String(conv._id), page: conv.meta.url, referrer: conv.meta.referrer });
  const token = jwt.sign({ purpose: PURPOSE, aid: String(bot._id), cid: String(conv._id) }, env.JWT_ACCESS_SECRET, { expiresIn: '24h' });
  res.json({ token, conversationId: String(conv._id), messages: [], lead: false });
}));

async function visitor(req) {
  const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) throw unauthorized();
  let p; try { p = jwt.verify(h.slice(7), env.JWT_ACCESS_SECRET); } catch { throw unauthorized('Sesión caducada'); }
  if (p.purpose !== PURPOSE) throw unauthorized();
  const rt = await getBotRuntime(p.aid); if (!rt || rt.bot.kind !== 'web') throw notFound();
  guardOrigin(req, rt.bot);
  const conv = await WebConversation.findById(p.cid); if (!conv) throw unauthorized('Conversación no encontrada');
  return { rt, conv };
}
async function guardTurn(req, rt, conv) {
  const { bot } = rt;
  if (bot.status !== 'active') throw new AppError(503, 'AGENT_PAUSED', 'El asistente no está disponible ahora mismo.');
  if (!rt.aiKey) throw new AppError(503, 'AGENT_NOT_CONFIGURED', 'El asistente aún no está configurado: falta la API key de IA (panel → Modelo de IA).');
  const perMin = bot.web?.guardrails?.visitorPerMinute || 15;
  if ((await takeToken(`web:v:${conv._id}`, perMin / 60, perMin)) > 0) throw tooMany('Vas muy rápido. Espera unos segundos.');
  if ((await takeToken(`web:ip:${req.ip}`, 0.5, 30)) > 0) throw tooMany();
  if ((await takeToken(`web:agent:${bot._id}`, 5, 120)) > 0) throw tooMany('El asistente está muy ocupado. Inténtalo en un momento.');
  const q = await consumeMessage(bot.tenantId); if (!q.allowed) throw new AppError(503, 'QUOTA', 'El asistente no está disponible ahora mismo.');
}

/** Respuesta en streaming (Server-Sent Events) sobre la misma petición POST. */
function sse(res, onClose) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  // OJO: en Node 18+ req 'close' salta al terminar de leer el cuerpo. La desconexión real se detecta en res.
  let closed = false; res.on('close', () => { if (!res.writableEnded) { closed = true; onClose?.(); } });
  const ping = setInterval(() => !closed && res.write(': ping\n\n'), 15000);
  return {
    emit: (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end: () => { clearInterval(ping); if (!closed) res.end(); },
    isAborted: () => closed,
  };
}

const imagesSchema = z.array(z.object({ mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']), data: z.string().max(6_000_000) })).max(4).default([]);

function voiceConfig(rt) {
  const v = rt.bot.web?.voice; if (!v?.enabled || v.mode === 'browser') return null;
  const key = decrypt(rt.bot.web.voice.keyEnc) || (v.mode === 'openai' && rt.bot.ai.provider === 'openai' ? rt.aiKey : null) || (v.mode === 'openai' ? env.PLATFORM_OPENAI_KEY : null);
  return key ? { mode: v.mode, key, voice: v.voice, elevenVoiceId: v.elevenVoiceId, instructions: v.instructions, language: v.language } : null;
}

async function turn(req, res, { text, images, isVoice, wantAudio, audio }) {
  const { rt, conv } = await visitor(req);
  await guardTurn(req, rt, conv);
  const max = rt.bot.web?.guardrails?.maxChars || 2000;
  /* "El último mensaje gana" (como al interrumpir en ChatGPT): un turno nuevo cancela el anterior
     de esta conversación —aunque esté en otro servidor— y espera a que libere el turno. */
  const turnId = randomToken(8); const curKey = `web:cur:${conv._id}`; const lockKey = `web:turn:${conv._id}`;
  await redis.set(curKey, turnId, 'EX', 600);
  let lock = null;
  for (let i = 0; i < 80 && !(lock = await acquireLock(lockKey, 15000)); i++) await new Promise((ok) => setTimeout(ok, 100));
  if (!lock) throw new AppError(409, 'BUSY', 'Sigo terminando la respuesta anterior; vuelve a intentarlo en un momento.');
  const ac = new AbortController();
  const watch = setInterval(async () => {
    try { if ((await redis.get(curKey)) !== turnId) ac.abort(); else await extendLock(lockKey, lock, 15000); } catch { /* reintenta en el siguiente latido */ }
  }, 250);
  const s = sse(res, () => ac.abort());
  try {
    if (audio) {
      const vc = voiceConfig(rt); if (!vc) throw badRequest('La voz premium no está configurada');
      s.emit('step', { label: 'Pensando…' });
      text = await speechToText(Buffer.from(audio.data, 'base64'), audio.mime, vc);
      if (!text) { s.emit('transcript', { text: '' }); s.emit('done', { text: '', empty: true }); return; }
      s.emit('transcript', { text });
    }
    if ((text || '').length > max) text = text.slice(0, max);
    const voiceOut = wantAudio ? voiceConfig(rt) : null;
    if (ac.signal.aborted) return;
    const result = await runWebTurn({ rt, conv, text, images, isVoice, voiceOut, emit: s.emit, isAborted: () => s.isAborted() || ac.signal.aborted, signal: ac.signal });
    if (!result.aborted) s.emit('done', { text: result.text });
  } catch (e) {
    if (ac.signal.aborted) return;
    logger.warn({ err: e.message, bot: String(rt.bot._id) }, 'Turno web fallido');
    s.emit('error', { message: e.status === 401 ? 'El asistente no está disponible ahora mismo.' : 'No he podido responder. Inténtalo de nuevo.' });
  } finally { clearInterval(watch); s.end(); await releaseLock(lockKey, lock); }
}

r.post('/chat', express.json({ limit: '25mb' }), asyncH(async (req, res) => {
  const b = z.object({ text: z.string().max(10000).default(''), images: imagesSchema, voice: z.boolean().default(false), audioReply: z.boolean().default(false) }).parse(req.body || {});
  if (!b.text.trim() && !b.images.length) throw badRequest('Mensaje vacío');
  await turn(req, res, { text: b.text, images: b.images, isVoice: b.voice, wantAudio: b.audioReply });
}));

// Voz premium: audio del visitante → transcripción → agente → frases de audio en streaming
r.post('/voice', express.json({ limit: '25mb' }), asyncH(async (req, res) => {
  const b = z.object({ audio: z.object({ mime: z.string().max(60), data: z.string().max(12_000_000) }), images: imagesSchema }).parse(req.body || {});
  await turn(req, res, { audio: b.audio, images: b.images, isVoice: true, wantAudio: true });
}));

r.post('/lead', express.json({ limit: '32kb' }), asyncH(async (req, res) => {
  const { rt, conv } = await visitor(req);
  if ((await takeToken(`web:lead:${conv._id}`, 1 / 60, 3)) > 0) throw tooMany();
  const f = req.body?.fields || {};
  const known = ['name', 'email', 'phone', 'company', 'notes'];
  const extra = Object.fromEntries(Object.entries(f).filter(([k]) => !known.includes(k)).map(([k, v]) => [k, String(v).slice(0, 500)]));
  const out = await saveLead(rt.bot, conv._id, { ...Object.fromEntries(known.map((k) => [k, f[k]])), extra }, 'form');
  if (!out.ok) throw badRequest(out.error);
  res.json({ ok: true });
}));

export default r;
