/* Level metrics, format normalisation and validation. Pure module (worker, page and Node).

   Internal level shape: {id, w, h, moves, tier, pieces: [{to, outer?, at: [[col, row]...]}]}
   — the game's "blockout-levels/2" format (Assets/Resources/Levels), y down. */

import { mulberry32 } from './generator.js';

export const STAT_FIELDS = ['id', 'w', 'h', 'n', 'cells', 'layers', 'moves', 'spare', 'tier', 'free0', 'depth', 'C', 'mf', 'singles', 'fill', 'domDir'];
export const TIERS = ['easy', 'tricky', 'expert'];
const DIR = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const NAME = { up: 'N', down: 'S', right: 'E', left: 'W', N: 'N', E: 'E', S: 'S', W: 'W' };
const TIER_OF = { 1: 'easy', 2: 'tricky', 3: 'expert', easy: 'easy', tricky: 'tricky', expert: 'expert', normal: 'easy', hard: 'tricky', superhard: 'expert' };

/* ---------------------------------------------------------------- formats -- */
/* Accepts: {"format":"blockout-levels/2","levels":[...]}, a bare array of levels, a single level, or a level in the
   "editor" format ({gridSize, blockList[{exitDir, cells[{x: row, y: col}]}]}). Returns an array of levels. */
export function normalise(json, fallbackId = 1) {
  if (Array.isArray(json)) return json.flatMap((l, i) => normalise(l, fallbackId + i));
  if (json && Array.isArray(json.levels)) return json.levels.flatMap((l, i) => normalise(l, fallbackId + i));
  if (json && Array.isArray(json.pieces)) {
    return [{ ...json, id: json.id ?? fallbackId, tier: TIER_OF[json.tier] || 'easy',
      pieces: json.pieces.map((p) => ({ ...p, to: NAME[p.to] })) }];
  }
  if (json && Array.isArray(json.blockList)) {
    const pieces = json.blockList.map((b) => {
      const p = { to: NAME[b.exitDir], at: b.cells.map((c) => [c.y, c.x]) };
      if (b.outerExitDir) p.outer = NAME[b.outerExitDir];
      return p;
    });
    const xs = pieces.flatMap((p) => p.at.map((c) => c[0]));
    const ys = pieces.flatMap((p) => p.at.map((c) => c[1]));
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    for (const p of pieces) p.at = p.at.map(([x, y]) => [x - x0, y - y0]);
    const n = pieces.length + pieces.filter((p) => p.outer).length;
    return [{ id: json.id ?? fallbackId, w: Math.max(...xs) - x0 + 1, h: Math.max(...ys) - y0 + 1,
      moves: json.moves ?? json.StepLimit ?? n + 5, tier: TIER_OF[json.tier ?? json.Difficulty] || 'easy', pieces }];
  }
  throw new Error('невідомий формат рівня');
}

/* The set file as the game reads one chunk. */
export function toSetFile(levels) {
  return '{"format":"blockout-levels/2","levels":[\n' + levels.map((l) => JSON.stringify(l)).join(',\n') + '\n]}\n';
}

/* -------------------------------------------------------------- validation -- */
export function validate(L) {
  const errs = [];
  if (!(L.w > 0 && L.h > 0)) errs.push('розмір поля');
  const grid = new Int32Array(L.w * L.h).fill(-1);
  L.pieces.forEach((p, i) => {
    if (!DIR[p.to]) errs.push(`блок ${i}: напрямок ${p.to}`);
    if (p.outer && (!DIR[p.outer] || p.outer === p.to)) errs.push(`блок ${i}: зовнішній шар ${p.outer}`);
    if (!p.at?.length) errs.push(`блок ${i}: без клітинок`);
    for (const [x, y] of p.at || []) {
      if (x < 0 || y < 0 || x >= L.w || y >= L.h) { errs.push(`блок ${i}: клітинка ${x},${y} поза полем`); continue; }
      if (grid[y * L.w + x] >= 0) errs.push(`блок ${i}: перекриває блок ${grid[y * L.w + x]}`);
      grid[y * L.w + x] = i;
    }
  });
  if (errs.length) return errs;
  if (solveRounds(L) < 0) errs.push('рівень не розв\'язується');
  const taps = L.pieces.length + L.pieces.filter((p) => p.outer).length;
  if (!(L.moves >= taps)) errs.push(`ходів ${L.moves} < потрібних тапів ${taps}`);
  return errs;
}

/* ------------------------------------------------------------------ play -- */
export class Board {
  constructor(L) {
    this.L = L;
    this.grid = new Int32Array(L.w * L.h).fill(-1);
    L.pieces.forEach((p, i) => p.at.forEach(([x, y]) => { this.grid[y * L.w + x] = i; }));
    this.alive = L.pieces.map(() => true);
    this.outer = L.pieces.map((p) => !!p.outer);
  }
  dirOf(i) { return this.outer[i] ? this.L.pieces[i].outer : this.L.pieces[i].to; }
  /* -1 when free, else the first blocking block. */
  blocker(i) {
    const { w, h } = this.L;
    const [dx, dy] = DIR[this.dirOf(i)];
    for (const [cx, cy] of this.L.pieces[i].at) {
      let x = cx + dx, y = cy + dy;
      while (x >= 0 && y >= 0 && x < w && y < h) {
        const o = this.grid[y * w + x];
        if (o >= 0 && o !== i) return o;
        x += dx; y += dy;
      }
    }
    return -1;
  }
  free() { const out = []; this.alive.forEach((a, i) => { if (a && this.blocker(i) < 0) out.push(i); }); return out; }
  /* Tap: true when the block (or its outer layer) left. */
  tap(i) {
    if (!this.alive[i] || this.blocker(i) >= 0) return false;
    if (this.outer[i]) { this.outer[i] = false; return true; }
    this.alive[i] = false;
    this.L.pieces[i].at.forEach(([x, y]) => { this.grid[y * this.L.w + x] = -1; });
    return true;
  }
  left() { return this.alive.filter(Boolean).length; }
}

/* Rounds when every free action is taken at once (= peel depth), or -1 when it cannot be cleared. */
export function solveRounds(L) {
  const b = new Board(L);
  let rounds = 0;
  for (;;) {
    const f = b.free();
    if (!f.length) break;
    rounds++;
    for (const i of f) b.tap(i);
  }
  return b.left() ? -1 : rounds;
}

/* ---------------------------------------------------------------- metrics -- */
const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* C = taps x median over steps of 1/(free actions), mean of `runs` random playthroughs (seed = position). */
export function measure(L, pos = 0, runs = 8) {
  const n = L.pieces.length;
  const cells = L.pieces.reduce((s, p) => s + p.at.length, 0);
  const layers = L.pieces.filter((p) => p.outer).length;
  const taps = n + layers;
  const rnd = mulberry32(1000 + pos);
  const all = [];
  let C = 0;
  let free0 = 0;
  for (let r = 0; r < runs; r++) {
    const b = new Board(L);
    const counts = [];
    for (;;) {
      const f = b.free();
      if (!f.length) break;
      counts.push(f.length);
      b.tap(f[Math.floor(rnd() * f.length)]);
    }
    if (r === 0) free0 = counts[0] || 0;
    C += taps * median(counts.map((x) => 1 / x));
    for (const x of counts) all.push(x);
  }
  const dirs = { N: 0, E: 0, S: 0, W: 0 };
  for (const p of L.pieces) dirs[p.to]++;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    id: L.id, w: L.w, h: L.h, n, cells, layers, moves: L.moves, spare: L.moves - taps,
    tier: Math.max(0, TIERS.indexOf(L.tier)), free0, depth: solveRounds(L), C: r2(C / runs), mf: r2(median(all)),
    singles: r2(L.pieces.filter((p) => p.at.length === 1).length / n), fill: r2(cells / (L.w * L.h)),
    domDir: r2(Math.max(...Object.values(dirs)) / n),
  };
}

/* Stats file: {fields, rows} keeps it compact. */
export const packStats = (list) => ({ fields: STAT_FIELDS, rows: list.map((s) => STAT_FIELDS.map((f) => s[f])) });
export const unpackStats = (pk) => pk.rows.map((r) => Object.fromEntries(pk.fields.map((f, i) => [f, r[i]])));

/* Rolling aggregates (window +-half) of one numeric field: {med, p10, p90} arrays by position. */
export function rolling(values, half) {
  const med = [], p10 = [], p90 = [];
  for (let i = 0; i < values.length; i++) {
    const win = values.slice(Math.max(0, i - half), i + half + 1).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p) => win[Math.min(win.length - 1, Math.floor(p * win.length))];
    med.push(win.length ? q(0.5) : NaN); p10.push(win.length ? q(0.1) : NaN); p90.push(win.length ? q(0.9) : NaN);
  }
  return { med, p10, p90 };
}

/* Band table rows for a stats list. */
export function bands(stats, ranges) {
  const r1 = (x, d = 1) => (Number.isFinite(x) ? +x.toFixed(d) : null);
  return ranges.map(([a, b]) => {
    const s = stats.slice(a - 1, b);
    if (!s.length) return null;
    const g = (k) => s.map((x) => x[k]).filter(Number.isFinite);
    const q = (arr, p) => { const t = [...arr].sort((x, y) => x - y); return t[Math.min(t.length - 1, Math.floor(p * t.length))]; };
    const share = (t) => s.filter((x) => x.tier === t).length / s.length;
    return {
      band: `${a}–${a + s.length - 1}`, count: s.length, board: `${median(g('w'))}×${median(g('h'))}`,
      blocks: median(g('n')), blocksP10: q(g('n'), 0.1), blocksP90: q(g('n'), 0.9),
      size: r1(g('cells').reduce((x, y) => x + y, 0) / g('n').reduce((x, y) => x + y, 0), 2),
      singles: r1(100 * median(g('singles')), 0), fill: r1(100 * median(g('fill')), 0), spare: median(g('spare')),
      layers: r1(g('layers').reduce((x, y) => x + y, 0) / s.length), free0: median(g('free0')), depth: median(g('depth')),
      C: r1(median(g('C'))), Cp90: r1(q(g('C'), 0.9)), tricky: r1(100 * share(1), 0), expert: r1(100 * share(2), 0),
    };
  }).filter(Boolean);
}

export const DEFAULT_BANDS = {
  normal: [[1, 5], [6, 10], [11, 20], [21, 50], [51, 100], [101, 200], [201, 300], [301, 500], [501, 1000], [1001, 2000], [2001, 3000], [3001, 5000]],
  challenge: [[1, 31], [32, 62], [63, 92], [93, 123], [124, 300], [301, 549]],
  roadtrip: [[1, 20], [21, 50], [51, 100], [101, 200], [201, 300], [301, 400]],
  special: [[1, 10], [11, 30], [31, 60], [61, 90], [91, 331]],
};
