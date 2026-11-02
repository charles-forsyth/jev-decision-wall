"use strict";
/* Compact encoding of 200 probabilities: one byte each (0-255), base64url. 200 answers -> 267 characters.
   Used for shareable links and recorded replays. Precision is 1/255 (about .004), plenty for a heatmap. */
(function (root) {
  const enc = ps => {
    let bin = ''; for (const p of ps) bin += String.fromCharCode(Math.max(0, Math.min(255, Math.round((+p || 0) * 255))));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const dec = s => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
    let bin; try { bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
    return Array.from(bin, c => c.charCodeAt(0) / 255);
  };
  // Split text into sentence-ish chunks for the Explain view (keeps the exact characters, so chunks rejoin to the text).
  const chunks = (text, max = 12) => {
    const parts = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)\s*/g) || [text];
    const out = parts.filter(p => p.trim());
    if (out.length <= max) return out;
    const size = Math.ceil(out.length / max), merged = [];   // too many: merge neighbours into max groups
    for (let i = 0; i < out.length; i += size) merged.push(out.slice(i, i + size).join(''));
    return merged;
  };
  const api = { enc, dec, chunks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JEV_CODEC = api;
})(typeof window !== 'undefined' ? window : globalThis);
