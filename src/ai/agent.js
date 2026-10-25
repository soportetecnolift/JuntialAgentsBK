import { env } from '../config/env.js';
import { runAnthropic } from './providers/anthropic.js';
import { runOpenAI } from './providers/openai.js';
import { llmLatency } from '../lib/metrics.js';
import { createToolset } from './toolset.js';
import { listModels, replacementFor, isModelNotFound } from './models.js';

/** Herramientas que no son "consultas" sino parte de la respuesta: el texto escrito junto a ellas es lo que el usuario debe leer. */
export const SILENT_TOOLS = new Set(['show_options', 'show_button_set', 'request_contact_form', 'capture_lead', 'crm_update_contact', 'crm_get_contact', 'chat_save_note', 'chat_set_project', 'schedule_reminder', 'handoff_human']);
const joinText = (a, b) => { if (!a) return b || ''; if (!b) return a; const na = a.replace(/\s+/g, ' ').trim(); const nb = b.replace(/\s+/g, ' ').trim(); if (nb.includes(na)) return b; if (na.includes(nb)) return a; return `${a.trim()}\n\n${b.trim()}`; };

export function defaultModel(provider) { return provider === 'openai' ? env.DEFAULT_OPENAI_MODEL : env.DEFAULT_CLAUDE_MODEL; }

/**
 * Bucle agente (LLM ↔ herramientas) con el proveedor elegido por el cliente.
 *  tools     → herramientas nativas (siempre presentes)
 *  mcpTools  → catálogo MCP (se envía completo o con búsqueda dinámica según su tamaño)
 *  hot       → claves Redis para recordar las herramientas más usadas (bot/chat)
 *  onText    → recibe el texto en streaming para mostrarlo en Telegram mientras se genera
 */
export async function runAgent({ bot, apiKey, system, turns, tools = [], mcpTools = [], hot, exec, onStep, onText, signal }) {
  const provider = bot.ai.provider;
  const toolset = await createToolset({ core: tools, mcp: mcpTools, hot });
  const wrapped = async (name, args) => {
    if (name === 'find_tools' && toolset.search) { onStep?.(`Buscando herramientas: ${String(args?.query || '').slice(0, 60)}`); return { text: toolset.search(String(args?.query || '')) }; }
    const r = await exec(name, args);
    if (!r?.isError) toolset.record(name);
    return r;
  };
  // Texto acumulado de los pasos con herramientas silenciosas: se conserva en el streaming y en la respuesta final
  let carried = ''; let lastNarration = '';
  const onStepEnd = ({ text, tools: used }) => {
    if (used.length && used.every((t) => SILENT_TOOLS.has(t))) { if (text) { carried = joinText(carried, text); onText?.(carried); } }
    else if (text) { onStep?.(text.slice(0, 120)); if (text.length > lastNarration.length || text.length > 300) lastNarration = text; } // narración previa a una consulta: progreso (y reserva por si la respuesta final llega vacía)
  };
  const streamText = onText ? (snap) => onText(carried ? joinText(carried, snap) : snap) : undefined;
  const end = llmLatency.startTimer({ provider });
  try {
    const args = {
      apiKey, model: bot.ai.model || defaultModel(provider), system, turns, tools: () => toolset.list(), exec: wrapped, onStep, onStepEnd, onText: streamText, signal,
      maxTokens: bot.ai.maxTokens || 1500, temperature: bot.ai.temperature ?? 0.4, maxSteps: bot.ai.maxToolSteps ?? 8,
    };
    const call = (model) => (provider === 'openai' ? runOpenAI({ ...args, model }) : runAnthropic({ ...args, model }));
    let out; let modelChanged = null;
    try { out = await call(args.model); } catch (e) {
      if (signal?.aborted || !isModelNotFound(e)) throw e;
      // Modelo retirado o inexistente: se usa la versión más reciente de su misma familia y se sigue respondiendo
      const { models } = await listModels(provider, apiKey, { force: true });
      const rep = replacementFor(provider, models, args.model);
      if (!rep || rep.id === args.model) throw e;
      onStep?.(`Modelo no disponible, usando ${rep.name}`);
      out = await call(rep.id); modelChanged = { from: args.model, to: rep.id };
    }
    // Si el modelo escribió su informe junto a una última consulta y luego terminó sin texto, se usa ese informe
    const text = joinText(carried, out.text).trim() || (lastNarration.length > 200 ? lastNarration.trim() : '');
    return { ...out, text, modelChanged, toolMode: toolset.mode, toolsOffered: toolset.offered(), catalogSize: mcpTools.length };
  } finally { end(); }
}
