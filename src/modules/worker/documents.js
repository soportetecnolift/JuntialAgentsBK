import { WorkerFile, daysFromNow } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { runAgent } from '../../ai/agent.js';
import { safeUrl } from '../crm/net.js';

/**
 * Documentos del empleado digital: se reciben (panel, chat, API, enlaces) o se encuentran en su trabajo
 * (archivos que devuelven los conectores) y se analizan con el contexto de su puesto y sus reglas de documentos.
 * PDF (incluidos escaneados) e imágenes van nativos al modelo; Word, Excel/CSV, texto, HTML y JSON se convierten a texto.
 */
export const MAX_BYTES = 10 * 1024 * 1024;
const EXT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'application/xml' };
export const guessMime = (name, mime) => (mime && mime !== 'application/octet-stream' ? mime.split(';')[0] : EXT[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream');
const kindOf = (mime) => (mime === 'application/pdf' ? 'pdf' : /^image\/(png|jpeg|webp|gif)$/.test(mime) ? 'image' : /wordprocessingml/.test(mime) ? 'docx' : /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime) ? 'sheet' : /^text\/|json|xml/.test(mime) ? 'text' : null);
export const isSupported = (mime) => !!kindOf(mime);

export async function fetchDocument(url) {
  await safeUrl(url);
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'JuntialAgents-Documents/1.0' } });
  if (!r.ok) throw new Error(`No se pudo descargar (${r.status})`);
  const len = Number(r.headers.get('content-length') || 0); if (len > MAX_BYTES) throw new Error('El documento supera 10 MB');
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > MAX_BYTES) throw new Error('El documento supera 10 MB');
  const cd = r.headers.get('content-disposition') || ''; const name = decodeURIComponent(cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] || new URL(url).pathname.split('/').pop() || 'documento');
  return { buf, name, mime: guessMime(name, r.headers.get('content-type')) };
}

/** Guarda un documento en la bandeja del empleado y, si está configurado, le encarga procesarlo. */
export async function storeDocument(bot, { name, mime, buffer, url, source, note, recordId, autoProcess }) {
  let buf = buffer;
  if (!buf && url) { const d = await fetchDocument(url); buf = d.buf; name ||= d.name; mime ||= d.mime; }
  if (!buf?.length) throw new Error('Documento vacío');
  if (buf.length > MAX_BYTES) throw new Error('El documento supera 10 MB');
  mime = guessMime(name || 'documento', mime);
  if (!isSupported(mime)) throw new Error(`Formato no soportado (${mime}). Admite PDF, imágenes, Word, Excel/CSV, texto, HTML y JSON.`);
  const f = await WorkerFile.create({ tenantId: bot.tenantId, botId: bot._id, name: String(name || 'documento').slice(0, 200), mime, size: buf.length, source, url, data: buf, note, recordId, status: 'new', expiresAt: daysFromNow(180) });
  const auto = autoProcess ?? bot.worker?.documents?.autoProcess !== false;
  if (auto) await Q.workers.add('event', { botId: String(bot._id), label: `Documento recibido: ${f.name}`, instruction: `Ha llegado un documento nuevo a tu bandeja: «${f.name}» (ref doc:${f._id}, origen: ${source}${note ? `, nota: ${note}` : ''}). Analízalo con analyze_document y procésalo según tus reglas de documentos y tu autonomía. Al terminar, márcalo con mark_document.` }, { attempts: 2 });
  return f;
}

/** Contenido para el modelo: nativo para PDF e imágenes, texto para el resto. */
async function toParts(file, raw) {
  // Mongo puede devolver Buffer, MongooseBuffer o BSON Binary según cómo se lea
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw?.buffer ?? raw?.value?.() ?? raw ?? []);
  const kind = kindOf(file.mime); const b64 = () => data.toString('base64');
  if (kind === 'pdf') return [{ type: 'pdf', data: b64(), name: file.name }];
  if (kind === 'image') return [{ type: 'image', mime: file.mime, data: b64() }];
  if (kind === 'docx') { const mammoth = (await import('mammoth')).default; const { value } = await mammoth.extractRawText({ buffer: data }); return [{ type: 'text', text: `Contenido de «${file.name}»:\n${value.slice(0, 120000)}` }]; }
  if (kind === 'sheet') {
    const XLSX = (await import('xlsx')).default; const wb = XLSX.read(data, { type: 'buffer', cellDates: true });
    const out = wb.SheetNames.slice(0, 10).map((n) => `## Hoja «${n}»\n${XLSX.utils.sheet_to_csv(wb.Sheets[n]).slice(0, 40000)}`).join('\n\n');
    return [{ type: 'text', text: `Contenido de «${file.name}» (CSV por hoja):\n${out.slice(0, 120000)}` }];
  }
  if (kind === 'text') { let t = data.toString('utf8'); if (/html/.test(file.mime)) t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); return [{ type: 'text', text: `Contenido de «${file.name}»:\n${t.slice(0, 120000)}` }]; }
  throw new Error('Formato no soportado');
}
const parseJson = (t) => { const s = String(t || '').replace(/```json|```/g, ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}'); return JSON.parse(s.slice(a, b + 1)); };

/** Análisis con el contexto del puesto: tipo de documento, regla aplicable, datos extraídos, incidencias y acciones propuestas. */
export async function analyzeDocument(rt, fileId, goal) {
  const { bot } = rt; const w = bot.worker || {}; const rules = w.documents?.rules || [];
  const file = await WorkerFile.findOne({ _id: fileId, botId: bot._id }).select('+data'); if (!file) throw new Error('Documento no encontrado en tu bandeja');
  await WorkerFile.updateOne({ _id: file._id }, { status: 'processing' });
  try {
    const parts = await toParts(file, file.data);
    const system = [
      `Eres el analista de documentos de ${w.title || bot.name}. Lees documentos de empresa con precisión y no inventas datos: si algo no aparece o no se lee, déjalo en null y señálalo en "issues".`,
      w.mission ? `Misión del puesto: ${w.mission}` : '', w.responsibilities ? `Responsabilidades:\n${w.responsibilities}` : '',
      w.knowledge?.instructions ? `Manual del puesto:\n${w.knowledge.instructions.slice(0, 8000)}` : '',
      rules.length ? `Reglas de documentos (elige la que encaje):\n${rules.map((r, i) => `${i + 1}. «${r.type}»: ${r.how}${r.fields?.length ? `\n   Campos a extraer: ${r.fields.join(', ')}` : ''}`).join('\n')}` : '',
      `Si no encaja ninguna regla: ${w.documents?.fallback || 'resume el documento e indica si requiere acción.'}`,
      'Responde SOLO con un objeto JSON, sin texto adicional, con esta forma:\n{"documentType": string, "matchedRule": string|null, "language": string, "summary": string (2-4 frases), "fields": {clave: valor} (los campos de la regla, con números como número y fechas en AAAA-MM-DD), "confidence": número 0-1, "issues": [string] (datos ilegibles, incoherencias, importes que no cuadran, firmas que faltan…), "suggestedActions": [string] (pasos concretos según la regla y tu puesto)}',
    ].filter(Boolean).join('\n\n');
    const res = await runAgent({ bot: { ...bot, ai: { ...bot.ai, maxToolSteps: 1, maxTokens: 3000 } }, apiKey: rt.aiKey, system: { static: system, dynamic: '' },
      turns: [{ role: 'user', parts: [...parts, { type: 'text', text: `Documento: «${file.name}» (${file.mime}, origen ${file.source}${file.note ? `, nota: ${file.note}` : ''}).${goal ? `\nObjetivo concreto: ${goal}` : ''}\nAnalízalo y devuelve el JSON.` }] }], tools: [], mcpTools: [], exec: async () => ({ text: '' }) });
    let a; try { a = parseJson(res.text); } catch { a = { documentType: 'Desconocido', summary: res.text.slice(0, 1500), fields: {}, confidence: 0.3, issues: ['La respuesta no tenía formato estructurado'], suggestedActions: [] }; }
    const analysis = { documentType: String(a.documentType || 'Documento').slice(0, 80), matchedRule: a.matchedRule || null, language: a.language, summary: String(a.summary || '').slice(0, 3000), fields: a.fields || {}, confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)), issues: (a.issues || []).map(String).slice(0, 20), suggestedActions: (a.suggestedActions || []).map(String).slice(0, 20), analyzedAt: new Date() };
    await WorkerFile.updateOne({ _id: file._id }, { status: 'analyzed', analysis, error: null });
    return { ref: `doc:${file._id}`, name: file.name, ...analysis };
  } catch (e) { await WorkerFile.updateOne({ _id: file._id }, { status: 'error', error: e.message }); throw e; }
}
export const docRef = (s) => String(s || '').replace(/^doc:/, '').trim();
