import OpenAI from 'openai';

const toContent = (parts, role) => {
  if (role === 'assistant') return parts.map((p) => p.text || '').join('\n');
  return parts.map((p) => {
    if (p.type === 'image') return { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } };
    if (p.type === 'pdf') return { type: 'file', file: { filename: p.name || 'doc.pdf', file_data: `data:application/pdf;base64,${p.data}` } };
    return { type: 'text', text: p.text || ' ' };
  });
};
// OpenAI cachea automáticamente el prefijo común (>1024 tokens): instrucciones fijas primero, contexto variable después.
const systemMessages = (system) => [typeof system === 'string' ? system : system?.static, typeof system === 'string' ? '' : system?.dynamic]
  .map((t) => String(t || '').trim()).filter(Boolean).map((content) => ({ role: 'system', content }));

const NO_TEMPERATURE = new Set();
const supportsTemperature = (m) => /^gpt-4/.test(m) && !NO_TEMPERATURE.has(m);
async function request(client, params, onText, signal) {
  const run = async (p) => {
    if (!onText) return client.chat.completions.create(p, { signal });
    const stream = client.beta.chat.completions.stream({ ...p, stream_options: { include_usage: true } }, { signal });
    stream.on('content', (_d, snapshot) => onText(snapshot));
    return stream.finalChatCompletion();
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

export async function runOpenAI({ apiKey, model, system, turns, tools, exec, onStep, onStepEnd, onText, maxTokens, temperature, maxSteps, signal }) {
  const client = new OpenAI({ apiKey, maxRetries: 3, timeout: 120000 });
  const clean = turns.map((t) => ({ ...t, parts: (t.parts || []).filter((p) => p.type !== 'text' || (p.text && String(p.text).trim())) })).filter((t) => t.parts.length);
  const messages = [...systemMessages(system), ...clean.map((t) => ({ role: t.role, content: toContent(t.parts, t.role) }))];
  const usage = { in: 0, out: 0, cacheRead: 0 }; const calls = []; const timing = { llmMs: 0, toolMs: 0, steps: 0 };
  for (let step = 0; step <= maxSteps; step++) {
    const list = typeof tools === 'function' ? tools() : tools;
    const t0 = Date.now();
    const resp = await request(client, {
      model, messages, max_completion_tokens: maxTokens, ...(supportsTemperature(model) ? { temperature } : {}),
      ...(list.length && step < maxSteps ? { tools: list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })), parallel_tool_calls: true } : {}),
    }, onText, signal);
    timing.llmMs += Date.now() - t0; timing.steps++;
    usage.in += resp.usage?.prompt_tokens || 0; usage.out += resp.usage?.completion_tokens || 0; usage.cacheRead += resp.usage?.prompt_tokens_details?.cached_tokens || 0;
    const msg = resp.choices[0].message;
    if (!msg.tool_calls?.length) return { text: (msg.content || '').trim(), usage, calls, timing  };
    if (onStepEnd) onStepEnd({ text: (msg.content || '').trim(), tools: msg.tool_calls.map((t) => t.function.name) }); else if (msg.content) onStep?.(msg.content.slice(0, 120));
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    if (signal?.aborted) throw Object.assign(new Error('Cancelado'), { name: 'AbortError' });
    const t1 = Date.now();
    const results = await Promise.all(msg.tool_calls.map(async (tc) => {
      let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* args vacíos */ }
      const r = await exec(tc.function.name, args).catch((e) => ({ isError: true, text: e.message }));
      calls.push({ name: tc.function.name, ok: !r.isError });
      return { role: 'tool', tool_call_id: tc.id, content: r.isError ? `ERROR: ${r.text}` : (r.text || '') };
    }));
    timing.toolMs += Date.now() - t1;
    messages.push(...results);
  }
  return { text: 'He alcanzado el límite de pasos para esta consulta.', usage, calls, timing };
}
