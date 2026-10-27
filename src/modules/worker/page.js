import { Router, json } from 'express';
import { WorkerMessage } from '../../models/index.js';
import { takeToken } from '../../lib/redis.js';
import { resolveLink, talkToWorker } from './conversation.js';

/** Página de chat personal con el empleado digital: /w/<enlace>. Sin login: el enlace identifica a la persona. */
export const workerPage = Router();
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

workerPage.get('/:token', async (req, res) => {
  const ctx = await resolveLink(req.params.token);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  if (!ctx) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;text-align:center"><h2>Enlace no válido</h2><p>Pide uno nuevo a tu responsable.</p></body>');
  const agent = ctx.bot.worker?.title || ctx.bot.name; const first = ctx.person.name.split(' ')[0];
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(agent)}</title><meta name="theme-color" content="#16324F">
<style>
:root{--bg:#f4f6f8;--card:#fff;--ink:#14202b;--soft:#5b6673;--me:#0E7C86;--me-ink:#fff;--line:#e3e8ee}
@media (prefers-color-scheme:dark){:root{--bg:#0f1720;--card:#17222e;--ink:#e6edf3;--soft:#93a1b0;--line:#26323f}}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:12px;padding:calc(12px + env(safe-area-inset-top)) 16px 12px;background:#16324F;color:#fff}
header .av{width:40px;height:40px;border-radius:50%;background:#0E7C86;display:grid;place-items:center;font-weight:700}
header b{display:block}header span{font-size:13px;opacity:.75}
main{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.m{max-width:min(82%,560px);padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.06)}
.a{background:var(--card);border-bottom-left-radius:5px;align-self:flex-start}.u{background:var(--me);color:var(--me-ink);border-bottom-right-radius:5px;align-self:flex-end}
.t{font-size:11px;opacity:.6;margin-top:3px}.typing{color:var(--soft);font-style:italic;align-self:flex-start}
form{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:var(--card);border-top:1px solid var(--line)}
textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:22px;padding:10px 16px;font:inherit;background:var(--bg);color:var(--ink);max-height:140px}
button{width:46px;height:46px;border:0;border-radius:50%;background:var(--me);color:#fff;font-size:20px;cursor:pointer}button:disabled{opacity:.5}
.hint{color:var(--soft);font-size:14px;text-align:center;margin:8px auto 12px;max-width:420px}
</style></head><body>
<header><div class="av">${esc(agent.slice(0, 1).toUpperCase())}</div><div><b>${esc(agent)}</b><span>Hablas como ${esc(ctx.person.name)}${ctx.person.canApprove ? ' · puedes aprobar sus cambios' : ''}</span></div></header>
<main id="log"><p class="hint">Hola ${esc(first)} 👋 Escríbeme como a un compañero: qué necesitas, qué te preocupa o qué ha cambiado.</p></main>
<form id="f"><textarea id="t" rows="1" placeholder="Escribe un mensaje" aria-label="Mensaje"></textarea><button id="b" aria-label="Enviar">➤</button></form>
<script>
const T=${JSON.stringify(req.params.token)};const log=document.getElementById('log'),t=document.getElementById('t'),b=document.getElementById('b');
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');const md=s=>esc(s).replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>');
function add(role,text,at){const d=document.createElement('div');d.className='m '+(role==='user'?'u':'a');d.innerHTML=md(text)+(at?'<div class="t">'+new Date(at).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})+'</div>':'');log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
fetch(T+'/history').then(r=>r.json()).then(h=>h.forEach(m=>add(m.role,m.text,m.createdAt))).catch(()=>{});
t.addEventListener('input',()=>{t.style.height='auto';t.style.height=Math.min(t.scrollHeight,140)+'px'});
t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('f').requestSubmit()}});
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const text=t.value.trim();if(!text)return;t.value='';t.style.height='auto';add('user',text,Date.now());b.disabled=true;
const w=add('agent','escribiendo…');w.className='typing';
try{const r=await fetch(T+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});const j=await r.json();w.remove();add('agent',j.reply||j.error||'No he podido responder.',Date.now())}
catch{w.remove();add('agent','Se ha cortado la conexión. Vuelve a intentarlo.')}finally{b.disabled=false;t.focus()}});
</script></body></html>`);
});

workerPage.get('/:token/history', async (req, res) => {
  const ctx = await resolveLink(req.params.token); if (!ctx) return res.status(404).json([]);
  const rows = await WorkerMessage.find({ botId: ctx.bot._id, conv: ctx.conv }).sort({ createdAt: -1 }).limit(40).select('role text createdAt').lean();
  res.json(rows.reverse());
});

workerPage.post('/:token/send', json({ limit: '64kb' }), async (req, res) => {
  const ctx = await resolveLink(req.params.token); if (!ctx) return res.status(404).json({ error: 'Enlace no válido' });
  if ((await takeToken(`wpage:${req.params.token.slice(-12)}`, 0.25, 6)) > 0) return res.status(429).json({ error: 'Vas muy rápido: espera unos segundos.' });
  const text = String(req.body?.text || '').trim().slice(0, 4000); if (!text) return res.status(400).json({ error: 'Mensaje vacío' });
  try { const out = await talkToWorker(ctx.bot._id, { text, person: ctx.person, channel: 'page', conv: ctx.conv }); res.json({ reply: out.reply }); }
  catch (e) { res.status(500).json({ error: 'No he podido responder ahora mismo. Inténtalo en un momento.' }); }
});
