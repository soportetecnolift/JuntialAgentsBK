import { WorkerDoc } from '../../models/index.js';

/** Documentos de entrenamiento troceados + búsqueda BM25 (sin base vectorial: rápido, barato y explicable). */
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const tokens = (s) => norm(s).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 2);
export function chunkText(text, size = 1200, overlap = 150) {
  const clean = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(); const out = [];
  for (let i = 0; i < clean.length; i += size - overlap) { out.push(clean.slice(i, i + size)); if (out.length >= 400) break; }
  return out.map((t, i) => ({ i, text: t }));
}
export const htmlToText = (html) => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();

export async function searchKnowledge(botId, query, k = 5) {
  const docs = await WorkerDoc.find({ botId }).select('title chunks').lean();
  const all = docs.flatMap((d) => d.chunks.map((c) => ({ title: d.title, text: c.text, toks: tokens(c.text) })));
  if (!all.length) return [];
  const q = [...new Set(tokens(query))]; const N = all.length; const avg = all.reduce((a, c) => a + c.toks.length, 0) / N;
  const df = Object.fromEntries(q.map((t) => [t, all.filter((c) => c.toks.includes(t)).length]));
  return all.map((c) => {
    let score = 0;
    for (const t of q) { const f = c.toks.filter((x) => x === t).length; if (!f) continue; const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5)); score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.toks.length / avg)))); }
    return { title: c.title, text: c.text, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
