import OpenAI, { toFile } from 'openai';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { sha256 } from '../lib/crypto.js';

/**
 * Voz para agentes web (el "cerebro" sigue siendo Claude o GPT, a elección del cliente):
 *  - browser:    reconocimiento y síntesis en el propio navegador (gratis, calidad según dispositivo)
 *  - openai:     STT gpt-4o-mini-transcribe + TTS gpt-4o-mini-tts (voces naturales, baja latencia)
 *  - elevenlabs: STT Scribe + TTS Flash v2.5 (voces más expresivas)
 */
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a' };
const extFor = (mime = '') => EXT[mime.split(';')[0]] || 'webm';

export async function speechToText(buffer, mime, { mode, key, language }) {
  const lang = (language || 'es').slice(0, 2);
  if (mode === 'elevenlabs') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `audio.${extFor(mime)}`);
    form.append('model_id', 'scribe_v1'); form.append('language_code', lang);
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.detail?.message || `ElevenLabs STT ${r.status}`), { status: r.status });
    return (j.text || '').trim();
  }
  const client = new OpenAI({ apiKey: key, timeout: 30000 });
  const r = await client.audio.transcriptions.create({ file: await toFile(buffer, `audio.${extFor(mime)}`), model: env.TRANSCRIBE_MODEL, language: lang });
  return (r.text || '').trim();
}

export async function textToSpeech(text, { mode, key, voice, elevenVoiceId, instructions }) {
  if (mode === 'elevenlabs') {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoiceId || '21m00Tcm4TlvDq8ikWAM')}?output_format=mp3_44100_64`, {
      method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8 } }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Object.assign(new Error(`ElevenLabs TTS ${r.status}`), { status: r.status });
    return { mime: 'audio/mpeg', data: Buffer.from(await r.arrayBuffer()) };
  }
  const client = new OpenAI({ apiKey: key, timeout: 30000 });
  const r = await client.audio.speech.create({
    model: process.env.TTS_MODEL || 'gpt-4o-mini-tts', voice: voice || 'coral', input: text, response_format: 'mp3',
    instructions: instructions || 'Habla en español, con tono cálido, natural y cercano, a ritmo conversacional.',
  });
  return { mime: 'audio/mpeg', data: Buffer.from(await r.arrayBuffer()) };
}

/** Limpia Markdown/emoji para que la voz no lea símbolos. */
export const speakable = (t) => t.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\*\*|__|[*_~#>]/g, '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, 'el enlace').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Trocea el texto en frases a medida que llega en streaming → la voz empieza con la 1.ª frase
 * mientras el modelo sigue escribiendo el resto (latencia percibida mínima).
 */
export class SentenceChunker {
  constructor() { this.sent = 0; this.count = 0; }
  push(snapshot) {
    const out = []; let rest = snapshot.slice(this.sent);
    const min = this.count === 0 ? 24 : 60; // 1.ª frase cuanto antes; luego trozos algo mayores (voz más natural)
    const re = /[.!?…:;]\s|\n+/g; let m; let cut = -1;
    while ((m = re.exec(rest))) { if (m.index + 1 >= min) { cut = m.index + m[0].length; break; } }
    if (cut === -1 && rest.length > 260) cut = rest.lastIndexOf(' ', 220) + 1 || 220;
    if (cut > 0) { out.push(rest.slice(0, cut)); this.sent += cut; this.count++; }
    return out.map(speakable).filter(Boolean);
  }
  flush(snapshot) { const r = speakable(snapshot.slice(this.sent)); this.sent = snapshot.length; return r ? [r] : []; }
}

/* ───────── Muletillas humanas mientras el agente piensa ─────────
 * Solo suenan si la respuesta TARDA (como una persona: si sabe la respuesta, contesta sin más).
 * Se sintetizan una vez con la voz del agente y se guardan en caché (Redis, 30 días): salen al instante.
 */
export const FILLERS = {
  es: {
    think: ['Mmm, déjame ver…', 'Dame un momento…', 'A ver…', 'Vale, un segundo…', 'Buena pregunta, déjame pensarlo…', 'Un momentito…', 'Déjame comprobarlo…', 'Vale, lo miro…'],
    tool: ['Lo estoy consultando…', 'Déjame revisarlo en el sistema…', 'Estoy buscando esa información…', 'Un segundo, lo compruebo…'],
    long: ['Ya casi lo tengo…', 'Un segundo más…', 'Sigo con ello, ya casi…'],
  },
  en: {
    think: ['Hmm, let me see…', 'Give me a moment…', 'Okay, one second…', 'Good question, let me think…', 'Let me check that…'],
    tool: ['Let me look that up…', "I'm checking the system…", 'Searching for that now…'],
    long: ['Almost there…', 'Just a moment more…'],
  },
  pt: { think: ['Hmm, deixa eu ver…', 'Só um momento…', 'Um segundinho…'], tool: ['Estou consultando…', 'Deixa eu verificar no sistema…'], long: ['Quase lá…'] },
  fr: { think: ['Hmm, voyons voir…', 'Un instant…', 'Une petite seconde…'], tool: ['Je vérifie…', 'Je regarde dans le système…'], long: ['Presque fini…'] },
};
const fillerSet = (cfg) => FILLERS[(cfg.language || 'es').slice(0, 2)] || FILLERS.es;
const voiceHash = (cfg) => sha256(JSON.stringify([cfg.mode, cfg.voice, cfg.elevenVoiceId, cfg.instructions, (cfg.language || 'es').slice(0, 2)])).slice(0, 16);

/** Genera (en segundo plano) todas las muletillas de esa voz. Idempotente y con bloqueo. */
export async function warmFillers(cfg) {
  if (!cfg?.key) return;
  const h = voiceHash(cfg);
  if (!(await redis.set(`filler:warm:${h}`, 1, 'EX', 3600, 'NX'))) return;
  const set = fillerSet(cfg);
  for (const [kind, list] of Object.entries(set)) {
    for (let i = 0; i < list.length; i++) {
      const key = `filler:${h}:${kind}:${i}`;
      if (await redis.exists(key)) continue;
      try { const a = await textToSpeech(list[i], { ...cfg, instructions: `${cfg.instructions || ''} Dilo de forma espontánea y natural, como quien piensa en voz alta.` }); await redis.set(key, a.data.toString('base64'), 'EX', 30 * 86400); } catch { /* se reintenta en la próxima hora */ }
    }
  }
}
const lastFiller = new Map(); // conversación → última muletilla (para no repetir seguidas)
export async function pickFiller(cfg, kind, convId) {
  const h = voiceHash(cfg); const list = fillerSet(cfg)[kind] || [];
  if (!list.length) return null;
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && lastFiller.get(String(convId)) === `${kind}${i}`) i = (i + 1) % list.length;
  const data = await redis.get(`filler:${h}:${kind}:${i}`);
  if (!data) { warmFillers(cfg).catch(() => {}); return null; } // aún no está en caché: se prepara para la próxima
  lastFiller.set(String(convId), `${kind}${i}`); if (lastFiller.size > 5000) lastFiller.delete(lastFiller.keys().next().value);
  return { text: list[i], mime: 'audio/mpeg', data };
}
