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
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);          // quoted: keep as-is (may contain #)
      else v = v.replace(/\s+#.*$/, '');                       // unquoted: strip inline comment
      process.env[m[1]] = v;
    }
  } catch {}
}
loadDotEnv();
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
// Numbers: a typo or NaN falls back to the default (never silently disables a cap).
const num = (k, d) => { const n = Number(env(k, d)); if (!Number.isFinite(n) || n <= 0) { if (process.env[k]) console.warn(`  ${k}=${process.env[k]} is not a positive number; using ${d}`); return d; } return n; };
const PORT = num('PORT', 8770);
const HOST = env('HOST', '127.0.0.1');
const KEY_FILE = env('JEV_KEY_FILE', path.join(os.homedir(), '.config', 'jev', '.key'));
const API_URL = env('TYPESAFE_API_URL', 'https://api.typesafe.ai/v1/systemone');
const MODEL = env('JEV_MODEL', 'jev-latest');
const CAP = num('JEV_DAILY_TOKEN_CAP', 5_000_000);          // all users, input tokens/day (~$0.21 at $0.042/M)
const USER_CAP = num('JEV_USER_DAILY_TOKEN_CAP', 1_000_000); // per signed-in user
const PRICE_PER_MTOK = num('JEV_PRICE_PER_MTOK', 0.042);
const USAGE = env('JEV_USAGE_FILE', path.join(os.homedir(), '.config', 'jev', 'usage.jsonl'));
const AUTH_HEADER = env('AUTH_HEADER', '').toLowerCase();
const ALLOWED_DOMAIN = env('ALLOWED_DOMAIN', '').toLowerCase();
const NOTICE = env('NOTICE', '');
if (ALLOWED_DOMAIN && !AUTH_HEADER) {   // fail closed: a domain limit without a sign-in header would silently allow everyone
  console.error('ALLOWED_DOMAIN is set but AUTH_HEADER is not, so the domain limit cannot be enforced. Set AUTH_HEADER (e.g. x-goog-authenticated-user-email) or unset ALLOWED_DOMAIN.');
  process.exit(1);
}
const ROOT = path.join(__dirname, 'public');
const HASH_SALT = env('LOG_HASH_SALT', crypto.randomBytes(16).toString('hex'));   // keyed hash: short texts can't be guessed from audit logs
const MAX_Q = 220, MAX_STATE = 12000, MAX_Q_CHARS = 400, UPSTREAM_TIMEOUT_MS = num('JEV_TIMEOUT_MS', 15000);
const EST_TOKENS_PER_CALL = 6000; // reserved before each call so parallel requests can't slip past the caps

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
  let raw = ''; try { raw = fs.readFileSync(USAGE, 'utf8'); } catch {}
  for (const l of raw.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r.day === d) t += r.in || 0; } catch {} }
  return (dayUse = { day: d, t }).t;
}
function logUsage(rec) {
  try { fs.mkdirSync(path.dirname(USAGE), { recursive: true }); fs.appendFileSync(USAGE, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch {}
  usedToday(); dayUse.t += rec.in;
}
const userUse = new Map();
let inflight = 0; const userInflight = new Map();   // reserved tokens for calls still in progress
function pruneUsers() { const d = today(); for (const k of userUse.keys()) if (!k.startsWith(d + '|')) userUse.delete(k); }
setInterval(pruneUsers, 3600_000).unref();


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
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP };
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...SEC, ...extra }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) { req.destroy(); throw Object.assign(new Error('too large'), { code: 413 }); } chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');   // decode once, so multi-byte characters split across chunks stay intact
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('handler error:', err && err.message);
    try { if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end(); } catch {}
  });
});
async function handle(req, res) {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch { return json(res, 400, { error: 'bad url' }); }
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
    let e = {}; try { e = JSON.parse(await readBody(req, 4000)); } catch { if (req.destroyed) return; }
    if (!e || typeof e !== 'object') e = {};
    const ev = String(e.event || '').replace(/[^a-z_]/g, '').slice(0, 30);
    if (['open_set', 'sample', 'burst', 'open_gate'].includes(ev)) audit(ev, user, { set: String(e.set || '').slice(0, 20), detail: String(e.detail || '').slice(0, 120) });
    res.writeHead(204, SEC); return res.end();
  }

  if (url === '/api/jev' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 400000)); }
    catch (e) { if (req.destroyed && e.code !== 413) return; return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'too large' : 'bad json' }); }
    if (!body || typeof body !== 'object' || !body.questions || typeof body.questions !== 'object') return json(res, 400, { error: 'expected {state, questions}' });
    const questions = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (!q || typeof q !== 'object' || typeof q.instructions !== 'string' || q.instructions.length > MAX_Q_CHARS || String(id).length > 40)
        return json(res, 400, { error: `each question needs instructions (max ${MAX_Q_CHARS} chars)` });
      questions[id] = { type: 'noul', instructions: q.instructions };   // only yes/no questions are proxied
    }
    const nq = Object.keys(questions).length;
    const qChars = Object.values(questions).reduce((n, q) => n + q.instructions.length, 0);
    if (qChars > MAX_Q * 160) return json(res, 400, { error: 'questions too long in total' });
    if (!nq || nq > MAX_Q) return json(res, 400, { error: `need 1..${MAX_Q} questions` });
    if (JSON.stringify(body.state || '').length > MAX_STATE) return json(res, 400, { error: 'text too long (12k chars max)' });
    const key = apiKey();
    if (!key) return json(res, 500, { error: 'no API key: set TYPESAFE_API_KEY (see README)' });
    const out = { model: MODEL, state: body.state, questions };
    const meta = { set: String(body.set || '').slice(0, 20), mode: String(body.mode || '').slice(0, 12), gates: nq };
    const text = typeof body.state?.text === 'string' ? body.state.text : '';
    const tinfo = { chars: text.length, text_hmac: crypto.createHmac('sha256', HASH_SALT).update(text).digest('hex').slice(0, 16) };
    const k = crypto.createHash('sha1').update(JSON.stringify(out)).digest('hex');
    const hit = body.fresh ? null : cacheGet(k);
    if (hit) { audit('ask', user, { ...meta, ...tinfo, cache: 'hit' }); return json(res, 200, hit, { 'X-Upstream-Ms': '0', 'X-Cache': 'hit' }); }
    const ukey = today() + '|' + user, used = usedToday() + inflight, mine = (userUse.get(ukey) || 0) + (userInflight.get(ukey) || 0);
    if (user && mine >= USER_CAP) { audit('capped_user', user, meta); return json(res, 429, { error: `your daily limit is reached (${mine.toLocaleString()} tokens). It resets at midnight.` }); }
    if (used >= CAP) { audit('capped_global', user, meta); return json(res, 429, { error: `daily cap reached (${used.toLocaleString()} of ${CAP.toLocaleString()} tokens). Raise JEV_DAILY_TOKEN_CAP to continue.` }); }
    // Reserve an estimate before calling (about 4 characters per token, never less than the old flat 6,000),
    // so parallel calls can't all pass the cap check at once. Released exactly once.
    const est = Math.max(EST_TOKENS_PER_CALL, Math.ceil((JSON.stringify(out).length) / 3));
    inflight += est; userInflight.set(ukey, (userInflight.get(ukey) || 0) + est);
    let released = false;
    const release = () => { if (released) return; released = true; inflight -= est; const v = (userInflight.get(ukey) || 0) - est; if (v > 0) userInflight.set(ukey, v); else userInflight.delete(ukey); };
    const t0 = Date.now();
    try {
      const r = await fetch(API_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(out), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const txt = await r.text(), ms = Date.now() - t0;
      let parsed = null, inTok = 0, outTok = 0;
      try { parsed = JSON.parse(txt); inTok = parsed.usage?.input_tokens || 0; outTok = parsed.usage?.output_tokens || 0; } catch {}
      if (!r.ok && !inTok) inTok = 0;   // failed calls are not billed by TypeSafe
      logUsage({ ts: new Date().toISOString(), day: today(), app: 'jev-decision-wall', user, status: r.status, gates: nq, in: inTok, out: outTok, ms });
      release();
      if (user) userUse.set(ukey, (userUse.get(ukey) || 0) + inTok);
      audit('ask', user, { ...meta, ...tinfo, cache: 'miss', status: r.status, ms, in_tokens: inTok, out_tokens: outTok, model: parsed?.model });
      if (!AUTH_HEADER) console.log(`jev ${r.status} · ${nq} questions · ${ms} ms · ${inTok} input tokens · today ${usedToday().toLocaleString()}/${CAP.toLocaleString()}`);
      if (!r.ok || !parsed || !parsed.answers) {
        const msg = (parsed && (parsed.error?.message || parsed.error || parsed.detail)) || `HTTP ${r.status}`;
        return json(res, r.status >= 400 && r.status < 600 ? r.status : 502, { error: 'TypeSafe: ' + String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300) });
      }
      cachePut(k, parsed);
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream-Ms': String(ms), 'X-Cache': 'miss', ...SEC });
      return res.end(txt);
    } catch (e) {
      release();
      const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      return json(res, timeout ? 504 : 502, { error: timeout ? `TypeSafe did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} s` : 'could not reach TypeSafe' });
    }
  }

  const p = url === '/' ? '/index.html' : url;
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, SEC); return res.end('not found'); }
  if (p === '/index.html') audit('page_view', user);
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
  fs.createReadStream(f).on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); }).pipe(res);
}

server.requestTimeout = 30000; server.headersTimeout = 15000;
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Jev Decision Wall  ->  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    console.log(apiKey() ? '  API key: found' : '  API key: MISSING - set TYPESAFE_API_KEY or create .env (see README)');
    console.log(`  Daily cap: ${CAP.toLocaleString()} input tokens${AUTH_HEADER ? ` | sign-in via ${AUTH_HEADER}${ALLOWED_DOMAIN ? ' @' + ALLOWED_DOMAIN : ''}` : ' | no sign-in (local mode)'}\n`);
  });
}
module.exports = { server };
