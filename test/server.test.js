// Server tests with a fake TypeSafe upstream: no network, no real key.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

let upstream, calls = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jdw-'));
function start(envOverrides) {
  for (const k of Object.keys(require.cache)) if (k.endsWith('server.js')) delete require.cache[k];
  Object.assign(process.env, envOverrides);
  const { server } = require('../server.js');
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}
const req = (srv, p, opts = {}) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, opts);
const ask = (srv, text, headers = {}) => req(srv, '/api/jev', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ set: 't', state: { text }, questions: { a: { type: 'noul', instructions: 'Q?' } } }) });

before(async () => {
  upstream = http.createServer((rq, rs) => {
    calls++;
    let b = ''; rq.on('data', c => b += c); rq.on('end', () => {
      const body = JSON.parse(b);
      assert.strictEqual(rq.headers.authorization, 'Bearer test-key');
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ model: 'jev-test', usage: { input_tokens: 100, output_tokens: 18 },
        answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { noul: 0.9 }])) }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
});
after(() => upstream.close());

test('local mode: serves page, proxies, caches, never leaks the key', async () => {
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${upstream.address().port}`,
    JEV_USAGE_FILE: path.join(tmp, 'u1.jsonl'), AUTH_HEADER: '', ALLOWED_DOMAIN: '' });
  try {
    const page = await req(srv, '/');
    assert.strictEqual(page.status, 200);
    assert.ok(!(await page.text()).includes('test-key'));
    const h = await (await req(srv, '/api/health')).json();
    assert.strictEqual(h.key, true); assert.strictEqual(h.user, null);
    assert.ok(!JSON.stringify(h).includes('test-key'));
    const before = calls;
    const r1 = await ask(srv, 'hello'); assert.strictEqual(r1.status, 200);
    assert.strictEqual((await r1.json()).answers.a.noul, 0.9);
    const r2 = await ask(srv, 'hello'); assert.strictEqual(r2.headers.get('x-cache'), 'hit');
    assert.strictEqual(calls - before, 1);
    assert.strictEqual((await req(srv, '/../server.js')).status, 404);
    assert.strictEqual((await req(srv, '/.env')).status, 404);
  } finally { srv.close(); }
});

test('rejects oversized and empty requests', async () => {
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${upstream.address().port}`, JEV_USAGE_FILE: path.join(tmp, 'u2.jsonl') });
  try {
    const empty = await req(srv, '/api/jev', { method: 'POST', body: JSON.stringify({ state: 'x', questions: {} }) });
    assert.strictEqual(empty.status, 400);
    const big = await ask(srv, 'x'.repeat(13000)); assert.strictEqual(big.status, 400);
  } finally { srv.close(); }
});

test('daily cap blocks further calls', async () => {
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${upstream.address().port}`,
    JEV_USAGE_FILE: path.join(tmp, 'u3.jsonl'), JEV_DAILY_TOKEN_CAP: '150' });
  try {
    assert.strictEqual((await ask(srv, 'one')).status, 200);
    assert.strictEqual((await ask(srv, 'two')).status, 200);
    assert.strictEqual((await ask(srv, 'three')).status, 429);
  } finally { srv.close(); delete process.env.JEV_DAILY_TOKEN_CAP; }
});

test('sign-in mode: header required and domain enforced', async () => {
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${upstream.address().port}`,
    JEV_USAGE_FILE: path.join(tmp, 'u4.jsonl'), AUTH_HEADER: 'x-goog-authenticated-user-email', ALLOWED_DOMAIN: 'example.edu' });
  try {
    assert.strictEqual((await req(srv, '/')).status, 403);
    assert.strictEqual((await req(srv, '/', { headers: { 'x-goog-authenticated-user-email': 'accounts.google.com:a@gmail.com' } })).status, 403);
    const ok = await req(srv, '/api/health', { headers: { 'x-goog-authenticated-user-email': 'accounts.google.com:Ann@example.edu' } });
    assert.strictEqual(ok.status, 200); assert.strictEqual((await ok.json()).user, 'ann@example.edu');
    assert.strictEqual((await req(srv, '/healthz')).status, 200);
  } finally { srv.close(); delete process.env.AUTH_HEADER; delete process.env.ALLOWED_DOMAIN; }
});

test('missing key gives a helpful error', async () => {
  delete process.env.TYPESAFE_API_KEY;
  const srv = await start({ JEV_KEY_FILE: path.join(tmp, 'nope'), JEV_USAGE_FILE: path.join(tmp, 'u5.jsonl') });
  try {
    assert.strictEqual((await (await req(srv, '/api/health')).json()).key, false);
    const r = await ask(srv, 'x'); assert.strictEqual(r.status, 500);
    assert.match((await r.json()).error, /TYPESAFE_API_KEY/);
  } finally { srv.close(); }
});

// ---------- v1.1 regression tests (from the 2026-11-01 review panel) ----------
test('malformed requests never crash the process', async () => {
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${upstream.address().port}`, JEV_USAGE_FILE: path.join(tmp, 'u6.jsonl') });
  try {
    assert.strictEqual((await req(srv, '/%E0%A4%A')).status, 400);
    assert.strictEqual((await req(srv, '/api/jev', { method: 'POST', body: 'null' })).status, 400);
    assert.strictEqual((await req(srv, '/api/jev', { method: 'POST', body: '[]' })).status, 400);
    assert.strictEqual((await req(srv, '/api/jev', { method: 'POST', body: JSON.stringify({ state: 'x', questions: { a: 'not an object' } }) })).status, 400);
    assert.strictEqual((await req(srv, '/api/event', { method: 'POST', body: 'null' })).status, 204);
    const long = { state: 'x', questions: { a: { type: 'noul', instructions: 'q'.repeat(401) } } };
    assert.strictEqual((await req(srv, '/api/jev', { method: 'POST', body: JSON.stringify(long) })).status, 400);
    assert.strictEqual((await req(srv, '/healthz')).status, 200);   // still alive
  } finally { srv.close(); }
});

test('only yes/no questions are forwarded, and the model cannot be overridden', async () => {
  let seen;
  const up = http.createServer((rq, rs) => { let b = ''; rq.on('data', c => b += c); rq.on('end', () => { seen = JSON.parse(b);
    rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ usage: { input_tokens: 1 }, answers: { a: { noul: .5 } } })); }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${up.address().port}`, JEV_USAGE_FILE: path.join(tmp, 'u7.jsonl') });
  try {
    await req(srv, '/api/jev', { method: 'POST', body: JSON.stringify({ model: 'expensive', state: 'x', questions: { a: { type: 'choice', instructions: 'Q?', criteria: { a: 1 } } } }) });
    assert.strictEqual(seen.model, 'jev-latest');
    assert.deepStrictEqual(seen.questions, { a: { type: 'noul', instructions: 'Q?' } });
  } finally { srv.close(); up.close(); }
});

test('upstream errors are summarized, timeouts return 504', async () => {
  const up = http.createServer((rq, rs) => { if (rq.url.includes('slow')) return; rs.writeHead(401, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ error: { message: 'bad key' }, debug: 'internal stuff' })); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  let srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${up.address().port}`, JEV_USAGE_FILE: path.join(tmp, 'u8.jsonl') });
  try {
    const r = await ask(srv, 'x'); assert.strictEqual(r.status, 401);
    const j = await r.json(); assert.match(j.error, /bad key/); assert.ok(!JSON.stringify(j).includes('internal stuff'));
  } finally { srv.close(); }
  srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${up.address().port}/slow`, JEV_TIMEOUT_MS: '300', JEV_USAGE_FILE: path.join(tmp, 'u9.jsonl') });
  try { assert.strictEqual((await ask(srv, 'y')).status, 504); }
  finally { srv.close(); up.closeAllConnections?.(); up.close(); delete process.env.JEV_TIMEOUT_MS; }
});

test('.env inline comments and bad numbers never disable the cap', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'env-'));
  fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(dir, 'server.js'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, '.env'), 'JEV_DAILY_TOKEN_CAP=150    # comment\nJEV_USER_DAILY_TOKEN_CAP=lots\n');
  delete process.env.JEV_DAILY_TOKEN_CAP; delete process.env.JEV_USER_DAILY_TOKEN_CAP;
  Object.assign(process.env, { TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${upstream.address().port}`, JEV_USAGE_FILE: path.join(tmp, 'u10.jsonl') });
  const { server } = require(path.join(dir, 'server.js'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const h = await (await req(server, '/api/health')).json();
    assert.strictEqual(h.cap, 150); assert.strictEqual(h.user_cap, 1000000);
    assert.strictEqual((await ask(server, 'a')).status, 200);
    assert.strictEqual((await ask(server, 'b')).status, 200);
    assert.strictEqual((await ask(server, 'c')).status, 429);
  } finally { server.close(); delete process.env.JEV_DAILY_TOKEN_CAP; delete process.env.JEV_USER_DAILY_TOKEN_CAP; }
});

test('a corrupt usage line does not reset the day total', async () => {
  const f = path.join(tmp, 'u11.jsonl'); const day = new Date().toLocaleDateString('en-CA');
  fs.writeFileSync(f, JSON.stringify({ day, in: 140 }) + '\n{oops\n');
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${upstream.address().port}`, JEV_USAGE_FILE: f, JEV_DAILY_TOKEN_CAP: '150' });
  try {
    assert.strictEqual((await (await req(srv, '/api/health')).json()).used_today, 140);
    assert.strictEqual((await ask(srv, 'one')).status, 200);
    assert.strictEqual((await ask(srv, 'two')).status, 429);
  } finally { srv.close(); delete process.env.JEV_DAILY_TOKEN_CAP; }
});

test('parallel calls reserve budget so a burst cannot run past the cap', async () => {
  // slow upstream: all 7 requests are in flight at once, like the app's "Fire all 7 sets"
  const slow = http.createServer((rq, rs) => { rq.resume(); setTimeout(() => { rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ usage: { input_tokens: 4000 }, answers: { a: { noul: .5 } } })); }, 150); });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', TYPESAFE_API_URL: `http://127.0.0.1:${slow.address().port}`, JEV_USAGE_FILE: path.join(tmp, 'u12.jsonl'), JEV_DAILY_TOKEN_CAP: '7000' });
  try {
    const rs = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(i => ask(srv, 'p' + i)));
    const ok = rs.filter(r => r.status === 200).length;
    assert.ok(ok <= 2, `expected at most 2 calls admitted against a 7000-token cap, got ${ok}`);
  } finally { srv.close(); slow.close(); delete process.env.JEV_DAILY_TOKEN_CAP; }
});

test('security headers include a content security policy', async () => {
  const srv = await start({ TYPESAFE_API_KEY: 'test-key', JEV_USAGE_FILE: path.join(tmp, 'u13.jsonl') });
  try {
    const r = await req(srv, '/');
    assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  } finally { srv.close(); }
});
