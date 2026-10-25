import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { sha256 } from '../lib/crypto.js';

/**
 * Catálogo de modelos EN VIVO desde la API de cada proveedor con la clave del cliente
 * (solo aparecen los modelos a los que esa clave tiene acceso). Caché de 6 h por clave.
 *  - Anthropic: GET /v1/models → id, display_name, line (familia), max_tokens…
 *  - OpenAI:    GET /v1/models → se filtran los modelos de chat
 * Si la API no responde, se usa la lista de respaldo.
 */
const TTL_S = 6 * 3600;
const LINE_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
export const LINE_INFO = {
  fable: 'Máxima capacidad para razonamiento exigente y tareas largas. Más lento y caro.',
  opus: 'Muy capaz para trabajo agéntico largo y conocimiento. Velocidad moderada.',
  sonnet: 'El mejor equilibrio entre velocidad e inteligencia. Recomendado.',
  haiku: 'El más rápido y económico. Ideal para respuestas cortas, clasificación y alto volumen.',
};
// Respaldo verificado en la documentación oficial (octubre 2026)
export const FALLBACK = {
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', line: 'sonnet', latest: true },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', line: 'haiku', latest: true },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', line: 'opus', latest: true },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', line: 'fable', latest: true },
  ],
  openai: [{ id: 'gpt-4.1-mini', name: 'gpt-4.1-mini', line: null, latest: true }, { id: 'gpt-4.1', name: 'gpt-4.1', line: null, latest: true }],
};
export const lineOf = (id = '') => id.match(/(fable|mythos|opus|sonnet|haiku)/)?.[1] || null; // admite claude-sonnet-5-5 y claude-3-haiku-…
const httpErr = (status, message) => Object.assign(new Error(message || `HTTP ${status}`), { status });

async function fetchAnthropic(key) {
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const out = []; let after = null;
  do {
    const u = new URL(`${base}/v1/models`); u.searchParams.set('limit', '1000'); if (after) u.searchParams.set('after_id', after);
    const r = await fetch(u, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw httpErr(r.status, j.error?.message);
    out.push(...(j.data || [])); after = j.has_more ? j.last_id : null;
  } while (after);
  return out.map((m) => ({ id: m.id, name: m.display_name || m.id, line: m.line ?? lineOf(m.id), created: m.created_at, maxTokens: m.max_tokens, maxInput: m.max_input_tokens }));
}
async function fetchOpenAI(key) {
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(r.status, j.error?.message);
  const chat = (j.data || []).filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !/(audio|realtime|transcribe|tts|embedding|image|search|instruct|moderation|dall-e|whisper)/.test(m.id));
  const ids = new Set(chat.map((m) => m.id));
  return chat.filter((m) => !(/-\d{4}-\d{2}-\d{2}$/.test(m.id) && ids.has(m.id.replace(/-\d{4}-\d{2}-\d{2}$/, '')))) // oculta snapshots con alias
    .map((m) => ({ id: m.id, name: m.id, line: null, created: new Date(m.created * 1000).toISOString() }));
}

function annotate(list) {
  const newest = {};
  for (const m of list) if (m.line && (!newest[m.line] || new Date(m.created) > new Date(newest[m.line].created))) newest[m.line] = m;
  return list.map((m) => ({ ...m, latest: m.line ? newest[m.line].id === m.id : true, info: LINE_INFO[m.line] }))
    .sort((a, b) => {
      const la = LINE_ORDER.indexOf(a.line); const lb = LINE_ORDER.indexOf(b.line);
      return (a.latest === b.latest ? 0 : a.latest ? -1 : 1) || (la < 0 ? 99 : la) - (lb < 0 ? 99 : lb) || new Date(b.created) - new Date(a.created);
    });
}

export async function listModels(provider, key, { force = false } = {}) {
  if (!key) return { models: annotate(FALLBACK[provider]), source: 'fallback' };
  const ck = `models:${provider}:${sha256(key).slice(0, 24)}`;
  if (!force) { const c = await redis.get(ck); if (c) return { models: JSON.parse(c), source: 'live' }; }
  const raw = provider === 'openai' ? await fetchOpenAI(key) : await fetchAnthropic(key);
  const models = annotate(raw);
  await redis.set(ck, JSON.stringify(models), 'EX', TTL_S);
  await redis.sadd(`models:seen:${provider}`, ...models.map((m) => m.id)).catch(() => {});
  return { models, source: 'live' };
}

/** Sustituto cuando un modelo se retira: la versión más reciente de la MISMA familia (sonnet→sonnet). */
export function replacementFor(provider, models, oldId) {
  const line = lineOf(oldId);
  return models.find((m) => m.latest && m.line && m.line === line)
    || (provider === 'openai' ? models.find((m) => m.id === env.DEFAULT_OPENAI_MODEL) : models.find((m) => m.latest && m.line === 'sonnet'))
    || models[0] || null;
}
/** ¿Hay una versión más nueva de la familia del modelo actual? */
export function newerFor(models, currentId) {
  const cur = models.find((m) => m.id === currentId); if (!cur?.line) return null;
  const top = models.find((m) => m.latest && m.line === cur.line);
  return top && top.id !== cur.id && new Date(top.created) > new Date(cur.created) ? top : null;
}
export const isModelNotFound = (e) => e?.status === 404
  || (e?.status === 400 && /model/i.test(e.message || '') && /(not.?found|does not exist|invalid|not available|deprecated|retired)/i.test(e.message || ''));
