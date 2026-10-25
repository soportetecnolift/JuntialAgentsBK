/** Motor de criterios (equivalente al "criterio" de las reglas de Zoho). */
export const OPERATORS = {
  equals: 'es igual a', not_equals: 'no es igual a', contains: 'contiene', not_contains: 'no contiene', starts_with: 'empieza por',
  is_empty: 'está vacío', is_not_empty: 'no está vacío', gt: 'mayor que', gte: 'mayor o igual que', lt: 'menor que', lte: 'menor o igual que',
  in: 'es uno de', not_in: 'no es ninguno de', changed: 'ha cambiado', changed_to: 'ha cambiado a',
  before: 'es anterior a', after: 'es posterior a', in_last_days: 'en los últimos N días', in_next_days: 'en los próximos N días', is_true: 'es verdadero', is_false: 'es falso',
};
const norm = (v) => (v == null ? '' : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(String).join(',').toLowerCase() : String(v).toLowerCase());
const num = (v) => (v instanceof Date ? +v : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? +new Date(v) : Number(v));
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

export function check(rule, data, changes = {}) {
  const v = data?.[rule.field]; const t = rule.value;
  switch (rule.op) {
    case 'equals': return norm(v) === norm(t);
    case 'not_equals': return norm(v) !== norm(t);
    case 'contains': return Array.isArray(v) ? list(v).includes(norm(t)) : norm(v).includes(norm(t));
    case 'not_contains': return !(Array.isArray(v) ? list(v).includes(norm(t)) : norm(v).includes(norm(t)));
    case 'starts_with': return norm(v).startsWith(norm(t));
    case 'is_empty': return v == null || v === '' || (Array.isArray(v) && !v.length);
    case 'is_not_empty': return !(v == null || v === '' || (Array.isArray(v) && !v.length));
    case 'gt': return num(v) > num(t); case 'gte': return num(v) >= num(t);
    case 'lt': return num(v) < num(t); case 'lte': return num(v) <= num(t);
    case 'in': return list(t).includes(norm(v));
    case 'not_in': return !list(t).includes(norm(v));
    case 'changed': return rule.field in changes;
    case 'changed_to': return rule.field in changes && norm(v) === norm(t);
    case 'before': return v != null && num(v) < num(t);
    case 'after': return v != null && num(v) > num(t);
    case 'in_last_days': return v != null && num(v) <= Date.now() && num(v) >= Date.now() - Number(t) * 86400000;
    case 'in_next_days': return v != null && num(v) >= Date.now() && num(v) <= Date.now() + Number(t) * 86400000;
    case 'is_true': return v === true; case 'is_false': return v !== true;
    default: return false;
  }
}
export function evaluate(conditions, data, changes) {
  const rules = conditions?.rules || []; if (!rules.length) return true;
  return conditions.match === 'any' ? rules.some((r) => check(r, data, changes)) : rules.every((r) => check(r, data, changes));
}
