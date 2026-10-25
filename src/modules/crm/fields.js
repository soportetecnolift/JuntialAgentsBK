import { FieldDef } from '../../models/index.js';
import { redis } from '../../lib/redis.js';
import { badRequest } from '../../lib/errors.js';

/** Campos de sistema de Contactos (como en Zoho: siempre existen, se pueden renombrar pero no borrar). */
export const SYSTEM_FIELDS = [
  { key: 'name', label: 'Nombre', type: 'text', aiHint: 'Nombre y apellidos de la persona', order: 1 },
  { key: 'email', label: 'Email', type: 'email', aiHint: 'Correo electrónico', order: 2 },
  { key: 'phone', label: 'Teléfono', type: 'phone', aiHint: 'Teléfono con prefijo si lo da', order: 3 },
  { key: 'company', label: 'Empresa', type: 'text', aiHint: 'Empresa u organización', order: 4 },
  { key: 'status', label: 'Estado', type: 'picklist', options: ['Nuevo', 'Contactado', 'Cualificado', 'Cliente', 'Perdido'], aiHint: 'Fase comercial. Pasa a Cualificado cuando haya necesidad clara y datos de contacto', order: 5 },
  { key: 'source', label: 'Origen', type: 'picklist', options: ['Web', 'Telegram', 'API', 'Manual'], agentWritable: false, order: 6 },
  { key: 'notes', label: 'Notas', type: 'textarea', aiHint: 'Resumen breve de lo que necesita', order: 7 },
];
export const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'currency', 'boolean', 'date', 'datetime', 'picklist', 'multiselect', 'url'];

export async function getFields(tenantId, module = 'contacts') {
  const ck = `crm:fields:${tenantId}:${module}`; const c = await redis.get(ck); if (c) return JSON.parse(c);
  let list = await FieldDef.find({ tenantId, module }).sort({ order: 1, createdAt: 1 }).lean();
  if (!list.some((f) => f.system)) {
    await FieldDef.insertMany(SYSTEM_FIELDS.map((f) => ({ ...f, tenantId, module, system: true, agentWritable: f.agentWritable !== false })), { ordered: false }).catch(() => {});
    list = await FieldDef.find({ tenantId, module }).sort({ order: 1, createdAt: 1 }).lean();
  }
  await redis.set(ck, JSON.stringify(list), 'EX', 300);
  return list;
}
export const invalidateFields = (tenantId, module = 'contacts') => redis.del(`crm:fields:${tenantId}:${module}`);

/** Valida y normaliza valores según el tipo del campo (lo que escriba el agente, la web, la API o una función). */
export function coerce(fields, data, { partial = true } = {}) {
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f])); const out = {}; const errors = [];
  for (const [k, raw] of Object.entries(data || {})) {
    const f = byKey[k]; if (!f) { errors.push(`El campo "${k}" no existe`); continue; }
    if (raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) { out[k] = null; continue; }
    const v = typeof raw === 'string' ? raw.trim() : raw;
    try { out[k] = cast(f, v); } catch (e) { errors.push(`${f.label}: ${e.message}`); }
  }
  if (!partial) for (const f of fields) if (f.required && (out[f.key] == null)) errors.push(`${f.label} es obligatorio`);
  if (errors.length) throw badRequest(errors.join(' · '), { errors });
  return out;
}
/** Números escritos por personas: "25.000", "25.000,50", "1,250.75", "3,5", "25k", "12 €". */
export function parseNumber(raw) {
  let t = String(raw).toLowerCase().replace(/[€$£\s]|eur|usd|cop/g, '');
  let mult = 1; if (/k$/.test(t)) { mult = 1e3; t = t.slice(0, -1); } else if (/(m|mill(ones)?)$/.test(t)) { mult = 1e6; t = t.replace(/(m|mill(ones)?)$/, ''); }
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');      // 25.000,50 (es)
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');                    // 25,000.50 (en)
  else if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');                                       // 3,5
  return Number(t) * mult;
}
function cast(f, v) {
  switch (f.type) {
    case 'text': return String(v).slice(0, 1000);
    case 'textarea': return String(v).slice(0, 10000);
    case 'email': { const e = String(v).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new Error('email no válido'); return e; }
    case 'phone': { const p = String(v).replace(/[^\d+()\s-]/g, '').trim(); if (p.replace(/\D/g, '').length < 6) throw new Error('teléfono no válido'); return p; }
    case 'number': case 'currency': { const n = typeof v === 'number' ? v : parseNumber(v); if (!Number.isFinite(n)) throw new Error('debe ser un número'); return f.type === 'currency' ? Math.round(n * 100) / 100 : n; }
    case 'boolean': if (typeof v === 'boolean') return v; if (/^(true|1|s[ií]|yes)$/i.test(String(v))) return true; if (/^(false|0|no)$/i.test(String(v))) return false; throw new Error('debe ser sí/no');
    case 'date': case 'datetime': { const d = new Date(v); if (Number.isNaN(+d)) throw new Error('fecha no válida'); if (f.type === 'date') d.setUTCHours(12, 0, 0, 0); return d; }
    case 'picklist': { const m = (f.options || []).find((o) => o.toLowerCase() === String(v).toLowerCase()); if (!m) throw new Error(`valor no permitido (opciones: ${(f.options || []).join(', ')})`); return m; }
    case 'multiselect': { const arr = Array.isArray(v) ? v : String(v).split(/[,;]/); return arr.map((x) => { const m = (f.options || []).find((o) => o.toLowerCase() === String(x).trim().toLowerCase()); if (!m) throw new Error(`"${x}" no es una opción`); return m; }); }
    case 'url': { const u = new URL(String(v).startsWith('http') ? v : `https://${v}`); return u.href; }
    default: return v;
  }
}

/** Esquema de la herramienta del agente generado a partir de los campos que puede rellenar. */
export function agentFieldSchema(fields) {
  const props = {};
  for (const f of fields.filter((x) => x.agentWritable !== false)) {
    const d = `${f.label}${f.aiHint ? `. ${f.aiHint}` : ''}`;
    if (f.type === 'picklist') props[f.key] = { type: 'string', enum: f.options, description: d };
    else if (f.type === 'multiselect') props[f.key] = { type: 'array', items: { type: 'string', enum: f.options }, description: d };
    else if (['number', 'currency'].includes(f.type)) props[f.key] = { type: 'number', description: d };
    else if (f.type === 'boolean') props[f.key] = { type: 'boolean', description: d };
    else props[f.key] = { type: 'string', description: `${d}${f.type === 'date' ? ' (formato AAAA-MM-DD)' : f.type === 'datetime' ? ' (ISO 8601)' : ''}` };
  }
  return { type: 'object', properties: props };
}
