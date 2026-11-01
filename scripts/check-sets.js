#!/usr/bin/env node
// Validates every question set: 8 categories x 25 = 200, "Label|Question" format, unique labels and questions.
const fs = require('fs'), path = require('path');
global.window = {};
const dir = path.join(__dirname, '..', 'public', 'sets');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) require(path.join(dir, f));
let bad = 0;
for (const s of window.JEV_SETS) {
  const all = s.cats.flatMap(c => c.q), errs = [];
  if (all.length !== 200) errs.push(`${all.length} questions (want 200)`);
  const malformed = all.filter(x => x.split('|').length !== 2 || !x.split('|')[1].trim().endsWith('?'));
  if (malformed.length) errs.push(`malformed: ${malformed.slice(0, 3).join(' / ')}`);
  const dup = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);
  const dl = dup(all.map(x => x.split('|')[0])), dq = dup(all.map(x => x.split('|')[1]));
  if (dl.length) errs.push(`duplicate labels: ${dl.join(', ')}`);
  if (dq.length) errs.push(`duplicate questions: ${dq.join(', ')}`);
  if (!s.samples?.length) errs.push('no samples');
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${s.id.padEnd(10)} ${s.cats.length} categories, ${all.length} questions, ${s.samples.length} samples${errs.length ? '\n     ' + errs.join('\n     ') : ''}`);
  bad += errs.length;
}
process.exit(bad ? 1 : 0);
