import { Router } from 'express';
import { z } from 'zod';
import { Bot, WebConversation } from '../../models/index.js';
import { asyncH, notFound, badRequest } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { tenantScope } from '../../middleware/auth.js';
import { encrypt, mask, randomToken } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { bumpBotVersion } from '../../telegram/runtime.js';
import { warmFillers } from '../../ai/voice.js';
import { decrypt } from '../../lib/crypto.js';

/** Configuración del agente web desde el panel del cliente: /api/bots/:id/web/* */
const r = Router({ mergeParams: true });
const find = async (req) => { const b = await Bot.findOne({ _id: req.params.botId, kind: 'web', ...tenantScope(req) }); if (!b) throw notFound('Agente web'); return b; };
const origin = z.string().regex(/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i, 'Usa el formato https://tudominio.com');

r.get('/install', asyncH(async (req, res) => {
  const b = await find(req);
  const src = `${env.PUBLIC_API_URL}/widget/v1/widget.js`;
  res.json({ publicKey: b.web.publicKey, scriptUrl: src, snippet: `<script src="${src}" data-agent="${b.web.publicKey}" async></script>`, allowedOrigins: b.web.allowedOrigins || [], previewOrigin: env.WEB_URL });
}));

r.put('/', validate(z.object({
  allowedOrigins: z.array(origin).max(30).optional(),
  appearance: z.object({ title: z.string().max(60), subtitle: z.string().max(80), avatarUrl: z.string().url().or(z.literal('')), primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i), position: z.enum(['right', 'left']), theme: z.enum(['auto', 'light', 'dark']), launcherLabel: z.string().max(30) }).partial().optional(),
  greeting: z.string().max(500).optional(), suggestions: z.array(z.string().max(60)).max(6).optional(),
  leadForm: z.object({ enabled: z.boolean(), preChat: z.boolean(), title: z.string().max(80), fields: z.array(z.object({ key: z.string().regex(/^[a-z_]{2,30}$/), label: z.string().max(60), type: z.enum(['text', 'email', 'tel', 'textarea']), required: z.boolean() })).max(8) }).partial().optional(),
  handoff: z.object({ enabled: z.boolean(), message: z.string().max(300), telegram: z.object({ botId: z.string().nullable(), chatId: z.number().nullable() }).partial() }).partial().optional(),
  guardrails: z.object({ allowedTopics: z.string().max(1000), blockedTopics: z.string().max(1000), maxChars: z.number().int().min(100).max(10000), visitorPerMinute: z.number().int().min(1).max(60) }).partial().optional(),
  voice: z.object({ enabled: z.boolean(), mode: z.enum(['browser', 'openai', 'elevenlabs']), voice: z.string().max(30), elevenVoiceId: z.string().max(60), language: z.string().max(10), silenceMs: z.number().int().min(400).max(2500), bargeIn: z.boolean(), instructions: z.string().max(500), key: z.string().min(20) }).partial().optional(),
})), asyncH(async (req, res) => {
  const b = await find(req); const w = b.web;
  const merge = (k) => { if (req.body[k]) w[k] = { ...(w[k]?.toObject?.() || w[k] || {}), ...req.body[k] }; };
  if (req.body.allowedOrigins) w.allowedOrigins = [...new Set(req.body.allowedOrigins.map((o) => o.replace(/\/$/, '').toLowerCase()))];
  if (req.body.greeting !== undefined) w.greeting = req.body.greeting;
  if (req.body.suggestions) w.suggestions = req.body.suggestions.filter(Boolean);
  ['appearance', 'leadForm', 'guardrails'].forEach(merge);
  if (req.body.handoff) { const h = req.body.handoff; w.handoff = { ...(w.handoff?.toObject?.() || {}), ...h, telegram: h.telegram ? { botId: h.telegram.botId || undefined, chatId: h.telegram.chatId || undefined } : w.handoff?.telegram }; }
  if (req.body.voice) {
    const { key, ...v } = req.body.voice;
    const cur = await Bot.findById(b._id).select('+web.voice.keyEnc').lean();
    w.voice = { ...(w.voice?.toObject?.() || {}), ...v, keyEnc: key ? encrypt(key) : cur.web?.voice?.keyEnc, keyMask: key ? mask(key) : w.voice?.keyMask };
    if (v.mode && v.mode !== 'browser' && !key && !cur.web?.voice?.keyEnc && !(v.mode === 'openai' && b.ai.provider === 'openai')) throw badRequest(v.mode === 'openai' ? 'Indica una API key de OpenAI para la voz' : 'Indica tu API key de ElevenLabs');
  }
  await b.save(); await bumpBotVersion(b._id);
  if (req.body.voice && b.web.voice.mode !== 'browser') {
    const key = req.body.voice.key || decrypt(b.web.voice.keyEnc);
    if (key) warmFillers({ mode: b.web.voice.mode, key, voice: b.web.voice.voice, elevenVoiceId: b.web.voice.elevenVoiceId, instructions: b.web.voice.instructions, language: b.web.voice.language }).catch(() => {});
  }
  audit(req, 'web.update', { kind: 'bot', id: b.id }, { fields: Object.keys(req.body) });
  const out = b.toObject(); delete out.web?.voice?.keyEnc; res.json(out);
}));

r.post('/mcp-ack', asyncH(async (req, res) => {
  const b = await find(req); b.web.mcpAck = { at: new Date(), by: req.user.email }; await b.save(); await bumpBotVersion(b._id);
  audit(req, 'web.mcp_ack', { kind: 'bot', id: b.id }); res.json({ ok: true, mcpAck: b.web.mcpAck });
}));

r.post('/rotate-key', asyncH(async (req, res) => {
  const b = await find(req); const old = b.web.publicKey;
  b.web.publicKey = `ja_pk_${randomToken(18)}`; await b.save(); await redis.del(`web:pk:${old}`); await bumpBotVersion(b._id);
  audit(req, 'web.rotate_key', { kind: 'bot', id: b.id }); res.json({ publicKey: b.web.publicKey });
}));

r.get('/conversations', asyncH(async (req, res) => {
  const b = await find(req); const q = { botId: b._id };
  if (req.query.filter === 'leads') q.$or = [{ 'lead.email': { $exists: true } }, { 'lead.phone': { $exists: true } }];
  if (req.query.filter === 'handoff') q['handoff.requested'] = true;
  const items = await WebConversation.find(q).sort({ lastMessageAt: -1 }).limit(100).select('lead handoff meta messageCount lastMessageAt createdAt messages').lean();
  res.json(items.map(({ messages, ...c }) => ({ ...c, preview: messages?.filter((m) => m.role === 'user').at(-1)?.text?.slice(0, 140) || '' })));
}));
r.get('/conversations/:cid', asyncH(async (req, res) => {
  const b = await find(req); const c = await WebConversation.findOne({ _id: req.params.cid, botId: b._id }).lean(); if (!c) throw notFound(); res.json(c);
}));
export default r;
