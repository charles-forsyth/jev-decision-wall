#!/usr/bin/env node
// Copies the app into docs/app/ so GitHub Pages can serve a no-key "try it" version.
// With no server behind it, the page finds /api/health missing and plays recorded answers (public/replays.js).
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'public'), dst = path.join(__dirname, '..', 'docs', 'app');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log('docs/app <- public/ (' + fs.readdirSync(dst, { recursive: true }).length + ' files)');
