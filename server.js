#!/usr/bin/env node
// Jev Decision Wall — zero-dependency Node server.
// Serves ./public and proxies POST /api/jev to TypeSafe so your API key never reaches the browser.
//
// Key (first one found wins):
//   1. TYPESAFE_API_KEY environment variable
//   2. TYPESAFE_API_KEY=... line in ./.env
//   3. JEV_KEY_FILE path (default ~/.config/jev/.key)
//
// Optional sign-in gate (for hosting behind Google IAP or any proxy that sets the header):
//   AUTH_HEADER=x-goog-authenticated-user-email  ALLOWED_DOMAIN=example.edu
// With no AUTH_HEADER the server is open to whoever can reach it: keep HOST=127.0.0.1 locally.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

// ---------- config ----------
function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
loadDotEnv();
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const PORT = +env('PORT', 8770);
const HOST = env('HOST', '127.0.0.1');
const KEY_FILE = env('JEV_KEY_FILE', path.join(os.homedir(), '.config', 'jev', '.key'));
const API_URL = env('TYPESAFE_API_URL', 'https://api.typesafe.ai/v1/systemone');
const MODEL = env('JEV_MODEL', 'jev-latest');
const CAP = +env('JEV_DAILY_TOKEN_CAP', 5_000_000);           // all users, input tokens/day (~$0.21 at $0.042/M)
const USER_CAP = +env('JEV_USER_DAILY_TOKEN_CAP', 1_000_000); // per signed-in user
const PRICE_PER_MTOK = +env('JEV_PRICE_PER_MTOK', 0.042);
const USAGE = env('JEV_USAGE_FILE', path.join(os.homedir(), '.config', 'jev', 'usage.jsonl'));
const AUTH_HEADER = env('AUTH_HEADER', '').toLowerCase();
const ALLOWED_DOMAIN = env('ALLOWED_DOMAIN', '').toLowerCase();
const NOTICE = env('NOTICE', '');
const ROOT = path.join(__dirname, 'public');
const MAX_Q = 220, MAX_STATE = 12000;

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

// ---------- usage + caps ----------
const today = () => new Date().toLocaleDateString('en-CA');
let dayUse = { day: null, t: 0 };
function usedToday() {
  const d = today();
  if (dayUse.day === d) return dayUse.t;
  let t = 0;
  try { for (const l of fs.readFileSync(USAGE, 'utf8').split('\n')) { if (!l) continue; const r = JSON.parse(l); if (r.day === d) t += r.in || 0; } } catch {}
  return (dayUse = { day: d, t }).t;
}
function logUsage(rec) {
  try { fs.mkdirSync(path.dirname(USAGE), { recursive: true }); fs.appendFileSync(USAGE, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch {}
  usedToday(); dayUse.t += rec.in;
}
const userUse = new Map();

// ---------- identity + audit (only when AUTH_HEADER is set) ----------
function who(req) {
  if (!AUTH_HEADER) return null;
  const h = req.headers[AUTH_HEADER];
  return h ? String(h).replace(/^accounts\.google\.com:/, '').toLowerCase() : null;
}
function audit(event, user, fields = {}) {
  if (!AUTH_HEADER) return;
  console.log(JSON.stringify({ severity: 'INFO', component: 'jev-decision-wall', event, user, ...fields, time: new Date().toISOString() }));
}

// ---------- answer cache ----------
const cache = new Map();
const cacheGet = k => { if (!cache.has(k)) return null; const v = cache.get(k); cache.delete(k); cache.set(k, v); return v; };
const cachePut = (k, v) => { cache.set(k, v); if (cache.size > 500) cache.delete(cache.keys().next().value); };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...SEC, ...extra }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit) { let b = ''; for await (const c of req) { b += c; if (b.length > limit) throw Object.assign(new Error('too large'), { code: 413 }); } return b; }

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/healthz') return json(res, 200, { ok: true });
  const user = who(req);
  if (AUTH_HEADER && (!user || (ALLOWED_DOMAIN && !user.endsWith('@' + ALLOWED_DOMAIN)))) {
    audit('denied', user, { path: url });
    return json(res, 403, { error: ALLOWED_DOMAIN ? `sign in with a @${ALLOWED_DOMAIN} account` : 'sign-in required' });
  }

  if (url === '/api/health') {
    const used = usedToday(), mine = userUse.get(today() + '|' + user) || 0;
    return json(res, 200, { ok: true, key: !!apiKey(), user, notice: NOTICE || null, used_today: used, cap: CAP, user_used: mine, user_cap: USER_CAP,
      cost_today_usd: +(used / 1e6 * PRICE_PER_MTOK).toFixed(5), blocked: used >= CAP || (!!user && mine >= USER_CAP) });
  }

  if (url === '/api/event' && req.method === 'POST') {
    let e = {}; try { e = JSON.parse(await readBody(req, 4000)); } catch {}
    const ev = String(e.event || '').replace(/[^a-z_]/g, '').slice(0, 30);
    if (['open_set', 'sample', 'burst', 'open_gate'].includes(ev)) audit(ev, user, { set: String(e.set || '').slice(0, 20), detail: String(e.detail || '').slice(0, 120) });
    res.writeHead(204, SEC); return res.end();
  }

  if (url === '/api/jev' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 400000)); } catch (e) { return json(res, e.code || 400, { error: e.message || 'bad json' }); }
    const nq = Object.keys(body.questions || {}).length;
    if (!nq || nq > MAX_Q) return json(res, 400, { error: `need 1..${MAX_Q} questions` });
    if (JSON.stringify(body.state || '').length > MAX_STATE) return json(res, 400, { error: 'text too long (12k chars max)' });
    const key = apiKey();
    if (!key) return json(res, 500, { error: 'no API key: set TYPESAFE_API_KEY (see README)' });
    const out = { model: MODEL, state: body.state, questions: body.questions };
    const meta = { set: String(body.set || '').slice(0, 20), mode: String(body.mode || '').slice(0, 12), gates: nq };
    const text = typeof body.state?.text === 'string' ? body.state.text : '';
    const tinfo = { chars: text.length, text_sha: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) };
    const k = crypto.createHash('sha1').update(JSON.stringify(out)).digest('hex');
    const hit = body.fresh ? null : cacheGet(k);
    if (hit) { audit('ask', user, { ...meta, ...tinfo, cache: 'hit' }); return json(res, 200, hit, { 'X-Upstream-Ms': '0', 'X-Cache': 'hit' }); }
    const used = usedToday(), ukey = today() + '|' + user, mine = userUse.get(ukey) || 0;
    if (user && mine >= USER_CAP) { audit('capped_user', user, meta); return json(res, 429, { error: `your daily limit is reached (${mine.toLocaleString()} tokens). It resets at midnight.` }); }
    if (used >= CAP) { audit('capped_global', user, meta); return json(res, 429, { error: `daily cap reached (${used.toLocaleString()} of ${CAP.toLocaleString()} tokens). Raise JEV_DAILY_TOKEN_CAP to continue.` }); }
    const t0 = Date.now();
    try {
      const r = await fetch(API_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
      const txt = await r.text(), ms = Date.now() - t0;
      let parsed = null, inTok = 0, outTok = 0;
      try { parsed = JSON.parse(txt); inTok = parsed.usage?.input_tokens || 0; outTok = parsed.usage?.output_tokens || 0; } catch {}
      logUsage({ ts: new Date().toISOString(), day: today(), app: 'jev-decision-wall', user, status: r.status, gates: nq, in: inTok, out: outTok, ms });
      if (user) userUse.set(ukey, mine + inTok);
      audit('ask', user, { ...meta, ...tinfo, cache: 'miss', status: r.status, ms, in_tokens: inTok, out_tokens: outTok, model: parsed?.model });
      if (!AUTH_HEADER) console.log(`jev ${r.status} · ${nq} questions · ${ms} ms · ${inTok} input tokens · today ${usedToday().toLocaleString()}/${CAP.toLocaleString()}`);
      if (r.ok && parsed) cachePut(k, parsed);
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'X-Upstream-Ms': String(ms), 'X-Cache': 'miss', ...SEC });
      return res.end(txt);
    } catch (e) { return json(res, 502, { error: 'upstream: ' + String(e.message || e) }); }
  }

  const p = url === '/' ? '/index.html' : url;
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, SEC); return res.end('not found'); }
  if (p === '/index.html') audit('page_view', user);
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
  fs.createReadStream(f).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Jev Decision Wall  ->  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    console.log(apiKey() ? '  API key: found' : '  API key: MISSING - set TYPESAFE_API_KEY or create .env (see README)');
    console.log(`  Daily cap: ${CAP.toLocaleString()} input tokens${AUTH_HEADER ? ` | sign-in via ${AUTH_HEADER}${ALLOWED_DOMAIN ? ' @' + ALLOWED_DOMAIN : ''}` : ' | no sign-in (local mode)'}\n`);
  });
}
module.exports = { server };
