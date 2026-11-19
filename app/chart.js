/* Minimal canvas line chart: series lines, shaded bands, hover readout, click to pick an x. */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Chart {
  constructor(host, { height = 320, onPick } = {}) {
    this.host = host;
    this.onPick = onPick;
    this.wrap = document.createElement('div');
    this.wrap.className = 'chart';
    this.canvas = document.createElement('canvas');
    this.canvas.height = height;
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.wrap.append(this.canvas, this.tip);
    host.append(this.wrap);
    this.series = [];
    this.bands = [];
    this.height = height;
    this.canvas.addEventListener('mousemove', (e) => this.hover(e));
    this.canvas.addEventListener('mouseleave', () => { this.tip.hidden = true; this.hoverX = null; this.draw(); });
    this.canvas.addEventListener('click', (e) => { const x = this.xAt(e); if (x != null && this.onPick) this.onPick(x); });
    new ResizeObserver(() => this.draw()).observe(host);
  }
  /* series: [{name, color, values: number[] (index = x - 1), dash?}], bands: [{color, lo[], hi[]}] */
  set(data) {
    Object.assign(this, data);
    this.draw();
  }
  range() {
    const n = Math.max(1, ...this.series.map((s) => s.values.length), ...this.bands.map((b) => b.lo.length));
    const x0 = Math.max(1, this.from || 1);
    const x1 = Math.min(n, this.to || n);
    let lo = Infinity;
    let hi = -Infinity;
    const scan = (arr) => { for (let x = x0; x <= x1; x++) { const v = arr[x - 1]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } } };
    this.series.forEach((s) => scan(s.values));
    this.bands.forEach((b) => { scan(b.lo); scan(b.hi); });
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo > 0 && lo < hi * 0.6) lo = 0;
    const pad = (hi - lo) * 0.06 || 1;
    return { x0, x1, y0: lo, y1: hi + pad };
  }
  geom() {
    const w = this.host.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = this.height + 'px';
    }
    return { w, h: this.height, dpr, L: 44, R: 12, T: 10, B: 26 };
  }
  draw() {
    if (!this.host.clientWidth) return;
    const g = this.geom();
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    const r = this.range();
    this.r = r;
    const X = (x) => g.L + ((x - r.x0) / Math.max(1, r.x1 - r.x0)) * (g.w - g.L - g.R);
    const Y = (y) => g.T + (1 - (y - r.y0) / (r.y1 - r.y0)) * (g.h - g.T - g.B);
    this.X = X;
    // grid + labels
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = r.y0 + ((r.y1 - r.y0) * k) / 4;
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(g.L, y); ctx.lineTo(g.w - g.R, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(v >= 100 ? v.toFixed(0) : +v.toFixed(1), g.L - 6, y + 4);
    }
    const span = r.x1 - r.x0;
    const maxLabels = Math.max(2, Math.floor((g.w - g.L - g.R) / 48));
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find((s) => span / s <= maxLabels) || 2000;
    ctx.textAlign = 'center';
    for (let x = Math.ceil(r.x0 / step) * step; x <= r.x1; x += step) ctx.fillText(x, X(x), g.h - 8);
    // bands
    for (const b of this.bands) {
      ctx.fillStyle = b.color;
      ctx.beginPath();
      let started = false;
      for (let x = r.x0; x <= r.x1; x++) { const v = b.hi[x - 1]; if (!Number.isFinite(v)) continue; started ? ctx.lineTo(X(x), Y(v)) : ctx.moveTo(X(x), Y(v)); started = true; }
      for (let x = r.x1; x >= r.x0; x--) { const v = b.lo[x - 1]; if (Number.isFinite(v)) ctx.lineTo(X(x), Y(v)); }
      ctx.closePath();
      ctx.fill();
    }
    // dots first (faint), lines on top
    for (const s of this.series) {
      if (!s.dots) continue;
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.35;
      for (let x = r.x0; x <= r.x1; x++) { const v = s.dots[x - 1]; if (Number.isFinite(v)) ctx.fillRect(X(x) - 1, Y(v) - 1, 2, 2); }
      ctx.globalAlpha = 1;
    }
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.6;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      let pen = false;
      const every = Math.max(1, Math.floor(span / (g.w * 2)));
      for (let x = r.x0; x <= r.x1; x += x + every > r.x1 && x !== r.x1 ? r.x1 - x || 1 : every) {
        const v = s.values[x - 1];
        if (!Number.isFinite(v)) { pen = false; continue; }
        pen ? ctx.lineTo(X(x), Y(v)) : ctx.moveTo(X(x), Y(v));
        pen = true;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (this.mark) {
      ctx.strokeStyle = css('--accent');
      ctx.beginPath(); ctx.moveTo(X(this.mark), g.T); ctx.lineTo(X(this.mark), g.h - g.B); ctx.stroke();
    }
    if (this.hoverX) {
      ctx.strokeStyle = css('--muted');
      ctx.beginPath(); ctx.moveTo(X(this.hoverX), g.T); ctx.lineTo(X(this.hoverX), g.h - g.B); ctx.stroke();
    }
  }
  xAt(e) {
    if (!this.r) return null;
    const g = this.geom();
    const px = e.offsetX;
    if (px < g.L || px > g.w - g.R) return null;
    return Math.round(this.r.x0 + ((px - g.L) / (g.w - g.L - g.R)) * (this.r.x1 - this.r.x0));
  }
  hover(e) {
    const x = this.xAt(e);
    if (x == null) { this.tip.hidden = true; return; }
    this.hoverX = x;
    this.draw();
    const rows = this.series.map((s) => {
      const v = s.dots ? s.dots[x - 1] : s.values[x - 1];
      const sm = s.dots ? s.values[x - 1] : null;
      return `<div><i style="background:${s.color}"></i>${s.name}: <b>${Number.isFinite(v) ? +v.toFixed(2) : '–'}</b>${Number.isFinite(sm) ? ` <span class="muted">(згладж. ${+sm.toFixed(1)})</span>` : ''}</div>`;
    });
    for (const b of this.bands) if (Number.isFinite(b.lo[x - 1])) rows.push(`<div class="muted">${b.name}: ${b.lo[x - 1]}–${b.hi[x - 1]}</div>`);
    this.tip.innerHTML = `<div><b>Рівень ${x}</b>${this.labelFor ? ' ' + this.labelFor(x) : ''}</div>` + rows.join('');
    this.tip.hidden = false;
    const left = Math.min(e.offsetX + 14, this.host.clientWidth - this.tip.offsetWidth - 4);
    this.tip.style.left = Math.max(0, left) + 'px';
    this.tip.style.top = Math.max(0, e.offsetY - 10) + 'px';
  }
}
