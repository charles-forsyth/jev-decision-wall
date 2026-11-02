#!/usr/bin/env node
// Records real Jev answers for every sample text against every question set, so the page can run
// without a key (GitHub Pages "Try it" mode). Output: public/replays.js. Costs ~28 x 7 calls (~$0.04).
//   TYPESAFE_API_KEY=ts-... node scripts/record-replays.js
const fs = require('fs'), path = require('path'), os = require('os');
global.window = {}; global.btoa = s => Buffer.from(s, 'binary').toString('base64');
const { enc } = require('../public/codec.js');
const dir = path.join(__dirname, '..', 'public', 'sets');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) require(path.join(dir, f));
const key = process.env.TYPESAFE_API_KEY || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.config', 'jev', '.key'), 'utf8').trim(); } catch { return ''; } })();
if (!key) { console.error('set TYPESAFE_API_KEY'); process.exit(1); }
const URL = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone';
const items = s => s.cats.flatMap((c, ci) => c.q.map((raw, qi) => ({ id: `q${ci}_${qi}`, question: raw.split('|')[1] })));
async function ask(set, text) {
  const its = items(set);
  const body = { model: 'jev-latest', state: { text }, questions: Object.fromEntries(its.map(it => [it.id, { type: 'noul', instructions: it.question + ' (about `text`)' }])) };
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { const d = await r.json(); return { a: enc(its.map(it => d.answers[it.id]?.noul ?? 0)), tok: d.usage?.input_tokens || 0, model: d.model }; }
    if (attempt >= 3) throw new Error(`${set.id}: HTTP ${r.status} ${await r.text()}`);
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
}
(async () => {
  const SETS = window.JEV_SETS, texts = [];
  for (const s of SETS) for (const x of s.samples) texts.push({ set: s.id, name: x.name, text: x.text });
  const out = { recorded: new Date().toISOString().slice(0, 10), model: '', texts: texts.map(t => ({ ...t, a: {} })) };
  let tok = 0;
  for (const [i, t] of texts.entries()) {            // one text at a time, its 7 sets in parallel
    const rs = await Promise.all(SETS.map(s => ask(s, t.text)));
    rs.forEach((r, k) => { out.texts[i].a[SETS[k].id] = r.a; tok += r.tok; out.model = r.model || out.model; });
    process.stdout.write(`\r${i + 1}/${texts.length} texts · ${tok.toLocaleString()} tokens`);
  }
  const js = `// Recorded Jev answers (${out.recorded}, ${out.model}) for every sample x every set. Made by scripts/record-replays.js.\nwindow.JEV_REPLAYS = ${JSON.stringify(out)};\n`;
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'replays.js'), js);
  console.log(`\nwrote public/replays.js (${(js.length / 1024).toFixed(0)} KB, ${tok.toLocaleString()} tokens, ~$${(tok * 0.042 / 1e6).toFixed(3)})`);
})().catch(e => { console.error('\n' + e.message); process.exit(1); });
