/* Procedural level generator — the browser port of block-out/tools/gen-levels.mjs.

   Every curve is a table in a config object (DEFAULT_CONFIG reproduces gen-levels.mjs), so the site can edit the
   tables, generate, measure and save a version. Pure module: no DOM, no fs; runs in a Web Worker or in Node.

   How a board is built (reverse play): blocks are placed one by one, and every new block must have a clear path
   off the board past all blocks placed before it, so every level is solvable by construction. A later block that
   lands in an earlier block's path blocks it; `chain` tracks the peel depth the player has to work through. */

export const DEFAULT_CONFIG = {
  seed: 0x5eed1e55,
  weights: { chainPace: 1.5, chainWeight: 2.5, shortWeight: 1.2, coverWeight: 1.2, pathWeight: 2.5, nearWeight: 0.4 },
  normal: {
    count: 5000,
    // [level, value] points, linear in between
    width: [[1, 4], [5, 4], [8, 5], [12, 7], [16, 8], [20, 8.2], [30, 8.8], [40, 9.8], [60, 10.4], [115, 10.9], [225, 11.6], [650, 11.9], [3000, 12.6]],
    height: [[1, 4], [5, 4], [8, 5], [12, 7], [16, 8], [20, 8.4], [30, 9.8], [40, 11], [60, 13.2], [115, 14.2], [225, 15.3], [650, 16.1], [3000, 16.6]],
    blocks: [[1, 4], [5, 5], [8, 7.6], [13, 14.8], [18, 17.4], [25, 22.6], [35, 28], [45, 41.8], [70, 45.4], [90, 46], [110, 50], [150, 51], [190, 58]],
    // after this level the block count scales with board area / blocksAreaRef
    blocksAreaFrom: 190,
    blocksAreaRef: 184,
    // block size mix from a level on: shares of sizes 1..7 and 8+ (8..bigMax)
    sizeMix: [
      [1, [0.04, 0.06, 0.36, 0.3, 0.18, 0.06, 0, 0]],
      [11, [0.12, 0.14, 0.2, 0.22, 0.14, 0.09, 0.05, 0.04]],
      [21, [0.29, 0.16, 0.2, 0.18, 0.08, 0.03, 0.03, 0.03]],
      [301, [0.16, 0.26, 0.22, 0.15, 0.1, 0.05, 0.03, 0.03]],
    ],
    bigMax: [[1, 6], [11, 11], [21, 18], [300, 20]],
    // peel depth as a share of the block count, and the share of blocks free at the start
    depthRatio: [[1, 0.2], [3, 0.5], [10, 0.5], [13, 0.42], [20, 0.45], [30, 0.42], [40, 0.38], [60, 0.43], [100, 0.45], [200, 0.5], [1000, 0.48]],
    freeRatio: [[1, 1], [3, 0.65], [8, 0.53], [13, 0.31], [20, 0.28], [30, 0.29], [40, 0.22], [60, 0.2], [150, 0.17], [1000, 0.18]],
    tierDepth: { easy: 1, tricky: 1.1, expert: 1.2 },
    tierFree: { easy: 1, tricky: 0.85, expert: 0.85 },
    // spare moves (moves = taps + spare) per tier, then +-jitter, clamped
    spare: {
      easy: [[1, 7], [20, 7], [30, 4.4], [60, 3.8], [120, 4.5], [200, 4.5], [600, 3.8], [1500, 3.3]],
      tricky: [[21, 6.2], [60, 6.5], [140, 5.2], [600, 4], [1500, 3.9]],
      expert: [[21, 6], [60, 7], [140, 7.2], [600, 4.9], [1500, 5]],
    },
    spareJitter: 1.1,
    // tier rules, first match wins: {from?, to?, mod?, rem?: [..], tier}
    tiers: {
      rules: [
        { to: 20, tier: 'easy' },
        { mod: 10, rem: [0], tier: 'expert' },
        { from: 201, mod: 20, rem: [5], tier: 'expert' },
        { mod: 10, rem: [3, 7], tier: 'tricky' },
        { from: 41, to: 200, mod: 10, rem: [5], tier: 'tricky' },
        { from: 1001, mod: 10, rem: [5], tier: 'tricky' },
      ],
      default: 'easy',
    },
    shapedShare: [[1, 0], [7, 0], [8, 0.2], [20, 0.22], [21, 0.45], [100, 0.45], [101, 0.31], [300, 0.31], [301, 0.19], [5000, 0.18]],
  },
  challenge: {
    count: 549,
    start: '2026-07-01',
    // [mean, jitter, min, max]
    w: [15.2, 1.5, 13, 17],
    h: [21.4, 1.8, 19, 25],
    sizeMix: [0.24, 0.22, 0.2, 0.16, 0.08, 0.04, 0.03, 0.03],
    bigMax: 14,
    blocksPerCell: 105 / 325,
    depthRatio: [0.57, 0.04], // base + random * extra
    freeRatio: 0.12,
    spare: [5, 9], // uniform integer in [min, max]
    shapedShare: 0,
  },
  roadtrip: {
    count: 400,
    width: [[1, 11.3], [300, 11], [400, 12]],
    height: [[1, 16.5], [300, 15.8], [400, 16.7]],
    wJitter: 1.5,
    hJitter: 1.8,
    wClamp: [8, 16],
    hClamp: [11, 24],
    blocksPerCell: 54 / 185,
    depthRatio: [[1, 0.31], [100, 0.31], [150, 0.4], [200, 0.41], [250, 0.49], [350, 0.55], [400, 0.53]],
    hardDepth: 1.08,
    freeRatio: [[1, 0.24], [100, 0.22], [150, 0.17], [300, 0.16], [400, 0.14]],
    outerShare: [[1, 0.4], [150, 0.43], [200, 0.38], [400, 0.34]],
    easyUntil: 200,
    spare: { firstLevels: 10, first: 6, base: 4.4, jitter: 1.2, min: 3, max: 7 },
    shapedShare: 0.14,
  },
  special: {
    count: 331,
    // special level k is built like normal level start + (k - 1) * interval
    start: 15,
    interval: 15,
    tiers: { rules: [{ mod: 4, rem: [1], tier: 'tricky' }], default: 'expert' },
    spareBonus: 1,
    shapedShare: 0.2,
  },
};

export const SET_NAMES = ['normal', 'challenge', 'roadtrip', 'special'];
const SALT = { normal: 0, challenge: 0x7c1d, roadtrip: 0x2d71, special: 0x51ec };

/* ------------------------------------------------------------------ PRNG -- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = Math.random;
const ri = (n) => Math.floor(rand() * n);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export function lerp(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}
function weighted(weights) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

export function tierBy(rules, id) {
  for (const r of rules.rules) {
    if (r.from != null && id < r.from) continue;
    if (r.to != null && id > r.to) continue;
    if (r.mod && !(r.rem || [0]).includes(id % r.mod)) continue;
    return r.tier;
  }
  return rules.default;
}

/* -------------------------------------------------------- campaign plan -- */
function plan(cfg, id, tier) {
  const N = cfg.normal;
  const W = cfg.weights;
  let w;
  let h;
  if (id === 1) {
    w = 4;
    h = 4;
  } else {
    const jw = id <= 10 ? 0.6 : id <= 30 ? 1.2 : 1.8;
    w = Math.round(lerp(N.width, id) + (rand() * 2 - 1) * jw);
    h = Math.round(lerp(N.height, id) + (rand() * 2 - 1) * jw * 1.4);
    if (tier === 'expert' && id > 30) h += 1;
    w = clamp(w, 4, 17);
    h = clamp(h, Math.max(4, w - 1), 26);
  }
  return {
    w,
    h,
    sizeMix: N.sizeMix.reduce((m, [lv, mix]) => (id >= lv ? mix : m), N.sizeMix[0][1]),
    bigMax: Math.round(lerp(N.bigMax, id)),
    blocks: lerp(N.blocks, id) * (id > N.blocksAreaFrom ? (w * h) / N.blocksAreaRef : 1),
    depthRatio: clamp(lerp(N.depthRatio, id) * (N.tierDepth[tier] ?? 1), 0.1, 0.75),
    freeRatio: lerp(N.freeRatio, id) * (N.tierFree[tier] ?? 1),
    chainPace: W.chainPace,
    chainWeight: W.chainWeight,
    shortWeight: W.shortWeight,
    coverWeight: id <= 5 ? 0 : W.coverWeight,
    pathWeight: id <= 5 ? 0 : W.pathWeight,
    nearWeight: W.nearWeight,
  };
}

function spareFor(cfg, id, tier) {
  const N = cfg.normal;
  const base = lerp(N.spare[tier] || N.spare.easy, id);
  const s = Math.round(base + (rand() * 2 - 1) * N.spareJitter);
  return clamp(s, id <= 20 ? 4 : 2, 12);
}

/* ------------------------------------------------------------- geometry -- */
const DIRS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const BIT = [1, 2, 4, 8];
const OPP = [2, 3, 0, 1];

function nearestDir(cells, w, h) {
  let cx = 0;
  let cy = 0;
  for (const c of cells) {
    cx += c % w;
    cy += (c / w) | 0;
  }
  cx /= cells.length;
  cy /= cells.length;
  const dist = { N: cy, S: h - 1 - cy, W: cx, E: w - 1 - cx };
  return Object.keys(dist).reduce((a, b) => (dist[a] <= dist[b] ? a : b));
}

/* ------------------------------------------------------- board building -- */
function buildBoard(p) {
  const { w, h } = p;
  const area = w * h;
  const owner = new Int16Array(area).fill(-1);
  let cellsInside = area;
  if (p.mask) {
    for (let c = 0; c < area; c++) if (!p.mask[c]) owner[c] = -2;
    cellsInside = p.mask.reduce((s, v) => s + v, 0);
  }
  const open = new Uint8Array(area).fill(15);
  const reach = new Uint16Array(area);
  const pathBy = Array.from({ length: area }, () => []);
  const covered = [];
  const pieces = [];
  const expectedPieces = cellsInside / meanSize(p);
  const targetDepth = Math.max(1, Math.round(expectedPieces * p.depthRatio));
  let filled = 0;

  const live = () => {
    const out = [];
    for (let c = 0; c < area; c++) if (owner[c] === -1 && open[c]) out.push(c);
    return out;
  };
  const buildFill = 0.9;

  for (let guard = 0; guard < area; guard++) {
    const cand = live();
    if (!cand.length) break;
    const t = filled / (cellsInside * buildFill);
    const wantChain = 1 + (targetDepth - 1) * Math.min(1, t * p.chainPace);

    let best = null;
    let bestScore = Infinity;
    const tries = Math.min(10, cand.length);
    const holeBudget = cellsInside * (1 - buildFill);
    for (let k = 0; k < tries; k++) {
      let seed = cand[ri(cand.length)];
      const alt = cand[ri(cand.length)];
      if (popcount(open[alt]) < popcount(open[seed])) seed = alt;
      const size = sampleSize(p);
      const near = DIRS.indexOf(nearestDir([seed], w, h));
      for (let dir = 0; dir < 4; dir++) {
        if (!(open[seed] & BIT[dir])) continue;
        const cells = grow(seed, dir, size, owner, open, w, h);
        let chain = 1;
        const covers = new Set();
        for (const c of cells) {
          chain = Math.max(chain, reach[c] + 1);
          for (const q of pathBy[c]) if (!covered[q]) covers.add(q);
        }
        const path = pathCells(cells, dir, owner, w, h);
        const dead = deadAfter(cells, owner, open, w, h);
        const holes = cellsInside - filled - cells.length - (cand.length - dead);
        let score = Math.abs(chain - wantChain) * p.chainWeight + (size - cells.length) * p.shortWeight;
        if (chain > targetDepth) score += (chain - targetDepth) * 6;
        score -= covers.size * p.coverWeight;
        score += p.pathWeight * (path === 0 ? 3 : path === 1 ? 1.4 : path === 2 ? 0.6 : 0);
        if (dir === near) score += p.nearWeight;
        score += dead * 0.9;
        if (holes + dead > holeBudget) score += dead * 4;
        score += rand() * 0.6;
        if (score < bestScore) {
          bestScore = score;
          best = { cells, dir, chain };
        }
      }
    }
    for (const c of best.cells) for (const q of pathBy[c]) covered[q] = true;
    covered.push(false);
    place(best, pieces, owner, open, reach, pathBy, w, h);
    filled += best.cells.length;
  }

  const n = pieces.length;
  if (n < 3) return null;
  const fill = filled / cellsInside;
  if (fill < 0.75) return null;
  const res = peel(pieces, w, h);
  if (!res.solved) throw new Error('internal: reverse-built board is not solvable');
  let nearest = 0;
  for (const pc of pieces) if (nearestDir(pc.cells, w, h) === DIRS[pc.dir]) nearest++;
  return { pieces, fill, depth: res.depth, free0: res.free0, nearest: nearest / n, targetDepth };
}

function pathCells(cells, dir, owner, w, h) {
  const mine = new Set(cells);
  const seen = new Set();
  for (const c of cells) {
    let x = (c % w) + DX[dir];
    let y = ((c / w) | 0) + DY[dir];
    while (x >= 0 && y >= 0 && x < w && y < h) {
      const n = y * w + x;
      if (!mine.has(n) && owner[n] === -1) seen.add(n);
      x += DX[dir];
      y += DY[dir];
    }
  }
  return seen.size;
}

function popcount(b) {
  return (b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1);
}

function meanSize(p) {
  let s = 0;
  let t = 0;
  p.sizeMix.forEach((wgt, i) => {
    s += wgt * (i < 7 ? i + 1 : (8 + p.bigMax) / 2);
    t += wgt;
  });
  return s / t;
}

function sampleSize(p) {
  const i = weighted(p.sizeMix);
  if (i < 7) return i + 1;
  return 8 + Math.floor(rand() * rand() * (p.bigMax - 7));
}

function grow(seed, dir, size, owner, open, w, h) {
  const cells = [seed];
  const mine = new Set(cells);
  const bit = BIT[dir];
  let last = seed;
  let lastStep = -1;
  while (cells.length < size) {
    const options = [];
    const from = rand() < 0.55 ? [last] : cells;
    for (const c of from) {
      const x = c % w;
      const y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (owner[n] !== -1 || mine.has(n) || !(open[n] & bit)) continue;
        options.push([n, c === last && d === lastStep ? 2.2 : 1, d]);
      }
    }
    if (!options.length) {
      if (from.length === 1 && cells.length > 1) {
        last = cells[ri(cells.length)];
        lastStep = -1;
        continue;
      }
      break;
    }
    const [n, , d] = options[weighted(options.map((o) => o[1]))];
    cells.push(n);
    mine.add(n);
    last = n;
    lastStep = d;
  }
  return cells;
}

function deadAfter(cells, owner, open, w, h) {
  const mine = new Set(cells);
  const lost = new Map();
  for (const c of cells) {
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      let nx = x + DX[d];
      let ny = y + DY[d];
      while (nx >= 0 && ny >= 0 && nx < w && ny < h) {
        const n = ny * w + nx;
        if (owner[n] === -1 && !mine.has(n) && open[n]) lost.set(n, (lost.has(n) ? lost.get(n) : open[n]) & ~BIT[OPP[d]]);
        nx += DX[d];
        ny += DY[d];
      }
    }
  }
  let dead = 0;
  for (const v of lost.values()) if (!v) dead++;
  return dead;
}

function place(best, pieces, owner, open, reach, pathBy, w, h) {
  const idx = pieces.length;
  const { cells, dir, chain } = best;
  for (const c of cells) owner[c] = idx;
  for (const c of cells) {
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      let nx = x + DX[d];
      let ny = y + DY[d];
      while (nx >= 0 && ny >= 0 && nx < w && ny < h) {
        const n = ny * w + nx;
        open[n] &= ~BIT[OPP[d]];
        nx += DX[d];
        ny += DY[d];
      }
    }
    let nx = x + DX[dir];
    let ny = y + DY[dir];
    while (nx >= 0 && ny >= 0 && nx < w && ny < h) {
      const n = ny * w + nx;
      if (owner[n] !== idx) {
        if (reach[n] < chain) reach[n] = chain;
        pathBy[n].push(idx);
      }
      nx += DX[dir];
      ny += DY[dir];
    }
  }
  pieces.push({ cells, dir, chain });
}

function peel(pieces, w, h) {
  const grid = new Int16Array(w * h).fill(-1);
  pieces.forEach((pc, i) => pc.cells.forEach((c) => (grid[c] = i)));
  const left = new Set(pieces.map((_, i) => i));
  const isFree = (i) => {
    const d = pieces[i].dir;
    for (const c of pieces[i].cells) {
      let x = (c % w) + DX[d];
      let y = ((c / w) | 0) + DY[d];
      while (x >= 0 && y >= 0 && x < w && y < h) {
        const o = grid[y * w + x];
        if (o >= 0 && o !== i) return false;
        x += DX[d];
        y += DY[d];
      }
    }
    return true;
  };
  let depth = 0;
  let free0 = -1;
  for (;;) {
    const free = [...left].filter(isFree);
    if (free0 < 0) free0 = free.length;
    if (!free.length) break;
    depth++;
    for (const i of free) {
      pieces[i].cells.forEach((c) => (grid[c] = -1));
      left.delete(i);
    }
  }
  return { solved: left.size === 0, depth, free0 };
}

/* ------------------------------------------------------------ merge pass -- */
function mergeSmall(b, w, h, targetN, bigMax) {
  let pieces = b.pieces.map((pc) => ({ cells: pc.cells.slice(), dir: pc.dir }));
  const solvable = (ps) => {
    const grid = new Int16Array(w * h).fill(-1);
    ps.forEach((pc, i) => pc.cells.forEach((c) => (grid[c] = i)));
    return depthOf(ps.map((pc, i) => blockersOf(ps, grid, w, h, i, pc.dir)), ps.length) > 0;
  };
  let fails = 0;
  while (pieces.length > targetN && fails < 30) {
    const grid = new Int16Array(w * h).fill(-1);
    pieces.forEach((pc, i) => pc.cells.forEach((c) => (grid[c] = i)));
    const small = pieces.map((pc, i) => i).filter((i) => pieces[i].cells.length <= 3);
    const pool = small.length ? small : pieces.map((_, i) => i);
    const i = pool[ri(pool.length)];
    const nb = new Set();
    for (const c of pieces[i].cells) {
      const x = c % w;
      const y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const o = grid[ny * w + nx];
        if (o >= 0 && o !== i && pieces[o].cells.length + pieces[i].cells.length <= bigMax) nb.add(o);
      }
    }
    if (!nb.size) {
      fails++;
      continue;
    }
    const opts = [...nb];
    const j = opts[ri(opts.length)];
    const merged = { cells: pieces[j].cells.concat(pieces[i].cells), dir: rand() < 0.5 ? pieces[j].dir : pieces[i].dir };
    const next = pieces.filter((_, k) => k !== i && k !== j);
    next.push(merged);
    if (solvable(next)) {
      pieces = next;
      fails = 0;
    } else fails++;
  }
  return { ...b, pieces };
}

/* -------------------------------------------------------- direction pass -- */
function blockersOf(pieces, grid, w, h, i, dir) {
  const out = new Set();
  for (const c of pieces[i].cells) {
    let x = (c % w) + DX[dir];
    let y = ((c / w) | 0) + DY[dir];
    while (x >= 0 && y >= 0 && x < w && y < h) {
      const o = grid[y * w + x];
      if (o >= 0 && o !== i) out.add(o);
      x += DX[dir];
      y += DY[dir];
    }
  }
  return [...out];
}

function depthOf(blockers, n) {
  const memo = new Int32Array(n);
  const stack = [];
  let best = 0;
  for (let s = 0; s < n; s++) {
    if (memo[s]) continue;
    stack.push([s, 0]);
    memo[s] = -1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, k] = top;
      const bl = blockers[v];
      if (k < bl.length) {
        top[1]++;
        const u = bl[k];
        if (memo[u] === -1) return -1;
        if (memo[u] === 0) {
          memo[u] = -1;
          stack.push([u, 0]);
        }
      } else {
        let d = 1;
        for (const u of bl) if (memo[u] + 1 > d) d = memo[u] + 1;
        memo[v] = d;
        if (d > best) best = d;
        stack.pop();
      }
    }
  }
  return best;
}

function tuneDirections(b, w, h, wantDepth, wantFree, iterations) {
  const { pieces } = b;
  const n = pieces.length;
  const grid = new Int16Array(w * h).fill(-1);
  pieces.forEach((pc, i) => pc.cells.forEach((c) => (grid[c] = i)));
  const near = pieces.map((pc) => DIRS.indexOf(nearestDir(pc.cells, w, h)));
  const blockers = pieces.map((pc, i) => blockersOf(pieces, grid, w, h, i, pc.dir));
  let nearCount = pieces.filter((pc, i) => pc.dir === near[i]).length;
  let freeCount = blockers.filter((bl) => !bl.length).length;
  let depth = depthOf(blockers, n);
  const cost = (d, f, nc) =>
    (Math.abs(d - wantDepth) / Math.max(2, wantDepth)) * 6 + Math.abs(f / n - wantFree) * 8 + Math.max(0, nc / n - 0.45) * 20;
  let cur = cost(depth, freeCount, nearCount);
  for (let it = 0; it < iterations; it++) {
    const i = ri(n);
    const old = pieces[i].dir;
    const dir = (old + 1 + ri(3)) % 4;
    const bl = blockersOf(pieces, grid, w, h, i, dir);
    const prev = blockers[i];
    blockers[i] = bl;
    const d = depthOf(blockers, n);
    if (d < 0) {
      blockers[i] = prev;
      continue;
    }
    const f = freeCount - (prev.length ? 0 : 1) + (bl.length ? 0 : 1);
    const nc = nearCount - (old === near[i] ? 1 : 0) + (dir === near[i] ? 1 : 0);
    const c = cost(d, f, nc);
    if (c <= cur || rand() < 0.02) {
      pieces[i].dir = dir;
      depth = d;
      freeCount = f;
      nearCount = nc;
      cur = c;
    } else blockers[i] = prev;
  }
  return { ...b, depth, free0: freeCount, nearest: nearCount / n };
}

/* ------------------------------------------------------------ hole pass -- */
function fillHoles(b, w, h, mask, bigMax) {
  const pieces = b.pieces.map((pc) => ({ cells: pc.cells.slice(), dir: pc.dir }));
  const area = w * h;
  const owner = new Int16Array(area).fill(-1);
  pieces.forEach((pc, i) => pc.cells.forEach((c) => (owner[c] = i)));
  const solvable = () => {
    const grid = new Int16Array(area).fill(-1);
    pieces.forEach((pc, i) => pc.cells.forEach((c) => (grid[c] = i)));
    return depthOf(pieces.map((pc, i) => blockersOf(pieces, grid, w, h, i, pc.dir)), pieces.length) > 0;
  };
  const holes = [];
  for (let c = 0; c < area; c++) if (owner[c] < 0 && (!mask || mask[c])) holes.push(c);
  for (let k = holes.length - 1; k > 0; k--) {
    const j = ri(k + 1);
    [holes[k], holes[j]] = [holes[j], holes[k]];
  }
  let left = 0;
  for (let pass = 0; pass < 3; pass++) {
    left = 0;
    for (const c of holes) {
      if (owner[c] >= 0) continue;
      const x = c % w;
      const y = (c / w) | 0;
      const nb = [];
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const o = owner[ny * w + nx];
        if (o >= 0 && !nb.includes(o)) nb.push(o);
      }
      nb.sort((a, z) => pieces[a].cells.length - pieces[z].cells.length);
      let done = false;
      for (const o of nb) {
        if (pieces[o].cells.length >= bigMax) continue;
        pieces[o].cells.push(c);
        if (solvable()) {
          owner[c] = o;
          done = true;
          break;
        }
        pieces[o].cells.pop();
      }
      if (!done && pass > 0) {
        const first = ri(4);
        pieces.push({ cells: [c], dir: 0 });
        for (let t = 0; t < 4 && !done; t++) {
          pieces[pieces.length - 1].dir = (first + t) % 4;
          done = solvable();
        }
        if (done) owner[c] = pieces.length - 1;
        else pieces.pop();
      }
      if (!done) left++;
    }
    if (!left) break;
  }
  const inside = mask ? mask.reduce((s, v) => s + v, 0) : area;
  return { ...b, pieces, fill: (inside - left) / inside, holesLeft: left };
}

/* --------------------------------------------------------- outer layers -- */
function peelLayers(pieces, outer, w, h) {
  const grid = new Int16Array(w * h).fill(-1);
  pieces.forEach((pc, i) => pc.cells.forEach((c) => (grid[c] = i)));
  const layer = outer.slice();
  const left = new Set(pieces.map((_, i) => i));
  const isFree = (i) => {
    const d = layer[i] >= 0 ? layer[i] : pieces[i].dir;
    for (const c of pieces[i].cells) {
      let x = (c % w) + DX[d];
      let y = ((c / w) | 0) + DY[d];
      while (x >= 0 && y >= 0 && x < w && y < h) {
        const o = grid[y * w + x];
        if (o >= 0 && o !== i) return false;
        x += DX[d];
        y += DY[d];
      }
    }
    return true;
  };
  let rounds = 0;
  for (;;) {
    const free = [...left].filter(isFree);
    if (!free.length) break;
    rounds++;
    for (const i of free) {
      if (layer[i] >= 0) layer[i] = -1;
      else {
        pieces[i].cells.forEach((c) => (grid[c] = -1));
        left.delete(i);
      }
    }
  }
  return left.size === 0 ? rounds : -1;
}

function addOuters(pieces, w, h, share) {
  const n = pieces.length;
  const outer = new Array(n).fill(-1);
  const want = Math.round(n * share);
  const order = pieces.map((_, i) => i);
  for (let k = n - 1; k > 0; k--) {
    const j = ri(k + 1);
    [order[k], order[j]] = [order[j], order[k]];
  }
  let placed = 0;
  for (const i of order) {
    if (placed >= want) break;
    const first = ri(3);
    for (let t = 0; t < 3; t++) {
      outer[i] = (pieces[i].dir + 1 + ((first + t) % 3)) % 4;
      if (peelLayers(pieces, outer, w, h) > 0) break;
      outer[i] = -1;
    }
    if (outer[i] >= 0) placed++;
  }
  return outer;
}

/* ------------------------------------------------------------- outlines -- */
const OUTLINES = ['corners', 'octagon', 'ellipse', 'plus', 'notches', 'hourglass', 'steps', 'arch'];

function outline(w, h, kind) {
  const m = new Uint8Array(w * h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const r = 0.25 + rand() * 0.15;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ux = Math.abs(x - cx) / Math.max(1, cx);
      const uy = Math.abs(y - cy) / Math.max(1, cy);
      let inside = true;
      if (kind === 'corners') inside = Math.min(x, w - 1 - x) + Math.min(y, h - 1 - y) >= Math.round(Math.min(w, h) * r);
      else if (kind === 'octagon') inside = ux + uy <= 1.45 - r * 0.6;
      else if (kind === 'ellipse') inside = ux * ux + uy * uy <= 1.08 + r * 0.3;
      else if (kind === 'plus') inside = ux <= 0.42 + r * 0.6 || uy <= 0.38 + r * 0.6;
      else if (kind === 'notches') inside = !(ux >= 0.45 && uy <= 0.2 + r) && !(uy >= 0.8 && ux <= 0.18 + r * 0.6);
      else if (kind === 'hourglass') inside = ux <= 0.38 + 0.62 * uy + r * 0.2;
      else if (kind === 'steps') {
        const s = x / Math.max(1, w - 1) + y / Math.max(1, h - 1);
        inside = s >= 0.42 + r * 0.4 && s <= 1.58 - r * 0.4;
      } else if (kind === 'arch') {
        const top = y < cy ? ux * ux + Math.pow((cy - y) / Math.max(1, cy), 2) <= 1.02 : true;
        inside = top && !(y >= h - 1 - Math.round(h * (0.12 + r * 0.25)) && ux <= 0.22 + r * 0.4);
      }
      m[y * w + x] = inside ? 1 : 0;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (let c = 0; c < w * h; c++) {
      if (!m[c]) continue;
      const x = c % w;
      const y = (c / w) | 0;
      let nb = 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && m[ny * w + nx]) nb++;
      }
      if (nb <= 1) {
        m[c] = 0;
        changed = true;
      }
    }
  }
  const comp = new Int32Array(w * h).fill(-1);
  let bestComp = -1;
  let bestSize = 0;
  for (let s = 0, id = 0; s < w * h; s++) {
    if (!m[s] || comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = id;
    let size = 0;
    while (stack.length) {
      const c = stack.pop();
      size++;
      for (let d = 0; d < 4; d++) {
        const nx = (c % w) + DX[d];
        const ny = ((c / w) | 0) + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (m[n] && comp[n] < 0) {
          comp[n] = id;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestComp = id;
    }
    id++;
  }
  for (let c = 0; c < w * h; c++) if (comp[c] !== bestComp) m[c] = 0;
  return { mask: m, fill: bestSize / (w * h) };
}

function shapeBoard(p) {
  for (let t = 0; t < 12; t++) {
    const kind = OUTLINES[ri(OUTLINES.length)];
    const f = 0.62 + rand() * 0.12;
    const w = clamp(Math.round(p.w / Math.sqrt(f)), 6, 18);
    const h = clamp(Math.round(p.h / Math.sqrt(f)), 7, 28);
    const o = outline(w, h, kind);
    if (o.fill < 0.55 || o.fill > 0.82) continue;
    const rows = new Set();
    const cols = new Set();
    o.mask.forEach((v, c) => {
      if (v) {
        rows.add((c / w) | 0);
        cols.add(c % w);
      }
    });
    if (!rows.has(0) || !rows.has(h - 1) || !cols.has(0) || !cols.has(w - 1)) continue;
    return { ...p, w, h, mask: o.mask, shape: kind };
  }
  return p;
}

/* -------------------------------------------------------------- set rules -- */
export function dateIds(start, count) {
  const [y, m, d0] = start.split('-').map(Number);
  const out = [];
  const d = new Date(Date.UTC(y, m - 1, d0));
  for (let i = 0; i < count; i++) {
    out.push(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function planChallenge(cfg) {
  const C = cfg.challenge;
  const p = plan(cfg, 1500, 'easy');
  p.w = clamp(Math.round(C.w[0] + (rand() * 2 - 1) * C.w[1]), C.w[2], C.w[3]);
  p.h = clamp(Math.round(C.h[0] + (rand() * 2 - 1) * C.h[1]), C.h[2], C.h[3]);
  p.sizeMix = C.sizeMix;
  p.bigMax = C.bigMax;
  p.blocks = C.blocksPerCell * p.w * p.h;
  p.depthRatio = C.depthRatio[0] + rand() * C.depthRatio[1];
  p.freeRatio = C.freeRatio;
  return p;
}

function planRoadtrip(cfg, rid, tier) {
  const R = cfg.roadtrip;
  const p = plan(cfg, 600, tier);
  p.w = clamp(Math.round(lerp(R.width, rid) + (rand() * 2 - 1) * R.wJitter), R.wClamp[0], R.wClamp[1]);
  p.h = clamp(Math.round(lerp(R.height, rid) + (rand() * 2 - 1) * R.hJitter), R.hClamp[0], R.hClamp[1]);
  p.blocks = R.blocksPerCell * p.w * p.h;
  p.depthRatio = lerp(R.depthRatio, rid) * (tier === 'easy' ? 1 : R.hardDepth);
  p.freeRatio = lerp(R.freeRatio, rid);
  p.outerShare = lerp(R.outerShare, rid);
  return p;
}

const asLerp = (v) => (Array.isArray(v) ? (i) => lerp(v, i) : () => v);

export function setRules(cfg) {
  const challengeIds = dateIds(cfg.challenge.start, cfg.challenge.count);
  const S = cfg.special;
  const specialLevel = (k) => S.start + (k - 1) * S.interval;
  return {
    normal: {
      count: cfg.normal.count,
      idAt: (i) => i,
      tier: (i) => tierBy(cfg.normal.tiers, i),
      plan: (i, tier) => plan(cfg, i, tier),
      spare: (i, tier) => spareFor(cfg, i, tier),
      shaped: asLerp(cfg.normal.shapedShare),
      lv: (i) => i,
      extras: true,
    },
    challenge: {
      count: cfg.challenge.count,
      idAt: (i) => challengeIds[i - 1],
      tier: () => 'easy',
      plan: () => planChallenge(cfg),
      spare: () => cfg.challenge.spare[0] + ri(cfg.challenge.spare[1] - cfg.challenge.spare[0] + 1),
      shaped: asLerp(cfg.challenge.shapedShare),
      lv: () => 1000,
      extras: true,
    },
    roadtrip: {
      count: cfg.roadtrip.count,
      idAt: (i) => i,
      tier: (i) => (i <= cfg.roadtrip.easyUntil ? 'easy' : tierBy(cfg.normal.tiers, i)),
      plan: (i, tier) => planRoadtrip(cfg, i, tier),
      spare: (i) => {
        const s = cfg.roadtrip.spare;
        return i <= s.firstLevels ? s.first : clamp(Math.round(s.base + (rand() * 2 - 1) * s.jitter), s.min, s.max);
      },
      shaped: asLerp(cfg.roadtrip.shapedShare),
      lv: () => 1000,
      extras: false,
    },
    special: {
      count: S.count,
      idAt: (i) => i,
      tier: (i) => tierBy(S.tiers, i),
      plan: (i, tier) => plan(cfg, specialLevel(i), tier),
      spare: (i, tier) => spareFor(cfg, specialLevel(i), tier) + (S.spareBonus || 0),
      shaped: (i) => (Array.isArray(S.shapedShare) ? lerp(S.shapedShare, i) : S.shapedShare),
      lv: (i) => Math.max(21, specialLevel(i)),
      extras: true,
    },
  };
}

/* ------------------------------------------------------------ one level -- */
function layoutKey(w, h, pieces) {
  return `${w}x${h}:` + pieces.map((pc) => DIRS[pc.dir] + [...pc.cells].sort((a, b) => a - b).join('.')).sort().join('|');
}

/* Generate level number `idx` (1-based position in the set). `seen` holds layout keys to avoid duplicates. */
export function makeLevel(cfg, rules, set, idx, seen) {
  const rule = rules[set];
  const id = rule.idAt(idx);
  rand = mulberry32((cfg.seed ^ SALT[set] ^ Math.imul(id, 0x9e3779b1)) >>> 0);
  const tier = rule.tier(idx);
  const lv = rule.lv(idx);
  let best = null;
  let bestScore = Infinity;
  const attempts = lv <= 3 ? 40 : lv <= 300 ? 10 : 6;
  for (let a = 0; a < attempts; a++) {
    let p = rule.plan(idx, tier);
    if (rand() < rule.shaped(idx)) p = shapeBoard(p);
    let b = buildBoard(p);
    if (!b) continue;
    if (lv > 1) b = mergeSmall(b, p.w, p.h, Math.round(p.blocks * (0.98 + rand() * 0.16)), p.bigMax);
    b = fillHoles(b, p.w, p.h, p.mask, p.bigMax);
    const n = b.pieces.length;
    const wantDepth = Math.max(1, Math.round(n * p.depthRatio));
    if (lv > 3) b = tuneDirections(b, p.w, p.h, wantDepth, p.freeRatio, n * 40);
    const fr = b.free0 / n;
    let score = (Math.abs(b.depth - wantDepth) / Math.max(2, wantDepth)) * 6;
    score += Math.abs(fr - p.freeRatio) * 8;
    score += b.holesLeft * 50;
    if (b.nearest > 0.5) score += (b.nearest - 0.5) * 40;
    if (lv === 1 && b.depth !== 1) score += 50;
    if (score < bestScore) {
      const key = layoutKey(p.w, p.h, b.pieces);
      if (seen.has(key)) continue;
      bestScore = score;
      best = { ...b, w: p.w, h: p.h, key, outerShare: p.outerShare || 0, shape: p.shape || '' };
    }
  }
  if (!best) throw new Error(`could not generate ${set} level ${id}`);
  seen.add(best.key);
  const { w, h } = best;
  const outer = best.outerShare ? addOuters(best.pieces, w, h, best.outerShare) : null;
  const layers = outer ? outer.filter((d) => d >= 0).length : 0;
  const spare = rule.spare(idx, tier);
  const level = {
    id,
    w,
    h,
    moves: best.pieces.length + layers + spare,
    tier,
    pieces: best.pieces.map((pc, i) => {
      const piece = { to: DIRS[pc.dir], at: pc.cells.map((c) => [c % w, (c / w) | 0]) };
      if (outer && outer[i] >= 0) piece.outer = DIRS[outer[i]];
      return piece;
    }),
  };
  if (rule.extras) {
    level.movesB = level.moves;
    level.coins = 5;
  }
  return level;
}
