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
  mode: 'live',       // 'live' (server with a key) or 'replay' (recorded answers, no key needed)
  explain: null,      // {text, set, parts, deltas[], ms}
  src: {},            // setId -> 'live' | 'recorded' | 'shared' (where the shown answers came from)
};
const SRC_LABEL = { live: 'live Jev answers', recorded: 'recorded Jev answers (sample replay)', shared: 'from a shared link (not re-checked)' };
const CODEC = window.JEV_CODEC, REPLAYS = window.JEV_REPLAYS || null;

const track = (event, detail) => { if (S.mode !== 'live') return; try { fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, set: S.set.id, detail }), keepalive: true }); } catch {} };
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
  if (s !== S.set && S.ctrl) { S.ctrl.abort(); S.seq++; clearBusy(); }
  S.set = s;
  if (typeof closeExplain === 'function') closeExplain();
  if (S.drawerId) closeDrawer();
  $('#flips').innerHTML = '';
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
  if (!text) { if (S.ctrl) S.ctrl.abort(); S.seq++; clearBusy(); closeExplain(); S.answers[S.set.id] = null; S.lastText[S.set.id] = ''; $('#wall').classList.remove('stale'); $('#flips').innerHTML = ''; paint(false); setState('idle'); return; }
  setState('typing…'); $('#wall').classList.add('stale');
  if (S.explain && S.explain.text !== text) closeExplain();
  S.timer = setTimeout(() => ask(), now ? 0 : 380);   // debounce: Jev runs on pauses, never per keystroke
}
inp.addEventListener('input', () => onInput(false));
inp.addEventListener('paste', () => setTimeout(() => onInput(true), 0));
inp.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onInput(true); });
function clearBusy() { $('#scan').classList.remove('on'); $('#hJev .dot')?.classList.remove('busy'); Object.values(S.cellEls || {}).forEach(c => c.classList.remove('wait')); $('#state').classList.remove('busy'); }
function setState(t, busy) { const el = $('#state'); el.textContent = t; el.classList.toggle('busy', !!busy); }

// ---------- Jev ----------
function replayFor(set, text) {
  const r = REPLAYS && REPLAYS.texts.find(x => x.text.trim() === text);
  const v = r && CODEC.dec(r.a[set.id]);
  return v && v.length === set.items.length ? Object.fromEntries(set.items.map((it, i) => [it.id, v[i]])) : null;
}
async function callJev(set, text, signal, fresh, mode) {
  const key = set.id + '|' + text;
  if (S.mode === 'replay') {
    const answers = replayFor(set, text);
    if (!answers) throw Object.assign(new Error('recorded mode: pick a sample above. Live typing needs your own key (run it locally).'), { replayMiss: true });
    return { answers, ms: null, usage: { input_tokens: 0 }, model: REPLAYS.model, recorded: true };
  }
  if (!fresh && S.cache.has(key)) return { ...S.cache.get(key), cached: true };
  const t0 = performance.now();
  const r = await fetch('/api/jev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...set.request(text), set: set.id, mode: mode || (fresh ? 'burst' : 'type'), fresh: !!fresh }), signal });
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
    if (my !== S.seq || set !== S.set || inp.value.trim() !== text) { if (my === S.seq) { clearBusy(); setState('idle'); } return; }   // stale result; drop it
    $('#wall').classList.remove('stale');
    const prev = S.answers[set.id];
    S.answers[set.id] = res.answers; S.lastText[set.id] = text; S.src[set.id] = res.recorded ? 'recorded' : 'live';
    pushHistory(set, text, res.answers);
    paint(true, prev);
    showFlips(set, prev, res.answers);
    if (res.recorded) { setState(`recorded answers (${REPLAYS.model}, ${REPLAYS.recorded})`); beams(set); return; }
    if (!res.cached) { noteLatency(res.ms); }
    if (res.cached) { setState(`shown from cache (answered earlier in ${res.ms} ms)`); }
    else {
      setState(`200 answers · ${res.ms} ms · ${(res.usage?.input_tokens || 0).toLocaleString()} tokens`);
      $('#hMs').textContent = res.ms + ' ms';
      $('#hPer').textContent = (res.ms / 200).toFixed(2) + ' ms';
      S.calls = (S.calls || 0) + 1; $('#hCalls').textContent = S.calls;
    }
    beams(set);
    refreshUsage();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setState(e.replayMiss ? e.message : 'error: ' + e.message); $('#wall').classList.add('stale');
  } finally {
    clearTimeout(waitT);
    if (my === S.seq) clearBusy();
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
function enterReplay(why) {
  if (S.ctrl) S.ctrl.abort(); S.seq++; clearBusy();
  S.mode = 'replay'; S.jevOk = false; document.body.classList.add('replay');
  for (const k of Object.keys(S.answers)) if (S.src[k] === 'live') { S.answers[k] = null; S.lastText[k] = ''; }
  $('#hJev').innerHTML = '<i class="dot rec"></i>recorded';
  $('#hMs').textContent = '—'; $('#hPer').textContent = '—';
  $('#replayBar').hidden = false; $('#replayWhy').textContent = why;
  $('#usage').textContent = `recorded answers: ${REPLAYS.texts.length} sample texts × ${SETS.length} sets, ${REPLAYS.model}, ${REPLAYS.recorded}`;
}
async function refreshUsage() {
  if (S.mode === 'replay') return;
  try {
    const r = await fetch('/api/health', { redirect: 'manual' });
    const static404 = r.status === 404;
    if (static404 && REPLAYS) return enterReplay('This copy has no server, so it plays real Jev answers recorded for the sample texts.');
    if (!r.ok) throw Object.assign(new Error('server error ' + r.status), { transient: true });
    const d = await r.json();
    if (!d.key && REPLAYS) { $('#setup').hidden = false; return enterReplay('No API key on this server yet, so the samples below play recorded Jev answers.'); }
    S.jevOk = d.key && !d.blocked;
    $('#hJev').innerHTML = `<i class="dot ${S.jevOk ? 'ok' : 'bad'}"></i>${d.blocked ? 'capped' : d.key ? 'live' : 'no key'}`;
    if (!d.key) $('#setup').hidden = false;
    if (d.notice) $('#notice').textContent = d.notice;
    $('#usage').textContent = d.user
      ? `signed in as ${d.user} · you today ${(d.user_used || 0).toLocaleString()} of ${(d.user_cap || 0).toLocaleString()} tokens · all users ${d.used_today.toLocaleString()} · $${d.cost_today_usd.toFixed(4)}`
      : `today ${d.used_today.toLocaleString()} of ${d.cap.toLocaleString()} input tokens · $${d.cost_today_usd.toFixed(4)}`;
  } catch (e) {
    // Only a static host with no API at all (file:// or a page with no server) goes to recorded mode; anything else is a live server having a bad moment.
    if (REPLAYS && !e.transient && location.protocol === 'file:') return enterReplay('This copy has no server, so it plays real Jev answers recorded for the sample texts.');
    $('#hJev').innerHTML = '<i class="dot bad"></i>offline'; S.jevOk = false;
  }
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
  const p = a ? (a[id] ?? null) : null;
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
  $('#dHist').innerHTML = h.length ? h.map(x => `<div class="hrow"><span title="${esc(x.text)}">${esc(x.text.slice(0, 60))}</span><div class="hb"><i style="width:${(x.answers[id] ?? 0) * 100}%"></i></div><b>${fmtP(x.answers[id])}</b></div>`).join('') : '<span style="color:var(--dim);font-size:12px">no inputs yet</span>';
  $('#dJson').textContent = JSON.stringify({ [id]: { type: 'noul', instructions: it.question + ' (about `text`)' } }, null, 2) + (p != null ? `\n\n→ { "noul": ${p.toFixed(4)} }` : '');
  if (!quiet) track('open_gate', it.label); $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); document.body.classList.add('drawer-open');
}
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); S.drawerId = null; document.body.classList.remove('drawer-open'); }
// close on outside click, but not while using controls (threshold drag keeps the drawer live)
document.addEventListener('pointerdown', e => { if (S.drawerId && !e.target.closest('#drawer, .cell, .pill, .fchip, #explain, .controls, .tools')) closeDrawer(); });
$('#dx').onclick = closeDrawer;
// burst dialog focus management
function closeBurst() { $('#burst').classList.remove('open'); $('#burst').setAttribute('aria-hidden', 'true'); $('#burstBtn').focus(); }
addEventListener('keydown', e => { if (e.key === 'Escape') { if (S.drawerId) closeDrawer(); if ($('#burst').classList.contains('open')) closeBurst(); } });

// ---------- burst: all seven sets in parallel ----------
$('#burstBtn').onclick = async () => {
  const text = inp.value.trim();
  if (!text) { inp.focus(); setState('type something first'); return; }
  track('burst'); const m = $('#burst'); m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); setTimeout(() => $('#bx').focus(), 50);
  $('#bGrid').innerHTML = SETS.map(s => `<div class="b-set" data-id="${s.id}" style="--th:${s.hue}"><div class="t">${s.glyph} ${esc(s.name)}<span>…</span></div>
    <div class="lane"><i></i></div><div class="b-mini">${s.items.map(() => '<i style="--p:0"></i>').join('')}</div><div class="top3"></div></div>`).join('');
  $('#bStat').innerHTML = `firing ${SETS.length} requests…`; $('#bCompare').innerHTML = '';
  const t0 = performance.now(); $('#burstBtn').disabled = true;
  let doneN = 0, tok = 0, sumMs = 0; const doneAt = {}, LANE = 600;   // lanes are drawn on a 600 ms scale
  const race = () => {   // live race: every unfinished lane keeps running until its answer lands
    const el = performance.now() - t0;
    for (const s of SETS) { if (doneAt[s.id] != null) continue; const c = $(`.b-set[data-id="${s.id}"]`); if (!c) continue;
      $('.lane i', c).style.width = Math.min(100, el / LANE * 100) + '%'; if (S.mode === 'live') $('.t span', c).textContent = Math.round(el) + ' ms'; }
    if (Object.keys(doneAt).length < SETS.length && $('#burst').classList.contains('open')) requestAnimationFrame(race);
  };
  requestAnimationFrame(race);
  await Promise.all(SETS.map(async s => {
    const card = $(`.b-set[data-id="${s.id}"]`);
    try {
      const res = await callJev(s, text, undefined, true);   // fresh: skip both caches so the timing is honest
      if (inp.value.trim() === text) { S.answers[s.id] = res.answers; S.lastText[s.id] = text; S.src[s.id] = res.recorded ? 'recorded' : 'live'; }
      pushHistory(s, text, res.answers);
      doneN++; tok += res.usage?.input_tokens || 0; sumMs += res.ms || 0; doneAt[s.id] = res.ms;
      $('.t span', card).textContent = res.recorded ? 'recorded' : `${res.ms} ms`;
      $('.lane i', card).style.width = res.recorded ? '100%' : Math.min(100, res.ms / LANE * 100) + '%'; card.classList.add('done');
      $$('.b-mini i', card).forEach((i, k) => setTimeout(() => i.style.setProperty('--p', (res.answers[s.items[k].id] ?? 0).toFixed(3)), k * 2));
      const top = [...s.items].sort((x, y) => (res.answers[y.id] ?? 0) - (res.answers[x.id] ?? 0)).slice(0, 3);
      $('.top3', card).innerHTML = top.map(x => `<b>${esc(x.label)}</b> ${fmtP(res.answers[x.id])}`).join(' · ');
    } catch (e) { doneAt[s.id] = -1; $('.t span', card).textContent = 'error'; $('.top3', card).textContent = e.message; }
  }));
  const wall = Math.round(performance.now() - t0);
  if (S.mode === 'replay') {
    $('#bStat').innerHTML = `<b>${(doneN * 200).toLocaleString()}</b> recorded answers<br>timings are only shown for live calls`;
  } else {
    $('#bStat').innerHTML = `<b>${(doneN * 200).toLocaleString()}</b> answers · <b>${wall} ms</b> wall clock<br>${doneN} calls · ${tok.toLocaleString()} tokens`;
    const mx = Math.max(wall, sumMs, 1);
    $('#bCompare').innerHTML = `<div class="cmp"><span>all ${doneN} at once (measured)</span><div class="cbar"><i style="--w:${wall / mx * 100}%"></i></div><b>${wall.toLocaleString()} ms</b></div>
      <div class="cmp ghost"><span>one after another (sum of the ${doneN} call times)</span><div class="cbar"><i style="--w:${sumMs / mx * 100}%"></i></div><b>${sumMs.toLocaleString()} ms</b></div>`;
  }
  $('#burstBtn').disabled = false; paint(false); refreshUsage();
};
$('#bGrid').addEventListener('click', e => { const c = e.target.closest('.b-set'); if (!c) return; closeBurst(); selectSet(SETS.find(s => s.id === c.dataset.id)); });
$('#bx').onclick = closeBurst;

// ---------- boot ----------
const qs = new URLSearchParams(location.search);
const startSet = SETS.find(s => s.id === qs.get('set')) || SETS[0];
renderTabs(); selectSet(startSet);
const shared = loadShared();
refreshUsage().then(() => {
  if (shared) return;
  // First impression: never land on an empty wall. Use ?text= if given, else run the first sample once.
  const t = qs.get('text');
  if (t && S.mode === 'live') { inp.value = t.slice(0, 4000); autosize(); onInput(true); }
  else if ((S.jevOk || S.mode === 'replay') && !inp.value) { inp.value = S.set.samples[0].text; autosize(); onInput(true); }
});
autosize(); inp.focus();

// ======================================================================================
// v1.2 · flips, explain, share, fingerprint, export
// ======================================================================================

// ---------- flip log: which questions crossed the threshold on the last edit ----------
function showFlips(set, prev, next) {
  const el = $('#flips');
  if (!prev || !next) { el.innerHTML = ''; return; }
  const up = [], down = [];
  for (const it of set.items) {
    const a = prev[it.id] ?? 0, b = next[it.id] ?? 0;
    if (a < S.thr && b >= S.thr) up.push({ it, d: b - a }); else if (a >= S.thr && b < S.thr) down.push({ it, d: a - b });
  }
  if (!up.length && !down.length) { el.innerHTML = '<span class="f-k">last edit</span><span class="f-none">no question crossed the threshold</span>'; return; }
  const chip = (x, cls) => `<button class="fchip ${cls}" data-id="${x.it.id}" title="${esc(x.it.question)}">${cls === 'up' ? '▲' : '▼'} ${esc(x.it.label)}</button>`;
  up.sort((x, y) => y.d - x.d); down.sort((x, y) => y.d - x.d);
  el.innerHTML = `<span class="f-k">last edit</span><span class="f-n up">${up.length} lit</span>${up.slice(0, 7).map(x => chip(x, 'up')).join('')}`
    + (down.length ? `<span class="f-n down">${down.length} went dark</span>${down.slice(0, 5).map(x => chip(x, 'down')).join('')}` : '');
}
$('#flips').addEventListener('click', e => { const c = e.target.closest('.fchip'); if (c) openDrawer(c.dataset.id); });

// ---------- explain: leave one passage out at a time, see which questions move ----------
function splitPassages(text) {
  let parts = CODEC.chunks(text, 12);
  if (parts.length < 3) {   // one sentence: fall back to word groups
    const words = text.match(/\S+\s*/g) || [text];
    const n = Math.min(8, Math.max(1, Math.floor(words.length / 2)));
    const size = Math.ceil(words.length / n); parts = [];
    for (let i = 0; i < words.length; i += size) parts.push(words.slice(i, i + size).join(''));
  }
  return parts;
}
async function runExplain() {
  const text = inp.value.trim(), set = S.set;
  if (!text) { inp.focus(); setState('type something first'); return; }
  if (S.mode === 'replay') { setState('Explain needs live calls. Run it locally with your own key.'); toast('Explain needs a live key (run it locally)'); return; }
  if (!S.jevOk) { toast('Jev is not available right now (no key, capped or offline)'); return; }
  if (S.exCtrl) S.exCtrl.abort();
  const exCtrl = S.exCtrl = new AbortController();
  const parts = splitPassages(text);
  if (parts.length < 2) { toast('Need a longer text to explain'); return; }
  const btn = $('#explainBtn'); btn.disabled = true; track('explain', String(parts.length));
  setState(`explaining: ${parts.length + 1} parallel calls (full text + each passage left out)…`, true);
  const t0 = performance.now();
  try {
    const base = S.lastText[set.id] === text && S.answers[set.id] && S.src[set.id] === 'live' ? { answers: S.answers[set.id] } : await callJev(set, text, exCtrl.signal, false, 'explain');
    const without = await Promise.all(parts.map((_, i) => callJev(set, parts.filter((_, k) => k !== i).join('').trim() || '.', exCtrl.signal, false, 'explain')));
    if (exCtrl !== S.exCtrl || inp.value.trim() !== text || S.set !== set) return;
    // delta > 0: this passage pushes the question toward yes (removing it lowers p)
    const deltas = without.map(w => Object.fromEntries(set.items.map(it => [it.id, (base.answers[it.id] ?? 0) - (w.answers[it.id] ?? 0)])));
    const ms = Math.round(performance.now() - t0);
    S.explain = { text, set, parts, deltas, ms, base: base.answers };
    const pick = S.drawerId || [...set.items].sort((x, y) => (base.answers[y.id] ?? 0) - (base.answers[x.id] ?? 0))[0].id;
    renderExplain(pick);
    setState(`explained: ${parts.length + 1} calls in ${ms} ms`);
  } catch (e) { if (e.name !== 'AbortError') setState('explain failed: ' + e.message); }
  finally { if (exCtrl === S.exCtrl) { S.exCtrl = null; btn.disabled = false; if (!S.ctrl || S.ctrl.signal.aborted) $('#state').classList.remove('busy'); } }
}
function renderExplain(id) {
  const X = S.explain; if (!X || X.set !== S.set) return;
  const it = X.set.items.find(x => x.id === id); X.focus = id;
  const ds = X.deltas.map(d => d[id]); const mx = Math.max(0.05, ...ds.map(Math.abs));
  $('#explain').hidden = false;
  $('#exFocus').innerHTML = `<b>${esc(it.label)}</b> <span>${fmtP(X.base[id])}</span>`;
  $('#exMeta').textContent = `${X.parts.length} passages · ${X.parts.length + 1} parallel calls · ${X.ms} ms`;
  $('#exText').innerHTML = X.parts.map((p, i) => {
    const d = ds[i], w = Math.abs(d) / mx;
    return `<span class="ex-p ${d >= 0 ? 'pos' : 'neg'}" data-i="${i}" style="--w:${w.toFixed(3)}" title="${d >= 0 ? 'pushes toward yes' : 'pushes toward no'}: ${d >= 0 ? '+' : ''}${d.toFixed(2)}">${esc(p)}<sup>${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}</sup></span>`;
  }).join('');
  $('#exGates').innerHTML = '<span class="ex-hint">Click a passage to see the questions it moves most, or click any cell in the wall.</span>';
  if (S.drawerId === id) drawerWhy(id);
}
$('#exText').addEventListener('click', e => {
  const p = e.target.closest('.ex-p'); if (!p || !S.explain) return;
  const X = S.explain, d = X.deltas[+p.dataset.i];
  $$('.ex-p').forEach(x => x.classList.toggle('sel', x === p));
  const top = [...X.set.items].sort((a, b) => Math.abs(d[b.id]) - Math.abs(d[a.id])).slice(0, 10);
  $('#exGates').innerHTML = `<span class="ex-k">this passage moves</span>` + top.map(it => `<button class="fchip ${d[it.id] >= 0 ? 'up' : 'down'}" data-id="${it.id}">${d[it.id] >= 0 ? '+' : '−'}${Math.abs(d[it.id]).toFixed(2)} ${esc(it.label)}</button>`).join('');
});
$('#exGates').addEventListener('click', e => { const c = e.target.closest('.fchip'); if (c) { renderExplain(c.dataset.id); openDrawer(c.dataset.id); } });
function closeExplain() { if (S.exCtrl) { S.exCtrl.abort(); S.exCtrl = null; $('#explainBtn').disabled = false; } S.explain = null; $('#explain').hidden = true; $('#dWhyWrap').hidden = true; }
$('#exClose').onclick = closeExplain;
$('#explainBtn').onclick = runExplain;
function drawerWhy(id) {
  const X = S.explain;
  if (!X || X.set !== S.set) { $('#dWhyWrap').hidden = true; return; }
  const rows = X.parts.map((p, i) => ({ p, d: X.deltas[i][id] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
  const mx = Math.max(0.05, ...rows.map(r => Math.abs(r.d)));
  $('#dWhyWrap').hidden = false;
  $('#dWhy').innerHTML = rows.map(r => `<div class="hrow why"><span title="${esc(r.p)}">${esc(r.p.trim().slice(0, 120))}</span><div class="hb ${r.d < 0 ? 'neg' : ''}"><i style="width:${Math.abs(r.d) / mx * 100}%"></i></div><b>${r.d >= 0 ? '+' : '−'}${Math.abs(r.d).toFixed(2)}</b></div>`).join('');
}
// Clicking a cell while Explain is open re-colours the text for that question.
$('#wall').addEventListener('click', e => { const c = e.target.closest('.cell'); if (c && S.explain) renderExplain(c.dataset.id); });
const _openDrawer = openDrawer;
openDrawer = function (id, quiet) { _openDrawer(id, quiet); drawerWhy(id); };

// ---------- share: a link that replays this exact result, no key needed ----------
function currentResult() {
  const set = S.set, a = S.answers[set.id], text = S.lastText[set.id];
  return a && text ? { set, a, text } : null;
}
function shareLink() {
  const r = currentResult(); if (!r) return null;
  if (r.text.length > 1500) return { tooLong: true };   // never pair a cut-down text with answers for the full text
  const h = new URLSearchParams({ v: '1', set: r.set.id, a: CODEC.enc(r.set.items.map(it => r.a[it.id] ?? 0)), t: r.text, s: S.src[r.set.id] === 'live' ? 'l' : 'r' });
  return location.origin + location.pathname + '#' + h.toString();
}
$('#shareBtn').onclick = async () => {
  const url = shareLink(); if (!url) { toast('Run some text first'); return; }
  if (url.tooLong) { toast('Share links hold up to 1,500 characters. Shorten the text, or use Save PNG / Export JSON.'); return; }
  track('share');
  try { await navigator.clipboard.writeText(url); toast('Link copied. It replays this exact result, no key needed.'); }
  catch { prompt('Copy this link:', url); }
};
function loadShared() {
  if (!location.hash.startsWith('#v=1')) return false;
  const h = new URLSearchParams(location.hash.slice(1));
  const set = SETS.find(s => s.id === h.get('set')), v = CODEC.dec(h.get('a') || ''), t = h.get('t') || '';
  if (!set || !v || v.length !== set.items.length || !t || t.length > 1500) return false;
  selectSet(set);
  inp.value = t; autosize();
  S.answers[set.id] = Object.fromEntries(set.items.map((it, i) => [it.id, v[i]])); S.lastText[set.id] = t; S.src[set.id] = 'shared';
  $('#wall').classList.remove('stale'); paint(false);
  $('#sharedBar').hidden = false;
  setState('shared result: answers carried in the link, not re-checked. Edit the text to ask Jev live.');
  return true;
}
$('#sharedX').onclick = () => { $('#sharedBar').hidden = true; history.replaceState(null, '', location.pathname + location.search); };

// ---------- fingerprint: the whole result as one shareable image ----------
if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) { this.rect(x, y, w, h); };
function heatColor(p, hue) {   // matches the CSS ramp (oklch) closely enough in HSL for a canvas
  const q = p * p * (0.35 + 0.65 * p);
  return `hsla(${hue + q * 40}, ${30 + q * 65}%, ${12 + q * 55}%, ${0.45 + p * 0.55})`;
}
function wrapText(g, text, x, y, maxW, lh, maxLines) {
  const words = text.replace(/\s+/g, ' ').split(' ').flatMap(w => w.length > 40 ? w.match(/.{1,40}/g) : [w]); let line = '', n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (g.measureText(test).width > maxW && line) {
      n++; if (n === maxLines) { g.fillText(line.replace(/\s*\S*$/, '') + ' …', x, y); return; }
      g.fillText(line, x, y); y += lh; line = words[i];
    } else line = test;
  }
  if (line) g.fillText(line, x, y);
}
function drawFingerprint() {
  const r = currentResult(); if (!r) return null;
  const { set, a, text } = r, src = S.src[set.id] || 'live', W = 1200, H = 630, c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2; const g = c.getContext('2d'); g.scale(2, 2);
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#07080e'); bg.addColorStop(1, `hsl(${set.hue}, 45%, 9%)`);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // grid: 8 categories (rows) x 25 questions
  const gx = 60, gy = 250, cw = 26, ch = 26, gap = 4;
  set.cats.forEach((cat, ci) => {
    g.fillStyle = '#9aa1b5'; g.font = '500 12px "JetBrains Mono", monospace'; g.textAlign = 'right';
    g.fillText(cat.name.slice(0, 18), gx + 150, gy + ci * (ch + gap) + 17);
    set.items.filter(x => x.ci === ci).forEach((it, k) => {
      const p = a[it.id] ?? 0, x = gx + 162 + k * (cw + gap), y = gy + ci * (ch + gap);
      g.fillStyle = heatColor(p, set.hue); g.beginPath(); g.roundRect(x, y, cw, ch, 5); g.fill();
      if (p >= S.thr) { g.strokeStyle = `hsla(${set.hue + 30}, 100%, 80%, .9)`; g.lineWidth = 1.2; g.stroke(); }
    });
  });
  g.textAlign = 'left';
  g.fillStyle = '#9aa1b5'; g.font = '500 13px "JetBrains Mono", monospace';
  g.fillText(`DECISION WALL · ${set.name.toUpperCase()} · 200 QUESTIONS · ONE JEV CALL`, 60, 62);
  g.fillStyle = '#eef0f7'; g.font = 'italic 34px "Instrument Serif", Georgia, serif';
  wrapText(g, '“' + text + '”', 60, 110, 1080, 40, 3);
  const top = [...set.items].sort((x, y) => (a[y.id] ?? 0) - (a[x.id] ?? 0)).slice(0, 6);
  g.font = '600 15px "Inter Tight", system-ui, sans-serif';
  let tx = 60; const ty = 222;
  for (const it of top) {
    const label = `${fmtP(a[it.id])} ${it.label}`, w = g.measureText(label).width + 22;
    if (tx + w > W - 60) break;
    g.fillStyle = `hsla(${set.hue}, 80%, 55%, .22)`; g.beginPath(); g.roundRect(tx, ty - 18, w, 26, 13); g.fill();
    g.fillStyle = '#eef0f7'; g.fillText(label, tx + 11, ty); tx += w + 8;
  }
  const lit = set.items.filter(it => (a[it.id] ?? 0) >= S.thr).length;
  g.fillStyle = '#6b728a'; g.font = '500 12px "JetBrains Mono", monospace';
  g.fillText(`${lit} of 200 above ${S.thr.toFixed(2)} · ${SRC_LABEL[src]} · independent demo, not affiliated with TypeSafe · github.com/charles-forsyth/jev-decision-wall`, 60, H - 28);
  return c;
}
$('#pngBtn').onclick = () => {
  const c = drawFingerprint(); if (!c) { toast('Run some text first'); return; }
  track('fingerprint');
  const link = document.createElement('a'); link.download = `decision-wall-${S.set.id}.png`; link.href = c.toDataURL('image/png'); link.click();
  toast('Fingerprint saved as PNG');
};

// ---------- export: everything Jev answered, as JSON ----------
$('#jsonBtn').onclick = () => {
  const r = currentResult(); if (!r) { toast('Run some text first'); return; }
  track('export');
  const out = { tool: 'jev-decision-wall', source: S.src[r.set.id] || 'live', set: r.set.id, text: r.text, threshold: S.thr, model: S.src[r.set.id] === 'recorded' && REPLAYS ? REPLAYS.model : undefined,
    answers: r.set.items.map(it => ({ id: it.id, category: it.cat, label: it.label, question: it.question, p: +(r.a[it.id] ?? 0).toFixed(4) })) };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.download = `decision-wall-${r.set.id}.json`; link.href = URL.createObjectURL(blob); link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
};

// ---------- toast ----------
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }
