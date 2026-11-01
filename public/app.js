"use strict";
/* Decision Wall — one text, 200 parallel Jev judgments, rendered as a living heatmap. */
const SETS = window.JEV_SETS;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtP = p => (p == null || Number.isNaN(p)) ? '—' : p >= 0.995 ? '.99' : p < 0.005 ? '.00' : p.toFixed(2).slice(1);

// ---------- model ----------
for (const s of SETS) {
  s.items = [];
  s.cats.forEach((c, ci) => c.q.forEach((raw, qi) => {
    const [label, question] = raw.split('|');
    s.items.push({ id: `q${ci}_${qi}`, ci, cat: c.name, label, question, idx: s.items.length });
  }));
  s.request = text => ({
    state: { text },
    questions: Object.fromEntries(s.items.map(it => [it.id, { type: 'noul', instructions: it.question + ' (about `text`)' }])),
  });
}
const S = {
  set: SETS[0], thr: 0.5, sort: 'cat', view: 'heat',
  answers: {},        // setId -> {id: p}
  lastText: {},       // setId -> text answered
  history: {},        // setId -> [{text, answers}]
  cache: new Map(),   // setId|text -> {answers, ms, usage, model}
  lat: [], seq: 0, ctrl: null, timer: null, jevOk: false,
};

const track = (event, detail) => { try { fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, set: S.set.id, detail }), keepalive: true }); } catch {} };
// ---------- tabs ----------
function renderTabs() {
  $('#tabs').innerHTML = SETS.map(s => `<button class="tab ${s === S.set ? 'on' : ''}" role="tab" data-id="${s.id}" style="--th:${s.hue}">
    <span class="g">${s.glyph}</span><span class="n">${esc(s.name)}</span>
    <span class="mini">${s.cats.map(() => '<i></i>').join('')}</span></button>`).join('');
  $$('.tab').forEach(t => {
    const mini = $('.mini', t); mini.style.gridTemplateColumns = 'repeat(8,4px)'; mini.style.alignItems = 'end'; mini.style.height = '16px';
    $$('i', mini).forEach(i => { i.style.width = '4px'; i.style.height = '2px'; i.style.borderRadius = '1px'; i.style.transition = 'height .5s'; });
  });
  paintTabMinis();
}
function paintTabMinis() {
  for (const s of SETS) {
    const t = $(`.tab[data-id="${s.id}"]`); if (!t) continue;
    const a = S.answers[s.id];
    $$('.mini i', t).forEach((i, ci) => {
      const v = a ? s.items.filter(x => x.ci === ci).reduce((m, x) => m + (a[x.id] >= S.thr ? 1 : 0), 0) / 25 : 0;
      i.style.height = (2 + v * 14) + 'px'; i.style.setProperty('--p', a ? .35 + v * .65 : .1);
    });
  }
}
$('#tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  selectSet(SETS.find(s => s.id === t.dataset.id)); track('open_set');
});
function selectSet(s) {
  S.set = s;
  document.documentElement.style.setProperty('--hue', s.hue);
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.id === s.id));
  $('#blurb').textContent = s.blurb;
  $('#samples').innerHTML = s.samples.map((x, i) => `<button data-i="${i}">${esc(x.name)}</button>`).join('');
  buildWall();
  const text = $('#input').value.trim();
  if (text && S.lastText[s.id] !== text) ask(true); else paint(false);
}
$('#samples').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  track('sample', S.set.samples[+b.dataset.i].name); const inp = $('#input'); inp.value = S.set.samples[+b.dataset.i].text; autosize(); onInput(true);
});

// ---------- wall ----------
function buildWall() {
  const s = S.set, wall = $('#wall');
  wall.classList.toggle('flat', S.sort === 'heat');
  if (S.sort === 'heat') {
    wall.innerHTML = `<div class="cat"><div class="cat-h"><h3>All 200 · strongest first</h3><span class="meta" id="flatMeta"></span></div><div class="cells">${s.items.map(cellHtml).join('')}</div></div>`;
  } else {
    wall.innerHTML = s.cats.map((c, ci) => `<div class="cat" data-ci="${ci}"><div class="cat-h"><h3>${esc(c.name)}</h3><span class="meta"><b>0</b> / 25</span></div>
      <div class="heatbar"><i></i></div><div class="cells">${s.items.filter(x => x.ci === ci).map(cellHtml).join('')}</div></div>`).join('');
  }
  S.cellEls = Object.fromEntries($$('.cell', wall).map(el => [el.dataset.id, el]));
}
function cellHtml(it) {
  return `<button class="cell" data-id="${it.id}" style="--i:${it.idx}" title="${esc(it.question)}">${S.sort === 'heat' ? `<span class="c">${esc(it.cat)}</span>` : ''}<span class="l">${esc(it.label)}</span><span class="n">—</span></button>`;
}
function paint(flashChanges, prev) {
  const s = S.set, a = S.answers[s.id];
  let lit = 0;
  if (S.sort === 'heat' && a) {
    const cells = $('.cells', $('#wall'));
    const order = [...s.items].sort((x, y) => a[y.id] - a[x.id]);
    order.forEach(it => cells.appendChild(S.cellEls[it.id]));
  }
  for (const it of s.items) {
    const el = S.cellEls[it.id]; const p = a ? (a[it.id] ?? 0) : 0;
    el.style.setProperty('--p', p.toFixed(3));
    $('.n', el).textContent = a ? fmtP(p) : '—';
    const on = a && p >= S.thr; if (on) lit++;
    el.classList.toggle('lit', !!on);
    el.setAttribute('aria-label', `${it.label}: ${a ? Math.round(p * 100) + ' percent' + (on ? ', lit' : '') : 'no answer yet'}`);
    el.classList.toggle('dimmed', S.view === 'lit' && a && !on);
    if (flashChanges && prev && Math.abs((prev[it.id] ?? 0) - p) > 0.25) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
  if (S.sort === 'cat') $$('.cat', $('#wall')).forEach(cEl => {
    const ci = +cEl.dataset.ci; const items = s.items.filter(x => x.ci === ci);
    const n = a ? items.filter(x => a[x.id] >= S.thr).length : 0;
    const heat = a ? items.reduce((m, x) => m + a[x.id], 0) / items.length : 0;
    $('.meta b', cEl).textContent = n; cEl.style.setProperty('--heat', Math.min(1, heat * 2.2).toFixed(3));
    $('.heatbar i', cEl).style.width = (n / 25 * 100) + '%';
  });
  else if ($('#flatMeta')) $('#flatMeta').innerHTML = `<b>${lit}</b> lit`;
  $('#lit').textContent = lit;
  renderReadout();
  paintTabMinis();
}
function renderReadout() {
  const s = S.set, a = S.answers[s.id];
  if (!a) { $('#readout').innerHTML = '<span class="ghost">The strongest signals will line up here.</span>'; return; }
  // pick top signals with category diversity: best from each category first, then the rest
  const sorted = [...s.items].filter(x => a[x.id] >= S.thr).sort((x, y) => a[y.id] - a[x.id]);
  const seen = new Set(), pick = [];
  for (const it of sorted) if (!seen.has(it.ci)) { seen.add(it.ci); pick.push(it); }
  for (const it of sorted) if (pick.length < 14 && !pick.includes(it)) pick.push(it);
  pick.sort((x, y) => a[y.id] - a[x.id]);
  $('#readout').innerHTML = pick.length ? pick.map((it, i) => `<span class="pill" data-id="${it.id}" style="animation-delay:${i * 35}ms"><b>${fmtP(a[it.id])}</b>${esc(it.label)}</span>`).join('')
    : '<span class="ghost">Nothing crosses the threshold for this set.</span>';
}
$('#readout').addEventListener('click', e => { const p = e.target.closest('.pill'); if (p) openDrawer(p.dataset.id); });
$('#wall').addEventListener('click', e => { const c = e.target.closest('.cell'); if (c) openDrawer(c.dataset.id); });

// ---------- input ----------
const inp = $('#input');
function autosize() { if (!CSS.supports('field-sizing', 'content')) { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, innerHeight * .4) + 'px'; } $('#chars').textContent = inp.value.length.toLocaleString() + ' chars'; }
function onInput(now) {
  autosize();
  clearTimeout(S.timer);
  const text = inp.value.trim();
  if (!text) { if (S.ctrl) S.ctrl.abort(); S.seq++; S.answers[S.set.id] = null; S.lastText[S.set.id] = ''; $('#wall').classList.remove('stale'); paint(false); setState('idle'); return; }
  setState('typing…'); $('#wall').classList.add('stale');
  S.timer = setTimeout(() => ask(), now ? 0 : 380);   // debounce: Jev runs on pauses, never per keystroke
}
inp.addEventListener('input', () => onInput(false));
inp.addEventListener('paste', () => setTimeout(() => onInput(true), 0));
inp.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onInput(true); });
function setState(t, busy) { const el = $('#state'); el.textContent = t; el.classList.toggle('busy', !!busy); }

// ---------- Jev ----------
async function callJev(set, text, signal, fresh) {
  const key = set.id + '|' + text;
  if (!fresh && S.cache.has(key)) return { ...S.cache.get(key), cached: true };
  const t0 = performance.now();
  const r = await fetch('/api/jev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...set.request(text), set: set.id, mode: fresh ? 'burst' : 'type', fresh: !!fresh }), signal });
  let d; try { d = await r.json(); } catch { throw new Error(r.ok ? 'bad response from server' : `server error ${r.status}`); }
  if (!r.ok) throw new Error(d.error || d.detail || ('HTTP ' + r.status));
  if (!d.answers) throw new Error('no answers in response');
  const rt = Math.round(performance.now() - t0);
  const up = +r.headers.get('X-Upstream-Ms') || rt;
  const answers = Object.fromEntries(Object.entries(d.answers).map(([k, v]) => [k, typeof v?.noul === 'number' ? v.noul : 0]));
  const out = { answers, ms: up, rt, usage: d.usage, model: d.model };
  S.cache.set(key, out); if (S.cache.size > 300) S.cache.delete(S.cache.keys().next().value);
  return out;
}
async function ask(force) {
  const text = inp.value.trim(); const set = S.set;
  if (!text) return;
  if (!force && S.lastText[set.id] === text && S.answers[set.id]) return;
  if (S.ctrl) S.ctrl.abort();            // cancel the stale request
  const ctrl = S.ctrl = new AbortController(); const my = ++S.seq;
  setState('asking 200 questions…', true); $('#scan').classList.add('on'); $('#hJev .dot')?.classList.add('busy');
  const waitT = setTimeout(() => Object.values(S.cellEls).forEach(c => c.classList.add('wait')), 120);
  try {
    const res = await callJev(set, text, ctrl.signal);
    if (my !== S.seq || set !== S.set || inp.value.trim() !== text) return;   // a newer request won, or the text changed; drop this one
    $('#wall').classList.remove('stale');
    const prev = S.answers[set.id];
    S.answers[set.id] = res.answers; S.lastText[set.id] = text;
    pushHistory(set, text, res.answers);
    paint(true, prev);
    if (!res.cached) { noteLatency(res.ms); }
    if (res.cached) { setState(`shown from cache (answered earlier in ${res.ms} ms)`); }
    else {
      setState(`200 answers · ${res.ms} ms · ${res.usage.input_tokens.toLocaleString()} tokens`);
      $('#hMs').textContent = res.ms + ' ms';
      $('#hPer').textContent = (res.ms / 200).toFixed(2) + ' ms';
      S.calls = (S.calls || 0) + 1; $('#hCalls').textContent = S.calls;
    }
    beams(set);
    refreshUsage();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setState('error: ' + e.message); $('#wall').classList.add('stale');
  } finally {
    clearTimeout(waitT);
    if (my === S.seq) { $('#scan').classList.remove('on'); $('#hJev .dot')?.classList.remove('busy'); Object.values(S.cellEls).forEach(c => c.classList.remove('wait')); }
  }
}
function pushHistory(set, text, answers) {
  const h = S.history[set.id] || (S.history[set.id] = []);
  if (h.length && h[h.length - 1].text === text) return;
  h.push({ text, answers }); if (h.length > 8) h.shift();
}
function noteLatency(ms) {
  S.lat.push(ms); if (S.lat.length > 40) S.lat.shift();
  const max = Math.max(400, ...S.lat), w = 120, h = 26;
  const pts = S.lat.map((v, i) => `${(i / Math.max(1, S.lat.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  $('#spark').innerHTML = `<polyline points="${pts}" fill="none" stroke="var(--acc)" stroke-width="1.5"/>` +
    S.lat.map((v, i) => i === S.lat.length - 1 ? `<circle cx="${(i / Math.max(1, S.lat.length - 1)) * w}" cy="${h - 2 - (v / max) * (h - 4)}" r="2.2" fill="var(--acc)"/>` : '').join('');
}
async function refreshUsage() {
  try {
    const d = await (await fetch('/api/health')).json();
    S.jevOk = d.key && !d.blocked;
    $('#hJev').innerHTML = `<i class="dot ${S.jevOk ? 'ok' : 'bad'}"></i>${d.blocked ? 'capped' : d.key ? 'live' : 'no key'}`;
    if (!d.key) $('#setup').hidden = false;
    if (d.notice) $('#notice').textContent = d.notice;
    $('#usage').textContent = d.user
      ? `signed in as ${d.user} · you today ${(d.user_used || 0).toLocaleString()} of ${(d.user_cap || 0).toLocaleString()} tokens · all users ${d.used_today.toLocaleString()} · $${d.cost_today_usd.toFixed(4)}`
      : `today ${d.used_today.toLocaleString()} of ${d.cap.toLocaleString()} input tokens · $${d.cost_today_usd.toFixed(4)}`;
  } catch { $('#hJev').innerHTML = '<i class="dot bad"></i>offline'; }
}

// ---------- beams: light flies from the text box to every lit cell ----------
const cv = $('#beams'), g = cv.getContext('2d'); let parts = [], raf = 0;
function sizeCv() { const d = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * d; cv.height = innerHeight * d; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; g.setTransform(d, 0, 0, d, 0, 0); }
sizeCv(); addEventListener('resize', sizeCv);
function beams(set) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = S.answers[set.id]; if (!a) return;
  const fr = $('#field').getBoundingClientRect();
  const now = performance.now();
  const lit = set.items.filter(it => a[it.id] >= S.thr).sort((x, y) => a[y.id] - a[x.id]).slice(0, 90);
  lit.forEach((it, k) => {
    const r = S.cellEls[it.id].getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const sx = fr.left + fr.width * (0.15 + 0.7 * ((it.idx * 37) % 100) / 100), sy = fr.bottom - 6;
    parts.push({ sx, sy, ex: r.left + r.width / 2, ey: r.top + r.height / 2, t0: now + k * 7, dur: 520 + Math.random() * 260, p: a[it.id] });
  });
  if (!raf) raf = requestAnimationFrame(tick);
}
function tick(now) {
  g.clearRect(0, 0, innerWidth, innerHeight);
  const hue = S.set.hue;
  parts = parts.filter(pt => now < pt.t0 + pt.dur + 260);
  g.globalCompositeOperation = 'lighter';
  for (const pt of parts) {
    const t = Math.min(1, Math.max(0, (now - pt.t0) / pt.dur)); if (t <= 0) continue;
    const e = 1 - Math.pow(1 - t, 3);
    const cx = (pt.sx + pt.ex) / 2 + (pt.ex - pt.sx) * 0.15, cy = Math.min(pt.sy, pt.ey) - 40;
    const P = u => [(1 - u) * (1 - u) * pt.sx + 2 * (1 - u) * u * cx + u * u * pt.ex, (1 - u) * (1 - u) * pt.sy + 2 * (1 - u) * u * cy + u * u * pt.ey];
    const fade = t < 1 ? 1 : Math.max(0, 1 - (now - pt.t0 - pt.dur) / 260);
    g.lineWidth = 1.2; g.strokeStyle = `hsla(${hue + 30},95%,70%,${0.35 * fade * pt.p})`;
    g.beginPath(); const tail = Math.max(0, e - 0.25);
    for (let u = tail; u <= e; u += 0.02) { const [x, y] = P(u); u === tail ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke();
    const [hx, hy] = P(e);
    const rad = t < 1 ? 2.2 : 2.2 + (1 - fade) * 14;
    const grd = g.createRadialGradient(hx, hy, 0, hx, hy, rad * 4); grd.addColorStop(0, `hsla(${hue + 30},100%,85%,${fade})`); grd.addColorStop(1, `hsla(${hue},100%,60%,0)`);
    g.fillStyle = grd; g.beginPath(); g.arc(hx, hy, rad * 4, 0, 7); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  raf = parts.length ? requestAnimationFrame(tick) : 0;
  if (!parts.length) g.clearRect(0, 0, innerWidth, innerHeight);
}

// ---------- controls ----------
$('#thr').addEventListener('input', e => { S.thr = +e.target.value; $('#thrV').textContent = S.thr.toFixed(2); paint(false); if (S.drawerId) openDrawer(S.drawerId, true); });
$('#sortSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.sort = b.dataset.s; $$('#sortSeg button').forEach(x => x.classList.toggle('on', x === b)); buildWall(); paint(false); });
$('#viewSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.view = b.dataset.v; $$('#viewSeg button').forEach(x => x.classList.toggle('on', x === b)); paint(false); });

// ---------- drawer ----------
function openDrawer(id, quiet) {
  const s = S.set, it = s.items.find(x => x.id === id), a = S.answers[s.id]; S.drawerId = id;
  const p = a ? a[id] : null;
  $('#dCat').textContent = `${s.name} · ${it.cat}`;
  $('#dLab').textContent = it.label;
  $('#dQ').textContent = it.question;
  $('#dP').textContent = p == null ? '—' : p.toFixed(3);
  $('#dArc').style.strokeDashoffset = 326.7 * (1 - (p || 0));
  if (a) {
    const rank = [...s.items].sort((x, y) => a[y.id] - a[x.id]).findIndex(x => x.id === id) + 1;
    const rc = s.items.filter(x => x.ci === it.ci).sort((x, y) => a[y.id] - a[x.id]).findIndex(x => x.id === id) + 1;
    $('#dRank').textContent = `${rank} of 200`; $('#dRankC').textContent = `${rc} of 25`;
    $('#dVer').textContent = p >= S.thr ? `YES (≥ ${S.thr.toFixed(2)})` : `no (< ${S.thr.toFixed(2)})`;
  } else { $('#dRank').textContent = $('#dRankC').textContent = $('#dVer').textContent = '—'; }
  const h = (S.history[s.id] || []).slice().reverse();
  $('#dHist').innerHTML = h.length ? h.map(x => `<div class="hrow"><span title="${esc(x.text)}">${esc(x.text.slice(0, 60))}</span><div class="hb"><i style="width:${x.answers[id] * 100}%"></i></div><b>${fmtP(x.answers[id])}</b></div>`).join('') : '<span style="color:var(--dim);font-size:12px">no inputs yet</span>';
  $('#dJson').textContent = JSON.stringify({ [id]: { type: 'noul', instructions: it.question + ' (about `text`)' } }, null, 2) + (a ? `\n\n→ { "noul": ${p.toFixed(4)} }` : '');
  if (!quiet) track('open_gate', it.label); $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false');
}
document.addEventListener('pointerdown', e => { if (S.drawerId && !e.target.closest('#drawer, .cell, .pill')) { $('#drawer').classList.remove('open'); S.drawerId = null; } });
$('#dx').onclick = () => { $('#drawer').classList.remove('open'); S.drawerId = null; };
// burst dialog focus management
function closeBurst() { $('#burst').classList.remove('open'); $('#burst').setAttribute('aria-hidden', 'true'); $('#burstBtn').focus(); }
addEventListener('keydown', e => { if (e.key === 'Escape') { $('#drawer').classList.remove('open'); S.drawerId = null; if ($('#burst').classList.contains('open')) closeBurst(); } });

// ---------- burst: all seven sets in parallel ----------
$('#burstBtn').onclick = async () => {
  const text = inp.value.trim();
  if (!text) { inp.focus(); setState('type something first'); return; }
  track('burst'); const m = $('#burst'); m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); setTimeout(() => $('#bx').focus(), 50);
  $('#bGrid').innerHTML = SETS.map(s => `<div class="b-set" data-id="${s.id}" style="--th:${s.hue}"><div class="t">${s.glyph} ${esc(s.name)}<span>…</span></div>
    <div class="b-mini">${s.items.map(() => '<i style="--p:0"></i>').join('')}</div><div class="top3"></div></div>`).join('');
  $('#bStat').innerHTML = 'firing 7 requests…';
  const t0 = performance.now(); $('#burstBtn').disabled = true;
  let doneN = 0, tok = 0, sumMs = 0;
  await Promise.all(SETS.map(async s => {
    const card = $(`.b-set[data-id="${s.id}"]`);
    try {
      const res = await callJev(s, text, undefined, true);   // fresh: skip both caches so the timing is honest
      if (inp.value.trim() === text) { S.answers[s.id] = res.answers; S.lastText[s.id] = text; }
      pushHistory(s, text, res.answers);
      doneN++; tok += res.usage.input_tokens; sumMs += res.ms;
      $('.t span', card).textContent = `${res.ms} ms`;
      $$('.b-mini i', card).forEach((i, k) => setTimeout(() => i.style.setProperty('--p', (res.answers[s.items[k].id] ?? 0).toFixed(3)), k * 2));
      const top = [...s.items].sort((x, y) => (res.answers[y.id] ?? 0) - (res.answers[x.id] ?? 0)).slice(0, 3);
      $('.top3', card).innerHTML = top.map(x => `<b>${esc(x.label)}</b> ${fmtP(res.answers[x.id])}`).join(' · ');
    } catch (e) { $('.t span', card).textContent = 'error'; $('.top3', card).textContent = e.message; }
  }));
  const wall = Math.round(performance.now() - t0);
  $('#bStat').innerHTML = `<b>${(doneN * 200).toLocaleString()}</b> answers · <b>${wall} ms</b> wall clock<br>${doneN} calls · sum of call times ${sumMs.toLocaleString()} ms · ${tok.toLocaleString()} tokens`;
  $('#burstBtn').disabled = false; paint(false); refreshUsage();
};
$('#bGrid').addEventListener('click', e => { const c = e.target.closest('.b-set'); if (!c) return; closeBurst(); selectSet(SETS.find(s => s.id === c.dataset.id)); });
$('#bx').onclick = closeBurst;

// ---------- boot ----------
const qs = new URLSearchParams(location.search);
const startSet = SETS.find(s => s.id === qs.get('set')) || SETS[0];
renderTabs(); selectSet(startSet); refreshUsage().then(() => {
  // First impression: never land on an empty wall. Use ?text= if given, else run the first sample once.
  const t = qs.get('text');
  if (t) { inp.value = t.slice(0, 4000); autosize(); onInput(true); }
  else if (S.jevOk && !inp.value) { inp.value = startSet.samples[0].text; autosize(); onInput(true); }
});
autosize(); inp.focus();
