import { newAsyncContext, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { CrmRecord, CrmFunction, FunctionRun, Bot, Tenant, daysFromNow } from '../../models/index.js';
import { decrypt } from '../../lib/crypto.js';
import { Q } from '../../lib/queues.js';
import { notify } from '../notifications/service.js';
import { saveRecord } from './records.js';
import { safeUrl } from './net.js';

/**
 * Funciones personalizadas en JavaScript, aisladas en QuickJS (WebAssembly):
 *  - Sin acceso a Node, al sistema de archivos, a la red ni a otros clientes: solo al SDK `jx`.
 *  - Límites: 32 MB de memoria, tiempo máximo configurable (10 s por defecto), 10 llamadas HTTP, 5 emails.
 *  - Las llamadas jx.* son síncronas, como en Deluge (no hace falta await).
 */
const PRELUDE = `
const __call = (n, a) => { const r = JSON.parse(__host(n, JSON.stringify(a === undefined ? null : a))); if (!r.ok) throw new Error(r.e); return r.v; };
const __fmt = (x) => typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })();
const jx = Object.freeze({
  records: Object.freeze({
    get: (id) => __call('records.get', { id }),
    update: (id, data) => __call('records.update', { id, data }),
    create: (data) => __call('records.create', { data }),
    search: (criteria, limit) => __call('records.search', { criteria, limit }),
  }),
  http: Object.freeze({
    request: (o) => __call('http.request', o),
    get: (url, o) => __call('http.request', Object.assign({}, o, { url, method: 'GET' })),
    post: (url, body, o) => __call('http.request', Object.assign({}, o, { url, method: 'POST', body })),
  }),
  telegram: Object.freeze({ send: (o) => __call('telegram.send', o) }),
  connections: Object.freeze({ request: (name, o) => __call('connections.request', Object.assign({}, o, { name })) }),
  email: Object.freeze({ send: (o) => __call('email.send', o) }),
  notify: (title, body) => __call('notify', { title, body }),
  env: Object.freeze(__env),
  log: (...a) => __log('log', a.map(__fmt).join(' ')),
  info: (...a) => __log('info', a.map(__fmt).join(' ')),
  warn: (...a) => __log('warn', a.map(__fmt).join(' ')),
  error: (...a) => __log('error', a.map(__fmt).join(' ')),
});
const console = { log: jx.log, info: jx.info, warn: jx.warn, error: jx.error, debug: jx.log, table: (x) => jx.log(x) };
`;
const LIMITS = { http: 10, email: 5, telegram: 10, records: 50, logs: 200 };

export async function runFunction({ fn, input, tenantId, depth = 0, ruleId, recordId, trigger = 'manual' }) {
  const logs = []; const trace = []; const used = { http: 0, email: 0, telegram: 0, records: 0 }; const t0 = Date.now();
  const brief = (v, n = 1500) => { try { const x = typeof v === 'string' ? v : JSON.stringify(v); return x && x.length > n ? `${x.slice(0, n)}…` : x; } catch { return String(v); } };
  const env = fn.envEnc ? JSON.parse(decrypt(fn.envEnc) || '{}') : {};
  const tenant = await Tenant.findById(tenantId).lean();
  const bump = (k) => { if (++used[k] > LIMITS[k]) throw new Error(`Límite de ${LIMITS[k]} llamadas ${k} por ejecución`); };
  const rec = (r) => (r ? { id: String(r._id), ...r.data, _createdAt: r.createdAt, _updatedAt: r.updatedAt } : null);

  const host = async (name, a) => {
    switch (name) {
      case 'records.get': bump('records'); return rec(await CrmRecord.findOne({ _id: a?.id || input.record?.id, tenantId }).lean());
      case 'records.update': bump('records'); return rec((await saveRecord({ tenantId, id: a?.id || input.record?.id, data: a?.data || {}, by: 'function', depth: depth + 1 })).record);
      case 'records.create': bump('records'); return rec((await saveRecord({ tenantId, data: a?.data || {}, by: 'function', depth: depth + 1 })).record);
      case 'records.search': {
        bump('records'); const q = { tenantId };
        for (const [k, v] of Object.entries(a?.criteria || {})) { if (!/^[a-z_][a-z0-9_]{0,40}$/i.test(k)) throw new Error(`Campo no válido: ${k}`); q[`data.${k}`] = v; }
        return (await CrmRecord.find(q).sort({ updatedAt: -1 }).limit(Math.min(Number(a?.limit) || 20, 50)).lean()).map(rec);
      }
      case 'http.request': {
        bump('http'); const url = await safeUrl(String(a?.url || ''));
        const method = String(a?.method || 'GET').toUpperCase();
        const headers = { 'user-agent': 'JuntialAgents-Functions/1.0', ...(a?.headers || {}) };
        let body = a?.body;
        if (body != null && typeof body !== 'string') { body = JSON.stringify(body); headers['content-type'] ||= 'application/json'; }
        const r = await fetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(Math.min(Number(a?.timeoutMs) || 8000, 15000)) });
        const text = (await r.text()).slice(0, 1_000_000); let json = null; try { json = JSON.parse(text); } catch { /* no es JSON */ }
        return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), body: json ?? text };
      }
      case 'telegram.send': {
        bump('telegram'); const botId = a?.botId || input.ctx?.agentId;
        const bot = botId ? await Bot.findOne({ _id: botId, tenantId, kind: { $ne: 'web' } }).lean() : null;
        if (!bot) throw new Error('Indica botId de un bot de Telegram de tu cuenta');
        if (!a?.chatId || !a?.text) throw new Error('Faltan chatId o text');
        await Q.inbound.add('api-send', { botId: String(bot._id), chatIds: [Number(a.chatId)], mode: 'message', text: String(a.text).slice(0, 4000) }, { attempts: 3 });
        return { queued: true };
      }
      case 'email.send': {
        bump('email'); const to = String(a?.to || '').split(',').map((x) => x.trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x));
        if (!to.length || !a?.subject) throw new Error('Faltan "to" válido o "subject"');
        for (const t of to.slice(0, 5)) await Q.email.add('send', { to: t, subject: String(a.subject).slice(0, 200), title: String(a.subject).slice(0, 200), body: String(a.body || '').slice(0, 20000) }, { attempts: 3 });
        return { queued: to.length };
      }
      case 'connections.request': { bump('http'); const { connectionRequest } = await import('../center/connections.js'); return connectionRequest(tenantId, String(a?.name || ''), a || {}); }
      case 'notify': await notify(tenant.ownerId, 'crm.workflow', { title: String(a?.title || 'Aviso de función').slice(0, 140), body: String(a?.body || '').slice(0, 500) }); return { ok: true };
      default: throw new Error(`Función desconocida: ${name}`);
    }
  };

  let status = 'ok'; let result = null; let error = null; let errorAt = null; const vm = await newAsyncContext();
  try {
    vm.runtime.setMemoryLimit(32 * 1024 * 1024); vm.runtime.setMaxStackSize(512 * 1024);
    vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + Math.min(fn.timeoutMs || 10000, 30000)));
    const h = vm.newAsyncifiedFunction('__host', async (nH, aH) => {
      const name = vm.getString(nH); const args = JSON.parse(vm.getString(aH)); const t1 = Date.now();
      const entry = { t: t1 - t0, name, args: brief(args, 800) };
      if (name === 'http.request' || name === 'connections.request') entry.http = { method: String(args?.method || 'GET').toUpperCase(), url: `${name === 'connections.request' ? `[${args?.name}] ` : ''}${String(args?.url || '')}` };
      try {
        const v = await host(name, args); entry.ms = Date.now() - t1; entry.ok = true; entry.result = brief(v);
        if (entry.http) Object.assign(entry.http, { status: v?.status, bytes: JSON.stringify(v?.body ?? '').length });
        trace.push(entry); return vm.newString(JSON.stringify({ ok: true, v: v ?? null }));
      } catch (e) { entry.ms = Date.now() - t1; entry.ok = false; entry.error = e.message; trace.push(entry); return vm.newString(JSON.stringify({ ok: false, e: e.message })); }
    });
    vm.setProp(vm.global, '__host', h); h.dispose();
    const lg = vm.newFunction('__log', (lv, s) => { if (logs.length < LIMITS.logs) logs.push({ t: Date.now() - t0, level: vm.getString(lv), msg: vm.getString(s).slice(0, 4000) }); });
    vm.setProp(vm.global, '__log', lg); lg.dispose();
    const head = `const __env = ${JSON.stringify(env)};\nconst __input = ${JSON.stringify(input)};\n${PRELUDE}\n`;
    const offset = head.split('\n').length - 1; // líneas añadidas antes del código del usuario
    const code = `${head}${fn.code}\n;(() => {
      if (typeof main !== 'function') throw new Error('Define una función main(record, ctx)');
      const r = main(__input.record, __input.ctx);
      if (r && typeof r.then === 'function') throw new Error('main no debe ser async: las llamadas jx.* ya son síncronas');
      return JSON.stringify(r === undefined ? null : r);
    })()`;
    const res = await vm.evalCodeAsync(code, `${fn.apiName || 'funcion'}.js`);
    if (res.error) {
      const e = vm.dump(res.error); res.error.dispose(); status = 'error';
      const stack = typeof e === 'object' ? String(e.stack || '') : '';
      // Primera línea de la pila que cae dentro del código del usuario → línea y columna reales en el editor
      const userLines = fn.code.split('\n').length;
      for (const m of stack.matchAll(/:(\d+)(?::(\d+))?\)?\s*$/gm)) { const ln = Number(m[1]) - offset; if (ln >= 1 && ln <= userLines) { errorAt = { line: ln, column: Number(m[2] || 1) }; break; } }
      error = typeof e === 'object' ? `${e.name || 'Error'}: ${e.message}` : String(e);
      if (/interrupted/i.test(error)) error = `Tiempo máximo superado (${(fn.timeoutMs || 10000) / 1000} s)`;
      if (/SyntaxError/.test(error) && !errorAt) { const m = String(e.message || '').match(/line (\d+)/); if (m) errorAt = { line: Math.max(1, Number(m[1]) - offset), column: 1 }; }
    }
    else { const out = vm.getString(res.value); res.value.dispose(); result = JSON.parse(out); }
  } catch (e) { status = 'error'; error = /memory/i.test(e.message) ? 'Memoria máxima superada (32 MB)' : e.message; }
  finally { try { vm.dispose(); } catch { /* ya liberado */ } }
  const ms = Date.now() - t0;
  if (fn._id) {
    FunctionRun.create({ functionId: fn._id, tenantId, recordId, ruleId, status, ms, logs, trace, errorAt, input: brief(input, 4000), result: JSON.parse(JSON.stringify(result ?? null)), error, trigger, expiresAt: daysFromNow(30) }).catch(() => {});
    CrmFunction.updateOne({ _id: fn._id }, { $inc: { 'stats.runs': 1, 'stats.errors': status === 'error' ? 1 : 0 }, 'stats.lastRunAt': new Date() }).catch(() => {});
  }
  return { status, ms, logs, trace, result, error, errorAt, usage: { ...used } };
}
