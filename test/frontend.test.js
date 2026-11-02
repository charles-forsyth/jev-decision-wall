// Front-end data checks: share-link codec, recorded replays, and the GitHub Pages copy.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
global.window = {};
global.btoa ??= s => Buffer.from(s, 'binary').toString('base64');
global.atob ??= s => Buffer.from(s, 'base64').toString('binary');
const ROOT = path.join(__dirname, '..');
const { enc, dec, chunks } = require(path.join(ROOT, 'public', 'codec.js'));
for (const f of fs.readdirSync(path.join(ROOT, 'public', 'sets')).sort()) require(path.join(ROOT, 'public', 'sets', f));
require(path.join(ROOT, 'public', 'replays.js'));

test('codec round-trips 200 probabilities within 1/255 and stays URL-safe', () => {
  const ps = Array.from({ length: 200 }, (_, i) => (i * 0.137) % 1);
  const s = enc(ps);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
  assert.strictEqual(s.length, 267);
  dec(s).forEach((p, i) => assert.ok(Math.abs(p - ps[i]) <= 1 / 255 / 2 + 1e-9));
  assert.strictEqual(dec('not base64 !!'), null);
  assert.deepStrictEqual(dec(enc([0, 1, -3, 7, NaN])), [0, 1, 0, 1, 0]);
});

test('chunks keep every character of the text', () => {
  const t = 'Hey there. The board moved the review! Can you send slides?\nThanks, Sam';
  assert.strictEqual(chunks(t).join(''), t);
  assert.ok(chunks(t).length >= 3);
  const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i}.`).join(' ');
  assert.ok(chunks(long, 12).length <= 12);
  assert.strictEqual(chunks(long, 12).join(''), long);
});

test('recorded replays cover every sample of every set, 200 answers each', () => {
  const R = window.JEV_REPLAYS, SETS = window.JEV_SETS;
  assert.ok(R && R.model && R.recorded);
  for (const s of SETS) for (const x of s.samples) {
    const r = R.texts.find(t => t.text === x.text);
    assert.ok(r, `no replay for sample "${x.name}" in ${s.id}`);
    for (const s2 of SETS) {
      const v = dec(r.a[s2.id]);
      assert.ok(v && v.length === 200, `${x.name} x ${s2.id}: ${v && v.length}`);
    }
  }
});

test('docs/app matches public/ (run npm run pages after editing public/)', () => {
  const walk = d => fs.readdirSync(d, { recursive: true }).filter(f => fs.statSync(path.join(d, f)).isFile()).sort();
  const a = walk(path.join(ROOT, 'public')), b = walk(path.join(ROOT, 'docs', 'app'));
  assert.deepStrictEqual(b, a);
  for (const f of a) assert.ok(fs.readFileSync(path.join(ROOT, 'public', f)).equals(fs.readFileSync(path.join(ROOT, 'docs', 'app', f))), `docs/app/${f} is stale`);
});

test('codec rejects truncated or tampered payloads by length', () => {
  const s = enc(Array(200).fill(0.5));
  assert.strictEqual(dec(s).length, 200);
  assert.notStrictEqual(dec(s.slice(0, -4)).length, 200);   // app requires exactly 200
  assert.strictEqual(dec('a b'), null);
  assert.strictEqual(dec(null), null);
});

test('replay answers are probabilities and differ between samples', () => {
  const R = window.JEV_REPLAYS;
  const seen = new Set();
  for (const t of R.texts) for (const v of Object.values(t.a)) {
    const d = dec(v); assert.ok(d.every(p => p >= 0 && p <= 1)); seen.add(v);
  }
  assert.ok(seen.size > R.texts.length * 5, 'replays look duplicated');
});
