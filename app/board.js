/* Draws a level on a canvas and lets you play it (tap = slide out) or edit it (turn, peel, delete blocks). */
import { Board } from './metrics.js';

export const COLOURS = { N: '#e7bd2f', E: '#2f96df', S: '#a35ae6', W: '#43b649' };
const ARROW = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const NEXT = { N: 'E', E: 'S', S: 'W', W: 'N' };

export class BoardView {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.onChange = onChange || (() => {});
    this.mode = 'play';
    canvas.addEventListener('click', (e) => this.click(e, false));
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.click(e, true); });
  }
  load(level) {
    this.level = structuredClone(level);
    this.reset();
  }
  reset() {
    this.board = new Board(this.level);
    this.movesLeft = this.level.moves;
    this.flash = -1;
    this.draw();
    this.onChange('reset');
  }
  get won() { return this.board && this.board.left() === 0; }
  cellAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - this.ox) / this.cs);
    const y = Math.floor((e.clientY - r.top - this.oy) / this.cs);
    if (x < 0 || y < 0 || x >= this.level.w || y >= this.level.h) return -1;
    return this.board.grid[y * this.level.w + x];
  }
  click(e, alt) {
    if (!this.level) return;
    const i = this.cellAt(e);
    if (i < 0) return;
    if (this.mode === 'play') {
      if (alt || this.movesLeft <= 0 || this.won) return;
      this.movesLeft--;
      if (!this.board.tap(i)) {
        this.flash = i;
        setTimeout(() => { this.flash = -1; this.draw(); }, 250);
      }
      this.draw();
      this.onChange(this.won ? 'won' : this.movesLeft <= 0 ? 'lost' : 'move');
      return;
    }
    // edit: click = turn, shift+click = outer layer (none -> each other dir -> none), right click / alt = delete
    const p = this.level.pieces[i];
    if (alt || e.altKey) this.level.pieces.splice(i, 1);
    else if (e.shiftKey) {
      // cycle: no outer layer -> the three other directions -> no outer layer
      const opts = [null, NEXT[p.to], NEXT[NEXT[p.to]], NEXT[NEXT[NEXT[p.to]]]];
      const o = opts[(opts.indexOf(p.outer || null) + 1) % opts.length];
      if (o) p.outer = o; else delete p.outer;
    } else {
      p.to = NEXT[p.to];
      if (p.outer === p.to) p.to = NEXT[p.to];
    }
    this.reset();
    this.onChange('edit');
  }
  draw() {
    const c = this.canvas;
    const L = this.level;
    const dpr = window.devicePixelRatio || 1;
    const W = c.parentElement.clientWidth || 360;
    const maxH = Math.min(640, window.innerHeight * 0.7);
    const cs = Math.max(8, Math.floor(Math.min((W - 24) / (L.w + 1), (maxH - 24) / (L.h + 1))));
    const bw = cs * (L.w + 1) + 0;
    const bh = cs * (L.h + 1);
    c.style.width = bw + 'px';
    c.style.height = bh + 'px';
    c.width = bw * dpr;
    c.height = bh * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cs = cs;
    this.ox = cs / 2;
    this.oy = cs / 2;
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    ctx.clearRect(0, 0, bw, bh);
    // walls
    const t = Math.max(3, cs * 0.18);
    ctx.fillStyle = COLOURS.N; ctx.fillRect(this.ox, this.oy - t - 2, L.w * cs, t);
    ctx.fillStyle = COLOURS.S; ctx.fillRect(this.ox, this.oy + L.h * cs + 2, L.w * cs, t);
    ctx.fillStyle = COLOURS.W; ctx.fillRect(this.ox - t - 2, this.oy, t, L.h * cs);
    ctx.fillStyle = COLOURS.E; ctx.fillRect(this.ox + L.w * cs + 2, this.oy, t, L.h * cs);
    ctx.fillStyle = css('--cell');
    ctx.fillRect(this.ox, this.oy, L.w * cs, L.h * cs);
    const free = new Set(this.mode === 'play' && this.showFree ? this.board.free() : []);
    L.pieces.forEach((p, i) => {
      if (!this.board.alive[i]) return;
      const dir = this.board.dirOf(i);
      const hasOuter = this.board.outer[i];
      const set = new Set(p.at.map(([x, y]) => y * L.w + x));
      ctx.fillStyle = i === this.flash ? '#e03131' : COLOURS[dir];
      for (const [x, y] of p.at) ctx.fillRect(this.ox + x * cs + 1, this.oy + y * cs + 1, cs - 2, cs - 2);
      // join cells of one block
      for (const [x, y] of p.at) {
        if (x + 1 < L.w && set.has(y * L.w + x + 1)) ctx.fillRect(this.ox + x * cs + cs - 2, this.oy + y * cs + 1, 4, cs - 2);
        if (set.has((y + 1) * L.w + x)) ctx.fillRect(this.ox + x * cs + 1, this.oy + y * cs + cs - 2, cs - 2, 4);
        if (x + 1 < L.w && set.has(y * L.w + x + 1) && set.has((y + 1) * L.w + x) && set.has((y + 1) * L.w + x + 1))
          ctx.fillRect(this.ox + x * cs + cs - 2, this.oy + y * cs + cs - 2, 4, 4);
      }
      // outline along the block's own border, so neighbours of the same colour stay apart
      ctx.strokeStyle = 'rgba(0,0,0,0.38)';
      ctx.lineWidth = Math.max(1.5, cs * 0.07);
      ctx.beginPath();
      for (const [x, y] of p.at) {
        const X0 = this.ox + x * cs + 1, Y0 = this.oy + y * cs + 1, X1 = this.ox + (x + 1) * cs - 1, Y1 = this.oy + (y + 1) * cs - 1;
        if (!set.has((y - 1) * L.w + x) || y === 0) { ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y0); }
        if (!set.has((y + 1) * L.w + x)) { ctx.moveTo(X0, Y1); ctx.lineTo(X1, Y1); }
        if (x === 0 || !set.has(y * L.w + x - 1)) { ctx.moveTo(X0, Y0); ctx.lineTo(X0, Y1); }
        if (x === L.w - 1 || !set.has(y * L.w + x + 1)) { ctx.moveTo(X1, Y0); ctx.lineTo(X1, Y1); }
      }
      ctx.stroke();
      if (hasOuter) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = Math.max(1.5, cs * 0.1);
        for (const [x, y] of p.at) ctx.strokeRect(this.ox + x * cs + cs * 0.2, this.oy + y * cs + cs * 0.2, cs * 0.6, cs * 0.6);
        ctx.fillStyle = COLOURS[p.to];
        for (const [x, y] of p.at) ctx.fillRect(this.ox + x * cs + cs * 0.3, this.oy + y * cs + cs * 0.3, cs * 0.4, cs * 0.4);
      }
      if (free.has(i)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        for (const [x, y] of p.at) ctx.strokeRect(this.ox + x * cs + 2, this.oy + y * cs + 2, cs - 4, cs - 4);
      }
      // arrow on the cell nearest the exit
      const [dx, dy] = ARROW[dir];
      const head = p.at.reduce((a, b) => (b[0] * dx + b[1] * dy > a[0] * dx + a[1] * dy ? b : a));
      const cx = this.ox + head[0] * cs + cs / 2;
      const cy = this.oy + head[1] * cs + cs / 2;
      const s = cs * 0.22;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.moveTo(cx + dx * s * 1.3, cy + dy * s * 1.3);
      ctx.lineTo(cx - dx * s + dy * s, cy - dy * s - dx * s);
      ctx.lineTo(cx - dx * s - dy * s, cy - dy * s + dx * s);
      ctx.closePath();
      ctx.fill();
    });
  }
}
