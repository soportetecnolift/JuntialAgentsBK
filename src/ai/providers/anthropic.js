import Anthropic from '@anthropic-ai/sdk';

// Claude rechaza la petición ENTERA si un bloque de texto está vacío: se filtran siempre
const toBlocks = (parts) => (parts || []).map((p) => {
  if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } };
  if (p.type === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } };
  return p.text && String(p.text).trim() ? { type: 'text', text: String(p.text) } : null;
}).filter(Boolean);
function toMessages(turns) {
  const out = [];
  for (const t of turns) {
    const blocks = toBlocks(t.parts); if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last?.role === t.role) last.content.push(...blocks); else out.push({ role: t.role, content: blocks });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(inicio de conversación)' }] });
  if (out.at(-1)?.role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: '(continúa)' }] });
  return out;
}

/**
 * Prompt caching: herramientas e instrucciones fijas se cachean (≈90 % menos coste y menos latencia en esa parte).
 * El contexto que cambia (fecha, chat, notas) va DESPUÉS del punto de caché para no invalidarlo.
 * Máx. 4 puntos de caché: herramientas, sistema fijo y el último mensaje (para los pasos siguientes del bucle).
 */
const EPHEMERAL = { type: 'ephemeral' };
// Anthropic rechaza bloques de sistema vacíos (y más aún con cache_control): solo se envían los que tienen texto
const systemBlocks = (system) => {
  const st = (typeof system === 'string' ? system : system?.static || '').trim();
  const dy = (typeof system === 'string' ? '' : system?.dynamic || '').trim();
  const blocks = [];
  if (st) blocks.push({ type: 'text', text: st, cache_control: EPHEMERAL });
  if (dy) blocks.push({ type: 'text', text: dy });
  return blocks.length ? blocks : undefined;
};
function markLastMessage(messages) {
  for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.cache_control) delete b.cache_control;
  const last = messages[messages.length - 1];
  const block = Array.isArray(last?.content) ? last.content[last.content.length - 1] : null;
  if (block && ['text', 'tool_result', 'image', 'document'].includes(block.type)) block.cache_control = EPHEMERAL;
}

// Los modelos Claude más recientes rechazan `temperature`: se detecta en el primer error y se recuerda por modelo.
const NO_TEMPERATURE = new Set();
async function request(client, params, onText, signal) {
  const run = async (p) => {
    if (!onText) return client.messages.create(p, { signal });
    const stream = client.messages.stream(p, { signal }); let acc = '';
    stream.on('text', (d) => { acc += d; onText(acc); });
    return stream.finalMessage();
  };
  try { return await run(params); } catch (e) {
    if (e.status === 400 && /temperature/i.test(e.message || '') && 'temperature' in params) {
      NO_TEMPERATURE.add(params.model);
      const { temperature, ...rest } = params; // eslint-disable-line no-unused-vars
      return run(rest);
    }
    throw e;
  }
}

export async function runAnthropic({ apiKey, model, system, turns, tools, exec, onStep, onStepEnd, onText, maxTokens, temperature, maxSteps, signal }) {
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 120000 });
  const messages = toMessages(turns);
  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }; const calls = []; const timing = { llmMs: 0, toolMs: 0, steps: 0 };
  let nudges = 0; let carryText = '';
  for (let step = 0; step <= maxSteps; step++) {
    const list = typeof tools === 'function' ? tools() : tools;
    const defs = step < maxSteps ? list.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) : [];
    if (defs.length) defs[defs.length - 1].cache_control = EPHEMERAL;
    markLastMessage(messages);
    const t0 = Date.now();
    const resp = await request(client, {
      model, max_tokens: maxTokens, system: systemBlocks(system), messages,
      ...(NO_TEMPERATURE.has(model) || temperature == null ? {} : { temperature }),
      ...(defs.length ? { tools: defs } : {}),
    }, onText, signal);
    timing.llmMs += Date.now() - t0; timing.steps++;
    usage.in += resp.usage?.input_tokens || 0; usage.out += resp.usage?.output_tokens || 0;
    usage.cacheRead += resp.usage?.cache_read_input_tokens || 0; usage.cacheWrite += resp.usage?.cache_creation_input_tokens || 0;
    const uses = resp.content.filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !uses.length) {
      const txt = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      // Respuesta cortada por longitud, o anuncio de una acción sin hacerla («vuelvo a consultar…»): se le pide que continúe
      const cut = resp.stop_reason === 'max_tokens';
      const announced = !cut && step < maxSteps && txt.length < 400 && /(^|\n)\s*(voy a|vuelvo a|ahora (voy|consulto|reviso|busco)|a continuaci[oó]n (voy|consulto|reviso)|procedo a|déjame|permíteme)/i.test(txt);
      if ((cut || announced) && nudges < 2 && step < maxSteps) {
        nudges++; if (cut) carryText += txt;
        const content = resp.content.filter((b) => b.type === 'text' && b.text.trim());
        if (content.length) messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: [{ type: 'text', text: cut ? '(Tu respuesta se cortó por longitud. Si ibas a usar una herramienta, úsala ahora con parámetros más acotados; si no, continúa el texto exactamente donde lo dejaste, de forma más concisa.)' : '(Hazlo ahora: usa las herramientas que necesitas en vez de anunciarlo, y termina con el informe completo.)' }] });
        continue;
      }
      return { text: `${carryText}${txt}`.trim(), usage, calls, timing };
    }
    const stepText = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (onStepEnd) onStepEnd({ text: stepText, tools: uses.map((u) => u.name) }); else if (stepText) onStep?.(stepText.slice(0, 120));
    carryText = ''; // si tras un corte pasa a usar herramientas, el texto cortado era solo un anuncio: se descarta
    messages.push({ role: 'assistant', content: resp.content });
    if (signal?.aborted) throw Object.assign(new Error('Cancelado'), { name: 'AbortError' });
    // Herramientas independientes en PARALELO (el modelo puede pedir varias a la vez)
    const t1 = Date.now();
    const results = await Promise.all(uses.map(async (u) => {
      const r = await exec(u.name, u.input).catch((e) => ({ isError: true, text: e.message }));
      calls.push({ name: u.name, ok: !r.isError });
      return { type: 'tool_result', tool_use_id: u.id, content: r.text || '', is_error: !!r.isError };
    }));
    timing.toolMs += Date.now() - t1;
    messages.push({ role: 'user', content: results });
  }
  return { text: 'He alcanzado el límite de pasos para esta consulta.', usage, calls, timing };
}
