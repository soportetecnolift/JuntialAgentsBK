/**
 * Puesta a punto del empleado digital: antes de dejarlo trabajar solo, comprueba contra el conector REAL
 * qué campos y valores que el blueprint declara existen de verdad. Nace de un fallo real (Lucia, Tecnolift):
 * su manual daba por hecho un campo "Fabricado" que no existe, y tardamos varias ejecuciones en producción
 * en descubrirlo. Este módulo hace esa comprobación una sola vez, de forma dirigida, antes de activarlo.
 *
 * No usa performTool/workerTools del motor (de propósito: aquí solo se permite LEER del conector, nunca
 * escribir, pase lo que pase en el blueprint o en la instrucción).
 */
import { Bot } from '../../models/index.js';
import { runAgent } from '../../ai/agent.js';
import { loadTools, callTool } from '../mcp/client.js';
import { categorize } from './engine.js';
import { getBotRuntime } from '../../telegram/runtime.js';
import { renderBlueprint, blueprintCompleteness } from './blueprint.js';

const parseJson = (t) => { const s = String(t || '').replace(/```json|```/g, ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}'); return JSON.parse(s.slice(a, b + 1)); };

/** Extrae candidatos a "nombre de campo" mencionados en el manual, para dárselos como lista de partida a verificar. */
function extractFieldCandidates(instructions) {
  const found = new Set();
  // nombres tipo Campo_Con_Guion_Bajo o CamelCase que parezcan API name (letras/números/guion bajo, longitud >= 3)
  for (const m of String(instructions || '').matchAll(/\b[A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g)) found.add(m[0]);
  for (const m of String(instructions || '').matchAll(/\b[a-z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/g)) found.add(m[0]);
  return [...found].slice(0, 60);
}

/**
 * Ejecuta la puesta a punto: el modelo usa SOLO herramientas de lectura del conector para intentar
 * confirmar cada campo candidato y cada valor de estado declarado. Devuelve un informe estructurado,
 * no modifica nada y no cuenta como una "tarea" del empleado (no genera WorkerRun).
 */
export async function runOnboardingCheck(botId) {
  const rt = await getBotRuntime(botId); if (!rt || rt.bot.kind !== 'worker') throw new Error('Empleado digital no encontrado');
  const { bot } = rt; if (!rt.aiKey) throw new Error('Falta la API key de IA del agente');
  const bp = bot.worker?.blueprint || {};
  const instructions = bot.worker?.knowledge?.instructions || renderBlueprint(bp);
  const completeness = blueprintCompleteness(bp);
  const candidates = [...new Set([...extractFieldCandidates(instructions), bp.stateField].filter(Boolean))];

  const { tools: mcpTools, routes } = await loadTools(bot.mcpServerIds || []);
  const readOnly = mcpTools.filter((t) => categorize(t.name, t.annotations) === 'read');
  if (!readOnly.length) return { ok: false, skipped: true, reason: 'Este empleado no tiene ningún conector con herramientas de solo lectura conectado todavía.', completeness, candidates };

  const exec = async (name, args) => {
    const route = routes.get(name); if (!route) return { isError: true, text: 'Herramienta no disponible en la puesta a punto (solo lectura).' };
    try { const r = await callTool(route, args); return { text: r.text, isError: r.isError }; } catch (e) { return { isError: true, text: e.message }; }
  };

  const system = {
    static: [
      'Eres un verificador técnico. Tu única tarea es comprobar, usando las herramientas de SOLO LECTURA disponibles, si los campos y valores mencionados abajo existen de verdad en el sistema conectado.',
      'No redactes recomendaciones de negocio ni opines sobre el proceso: solo constata hechos técnicos (existe / no existe / no se pudo comprobar) con una prueba mínima real (una consulta de ejemplo, un registro de muestra).',
      'Si un campo aparentemente similar existe con otro nombre, indícalo como posible alternativa.',
      candidates.length ? `Campos a comprobar (nombres mencionados en el manual del puesto): ${candidates.join(', ')}` : 'No se detectaron nombres de campo explícitos en el manual; intenta listar los campos principales disponibles.',
      bp.stateField ? `Campo de estado declarado: "${bp.stateField}". Comprueba también si los valores declarados como reales existen entre las opciones de ese campo: ${bp.allStateValues || '(no se listaron valores)'}` : '',
      'Responde SOLO con un JSON: {"confirmed": [{"field": string, "note": string}], "notFound": [{"field": string, "suggestion": string|null}], "stateValuesNotFound": [string], "extraStateValues": [string], "summary": string (2-4 frases)}',
    ].filter(Boolean).join('\n\n'),
    dynamic: '',
  };
  const res = await runAgent({
    bot: { ...bot, ai: { ...bot.ai, maxToolSteps: 10, maxTokens: 3000 } }, apiKey: rt.aiKey, system,
    turns: [{ role: 'user', parts: [{ type: 'text', text: 'Verifica los campos y valores indicados y devuelve el JSON.' }] }],
    tools: [], mcpTools: readOnly, exec,
  });
  let report; try { report = parseJson(res.text); } catch { report = { confirmed: [], notFound: [], stateValuesNotFound: [], extraStateValues: [], summary: res.text.slice(0, 1500) }; }
  return { ok: true, completeness, candidates, ...report, checkedAt: new Date() };
}

export async function saveOnboardingResult(botId, result) {
  await Bot.updateOne({ _id: botId }, { 'worker.onboarding': { ...result, checkedAt: new Date() } });
}
