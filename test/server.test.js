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
