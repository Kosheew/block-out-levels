#!/usr/bin/env node
/* Builds data/reference.json — AGGREGATES ONLY of the reference game's levels (Tap Block Out).

     node tools/build-reference.mjs <level-complexity.html | its DATA as .json | dir with LevelData*.json>

   After Funjo's DMCA notice (2026-11-11) no reference layout may be stored in this repo or shown on the site. This
   script reads the layouts locally and writes only rolling medians / percentiles per position and band tables. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise, measure, rolling, bands, DEFAULT_BANDS } from '../app/metrics.js';

const src = process.argv[2];
if (!src) { console.error('usage: build-reference.mjs <level-complexity.html | levels dir>'); process.exit(1); }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'reference.json');

const sets = {};
if (src.endsWith('.html') || src.endsWith('.json')) {
  // the report page, or its DATA object saved as JSON
  const text = fs.readFileSync(src, 'utf8');
  const i = text.indexOf('const DATA = ') + 13;
  const D = src.endsWith('.json') ? JSON.parse(text) : JSON.parse(text.slice(i, text.indexOf('</script>', i)).trim().replace(/;\s*$/, ''));
  for (const [set, s] of Object.entries(D.sets)) {
    sets[set] = (s.refLevels || []).map((L, k) => ({
      id: k + 1, w: L.w, h: L.h, moves: L.moves, tier: 'easy',
      pieces: L.p.map(([to, outer, idx]) => ({ to, ...(outer ? { outer } : {}), at: idx.map((n) => [n % L.w, Math.floor(n / L.w)]) })),
    }));
  }
} else {
  const walk = (d) => fs.readdirSync(d).flatMap((f) => { const p = path.join(d, f); return fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : []; });
  for (const p of walk(src)) {
    const name = path.basename(p, '.json');
    const set = /^Challenge/.test(name) ? 'challenge' : /^Colorful/.test(name) ? 'roadtrip' : /^Special/.test(name) ? 'special' : /^LevelData/.test(name) ? 'normal' : null;
    if (!set || p.includes('groupB')) continue;
    try { (sets[set] ||= []).push(...normalise(JSON.parse(fs.readFileSync(p, 'utf8')), +(name.match(/\d+$/)?.[0] ?? 0))); } catch { /* skip */ }
  }
  for (const s of Object.values(sets)) s.sort((a, b) => a.id - b.id);
}

const r = (a, d = 1) => a.map((x) => (Number.isFinite(x) ? +x.toFixed(d) : null));
const result = { note: 'Aggregates of the reference game (Tap Block Out 1.9.x). No layouts. Rolling window +-25 levels.', sets: {} };
for (const [set, levels] of Object.entries(sets)) {
  if (!levels.length) continue;
  const stats = levels.map((L, k) => measure(L, k));
  const col = (f) => stats.map((s) => s[f]);
  const half = Math.min(25, Math.max(3, Math.floor(levels.length / 20)));
  const roll = (vals, d) => { const x = rolling(vals, half); return { med: r(x.med, d), p10: r(x.p10, d), p90: r(x.p90, d) }; };
  result.sets[set] = {
    count: levels.length,
    window: half,
    rolling: {
      C: roll(col('C'), 1), n: roll(col('n'), 0), spare: roll(col('spare'), 0), area: roll(stats.map((s) => s.w * s.h), 0),
      free0: roll(col('free0'), 0), depth: roll(col('depth'), 0), layers: roll(col('layers'), 0), singles: roll(col('singles'), 2),
    },
    bands: bands(stats, DEFAULT_BANDS[set] || DEFAULT_BANDS.normal).map(({ tricky, expert, ...b }) => b),
  };
  console.log(`${set}: ${levels.length} levels aggregated`);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result));
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0), 'KB');
