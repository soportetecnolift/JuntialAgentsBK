/*! JuntialAgents Web Agent · widget v1
 * Uso: <script src="https://API/widget/v1/widget.js" data-agent="ja_pk_..." async></script>
 * Aislado en Shadow DOM (no hereda ni rompe los estilos de la web anfitriona).
 */
(() => {
  'use strict';
  const script = document.currentScript || document.querySelector('script[data-agent]');
  if (!script) return;
  const PK = script.dataset.agent; const BASE = `${new URL(script.src).origin}/widget/v1`;
  window.__juntialAgents = window.__juntialAgents || {};
  if (!PK || window.__juntialAgents[PK]) return;
  window.__juntialAgents[PK] = true;

  /* ───────────── utilidades ───────────── */
  const $ = (root, sel) => root.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v); } kids.flat().forEach((c) => c != null && el.append(c)); return el; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (t) => esc(t || '')
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/^#{1,4}\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/^\s*[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, '')}</ul>`)
    .replace(/\n/g, '<br>');
  const plain = (t) => (t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>~]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  const store = { get: () => { try { return JSON.parse(localStorage.getItem(`ja_${PK}`) || '{}'); } catch { return {}; } }, set: (v) => { try { localStorage.setItem(`ja_${PK}`, JSON.stringify({ ...store.get(), ...v })); } catch { /* privado */ } } };
  const mix = (hex, other, t) => { const p = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)); const a = p(hex); const b = p(other); return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; };
  const b64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  const b64ToBuf = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ICON = {
    chat: '<path d="M4 5h16v11H8l-4 4z" stroke-linejoin="round"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
    wave: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>', mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
    micoff: '<path d="M3 3l18 18M9 9v2a3 3 0 005 2.2M15 9.3V6a3 3 0 00-5.7-1.3M5 11a7 7 0 0011.3 5.5M19 11a7 7 0 01-.6 2.9M12 18v3"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5"/>', min: '<path d="M6 12h12"/>', stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    spark: '<path d="M11 2.5l1.9 5.2 5.2 1.9-5.2 1.9L11 16.7l-1.9-5.2-5.2-1.9 5.2-1.9z" fill="currentColor" stroke="none"/><path d="M18.5 14l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" fill="currentColor" stroke="none"/>',
  };
  const svg = (name, size = 20) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[name]; return s; };

  /* ───────────── red ───────────── */
  const S = { token: null, cfg: null, busy: false, images: [], abort: null };
  async function api(path, body, { method = 'POST', auth = true } = {}) {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(auth && S.token ? { authorization: `Bearer ${S.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({})); if (!res.ok) throw Object.assign(new Error(j.error?.message || 'Error de conexión'), { status: res.status }); return j;
  }
  async function session(force = false) {
    const prev = force ? null : store.get().token;
    const j = await api(`/agents/${PK}/session`, { token: prev, visitorId: store.get().vid, lang: navigator.language, page: { url: location.href, title: document.title, referrer: document.referrer } }, { auth: false });
    S.token = j.token; store.set({ token: j.token, vid: store.get().vid || Math.random().toString(36).slice(2) }); return j;
  }
  /** POST con respuesta en streaming (Server-Sent Events). */
  async function stream(path, body, onEvent, signal, retry = true) {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}` }, body: JSON.stringify(body), signal });
    if (res.status === 401 && retry) { await session(true); return stream(path, body, onEvent, signal, false); }
    if (res.status === 409 && retry) { await new Promise((r) => setTimeout(r, 900)); return stream(path, body, onEvent, signal, false); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error?.message || 'No se pudo enviar'); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2); let ev = 'message'; let data = '';
        for (const line of raw.split('\n')) { if (line.startsWith('event: ')) ev = line.slice(7); else if (line.startsWith('data: ')) data += line.slice(6); }
        if (data) { try { onEvent(ev, JSON.parse(data)); } catch { /* evento mal formado */ } }
      }
    }
  }
  /** Reduce imágenes a ≤1568 px (lo óptimo para visión) y JPEG: envíos más rápidos sin perder calidad útil. */
  async function prepImage(file) {
    const bmp = await createImageBitmap(file); const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return { mime: 'image/jpeg', data: await b64(blob), url: URL.createObjectURL(blob) };
  }

  /* ───────────── estilos (Shadow DOM) ───────────── */
  const CSS = (c, dark) => `
  :host{all:initial}*{box-sizing:border-box}
  .w{--p:${c};--p2:${mix(c, '#ffffff', 0.35)};--p3:${mix(c, '#7c5cff', 0.45)};--bg:${dark ? '#12171f' : '#ffffff'};--bg2:${dark ? '#1b222c' : '#f3f5f8'};--ink:${dark ? '#e6ebf0' : '#1d2733'};--soft:${dark ? '#94a1b0' : '#5b6673'};--line:${dark ? '#2a3440' : '#e2e6eb'};--pglow:${c}88;
    font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);position:fixed;z-index:2147483000;bottom:20px;${S.cfg.appearance?.position === 'left' ? 'left' : 'right'}:20px}
  button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
  .dock{display:flex;align-items:center;gap:12px;flex-direction:${S.cfg.appearance?.position === 'left' ? 'row-reverse' : 'row'}}
  .launch{position:relative;width:64px;height:64px;border-radius:50%;flex:none;color:#fff;isolation:isolate;overflow:hidden;
    background:radial-gradient(circle at 32% 28%,var(--p2) 0%,var(--p) 55%,var(--p3) 100%);
    box-shadow:0 12px 32px -6px var(--pglow),0 0 0 1px rgba(255,255,255,.18) inset;transition:transform .35s cubic-bezier(.2,.9,.3,1.3),box-shadow .3s}
  .launch::before{content:'';position:absolute;inset:-35%;z-index:-1;background:conic-gradient(from 0deg,transparent 0 15%,rgba(255,255,255,.55) 22%,transparent 32%,var(--p3) 50%,transparent 62%,var(--p2) 80%,transparent 92%);filter:blur(7px);animation:spin 7s linear infinite;opacity:.85}
  .launch::after{content:'';position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 30% 22%,rgba(255,255,255,.7),transparent 42%);pointer-events:none}
  .launch:hover{transform:scale(1.07);box-shadow:0 16px 40px -6px var(--pglow),0 0 0 1px rgba(255,255,255,.3) inset}.launch:active{transform:scale(.95)}
  .launch .ic{position:absolute;inset:0;display:grid;place-items:center;transition:transform .45s cubic-bezier(.2,.9,.3,1.2),opacity .25s}
  .launch .ic.s svg{filter:drop-shadow(0 0 6px rgba(255,255,255,.7));animation:twinkle 3.2s ease-in-out infinite}
  .launch .ic.x{opacity:0;transform:rotate(-90deg) scale(.6)}
  .launch.open .ic.s{opacity:0;transform:rotate(90deg) scale(.6)}.launch.open .ic.x{opacity:1;transform:none}
  .halo{position:absolute;inset:0;border-radius:50%;pointer-events:none}
  .halo::before,.halo::after{content:'';position:absolute;inset:0;border-radius:50%;border:2px solid var(--p);opacity:0;animation:ping 3.6s cubic-bezier(.2,.6,.3,1) infinite}
  .halo::after{animation-delay:1.8s}.launch.open+.halo{display:none}
  .lwrap{position:relative;flex:none}
  .lbl{background:var(--bg);color:var(--ink);font-weight:700;font-size:14px;padding:10px 16px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.14);border:1px solid var(--line);white-space:nowrap;animation:slideIn .5s cubic-bezier(.2,.8,.2,1) .4s both;cursor:pointer}
  .teaser{position:absolute;bottom:80px;${S.cfg.appearance?.position === 'left' ? 'left' : 'right'}:0;width:280px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:18px 18px ${S.cfg.appearance?.position === 'left' ? '18px 4px' : '4px 18px'};padding:14px 38px 14px 14px;box-shadow:0 18px 44px rgba(0,0,0,.18);cursor:pointer;animation:teaser .5s cubic-bezier(.2,.9,.3,1.2) both;font-size:14.5px}
  .teaser .tx::after{content:'▍';color:var(--p);animation:blink 1s steps(1) infinite}.teaser.done .tx::after{display:none}
  .teaser .x{position:absolute;top:6px;right:6px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:var(--soft)}
  .teaser .who{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--soft);margin-bottom:6px;font-weight:600}
  .teaser .who i{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px #22c55e33}
  @keyframes spin{to{transform:rotate(360deg)}}@keyframes twinkle{0%,100%{transform:scale(1) rotate(0)}50%{transform:scale(1.12) rotate(12deg)}}
  @keyframes ping{0%{transform:scale(1);opacity:.55}80%,100%{transform:scale(1.75);opacity:0}}
  @keyframes slideIn{from{opacity:0;transform:translateX(${S.cfg.appearance?.position === 'left' ? '-' : ''}12px)}}
  @keyframes teaser{from{opacity:0;transform:translateY(12px) scale(.94)}}@keyframes blink{50%{opacity:0}}
  .panel{position:absolute;bottom:76px;${S.cfg.appearance?.position === 'left' ? 'left' : 'right'}:0;width:390px;height:min(640px,calc(100vh - 110px));background:var(--bg);border-radius:20px;box-shadow:0 24px 60px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line);--ox:${S.cfg.appearance?.position === 'left' ? '32px' : 'calc(100% - 32px)'};--oy:calc(100% + 44px);animation:reveal .55s cubic-bezier(.65,0,.25,1) both}
  .panel.closing{animation:conceal .38s cubic-bezier(.55,0,.75,.2) both}
  .panel.closing .msgs,.panel.closing .comp{opacity:0;transition:opacity .15s}
  .panel[hidden]{display:none}
  @keyframes reveal{from{clip-path:circle(30px at var(--ox) var(--oy));opacity:.4}to{clip-path:circle(160% at var(--ox) var(--oy));opacity:1}}
  @keyframes conceal{from{clip-path:circle(160% at var(--ox) var(--oy))}to{clip-path:circle(30px at var(--ox) var(--oy));opacity:.3}}
  .panel .hd,.panel .msgs>*,.panel .comp{animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
  .panel .hd{animation-delay:.12s}.panel .comp{animation-delay:.22s}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}}
  .hd{display:flex;align-items:center;gap:12px;padding:14px 14px 14px 16px;color:#fff;position:relative;overflow:hidden;background:linear-gradient(115deg,var(--p) 0%,var(--p3) 45%,var(--p) 70%,var(--p2) 100%);background-size:260% 100%;animation:aurora 14s ease-in-out infinite}
  .hd::after{content:'';position:absolute;inset:auto 0 0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent)}
  @keyframes aurora{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
  .av{position:relative}.av::after{content:'';position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid var(--p)}
  .av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2) center/cover;flex:none;display:grid;place-items:center;font-weight:800}
  .hd b{display:block;font-size:15px}.hd small{opacity:.85;font-size:12.5px}.hd .sp{flex:1;min-width:0}
  .ib{width:40px;height:40px;border-radius:12px;display:grid;place-items:center}.ib:hover{background:rgba(127,127,127,.16)}
  .msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain;scroll-behavior:smooth}
  .m{max-width:84%;padding:10px 13px;border-radius:16px;word-wrap:break-word;white-space:normal}
  .m.a{background:var(--bg2);border-bottom-left-radius:5px;align-self:flex-start}.m.u{background:var(--p);color:#fff;border-bottom-right-radius:5px;align-self:flex-end}
  .m a{color:inherit;text-decoration:underline}.m ul{margin:4px 0;padding-left:18px}.m pre{background:rgba(0,0,0,.08);padding:8px;border-radius:8px;overflow-x:auto;font-size:13px}.m code{font-family:ui-monospace,monospace;font-size:13px}
  .m img{display:block;max-width:180px;border-radius:10px;margin-bottom:6px}
  .step{align-self:flex-start;font-size:13px;display:flex;align-items:center;gap:8px;color:var(--p)}
  .step svg{animation:spin 2.4s linear infinite}
  .think{font-weight:600;background:linear-gradient(90deg,var(--soft) 0 35%,var(--ink) 50%,var(--soft) 65% 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shimmer 1.8s linear infinite}
  @keyframes shimmer{from{background-position:100% 0}to{background-position:-150% 0}}
  .m{animation:msgIn .35s cubic-bezier(.2,.8,.2,1) both}@keyframes msgIn{from{opacity:0;transform:translateY(6px) scale(.98)}}
  .dots{display:inline-flex;gap:3px}.dots i{width:6px;height:6px;border-radius:50%;background:var(--soft);animation:b 1.2s infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
  @keyframes b{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
  .chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 10px}.chip{padding:8px 13px;border-radius:18px;border:1.5px solid var(--p);color:var(--p);font-size:13.5px;font-weight:600;background:var(--bg)}.chip:hover{background:var(--p);color:#fff}
  .opts{display:flex;flex-wrap:wrap;gap:8px;align-self:flex-start;max-width:92%;margin-top:-4px;animation:msgIn .35s cubic-bezier(.2,.8,.2,1) both}
  .opt{padding:9px 14px;border-radius:14px;border:1.5px solid var(--p);color:var(--p);font-size:14px;font-weight:600;background:var(--bg);text-align:left;transition:background .15s,color .15s,opacity .2s;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
  .opt:hover:not(:disabled){background:var(--p);color:#fff}
  .opt.sel{background:var(--p);color:#fff}.opt.sel::before{content:'✓'}
  .opts.done .opt:not(.sel){opacity:.4;cursor:default}.opts.done a.opt{opacity:1;cursor:pointer}.opt:disabled{cursor:default}
  .card{align-self:stretch;border:1px solid var(--line);border-radius:14px;padding:14px;background:var(--bg)}
  .card h4{margin:0 0 10px;font-size:14.5px}.card label{display:block;font-size:12.5px;color:var(--soft);margin:8px 0 4px}
  .card input,.card textarea{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg2);color:var(--ink);font:inherit;font-size:16px}
  .pri{margin-top:12px;width:100%;height:44px;border-radius:12px;background:var(--p);color:#fff;font-weight:700}.pri:disabled{opacity:.5}
  .note{align-self:stretch;text-align:center;font-size:13px;color:var(--soft);background:var(--bg2);padding:10px;border-radius:12px}
  .thumbs{display:flex;gap:8px;padding:8px 12px 0}.thumbs div{position:relative}.thumbs img{width:54px;height:54px;object-fit:cover;border-radius:10px}.thumbs button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;background:var(--ink);color:var(--bg);display:grid;place-items:center}
  .comp{border-top:1px solid var(--line);padding:8px 10px 10px;background:var(--bg)}
  .row{display:flex;align-items:flex-end;gap:6px}
  textarea.in{flex:1;resize:none;border:1px solid var(--line);border-radius:22px;padding:10px 14px;max-height:120px;min-height:44px;background:var(--bg2);color:var(--ink);font:inherit;font-size:16px;outline:none}
  textarea.in:focus{border-color:var(--p)}
  .send{width:44px;height:44px;border-radius:50%;background:var(--p);color:#fff;display:grid;place-items:center;flex:none}.send:disabled{opacity:.45}
  .tool{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;color:var(--soft);flex:none}.tool:hover{background:var(--bg2);color:var(--ink)}
  .voicebtn{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;flex:none;color:#fff;background:linear-gradient(135deg,var(--p),var(--p3))}
  .brand{text-align:center;font-size:11px;color:var(--soft);padding-top:6px}.brand a{color:inherit}
  /* ── modo voz ── */
  .vo{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;background:radial-gradient(120% 80% at 50% 40%,${dark ? '#1a2230' : '#f6f8ff'} 0%,var(--bg) 70%);animation:fade .25s}
  @keyframes fade{from{opacity:0}}
  .vo .top{width:100%;display:flex;justify-content:space-between;align-items:center;padding:14px 14px 0;color:var(--soft);font-size:13px;font-weight:600}
  .vo canvas{width:260px;height:260px;margin-top:6vh;flex:none}
  .vo .st{margin-top:8px;font-weight:700;font-size:15px;min-height:22px;letter-spacing:.2px}
  .vo .cap{margin:10px 22px 0;text-align:center;color:var(--soft);font-size:15px;line-height:1.45;min-height:66px;max-height:30%;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical}
  .vo .cap b{color:var(--ink);font-weight:600}
  .vo .ctl{margin-top:auto;margin-bottom:max(26px,env(safe-area-inset-bottom));display:flex;gap:18px;align-items:center}
  .cb{width:60px;height:60px;border-radius:50%;display:grid;place-items:center;background:var(--bg2);color:var(--ink);transition:transform .15s}.cb:active{transform:scale(.94)}
  .cb.end{background:#e5484d;color:#fff}.cb.on{background:var(--ink);color:var(--bg)}
  .vo .pend{font-size:12.5px;color:var(--p);font-weight:600;margin-top:6px;min-height:18px}
  @media (max-width:520px){.w{bottom:14px;${S.cfg.appearance?.position === 'left' ? 'left' : 'right'}:14px}.panel{position:fixed;inset:0;width:auto;height:100dvh;border-radius:0;border:0;padding-top:env(safe-area-inset-top);--oy:calc(100% - 46px);--ox:${S.cfg.appearance?.position === 'left' ? '46px' : 'calc(100% - 46px)'}}.launch{width:58px;height:58px}.teaser{width:min(270px,calc(100vw - 40px))}.lbl{display:none}.comp{padding-bottom:max(10px,env(safe-area-inset-bottom))}.vo canvas{margin-top:8vh}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

  /* ───────────── orbe animado (efecto "hablando con la IA") ───────────── */
  class Orb {
    constructor(canvas, colors) { this.c = canvas; this.x = canvas.getContext('2d'); this.colors = colors; this.level = 0; this.target = 0; this.state = 'idle'; this.t = 0; this.run = false; }
    start() { const d = Math.min(2, devicePixelRatio || 1); this.c.width = 260 * d; this.c.height = 260 * d; this.run = true; const loop = (ts) => { if (!this.run) return; this.frame(ts / 1000); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
    stop() { this.run = false; }
    frame(t) {
      const { x, c } = this; const w = c.width; const cx = w / 2; const R = w * 0.29;
      const dt = Math.min(0.05, t - (this.last || t)); this.last = t;
      const speed = { idle: 0.4, listening: 0.6, user: 1.2, thinking: 2.6, speaking: 1.4 }[this.state] || 0.6;
      this.t += dt * speed;
      const idle = this.state === 'thinking' ? 0.12 + 0.06 * Math.sin(t * 6) : this.state === 'listening' ? 0.05 + 0.035 * Math.sin(t * 1.5) : 0;
      this.level += (Math.max(this.target, idle) - this.level) * (reduced ? 1 : 0.18);
      const L = Math.min(1, this.level); const T = this.t; const [c0, c1, c2] = this.colors;
      const r0 = R * (1 + L * 0.2);
      x.clearRect(0, 0, w, w);
      // halo exterior (dentro del lienzo, sin bordes cortados)
      const halo = x.createRadialGradient(cx, cx, r0 * 0.85, cx, cx, Math.min(w * 0.5, r0 * (1.6 + L * 0.35)));
      halo.addColorStop(0, `${c0}55`); halo.addColorStop(1, `${c0}00`);
      x.fillStyle = halo; x.beginPath(); x.arc(cx, cx, w * 0.5, 0, Math.PI * 2); x.fill();
      // forma de la esfera: respira y ondula ligeramente al hablar
      x.save(); x.beginPath();
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        const rr = r0 * (1 + (0.012 + L * 0.045) * Math.sin(a * 4 + T * 2.2) + (L * 0.03) * Math.sin(a * 7 - T * 3.1) + (this.state === 'thinking' ? 0.015 * Math.sin(a * 3 + T * 4) : 0));
        const px = cx + Math.cos(a) * rr; const py = cx + Math.sin(a) * rr; k ? x.lineTo(px, py) : x.moveTo(px, py);
      }
      x.closePath(); x.clip();
      const base = x.createLinearGradient(cx - r0, cx - r0, cx + r0, cx + r0);
      base.addColorStop(0, c1); base.addColorStop(1, c0); x.fillStyle = base; x.fillRect(0, 0, w, w);
      // nubes de color que fluyen por dentro
      x.filter = `blur(${Math.round(w * 0.035)}px)`; x.globalCompositeOperation = 'screen';
      for (let i = 0; i < 4; i++) {
        const bx = cx + Math.cos(T * (0.55 + i * 0.22) + i * 2.1) * r0 * (0.42 + L * 0.15);
        const by = cx + Math.sin(T * (0.75 + i * 0.18) + i * 1.3) * r0 * (0.38 + L * 0.15);
        const br = r0 * (0.55 + 0.12 * Math.sin(T * 1.3 + i));
        const g = x.createRadialGradient(bx, by, 0, bx, by, br);
        const col = [c2, c1, '#ffffff', c2][i];
        g.addColorStop(0, i === 2 ? 'rgba(255,255,255,.55)' : `${col}ee`); g.addColorStop(1, `${col}00`);
        x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
      }
      x.filter = 'none'; x.globalCompositeOperation = 'source-over';
      // brillo especular y borde
      const sh = x.createRadialGradient(cx - r0 * 0.38, cx - r0 * 0.45, 0, cx - r0 * 0.38, cx - r0 * 0.45, r0 * 0.75);
      sh.addColorStop(0, 'rgba(255,255,255,.6)'); sh.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = sh; x.fillRect(0, 0, w, w);
      const shade = x.createRadialGradient(cx, cx, r0 * 0.6, cx, cx, r0 * 1.05);
      shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,.18)'); x.fillStyle = shade; x.fillRect(0, 0, w, w);
      x.restore();
    }
  }

  /* ───────────── reproducción de audio en orden y sin cortes ───────────── */
  class Player {
    constructor(ctx, out) { this.ctx = ctx; this.out = out; this.reset(); }
    reset() { this.next = 0; this.pending = new Map(); this.time = 0; this.sources = new Set(); this.ended = false; }
    async add(seq, data) { try { const buf = await this.ctx.decodeAudioData(b64ToBuf(data)); this.pending.set(seq, buf); this.drain(); } catch { this.pending.set(seq, null); this.drain(); } }
    drain() {
      while (this.pending.has(this.next)) {
        const b = this.pending.get(this.next); this.pending.delete(this.next); this.next++; if (!b) continue;
        const src = this.ctx.createBufferSource(); src.buffer = b; src.connect(this.out);
        const at = Math.max(this.ctx.currentTime + 0.03, this.time); src.start(at); this.time = at + b.duration; this.sources.add(src);
        src.onended = () => { this.sources.delete(src); this.check(); };
      }
    }
    async addFiller(data) {
      if (this.next > 0 || this.playing) return; // si la respuesta ya suena, no hace falta
      try {
        const buf = await this.ctx.decodeAudioData(b64ToBuf(data)); if (this.next > 0) return;
        const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.out);
        const at = Math.max(this.ctx.currentTime + 0.02, this.time); src.start(at); this.time = at + buf.duration + 0.18; // pequeña pausa natural tras la muletilla
        this.sources.add(src); src.onended = () => { this.sources.delete(src); if (this.next === 0) this.onfillerend?.(); this.check(); };
      } catch { /* audio no decodificable: se ignora */ }
    }
    finish() { this.ended = true; this.check(); }
    check() { if (this.ended && !this.sources.size && !this.pending.size) { this.ended = false; this.onidle?.(); } }
    get playing() { return this.sources.size > 0; }
    stop() { this.sources.forEach((s) => { try { s.stop(); } catch { /* ya parado */ } }); this.reset(); }
  }

  /* ───────────── modo voz manos libres ───────────── */
  class Voice {
    constructor(ui) { this.ui = ui; this.cfg = S.cfg.voice; this.premium = this.cfg.mode !== 'browser'; this.state = 'idle'; this.muted = false; }
    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC(); await this.ctx.resume();
      this.mic = this.ctx.createAnalyser(); this.mic.fftSize = 1024; this.ctx.createMediaStreamSource(this.stream).connect(this.mic);
      this.out = this.ctx.createAnalyser(); this.out.fftSize = 512; this.out.connect(this.ctx.destination);
      this.player = new Player(this.ctx, this.out); this.player.onidle = () => this.idleAfterSpeak();
      this.player.onfillerend = () => { if (this.state === 'speaking') this.set('thinking'); }; // terminó la muletilla y la respuesta aún no llega
      this.buf = new Float32Array(this.mic.fftSize); this.ob = new Uint8Array(this.out.frequencyBinCount);
      this.floor = 0.004; this.above = 0; this.silent = 0; this.speaking = false;
      if (this.premium) this.startRecorder(); else this.startRecognition();
      this.set('listening'); this.loop = true; this.tick();
    }
    set(st, label) {
      this.state = st; this.ui.orb.state = st;
      const L = { listening: 'Te escucho…', user: 'Te escucho…', thinking: 'Pensando…', speaking: 'Hablando', idle: '' };
      this.ui.status.textContent = this.muted ? 'Micrófono silenciado' : label || L[st] || '';
    }
    rms() { this.mic.getFloatTimeDomainData(this.buf); let s = 0; for (const v of this.buf) s += v * v; return Math.sqrt(s / this.buf.length); }
    tick() {
      if (!this.loop) return;
      const now = performance.now(); const dt = Math.min(100, now - (this.lastT || now)); this.lastT = now;
      const level = this.muted ? 0 : this.rms();
      const agentTalking = this.premium ? this.player.playing : speechSynthesis.speaking;
      if (!this.speaking && !agentTalking) this.floor = this.floor * 0.995 + Math.min(level, 0.05) * 0.005;
      if (level > Math.max(0.04, this.floor * 6)) this.loudAt = now; // voz fuerte y cercana = persona real, no eco del altavoz
      if (agentTalking) {
        if (this.premium) { this.out.getByteFrequencyData(this.ob); let s = 0; for (const v of this.ob) s += v; this.ui.orb.target = Math.min(1, (s / this.ob.length) / 70); }
        else this.ui.orb.target = 0.35 + 0.25 * Math.abs(Math.sin(now / 110)) * (Math.random() * 0.5 + 0.5);
      } else this.ui.orb.target = Math.min(1, level * 14);
      // VAD adaptativo: aprende el ruido de fondo y detecta inicio/fin de voz; mientras habla el agente exige más energía (anti-eco)
      if (this.premium && !this.muted) {
        const thr = agentTalking ? (this.cfg.bargeIn ? Math.max(0.04, this.floor * 6) : 9) : Math.max(0.012, this.floor * 3.2);
        if (!this.speaking) {
          this.above = level > thr ? this.above + dt : 0;
          if (this.above > (agentTalking ? 260 : 140)) { this.speaking = true; this.silent = 0; this.speechAt = now; if (agentTalking || this.state === 'thinking') this.interrupt(); this.set('user'); }
        } else {
          this.silent = level < thr * 0.6 ? this.silent + dt : 0;
          if (this.silent > (this.cfg.silenceMs || 800)) { this.speaking = false; const dur = now - this.speechAt; if (dur > 350) this.endUtterance(); else this.set('listening'); }
        }
        if (!this.speaking && this.state === 'listening' && now - this.recAt > 20000) this.restartRecorder(); // descarta silencio acumulado
      }
      requestAnimationFrame(() => this.tick());
    }
    /* —— voz premium: graba → servidor (STT + agente + TTS en streaming) —— */
    pickMime() { return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || ''; }
    startRecorder() { const mime = this.pickMime(); this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined); this.chunks = []; this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data); this.rec.start(250); this.recAt = performance.now(); }
    restartRecorder() { try { this.rec.onstop = null; this.rec.stop(); } catch { /* inactivo */ } this.startRecorder(); }
    endUtterance() {
      const rec = this.rec; const chunks = this.chunks;
      rec.onstop = async () => { const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); this.send({ audio: { mime: blob.type, data: await b64(blob) } }); };
      try { rec.stop(); } catch { /* inactivo */ } this.startRecorder();
    }
    interrupt() { this.player?.stop(); if (S.abort) S.abort.abort(); if (!this.premium) { speechSynthesis.cancel(); clearInterval(this.waitIv); this.spokenText = ''; } this.ui.caption(''); }
    async send({ audio, text }) {
      this.set('thinking'); const images = S.images.splice(0); this.ui.renderPending();
      S.abort?.abort(); S.abort = new AbortController(); this.player.reset(); let agentText = ''; let user = text || ''; this.spokenText = '';
      const chunker = this.premium ? null : new Chunker();
      // Modo navegador: muletillas locales solo si tarda (en voz premium las envía el servidor ya sintetizadas)
      const fill = { n: 0, at: Date.now(), timers: [] };
      const sayFill = (kind) => { if (this.premium || agentText || fill.n >= 2 || S.abort?.signal.aborted) return; fill.n++; fill.at = Date.now(); this.lastFill = pickFill(this.cfg.language, kind, this.lastFill); this.ui.caption(`${user ? `<b>${esc(user)}</b><br>` : ''}<em>${esc(this.lastFill)}</em>`); this.say(this.lastFill); };
      if (!this.premium) fill.timers.push(setTimeout(() => Math.random() < 0.8 && sayFill('think'), 1100 + Math.random() * 400));
      const clearFill = () => fill.timers.forEach(clearTimeout);
      try {
        await stream(audio ? '/voice' : '/chat', audio ? { audio, images: images.map(({ mime, data }) => ({ mime, data })) } : { text, voice: true, images: images.map(({ mime, data }) => ({ mime, data })) }, (ev, d) => {
          if (ev === 'transcript') { user = d.text; this.ui.caption(user ? `<b>${esc(user)}</b>` : ''); this.ui.chat.addUser(user, images); }
          if (ev === 'step') { this.set('thinking', d.label?.length < 40 ? d.label : 'Pensando…'); if (/consult/i.test(d.label || '') && Date.now() - fill.at > 1800) sayFill('tool'); }
          if (ev === 'filler') { this.set('speaking'); this.ui.caption(`${user ? `<b>${esc(user)}</b><br>` : ''}<em>${esc(d.text)}</em>`); this.player.addFiller(d.data); }
          if (ev === 'delta') { clearFill(); agentText = d.text; this.ui.caption(`${user ? `<b>${esc(user)}</b><br>` : ''}${esc(plain(agentText).slice(-220))}`); if (chunker) chunker.push(agentText).forEach((s) => this.say(s)); }
          if (ev === 'audio') { if (this.state !== 'speaking') this.set('speaking'); this.player.add(d.seq, d.data); }
          if (ev === 'options' || ev === 'form' || ev === 'handoff') this.ui.chat.handleEvent(ev, d);
          if (ev === 'error') throw new Error(d.message);
          if (ev === 'done') { if (d.empty) { this.set('listening'); return; } this.ui.chat.addAgent(d.text); if (chunker) { chunker.flush(d.text).forEach((s) => this.say(s)); this.waitSynth(); } else this.player.finish(); }
        }, S.abort.signal);
      } catch (e) { if (e.name !== 'AbortError') { this.set('listening', e.message); this.ui.caption(''); } } finally { clearFill(); }
    }
    idleAfterSpeak() { if (this.state === 'speaking' || this.state === 'thinking') this.set('listening'); }
    /* —— modo navegador (gratis): reconocimiento + síntesis del sistema —— */
    startRecognition() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { this.set('idle', 'Tu navegador no admite voz. Prueba con Chrome, Edge o Safari.'); return; }
      const r = new SR(); r.lang = this.cfg.language || 'es-ES'; r.continuous = true; r.interimResults = true; this.recog = r; this.consumed = 0;
      r.onresult = (e) => {
        if (this.muted) return;
        let text = ''; let final = false;
        for (let i = this.consumed; i < e.results.length; i++) { text += e.results[i][0].transcript; if (e.results[i].isFinal) final = true; }
        text = text.trim(); const upTo = e.results.length; if (!text) return;
        const agentBusy = speechSynthesis.speaking || this.state === 'thinking';
        if (agentBusy) {
          // El micrófono oye al propio agente por el altavoz: se descarta el eco y solo una voz real lo interrumpe
          if (this.isEcho(text) || !this.cfg.bargeIn) { this.consumed = upTo; return; }
          if (performance.now() - (this.loudAt || 0) > 450) return;
          this.interrupt();
        }
        this.set('user'); this.ui.caption(`<b>${esc(text)}</b>`);
        clearTimeout(this.commitT);
        this.commitT = setTimeout(() => {
          this.consumed = upTo;
          if (this.lastSent === text && performance.now() - this.lastSentAt < 3000) return; // evita reenvíos del mismo resultado
          this.lastSent = text; this.lastSentAt = performance.now();
          this.ui.chat.addUser(text, S.images); this.send({ text });
        }, final ? Math.min(this.cfg.silenceMs || 800, 650) : (this.cfg.silenceMs || 800) + 450);
      };
      r.onend = () => { this.consumed = 0; if (this.loop && !this.muted) setTimeout(() => { try { r.start(); } catch { /* ya activo */ } }, 120); };
      r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.loop = false; this.set('idle', 'Permite el micrófono para hablar.'); } };
      try { r.start(); } catch { /* ya activo */ }
    }
    isEcho(heard) {
      const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
      const said = new Set(norm(this.spokenText || '')); const words = norm(heard);
      if (!words.length || !said.size) return false;
      return words.filter((w) => said.has(w)).length / words.length >= 0.6;
    }
    flushRecognition() { this.consumed = 0; try { this.recog?.abort(); } catch { /* inactivo */ } } // descarta lo oído mientras hablaba el agente
    say(sentence) {
      const u = new SpeechSynthesisUtterance(sentence); u.lang = this.cfg.language || 'es-ES'; u.rate = 1.05;
      if (!this.ttsVoice) {
        const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(u.lang.slice(0, 2).toLowerCase()));
        this.ttsVoice = voices.find((v) => v.lang === u.lang && /natural|neural|online|premium|enhanced/i.test(v.name)) || voices.find((v) => /natural|neural|online|google|premium|enhanced/i.test(v.name)) || voices[0] || null;
      }
      u.voice = this.ttsVoice; this.spokenText = `${this.spokenText || ''} ${sentence}`;
      u.onstart = () => this.set('speaking'); speechSynthesis.speak(u);
      if (!this.keep) this.keep = setInterval(() => { if (speechSynthesis.speaking) speechSynthesis.resume(); else { clearInterval(this.keep); this.keep = null; } }, 5000); // evita que Chrome corte audios largos
    }
    waitSynth() { clearInterval(this.waitIv); this.waitIv = setInterval(() => { if (!speechSynthesis.speaking && !speechSynthesis.pending) { clearInterval(this.waitIv); this.flushRecognition(); this.spokenText = ''; this.idleAfterSpeak(); } }, 150); }
    toggleMute() {
      this.muted = !this.muted; this.stream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
      if (this.recog) { if (this.muted) this.recog.stop(); else try { this.recog.start(); } catch { /* ya activo */ } }
      this.set(this.state); return this.muted;
    }
    stop() {
      this.loop = false; this.interrupt(); try { this.rec?.stop(); } catch { /* inactivo */ } try { this.recog?.abort(); } catch { /* inactivo */ }
      this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close();
    }
  }
  const FILL = {
    es: { think: ['Mmm, déjame ver…', 'Dame un momento…', 'A ver…', 'Vale, un segundo…', 'Déjame comprobarlo…', 'Un momentito…'], tool: ['Lo estoy consultando…', 'Déjame revisarlo…', 'Un segundo, lo compruebo…'], long: ['Ya casi lo tengo…', 'Un segundo más…'] },
    en: { think: ['Hmm, let me see…', 'Give me a moment…', 'Okay, one second…'], tool: ['Let me look that up…', 'Checking that now…'], long: ['Almost there…'] },
  };
  const pickFill = (lang, kind, last) => { const l = (FILL[(lang || 'es').slice(0, 2)] || FILL.es)[kind]; let i = Math.floor(Math.random() * l.length); if (l[i] === last && l.length > 1) i = (i + 1) % l.length; return l[i]; };
  class Chunker { constructor() { this.sent = 0; this.n = 0; } push(s) { const rest = s.slice(this.sent); const min = this.n ? 50 : 20; const m = [...rest.matchAll(/[.!?…:;]\s|\n+/g)].find((x) => x.index + 1 >= min); if (!m) return []; const cut = m.index + m[0].length; this.sent += cut; this.n++; return [plain(rest.slice(0, cut))].filter(Boolean); } flush(s) { const r = plain(s.slice(this.sent)); this.sent = s.length; return r ? [r] : []; } }

  /* ───────────── interfaz ───────────── */
  async function boot() {
    try { S.cfg = await api(`/agents/${PK}/config`, null, { method: 'GET', auth: false }); } catch (e) { console.warn('[JuntialAgents]', e.message); return; }
    if (S.cfg.status !== 'active') return;
    const ap = S.cfg.appearance || {}; const color = /^#[0-9a-f]{6}$/i.test(ap.primaryColor || '') ? ap.primaryColor : '#0E7C86';
    const dark = ap.theme === 'dark' || (ap.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const host = h('div', { id: `juntial-agent-${PK.slice(-6)}` }); document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', {}, CSS(color, dark)));
    const w = h('div', { class: 'w' }); root.append(w);
    const launch = h('button', { class: 'launch', 'aria-label': `Abrir chat con ${S.cfg.name}`, 'aria-expanded': 'false' },
      h('span', { class: 'ic s' }, svg('spark', 28)), h('span', { class: 'ic x' }, svg('close', 24)));
    const lwrap = h('div', { class: 'lwrap' }, launch, h('span', { class: 'halo' }));
    const label = ap.launcherLabel ? h('button', { class: 'lbl', onclick: () => toggle() }, ap.launcherLabel) : null;
    const dock = h('div', { class: 'dock' }, label, lwrap); w.append(dock);
    let panel; let chat; let opened = false; let teaser = null;
    const prevOverflow = document.documentElement.style.overflow;
    const mobile = () => matchMedia('(max-width:520px)').matches;
    const lockScroll = (on) => { if (mobile()) document.documentElement.style.overflow = on ? 'hidden' : prevOverflow; dock.style.display = on && mobile() ? 'none' : ''; };
    function open() {
      opened = true; teaser?.remove(); teaser = null; label?.remove();
      launch.classList.add('open'); launch.setAttribute('aria-expanded', 'true'); launch.setAttribute('aria-label', 'Cerrar chat');
      if (!panel) { panel = buildPanel(); w.append(panel); } else { panel.classList.remove('closing'); panel.hidden = false; panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = ''; chat.focus(); }
      lockScroll(true);
    }
    function close() {
      opened = false; launch.classList.remove('open'); launch.setAttribute('aria-expanded', 'false'); launch.setAttribute('aria-label', `Abrir chat con ${S.cfg.name}`);
      panel.classList.add('closing');
      const done = () => { if (!opened) { panel.hidden = true; panel.classList.remove('closing'); lockScroll(false); } };
      if (reduced) done(); else panel.addEventListener('animationend', done, { once: true });
      launch.focus();
    }
    const toggle = () => (opened ? close() : open());
    launch.addEventListener('click', toggle);
    // Saludo proactivo: aparece una vez por sesión y se escribe solo, como si el agente estuviera tecleando
    if (S.cfg.greeting && !sessionStorage.getItem(`ja_teased_${PK}`)) {
      setTimeout(() => {
        if (opened) return; sessionStorage.setItem(`ja_teased_${PK}`, '1');
        const tx = h('span', { class: 'tx' });
        teaser = h('div', { class: 'teaser', role: 'button', tabindex: '0', 'aria-label': 'Abrir chat' }, h('div', { class: 'who' }, h('i'), S.cfg.name), tx,
          h('button', { class: 'x', 'aria-label': 'Cerrar saludo', onclick: (e) => { e.stopPropagation(); teaser.remove(); teaser = null; if (label) label.style.display = ''; } }, svg('close', 14)));
        teaser.addEventListener('click', open); teaser.addEventListener('keydown', (e) => e.key === 'Enter' && open());
        lwrap.append(teaser); if (label) label.style.display = 'none';
        const msg = S.cfg.greeting.length > 110 ? `${S.cfg.greeting.slice(0, 107)}…` : S.cfg.greeting; let i = 0;
        if (reduced) { tx.textContent = msg; teaser.classList.add('done'); return; }
        const typeIt = () => { if (!teaser) return; tx.textContent = msg.slice(0, ++i); if (i < msg.length) setTimeout(typeIt, 18 + Math.random() * 38); else teaser.classList.add('done'); };
        setTimeout(typeIt, 450);
      }, 3500);
    }

    function buildPanel() {
      const msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite' });
      const chips = h('div', { class: 'chips' }); const thumbs = h('div', { class: 'thumbs' });
      const input = h('textarea', { class: 'in', rows: '1', placeholder: 'Escribe tu mensaje…', 'aria-label': 'Mensaje', maxlength: '4000' });
      const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
      const sendBtn = h('button', { class: 'send', 'aria-label': 'Enviar' }, svg('send'));
      const imgBtn = h('button', { class: 'tool', 'aria-label': 'Adjuntar imagen', title: 'Adjuntar imagen' }, svg('image'));
      const voiceBtn = S.cfg.voice ? h('button', { class: 'voicebtn', 'aria-label': 'Conversar por voz', title: 'Conversar por voz' }, svg('wave')) : null;
      const avatar = h('div', { class: 'av', style: ap.avatarUrl ? `background-image:url("${encodeURI(ap.avatarUrl)}")` : '' }, ap.avatarUrl ? '' : (S.cfg.name || 'A')[0]);
      const p = h('div', { class: 'panel', role: 'dialog', 'aria-label': `Chat con ${S.cfg.name}` },
        h('div', { class: 'hd' }, avatar, h('div', { class: 'sp' }, h('b', {}, S.cfg.name), h('small', {}, ap.subtitle || 'En línea')), h('button', { class: 'ib', 'aria-label': 'Cerrar chat', onclick: close }, svg('close'))),
        msgs, chips,
        h('div', { class: 'comp' }, thumbs, h('div', { class: 'row' }, imgBtn, input, voiceBtn, sendBtn), file,
          S.cfg.branding ? h('div', { class: 'brand' }, 'Funciona con ', h('a', { href: 'https://juntialagents.com', target: '_blank', rel: 'noopener' }, 'JuntialAgents')) : null));
      p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (voice) endVoice(); else close(); } });

      const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };
      const bubble = (role, html, imgs = []) => { const el = h('div', { class: `m ${role}` }); imgs.forEach((i) => el.append(h('img', { src: i.url, alt: 'Imagen enviada' }))); el.insertAdjacentHTML('beforeend', html); msgs.append(el); scroll(); return el; };
      const setChips = (list) => { chips.replaceChildren(...(list || []).map((o) => h('button', { class: 'chip', onclick: () => send(o) }, o))); };
      chat = {
        focus: () => input.focus(),
        addUser: (t, imgs) => { setChips([]); bubble('u', esc(t || '').replace(/\n/g, '<br>'), imgs); },
        addAgent: (t) => { const el = bubble('a', md(t)); if (chat.pending) { attachOptions(el, chat.pending); chat.pending = null; } return el; },
        pending: null,
        handleEvent: (ev, d) => {
          if (ev === 'options') chat.pending = d.options;
          if (ev === 'handoff') { msgs.append(h('div', { class: 'note' }, d.message)); scroll(); }
          if (ev === 'form') renderForm(d);
        },
      };
      /** Botones de decisión pegados al mensaje que los pregunta; al elegir, queda marcada la opción. */
      function attachOptions(el, options) {
        const box = h('div', { class: 'opts', role: 'group', 'aria-label': 'Opciones de respuesta' });
        (options || []).forEach((raw) => {
          const [label, url] = String(raw).split('|').map((x) => x.trim());
          const b = url && /^https?:\/\//.test(url)
            ? h('a', { class: 'opt', href: url, target: '_blank', rel: 'noopener noreferrer' }, `${label} ↗`)
            : h('button', { class: 'opt', onclick: () => { if (box.classList.contains('done')) return; box.classList.add('done'); b.classList.add('sel'); box.querySelectorAll('button').forEach((x) => { x.disabled = true; }); send(label); } }, label);
          box.append(b);
        });
        el.after(box); scroll();
      }
      const closeOpenOptions = () => msgs.querySelectorAll('.opts:not(.done)').forEach((o) => { o.classList.add('done'); o.querySelectorAll('button').forEach((x) => { x.disabled = true; }); });
      function renderForm(d) {
        const inputs = {}; const card = h('form', { class: 'card' }, h('h4', {}, d.title || 'Tus datos'));
        (d.fields || []).forEach((f) => { const el = f.type === 'textarea' ? h('textarea', { rows: '3', required: f.required, name: f.key }) : h('input', { type: f.type || 'text', required: f.required, name: f.key, autocomplete: { email: 'email', tel: 'tel', name: 'name' }[f.key] || 'on' }); inputs[f.key] = el; card.append(h('label', {}, f.label + (f.required ? ' *' : '')), el); });
        const btn = h('button', { class: 'pri', type: 'submit' }, 'Enviar'); card.append(btn);
        card.addEventListener('submit', async (e) => {
          e.preventDefault(); btn.disabled = true;
          try { await api('/lead', { fields: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) }); card.replaceWith(h('div', { class: 'note' }, '✓ Datos enviados. ¡Gracias!')); store.set({ lead: true }); if (d.preChat) unlock(); else send('He enviado mis datos de contacto.', true); }
          catch (err) { btn.disabled = false; btn.textContent = err.message; }
        });
        msgs.append(card); scroll(); setTimeout(() => card.querySelector('input,textarea')?.focus(), 50);
      }
      let typing;
      const showTyping = (label) => { if (!typing) { typing = h('div', { class: 'step', role: 'status' }, svg('spark', 16), h('span', { class: 'think' })); msgs.append(typing); } typing.lastChild.textContent = label || 'Pensando…'; scroll(); };
      const hideTyping = () => { typing?.remove(); typing = null; };

      const setBusy = (on) => { S.busy = on; sendBtn.replaceChildren(svg(on ? 'stop' : 'send')); sendBtn.setAttribute('aria-label', on ? 'Detener respuesta' : 'Enviar'); };
      async function send(text, silent = false) {
        text = (text ?? input.value).trim();
        if (!text && !S.images.length) return;
        if (S.busy) { S.abort?.abort(); await new Promise((r) => setTimeout(r, 60)); } // un mensaje nuevo sustituye a la respuesta en curso
        const imgs = S.images.splice(0);
        closeOpenOptions(); setChips([]);
        setBusy(true); input.value = ''; autosize(); renderPending();
        if (!silent) chat.addUser(text, imgs);
        showTyping(); let el = null; let last = ''; let opts = null;
        const myAbort = new AbortController(); S.abort = myAbort;
        try {
          await stream('/chat', { text, images: imgs.map(({ mime, data }) => ({ mime, data })) }, (ev, d) => {
            if (ev === 'step') showTyping(d.label);
            if (ev === 'delta') { hideTyping(); last = d.text; if (!el) el = bubble('a', ''); el.innerHTML = md(last); scroll(); }
            if (ev === 'options') opts = d.options;
            if (ev === 'form' || ev === 'handoff') chat.handleEvent(ev, d);
            if (ev === 'done') {
              hideTyping();
              if (!el) el = bubble('a', md(d.text || (opts ? 'Elige una opción:' : ''))); else el.innerHTML = md(d.text || last);
              if (opts) attachOptions(el, opts);
            }
            if (ev === 'error') { hideTyping(); bubble('a', esc(d.message)); }
          }, S.abort.signal);
        } catch (e) { hideTyping(); if (e.name !== 'AbortError') bubble('a', esc(e.message)); else if (el) el.insertAdjacentHTML('beforeend', ' <em style="opacity:.6">(detenido)</em>'); }
        finally { if (S.abort === myAbort) setBusy(false); input.focus(); } // solo el turno más reciente libera el botón
      }
      function renderPending() {
        thumbs.replaceChildren(...S.images.map((im, i) => h('div', {}, h('img', { src: im.url, alt: '' }), h('button', { 'aria-label': 'Quitar imagen', onclick: () => { S.images.splice(i, 1); renderPending(); } }, svg('close', 12)))));
        if (voice) ui.pending.textContent = S.images.length ? `📷 ${S.images.length} imagen(es) irán con tu próxima frase` : '';
      }
      async function addFiles(files) { for (const f of [...files].filter((x) => x.type.startsWith('image/')).slice(0, 4 - S.images.length)) S.images.push(await prepImage(f)); renderPending(); }
      const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
      input.addEventListener('input', autosize);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      input.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });
      p.addEventListener('dragover', (e) => e.preventDefault());
      p.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
      imgBtn.addEventListener('click', () => file.click()); file.addEventListener('change', () => { addFiles(file.files); file.value = ''; });
      sendBtn.addEventListener('click', () => { if (S.busy && !input.value.trim() && !S.images.length) S.abort?.abort(); else send(); });

      /* —— capa de voz —— */
      let voice = null; const ui = {};
      async function startVoice() {
        const canvas = h('canvas', { 'aria-hidden': 'true' }); const status = h('div', { class: 'st', role: 'status' }); const cap = h('div', { class: 'cap' }); const pending = h('div', { class: 'pend' });
        const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
        const muteBtn = h('button', { class: 'cb', 'aria-label': 'Silenciar micrófono' }, svg('mic', 24));
        const camBtn = h('button', { class: 'cb', 'aria-label': 'Mostrar una imagen' }, svg('camera', 24));
        const endBtn = h('button', { class: 'cb end', 'aria-label': 'Terminar conversación por voz' }, svg('close', 24));
        const layer = h('div', { class: 'vo' }, h('div', { class: 'top' }, h('span', {}, S.cfg.name), h('span', {}, S.cfg.voice.mode === 'browser' ? 'Voz del dispositivo' : 'Voz natural')), canvas, status, cap, pending, h('div', { class: 'ctl' }, muteBtn, camBtn, endBtn), cam);
        p.append(layer);
        Object.assign(ui, { layer, status, pending, chat, orb: new Orb(canvas, [color, mix(color, '#ffffff', 0.35), mix(color, '#7c5cff', 0.45)]), caption: (html) => { cap.innerHTML = html; }, renderPending });
        ui.orb.start(); status.textContent = 'Conectando micrófono…';
        voice = new Voice(ui);
        try { await voice.start(); } catch (e) { status.textContent = 'No se pudo acceder al micrófono. Revisa los permisos del navegador.'; return; }
        muteBtn.addEventListener('click', () => { const m = voice.toggleMute(); muteBtn.replaceChildren(svg(m ? 'micoff' : 'mic', 24)); muteBtn.classList.toggle('on', m); });
        camBtn.addEventListener('click', () => cam.click()); cam.addEventListener('change', () => { addFiles(cam.files); cam.value = ''; });
        endBtn.addEventListener('click', endVoice); endBtn.focus();
      }
      function endVoice() { voice?.stop(); voice = null; ui.orb?.stop(); ui.layer?.remove(); input.focus(); }
      voiceBtn?.addEventListener('click', startVoice);

      /* —— arranque de la conversación —— */
      let locked = false;
      function unlock() { locked = false; input.disabled = false; sendBtn.disabled = false; input.focus(); }
      session().then((s) => {
        if (s.messages?.length) s.messages.forEach((m) => (m.role === 'assistant' ? chat.addAgent(m.text) : chat.addUser(m.text)));
        else { if (S.cfg.greeting) chat.addAgent(S.cfg.greeting); setChips(S.cfg.suggestions); }
        if (S.cfg.leadForm?.preChat && !s.lead && !store.get().lead) { locked = true; input.disabled = true; sendBtn.disabled = true; renderForm({ ...S.cfg.leadForm, preChat: true }); }
        else input.focus();
      }).catch((e) => bubble('a', esc(e.message)));
      return p;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
