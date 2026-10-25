import { redis } from '../lib/redis.js';

/**
 * Selección dinámica de herramientas.
 * Con pocos conectores (≤ SEARCH_THRESHOLD herramientas) se envían todas, como siempre.
 * Con catálogos grandes (p. ej. Zoho Books ~300 herramientas) enviar todas en cada llamada hace al modelo
 * más lento, más caro y peor eligiendo. En ese caso el modelo recibe:
 *   - las herramientas nativas,
 *   - las "calientes" (las más usadas por este bot y en este chat),
 *   - y `find_tools`, que busca en el catálogo COMPLETO y activa las encontradas al instante.
 * No se pierde ninguna capacidad: todas siguen siendo accesibles.
 */
export const SEARCH_THRESHOLD = 30;
const HOT_LIMIT = 12; const RESULTS = 10; const MAX_ACTIVE = 40;
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const stem = (w) => w.replace(/(iones|ion|es|s)$/, '');

export async function createToolset({ core = [], mcp = [], hot }) {
  const byName = new Map(mcp.map((t) => [t.name, t]));
  const isMcp = (n) => byName.has(n);
  const record = (name) => {
    if (!hot || !isMcp(name)) return;
    redis.multi().zincrby(hot.bot, 1, name).expire(hot.bot, 30 * 86400)
      .sadd(hot.chat, name).expire(hot.chat, 7 * 86400).exec().catch(() => {});
  };
  if (mcp.length <= SEARCH_THRESHOLD) return { mode: 'all', list: () => [...core, ...mcp], isMcp, record, search: null, offered: () => core.length + mcp.length };

  const active = new Set();
  if (hot) {
    const [botHot, chatHot] = await Promise.all([redis.zrevrange(hot.bot, 0, HOT_LIMIT - 1), redis.smembers(hot.chat)]).catch(() => [[], []]);
    for (const n of [...chatHot, ...botHot]) if (byName.has(n) && active.size < HOT_LIMIT) active.add(n);
  }
  const index = mcp.map((t) => ({ t, name: norm(t.name.replace(/[_-]+/g, ' ')), desc: norm(t.description) }));
  const perServer = mcp.reduce((m, t) => { const s = t.description.match(/^\[([^\]]+)\]/)?.[1] || 'MCP'; m[s] = (m[s] || 0) + 1; return m; }, {});
  const summary = Object.entries(perServer).map(([s, n]) => `${s}: ${n}`).join(', ');
  const finder = {
    name: 'find_tools',
    description: `Busca y activa herramientas de los conectores (${summary}). Hay demasiadas para tenerlas todas cargadas: cuando necesites una capacidad que no veas en tu lista, llama a esta herramienta con palabras clave en inglés Y en español (ej.: "invoice factura list listar customer cliente"). Las encontradas quedan disponibles para usarlas en el siguiente paso.`,
    schema: { type: 'object', properties: { query: { type: 'string', description: 'Palabras clave de la acción y el objeto, en inglés y español' } }, required: ['query'] },
  };

  return {
    mode: 'search', isMcp, record,
    list: () => [...core, finder, ...[...active].map((n) => byName.get(n))],
    offered: () => core.length + 1 + active.size,
    search(query) {
      const terms = [...new Set(norm(query).split(/[^a-z0-9]+/).filter((w) => w.length > 2).map(stem))];
      if (!terms.length) return 'Escribe palabras clave más concretas.';
      const ranked = index.map((x) => {
        let score = 0; let hits = 0;
        for (const w of terms) { const n = x.name.includes(w); const d = x.desc.includes(w); if (n) score += 3; if (d) score += 1; if (n || d) hits++; }
        return { x, score: score + hits * 2 };
      }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, RESULTS);
      if (!ranked.length) return `Sin coincidencias para "${query}". Prueba otros términos (en inglés suelen funcionar mejor: list, get, create, update, search, invoice, contact, deal…).`;
      for (const r of ranked) {
        if (active.size >= MAX_ACTIVE) active.delete(active.values().next().value);
        active.add(r.x.t.name);
      }
      return `Herramientas activadas (ya puedes llamarlas):\n${ranked.map((r) => `- ${r.x.t.name}: ${r.x.t.description.slice(0, 160)}`).join('\n')}`;
    },
  };
}
