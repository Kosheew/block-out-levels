import { DEFAULT_CONFIG, SET_NAMES, lerp } from './generator.js';
import { normalise, measure, validate, packStats, unpackStats, toSetFile, rolling, bands, DEFAULT_BANDS, TIERS } from './metrics.js';
import * as store from './store.js';
import * as pool from './pool.js';
import { Chart } from './chart.js';
import { BoardView } from './board.js';

/* ------------------------------------------------------------- helpers -- */
const $ = (sel, root = document) => root.querySelector(sel);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const opt = (value, label, selected) => h('option', { value, selected: selected ? true : null }, label);
const SET_LABEL = { normal: 'Звичайні', challenge: 'Календар (daily)', roadtrip: 'Road Trip', special: 'Спеціальні' };
const METRICS = {
  C: 'Складність C', n: 'Блоків', spare: 'Запас ходів', moves: 'Ліміт ходів', area: 'Площа поля (клітинок)', free0: 'Вільних блоків на старті',
  depth: 'Глибина (раунди зняття)', layers: 'Двошарових блоків', singles: 'Частка 1-клітинних', tier: 'Тир (0 easy · 1 hard · 2 super hard)',
};
const PALETTE = ['#3b6fe0', '#d9480f', '#2b8a3e', '#ae3ec9', '#1098ad', '#f08c00', '#c2255c', '#5c7cfa'];
const toast = (msg, kind = '') => {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
};
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яіїєґ]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);
const download = (name, blob) => { const a = h('a', { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

/* --------------------------------------------------------------- state -- */
const S = {
  index: { versions: [] },
  ref: null,
  stats: new Map(), // `${vid}/${set}` -> stats[]
  levels: new Map(), // `${vid}/${set}` -> levels[]
  draft: null, // {set, config, levels, stats, base, from, to}
  set: 'normal',
  shown: new Set(),
};
const DRAFT = '__draft';

const versionById = (id) => S.index.versions.find((v) => v.id === id);
/* Folder that really holds a set of a version (sets inherited from a parent point to it with `from`). */
function setHome(vid, set) {
  let v = versionById(vid);
  for (let k = 0; v && k < 50; k++) {
    const s = v.sets?.[set];
    if (!s) return null;
    if (!s.from) return v.id;
    v = versionById(s.from);
  }
  return null;
}
async function getStats(vid, set) {
  if (vid === DRAFT) return S.draft?.set === set ? S.draft.stats : null;
  const home = setHome(vid, set);
  if (!home) return null;
  const key = `${home}/${set}`;
  if (!S.stats.has(key)) S.stats.set(key, unpackStats(await store.readJson(`versions/${home}/${set}.stats.json`)));
  return S.stats.get(key);
}
async function getLevels(vid, set) {
  if (vid === DRAFT) return S.draft?.set === set ? S.draft.levels : null;
  const home = setHome(vid, set);
  if (!home) return null;
  const key = `${home}/${set}`;
  if (!S.levels.has(key)) S.levels.set(key, normalise(await store.readJson(`versions/${home}/${set}.json`)));
  return S.levels.get(key);
}
const metricOf = (s, m) => (s == null ? NaN : m === 'area' ? s.w * s.h : s[m]);
function versionsWith(set) {
  const list = S.index.versions.filter((v) => setHome(v.id, set)).slice().reverse();
  if (S.draft?.set === set) list.unshift({ id: DRAFT, title: '✱ Чернетка (не збережено)' });
  return list;
}
function colourOf(id) {
  const ids = [DRAFT, ...S.index.versions.map((v) => v.id).reverse()];
  return PALETTE[Math.max(0, ids.indexOf(id)) % PALETTE.length];
}

async function loadIndex(fresh = false) {
  if (fresh) await store.refreshHead();
  try {
    S.index = await store.readJson('versions/index.json', { fresh });
  } catch {
    S.index = { versions: [] };
  }
  if (!S.shown.size && S.index.versions.length) S.shown.add(S.index.versions[S.index.versions.length - 1].id);
}

/* -------------------------------------------------------------- access -- */
function renderAccess() {
  const btn = $('#access');
  btn.textContent = store.auth.token ? `✎ ${store.auth.author || 'редагування'}` : '🔒 Лише перегляд';
  btn.classList.toggle('ok', !!store.auth.token);
}
function openAccess() {
  const dlg = $('#accessDlg');
  $('#tok', dlg).value = store.auth.token;
  $('#who', dlg).value = store.auth.author;
  $('#accessMsg', dlg).textContent = '';
  dlg.showModal();
}
async function saveAccess(e) {
  e.preventDefault();
  const dlg = $('#accessDlg');
  store.auth.token = $('#tok', dlg).value;
  store.auth.author = $('#who', dlg).value;
  renderAccess();
  if (!store.auth.token) { dlg.close(); return; }
  $('#accessMsg', dlg).textContent = 'Перевіряю…';
  try {
    const me = await store.whoAmI();
    if (!store.auth.author) { store.auth.author = me.login; renderAccess(); }
    $('#accessMsg', dlg).textContent = me.canWrite ? `Готово: ${me.login}, є право запису.` : `${me.login}: токен дійсний, але без права запису в репозиторій.`;
    if (me.canWrite) setTimeout(() => dlg.close(), 800);
  } catch (err) {
    $('#accessMsg', dlg).textContent = `Не вдалося: ${err.message}`;
  }
}

/* -------------------------------------------------------------- curves -- */
let curveChart;
async function renderCurves() {
  const root = $('#tab-curves');
  const st = (root.state ||= { metric: 'C', smooth: 25, from: '', to: '', ref: true });
  root.replaceChildren();
  const vs = versionsWith(S.set);
  const controls = h('div', { class: 'controls' },
    h('label', {}, 'Набір ', h('select', { onchange: (e) => { S.set = e.target.value; renderCurves(); } }, SET_NAMES.map((s) => opt(s, SET_LABEL[s], s === S.set)))),
    h('label', {}, 'Метрика ', h('select', { onchange: (e) => { st.metric = e.target.value; renderCurves(); } }, Object.entries(METRICS).map(([k, v]) => opt(k, v, k === st.metric)))),
    h('label', {}, 'Згладжування ', h('select', { onchange: (e) => { st.smooth = +e.target.value; renderCurves(); } },
      [[0, 'немає'], [5, '±5'], [12, '±12'], [25, '±25'], [50, '±50']].map(([k, v]) => opt(k, v, k === st.smooth)))),
    h('label', {}, 'Рівні ', h('input', { type: 'number', min: 1, placeholder: 'від', value: st.from, onchange: (e) => { st.from = e.target.value; draw(); } }),
      '–', h('input', { type: 'number', min: 1, placeholder: 'до', value: st.to, onchange: (e) => { st.to = e.target.value; draw(); } })),
    h('label', {}, h('input', { type: 'checkbox', checked: st.ref, onchange: (e) => { st.ref = e.target.checked; draw(); } }), ' Reference (Tap Block Out)'),
  );
  const picks = h('div', { class: 'chips' }, vs.length ? vs.map((v) => h('label', { class: 'chip', style: `--c:${colourOf(v.id)}` },
    h('input', { type: 'checkbox', checked: S.shown.has(v.id), onchange: (e) => { e.target.checked ? S.shown.add(v.id) : S.shown.delete(v.id); draw(); } }),
    ' ', v.title)) : h('span', { class: 'muted' }, 'У цьому наборі ще немає версій.'));
  const chartHost = h('div', { class: 'chartHost' });
  const legend = h('p', { class: 'muted small' }, 'Крапки — окремі рівні, лінія — згладжена медіана. Сіра смуга — reference p10–p90, пунктир — його медіана. Клік по графіку відкриває рівень.');
  const table = h('div', { class: 'tableWrap' });
  root.append(h('section', { class: 'card' }, h('h2', {}, 'Крива складності'), controls, picks, chartHost, legend), h('section', { class: 'card' }, h('h3', {}, 'По діапазонах рівнів'), table));
  curveChart = new Chart(chartHost, {
    height: 360,
    onPick: (x) => { const vid = [...S.shown].find((id) => vs.some((v) => v.id === id)) || vs[0]?.id; if (vid) openLevel(vid, S.set, x); },
  });

  async function draw() {
    const m = st.metric;
    const series = [];
    const tableCols = [];
    for (const v of vs) {
      if (!S.shown.has(v.id)) continue;
      let stats;
      try { stats = await getStats(v.id, S.set); } catch (err) { toast(`${v.title}: ${err.message}`, 'error'); continue; }
      if (!stats) continue;
      const raw = stats.map((s) => metricOf(s, m));
      const smooth = st.smooth ? rolling(raw, st.smooth).med : raw;
      series.push({ name: v.title, color: colourOf(v.id), values: smooth, dots: st.smooth ? raw : null, width: 2 });
      tableCols.push({ name: v.title, color: colourOf(v.id), stats });
    }
    const bandsList = [];
    const ref = S.ref?.sets?.[S.set];
    const refRoll = ref?.rolling?.[m === 'area' ? 'area' : m];
    if (st.ref && refRoll) {
      bandsList.push({ name: 'Reference p10–p90', color: 'rgba(128,128,140,0.18)', lo: refRoll.p10, hi: refRoll.p90 });
      series.unshift({ name: 'Reference медіана', color: css('--ref'), values: refRoll.med, dash: [6, 4], width: 2 });
    }
    curveChart.set({ series, bands: bandsList, from: +st.from || null, to: +st.to || null });
    // band table
    const ranges = DEFAULT_BANDS[S.set];
    const q = (arr, p) => { const t = arr.filter(Number.isFinite).sort((a, b) => a - b); return t.length ? t[Math.min(t.length - 1, Math.floor(p * t.length))] : NaN; };
    const f = (x) => (Number.isFinite(x) ? +x.toFixed(x < 10 ? 2 : 1) : '–');
    const head = h('tr', {}, h('th', {}, 'Рівні'), st.ref && ref ? h('th', {}, 'Reference') : null, tableCols.map((c) => h('th', { style: `color:${c.color}` }, c.name)));
    const rows = ranges.map(([a, b]) => {
      const cells = [h('td', {}, `${a}–${b}`)];
      if (st.ref && ref) {
        const lo = refRoll ? refRoll.med.slice(a - 1, b) : [];
        cells.push(h('td', {}, lo.length ? `${f(q(lo, 0.5))}` : '–'));
      }
      for (const c of tableCols) {
        const vals = c.stats.slice(a - 1, b).map((s) => metricOf(s, m));
        const hard = c.stats.slice(a - 1, b);
        cells.push(h('td', {}, vals.length ? h('span', {}, `${f(q(vals, 0.5))}`, h('span', { class: 'muted' }, ` p90 ${f(q(vals, 0.9))} · H/SH ${Math.round(100 * hard.filter((s) => s?.tier === 1).length / hard.length)}/${Math.round(100 * hard.filter((s) => s?.tier === 2).length / hard.length)}%`)) : '–'));
      }
      return h('tr', {}, cells);
    });
    table.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, rows)),
      h('p', { class: 'muted small' }, `Медіана метрики «${METRICS[m]}» у діапазоні; для версій ще p90 і частка HARD / SUPER HARD.` + (st.ref && ref ? ' Для reference — медіана його згладженої кривої.' : '')));
  }
  draw();
}

/* -------------------------------------------------------------- levels -- */
const view = { vid: null, set: 'normal', pos: 1, mode: 'play' };
function openLevel(vid, set, pos) {
  Object.assign(view, { vid, set, pos });
  showTab('levels');
}
let boardView;
let levelChart;
async function renderLevels() {
  const root = $('#tab-levels');
  root.replaceChildren();
  const vs = versionsWith(view.set);
  if (!vs.some((v) => v.id === view.vid)) view.vid = vs[0]?.id || null;
  if (!view.vid) { root.append(h('section', { class: 'card' }, h('p', {}, 'У цьому наборі немає жодної версії.'), h('select', { onchange: (e) => { view.set = e.target.value; renderLevels(); } }, SET_NAMES.map((s) => opt(s, SET_LABEL[s], s === view.set))))); return; }
  let levels;
  let stats;
  try {
    root.append(h('p', { class: 'muted' }, 'Завантаження…'));
    [levels, stats] = await Promise.all([getLevels(view.vid, view.set), getStats(view.vid, view.set)]);
  } catch (err) { root.replaceChildren(h('p', { class: 'error' }, err.message)); return; }
  root.replaceChildren();
  view.pos = Math.min(Math.max(1, view.pos), levels.length);
  const L = levels[view.pos - 1];
  const s = stats?.[view.pos - 1];
  const go = (p) => { view.pos = p; renderLevels(); };
  const controls = h('div', { class: 'controls' },
    h('label', {}, 'Версія ', h('select', { onchange: (e) => { view.vid = e.target.value; renderLevels(); } }, vs.map((v) => opt(v.id, v.title, v.id === view.vid)))),
    h('label', {}, 'Набір ', h('select', { onchange: (e) => { view.set = e.target.value; renderLevels(); } }, SET_NAMES.map((x) => opt(x, SET_LABEL[x], x === view.set)))),
    h('span', { class: 'group' },
      h('button', { onclick: () => go(view.pos - 1), disabled: view.pos <= 1 }, '◀'),
      h('input', { type: 'number', min: 1, max: levels.length, value: view.pos, onchange: (e) => go(+e.target.value) }),
      h('span', { class: 'muted' }, ` / ${levels.length}`),
      h('button', { onclick: () => go(view.pos + 1), disabled: view.pos >= levels.length }, '▶')),
    h('span', { class: 'group seg' },
      h('button', { class: view.mode === 'play' ? 'on' : '', onclick: () => { view.mode = 'play'; renderLevels(); } }, 'Грати'),
      h('button', { class: view.mode === 'edit' ? 'on' : '', onclick: () => { view.mode = 'edit'; renderLevels(); } }, 'Редагувати')),
  );
  const canvas = h('canvas', { class: 'board' });
  const status = h('div', { class: 'status' });
  const info = h('div', { class: 'info' });
  const json = h('textarea', { rows: 10, spellcheck: false });
  const errs = h('div', { class: 'errs' });
  const boardWrap = h('div', { class: 'boardWrap' }, canvas);
  root.append(h('section', { class: 'card' }, controls, h('div', { class: 'levelGrid' }, h('div', {}, boardWrap, status), info)));

  boardView = new BoardView(canvas, { onChange: (why) => { refresh(why); } });
  boardView.mode = view.mode;
  boardView.showFree = view.showFree;
  boardView.load(L);

  function refresh(why) {
    const cur = boardView.level;
    if (view.mode === 'play') {
      status.textContent = boardView.won ? `Пройдено! Лишилось ходів: ${boardView.movesLeft}` : boardView.movesLeft <= 0 ? 'Ходи скінчились' : `Ходів: ${boardView.movesLeft} · блоків: ${boardView.board.left()}`;
      status.className = 'status ' + (boardView.won ? 'win' : boardView.movesLeft <= 0 ? 'lose' : '');
    } else {
      status.textContent = 'Клік — повернути напрямок · Shift+клік — зовнішній шар · правий клік / Alt+клік — видалити блок';
      status.className = 'status';
    }
    if (why === 'edit' || why === 'reset') {
      json.value = JSON.stringify(cur);
      const e = validate(cur);
      errs.replaceChildren(...(e.length ? e.map((x) => h('div', { class: 'error' }, '⚠ ' + x)) : [h('div', { class: 'ok' }, '✓ Рівень коректний і розв\'язний')]));
      if (why === 'edit') renderInfo(measure(cur, view.pos - 1), true);
    }
  }

  function renderInfo(m, edited) {
    const row = (k, v) => h('tr', {}, h('th', {}, k), h('td', {}, v));
    const tierSel = h('select', { disabled: view.mode !== 'edit', onchange: (e) => { boardView.level.tier = e.target.value; refresh('edit'); } }, TIERS.map((t) => opt(t, { easy: 'Normal', tricky: 'Hard', expert: 'Super Hard' }[t], t === boardView.level.tier)));
    const movesIn = h('input', { type: 'number', min: 1, value: boardView.level.moves, disabled: view.mode !== 'edit', onchange: (e) => { boardView.level.moves = +e.target.value; boardView.reset(); refresh('edit'); } });
    info.replaceChildren(
      h('h3', {}, `Рівень ${view.pos}`, h('span', { class: 'muted' }, ` · id ${boardView.level.id}`), edited ? h('span', { class: 'badge' }, 'змінено') : null),
      h('table', { class: 'kv' },
        row('Тир', tierSel), row('Поле', `${m.w}×${m.h}`), row('Блоків', `${m.n}${m.layers ? ` (+${m.layers} шарів)` : ''}`), row('Ліміт ходів', movesIn),
        row('Запас ходів', m.spare), row('Складність C', m.C), row('Глибина', m.depth), row('Вільних на старті', m.free0), row('Частка 1-клітинних', `${Math.round(m.singles * 100)}%`)),
      view.mode === 'play'
        ? h('div', { class: 'row' }, h('button', { onclick: () => boardView.reset() }, '↺ Почати знову'),
          h('label', {}, h('input', { type: 'checkbox', checked: !!view.showFree, onchange: (e) => { view.showFree = boardView.showFree = e.target.checked; boardView.draw(); } }), ' підсвітити вільні'))
        : h('div', {},
          errs,
          h('details', {}, h('summary', {}, 'JSON рівня'), json, h('button', { onclick: () => {
            try { const [nl] = normalise(JSON.parse(json.value)); boardView.load(nl); refresh('edit'); } catch (err) { toast(err.message, 'error'); }
          } }, 'Застосувати JSON')),
          h('div', { class: 'row' },
            h('button', { onclick: () => { boardView.load(L); renderInfo(s || measure(L, view.pos - 1)); refresh('reset'); } }, 'Скасувати зміни'),
            view.vid !== DRAFT ? h('button', { class: 'primary', onclick: (e) => saveLevel(e.target, false) }, 'Зберегти у версію') : null,
            h('button', { class: view.vid === DRAFT ? 'primary' : '', onclick: (e) => saveLevel(e.target, true) }, view.vid === DRAFT ? 'Застосувати до чернетки' : 'Зберегти як нову версію'))),
      h('h4', {}, 'Складність навколо'),
      h('div', { class: 'miniChart' }),
    );
    if (stats) {
      levelChart = new Chart($('.miniChart', info), { height: 140, onPick: (x) => go(x) });
      const raw = stats.map((x) => x?.C);
      const ref = S.ref?.sets?.[view.set]?.rolling?.C;
      levelChart.set({
        series: [...(ref ? [{ name: 'Reference', color: '#868e96', values: ref.med, dash: [4, 3], width: 1 }] : []), { name: 'C', color: colourOf(view.vid), values: rolling(raw, 5).med, dots: raw }],
        bands: [], from: Math.max(1, view.pos - 40), to: Math.min(stats.length, view.pos + 40), mark: view.pos,
      });
    }
  }

  async function saveLevel(btn, asNew) {
    const cur = boardView.level;
    const e = validate(cur);
    if (e.length) { toast('Рівень некоректний: ' + e[0], 'error'); return; }
    const next = levels.slice();
    next[view.pos - 1] = cur;
    const nextStats = (stats || []).slice();
    nextStats[view.pos - 1] = measure(cur, view.pos - 1);
    if (view.vid === DRAFT) { S.draft.levels = next; S.draft.stats = nextStats; toast('Застосовано до чернетки'); renderLevels(); return; }
    let title = null;
    if (asNew) { title = prompt('Назва нової версії', `${versionById(view.vid).title} · правка рівня ${view.pos}`); if (!title) return; }
    busy(btn, true, 'Зберігаю…');
    try {
      const id = asNew ? await saveVersion({ title, note: `Правка рівня ${view.pos} (${view.set})`, parent: view.vid, set: view.set, levels: next, stats: nextStats })
        : await saveSet(view.vid, view.set, next, nextStats, `${view.set}: рівень ${view.pos} змінено у «${versionById(view.vid).title}»`);
      toast('Збережено ✓');
      view.vid = id;
      renderLevels();
    } catch (err) { toast(err.message, 'error'); busy(btn, false, 'Зберегти'); }
  }
  renderInfo(s || measure(L, view.pos - 1));
  refresh('reset');
}

/* ---------------------------------------------------------- saving data -- */
const newId = (title) => `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-${slug(title) || 'v'}`;

/* Commit one set into an existing version (it becomes that version's own copy if it was inherited). */
async function saveSet(vid, set, levels, stats, message) {
  const v = structuredClone(versionById(vid));
  v.sets[set] = { count: levels.length, edited: new Date().toISOString(), by: store.auth.author || '' };
  v.date = new Date().toISOString();
  const index = structuredClone(S.index);
  index.versions = index.versions.map((x) => (x.id === vid ? v : x));
  await store.commit({
    [`versions/${vid}/${set}.json`]: toSetFile(levels),
    [`versions/${vid}/${set}.stats.json`]: JSON.stringify(packStats(stats)),
    [`versions/${vid}/meta.json`]: JSON.stringify(v, null, 2),
    'versions/index.json': JSON.stringify(index, null, 2),
  }, message);
  S.index = index;
  S.levels.set(`${vid}/${set}`, levels);
  S.stats.set(`${vid}/${set}`, stats);
  return vid;
}

/* New version: `set` gets its own files, the parent's other sets are inherited by reference. */
async function saveVersion({ title, note, parent, set, levels, stats, config }) {
  const id = newId(title);
  const sets = {};
  if (parent) for (const sname of SET_NAMES) { const home = setHome(parent, sname); if (home && sname !== set) sets[sname] = { count: versionById(home).sets[sname].count, from: home }; }
  sets[set] = { count: levels.length };
  const meta = { id, title, note: note || '', author: store.auth.author || '', date: new Date().toISOString(), parent: parent || null, source: config ? 'generator' : 'edit', sets };
  const index = structuredClone(S.index);
  index.versions.push(meta);
  const files = {
    [`versions/${id}/${set}.json`]: toSetFile(levels),
    [`versions/${id}/${set}.stats.json`]: JSON.stringify(packStats(stats)),
    [`versions/${id}/meta.json`]: JSON.stringify(meta, null, 2),
    'versions/index.json': JSON.stringify(index, null, 2),
  };
  if (config) files[`versions/${id}/config.json`] = JSON.stringify(config, null, 2);
  await store.commit(files, `Нова версія «${title}» (${set}, ${levels.length} рівнів)`);
  S.index = index;
  S.levels.set(`${id}/${set}`, levels);
  S.stats.set(`${id}/${set}`, stats);
  S.shown.add(id);
  return id;
}

/* ----------------------------------------------------------- generator -- */
const gen = { base: null, set: 'normal', config: structuredClone(DEFAULT_CONFIG), from: 1, to: 100, key: 'blocks' };
async function renderGenerator() {
  const root = $('#tab-gen');
  root.replaceChildren();
  const vs = S.index.versions.slice().reverse();
  const section = gen.config[gen.set];
  const tables = Object.entries(section).filter(([, v]) => Array.isArray(v) && Array.isArray(v[0]) && typeof v[0][1] === 'number').map(([k]) => k);
  if (!tables.includes(gen.key)) gen.key = tables[0] || null;
  const area = h('textarea', { rows: 22, spellcheck: false, class: 'code' }, JSON.stringify(section, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2]'));
  const common = h('textarea', { rows: 4, spellcheck: false, class: 'code' }, JSON.stringify({ seed: gen.config.seed, weights: gen.config.weights }));
  const msg = h('div', { class: 'small' });
  const apply = () => {
    try {
      const sec = JSON.parse(area.value);
      const c = JSON.parse(common.value);
      gen.config = { ...gen.config, ...c, [gen.set]: sec };
      area.classList.remove('invalid'); common.classList.remove('invalid');
      msg.textContent = '';
      return true;
    } catch (err) { msg.textContent = 'JSON: ' + err.message; msg.className = 'small error'; area.classList.add('invalid'); return false; }
  };
  area.addEventListener('input', () => { if (apply()) drawTable(); });
  common.addEventListener('input', apply);
  const bar = h('progress', { max: 1, value: 0, hidden: true });
  const result = h('div', {});
  const tableHost = h('div', { class: 'chartHost' });

  root.append(
    h('section', { class: 'card' },
      h('h2', {}, 'Генератор рівнів'),
      h('p', { class: 'muted small' }, 'Порт tools/gen-levels.mjs з гри: однаковий конфіг дає ті самі рівні, що й у грі. Криві — таблиці точок [рівень, значення], між точками лінійно. Генерація йде у фонових потоках браузера.'),
      h('div', { class: 'controls' },
        h('label', {}, 'Конфіг з версії ', h('select', { onchange: async (e) => { await loadConfig(e.target.value); renderGenerator(); } },
          opt('', 'стандартний (як у грі)', !gen.base), vs.map((v) => opt(v.id, v.title, v.id === gen.base)))),
        h('label', {}, 'Набір ', h('select', { onchange: (e) => { if (apply()) { gen.set = e.target.value; renderGenerator(); } } }, SET_NAMES.map((s) => opt(s, SET_LABEL[s], s === gen.set)))),
        h('button', { onclick: () => { gen.config = structuredClone(DEFAULT_CONFIG); gen.base = null; renderGenerator(); } }, 'Скинути до стандартного')),
      h('div', { class: 'genGrid' },
        h('div', {}, h('label', { class: 'small muted' }, `Параметри набору «${SET_LABEL[gen.set]}»`), area, h('label', { class: 'small muted' }, 'Seed і ваги побудови (спільні)'), common, msg),
        h('div', {},
          h('label', {}, 'Таблиця ', h('select', { onchange: (e) => { gen.key = e.target.value; drawTable(); } }, tables.map((k) => opt(k, k, k === gen.key)))),
          tableHost,
          h('p', { class: 'muted small' }, 'Підказка: blocks / width / height — розмір; depthRatio — глибина ланцюгів (складність); freeRatio — частка вільних на старті (менше = складніше); spare — запас ходів; tiers — які рівні HARD / SUPER HARD.'))),
      h('div', { class: 'controls' },
        h('label', {}, 'Рівні ', h('input', { type: 'number', min: 1, value: gen.from, onchange: (e) => { gen.from = +e.target.value; } }), '–',
          h('input', { type: 'number', min: 1, value: gen.to, onchange: (e) => { gen.to = +e.target.value; } })),
        h('button', { class: 'primary', onclick: () => run(gen.from, gen.to) }, 'Згенерувати діапазон'),
        h('button', { onclick: () => run(1, gen.config[gen.set].count) }, `Згенерувати весь набір (${gen.config[gen.set].count})`),
        h('button', { onclick: () => { pool.cancel(); bar.hidden = true; } }, 'Зупинити'),
        bar)),
    result,
  );
  const tChart = new Chart(tableHost, { height: 200 });
  function drawTable() {
    const pts = gen.config[gen.set][gen.key];
    if (!Array.isArray(pts)) return;
    const n = gen.config[gen.set].count || 5000;
    const vals = Array.from({ length: n }, (_, i) => lerp(pts, i + 1));
    // show up to a bit past the last point: after it the value stays flat
    const to = Math.min(n, Math.max(20, Math.round(pts[pts.length - 1][0] * 1.25)));
    tChart.set({ series: [{ name: gen.key, color: '#3b6fe0', values: vals, width: 2 }], bands: [], to });
  }
  drawTable();
  if (S.draft) renderDraft(result);

  async function run(from, to) {
    if (!apply()) return;
    from = Math.max(1, from); to = Math.min(gen.config[gen.set].count, to);
    if (to < from) return;
    bar.hidden = false; bar.value = 0;
    const t0 = performance.now();
    try {
      const out = await pool.generate(structuredClone(gen.config), gen.set, from, to, (p) => { bar.value = p; });
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      // draft = base version's set with the generated range replaced (or just the range if no base)
      const baseVid = gen.base && setHome(gen.base, gen.set) ? gen.base : [...S.index.versions].reverse().find((v) => setHome(v.id, gen.set))?.id;
      let levels = out.levels;
      let stats = out.stats;
      let full = from === 1 && to === gen.config[gen.set].count;
      if (!full && baseVid) {
        const bl = (await getLevels(baseVid, gen.set)).slice();
        const bs = (await getStats(baseVid, gen.set)).slice();
        levels = bl; stats = bs;
        out.levels.forEach((L, k) => { levels[from - 1 + k] = L; stats[from - 1 + k] = out.stats[k]; });
      }
      S.draft = { set: gen.set, config: structuredClone(gen.config), levels, stats, base: baseVid, from, to, full, secs };
      S.shown.add(DRAFT);
      bar.hidden = true;
      toast(`Згенеровано ${out.levels.length} рівнів за ${secs} с`);
      renderDraft(result);
    } catch (err) { bar.hidden = true; if (!/terminated/.test(err.message)) toast(err.message, 'error'); }
  }
}

async function loadConfig(vid) {
  gen.base = vid || null;
  if (!vid) { gen.config = structuredClone(DEFAULT_CONFIG); return; }
  try { gen.config = { ...structuredClone(DEFAULT_CONFIG), ...(await store.readJson(`versions/${vid}/config.json`)) }; }
  catch { gen.config = structuredClone(DEFAULT_CONFIG); toast('У цієї версії немає config.json — взято стандартний конфіг.'); }
}

function renderDraft(host) {
  const d = S.draft;
  const chartHost = h('div', { class: 'chartHost' });
  const title = h('input', { type: 'text', placeholder: 'Назва версії, напр. «Normal: більше піків»', size: 40 });
  const note = h('textarea', { rows: 2, placeholder: 'Що змінено і навіщо' });
  const tb = h('div', { class: 'tableWrap' });
  host.replaceChildren(h('section', { class: 'card' },
    h('h2', {}, `Чернетка: ${SET_LABEL[d.set]}`),
    h('p', { class: 'muted small' }, d.full ? `Увесь набір, ${d.levels.length} рівнів.` : `Рівні ${d.from}–${d.to} перегенеровано, решта взята з версії «${versionById(d.base)?.title || '—'}».`),
    chartHost,
    tb,
    h('div', { class: 'controls' },
      h('button', { onclick: () => openLevel(DRAFT, d.set, d.from) }, 'Переглянути рівні чернетки'),
      h('button', { onclick: () => { S.set = d.set; showTab('curves'); } }, 'Порівняти на «Кривих»'),
      h('button', { onclick: () => download(`${d.set}.json`, new Blob([toSetFile(d.levels)], { type: 'application/json' })) }, 'Завантажити JSON')),
    h('div', { class: 'saveRow' }, title, note,
      h('button', { class: 'primary', onclick: async (e) => {
        if (!title.value.trim()) { title.focus(); toast('Вкажіть назву версії'); return; }
        busy(e.target, true, 'Зберігаю…');
        try {
          const id = await saveVersion({ title: title.value.trim(), note: note.value.trim(), parent: d.base, set: d.set, levels: d.levels, stats: d.stats, config: d.config });
          S.draft = null; S.shown.delete(DRAFT);
          toast('Версію збережено ✓');
          gen.base = id;
          renderGenerator();
        } catch (err) { toast(err.message, 'error'); busy(e.target, false, 'Зберегти як версію'); }
      } }, 'Зберегти як версію')),
  ));
  const ch = new Chart(chartHost, { height: 260, onPick: (x) => openLevel(DRAFT, d.set, x) });
  (async () => {
    const series = [];
    const ref = S.ref?.sets?.[d.set]?.rolling?.C;
    const bandsList = [];
    if (ref) { bandsList.push({ name: 'Reference p10–p90', color: 'rgba(128,128,140,0.18)', lo: ref.p10, hi: ref.p90 }); series.push({ name: 'Reference медіана', color: css('--ref'), values: ref.med, dash: [6, 4], width: 2 }); }
    if (d.base) { const bs = await getStats(d.base, d.set); if (bs) series.push({ name: versionById(d.base).title, color: colourOf(d.base), values: rolling(bs.map((s) => s?.C), 25).med, width: 1.5 }); }
    const raw = d.stats.map((s) => s?.C);
    series.push({ name: 'Чернетка', color: colourOf(DRAFT), values: rolling(raw, 25).med, dots: raw, width: 2.2 });
    ch.set({ series, bands: bandsList, from: d.full ? null : Math.max(1, d.from - 50), to: d.full ? null : d.to + 50 });
    const rows = bands(d.stats.map((s) => s || {}), DEFAULT_BANDS[d.set]).filter((b) => d.full || true);
    const refB = S.ref?.sets?.[d.set]?.bands || [];
    tb.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Рівні', 'Поле', 'Блоків', 'Запас', 'C', 'C p90', 'HARD', 'SUPER', 'Ref C', 'Ref p90'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((b, i) => h('tr', {}, [b.band, b.board, `${b.blocks} (${b.blocksP10}–${b.blocksP90})`, b.spare, b.C, b.Cp90, `${b.tricky}%`, `${b.expert}%`, refB[i]?.C ?? '–', refB[i]?.Cp90 ?? '–'].map((x) => h('td', {}, x)))))));
  })();
}

/* ------------------------------------------------------------ versions -- */
async function renderVersions() {
  const root = $('#tab-versions');
  root.replaceChildren();
  const list = S.index.versions.slice().reverse();
  const rows = list.map((v) => h('tr', {},
    h('td', {}, h('b', {}, v.title), h('div', { class: 'muted small' }, v.id), v.note ? h('div', { class: 'small' }, v.note) : null),
    h('td', { class: 'small' }, v.author || '—', h('div', { class: 'muted' }, fmtDate(v.date)), v.parent ? h('div', { class: 'muted' }, `від: ${versionById(v.parent)?.title || v.parent}`) : null),
    h('td', { class: 'small' }, SET_NAMES.filter((s) => v.sets?.[s]).map((s) => h('div', {}, `${SET_LABEL[s]}: ${v.sets[s].count}`, v.sets[s].from ? h('span', { class: 'muted' }, ' (успадковано)') : null,
      ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); downloadSet(v.id, s, 'one'); } }, 'json'),
      ' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); downloadSet(v.id, s, 'chunks'); } }, 'zip для гри')))),
    h('td', { class: 'small' }, h('a', { href: store.historyUrl(`versions/${v.id}`), target: '_blank', rel: 'noopener' }, 'історія змін ↗'),
      h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); S.shown.add(v.id); showTab('curves'); } }, 'на графік'))),
  ));
  const files = h('input', { type: 'file', multiple: true, accept: '.json,application/json', hidden: true });
  const drop = h('div', { class: 'drop' }, 'Перетягніть сюди JSON-файли рівнів або ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); files.click(); } }, 'оберіть файли'),
    h('div', { class: 'muted small' }, 'Формати: файли гри (normal_000.json …, "blockout-levels/2"), масив рівнів, один рівень, або формат редактора (gridSize + blockList).'));
  const up = h('div', {});
  const handle = (fl) => prepareUpload([...fl], up);
  files.addEventListener('change', () => handle(files.files));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files); });
  root.append(
    h('section', { class: 'card' }, h('h2', {}, 'Завантажити рівні'),
      h('p', { class: 'warn small' }, '⚠ Лише наші рівні. Рівні інших ігор (зокрема Tap Block Out) завантажувати не можна — після DMCA-скарги це заборонено.'),
      drop, files, up),
    h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Версії'), h('button', { onclick: async () => { await loadIndex(true); renderVersions(); } }, '⟳ Оновити')),
      list.length ? h('div', { class: 'tableWrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Версія', 'Автор', 'Набори', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows)))
        : h('p', { class: 'muted' }, 'Ще немає версій.')),
  );
}

async function downloadSet(vid, set, how) {
  try {
    const levels = await getLevels(vid, set);
    if (how === 'one') return download(`${vid}-${set}.json`, new Blob([toSetFile(levels)], { type: 'application/json' }));
    const JSZip = window.JSZip;
    const zip = new JSZip();
    for (let c = 0; c * 50 < levels.length; c++) zip.file(`${set}/${set}_${String(c).padStart(3, '0')}.json`, toSetFile(levels.slice(c * 50, c * 50 + 50)));
    zip.file('index-entry.json', JSON.stringify({ [set]: { count: levels.length, ids: [levels[0].id, levels[levels.length - 1].id] } }, null, 2));
    download(`${vid}-${set}-chunks.zip`, await zip.generateAsync({ type: 'blob' }));
  } catch (err) { toast(err.message, 'error'); }
}

async function prepareUpload(fileList, host) {
  if (!fileList.length) return;
  host.replaceChildren(h('p', { class: 'muted' }, 'Читаю файли…'));
  let levels = [];
  const bad = [];
  let guess = 'normal';
  for (const f of fileList.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const m = f.name.match(/^(normal|challenge|roadtrip|special)/i);
      if (m) guess = m[1].toLowerCase();
      levels.push(...normalise(JSON.parse(await f.text()), levels.length + 1));
    } catch (err) { bad.push(`${f.name}: ${err.message}`); }
  }
  levels.sort((a, b) => a.id - b.id);
  if (!levels.length) { host.replaceChildren(h('p', { class: 'error' }, 'Не знайдено жодного рівня. ' + bad.join('; '))); return; }
  const bar = h('progress', { max: 1, value: 0 });
  host.replaceChildren(h('p', {}, `Знайдено ${levels.length} рівнів. Перевіряю і рахую метрики…`), bar);
  const { stats, errors } = await pool.measureAll(levels, (p) => { bar.value = p; });
  const setSel = h('select', {}, SET_NAMES.map((s) => opt(s, SET_LABEL[s], s === guess)));
  const target = h('select', {}, opt('new', 'нова версія'), S.index.versions.slice().reverse().map((v) => opt(v.id, `замінити набір у «${v.title}»`)));
  const parent = h('select', {}, opt('', '— без успадкування —'), S.index.versions.slice().reverse().map((v, i) => opt(v.id, v.title, i === 0)));
  const title = h('input', { type: 'text', placeholder: 'Назва версії', size: 36 });
  const note = h('textarea', { rows: 2, placeholder: 'Опис (звідки рівні, що змінилось)' });
  const ids = new Map();
  for (const L of levels) ids.set(L.id, (ids.get(L.id) || 0) + 1);
  const dups = [...ids].filter(([, c]) => c > 1).map(([id]) => id);
  if (dups.length) errors.unshift({ id: dups.slice(0, 10).join(', '), errs: [`повторюються id (${dups.length}) — рівні з однаковим id з різних файлів`] });
  const blocking = errors.filter((e) => e.errs.some((x) => !x.startsWith('ходів')));
  host.replaceChildren(...[
    h('p', {}, `Рівнів: ${levels.length} · id ${levels[0].id}–${levels[levels.length - 1].id}`),
    bad.length ? h('div', { class: 'error small' }, bad.map((b) => h('div', {}, b))) : null,
    errors.length ? h('details', { open: blocking.length > 0 }, h('summary', { class: blocking.length ? 'error' : 'warn' }, `Проблеми у ${errors.length} рівнях${blocking.length ? ` (${blocking.length} — нерозв'язні або зламані)` : ''}`),
      h('div', { class: 'small' }, errors.slice(0, 50).map((e) => h('div', {}, `id ${e.id}: ${e.errs.join('; ')}`)))) : h('p', { class: 'ok small' }, '✓ Усі рівні коректні й розв\'язні'),
    h('div', { class: 'controls' }, h('label', {}, 'Набір ', setSel), h('label', {}, 'Куди ', target), h('label', {}, 'Інші набори взяти з ', parent)),
    h('div', { class: 'saveRow' }, title, note, h('button', { class: 'primary', disabled: blocking.length > 0, onclick: async (e) => {
      const fixedStats = stats.map((s, i) => s || measure(levels[i], i));
      busy(e.target, true, 'Зберігаю…');
      try {
        if (target.value === 'new') {
          if (!title.value.trim()) { title.focus(); busy(e.target, false, 'Зберегти'); return toast('Вкажіть назву'); }
          await saveVersion({ title: title.value.trim(), note: note.value.trim(), parent: parent.value || null, set: setSel.value, levels, stats: fixedStats });
        } else {
          await saveSet(target.value, setSel.value, levels, fixedStats, `${setSel.value}: завантажено ${levels.length} рівнів у «${versionById(target.value).title}»`);
        }
        toast('Збережено ✓');
        renderVersions();
      } catch (err) { toast(err.message, 'error'); busy(e.target, false, 'Зберегти'); }
    } }, 'Зберегти')),
  ].filter(Boolean));
}

/* ---------------------------------------------------------------- tabs -- */
const TABS = { curves: renderCurves, levels: renderLevels, gen: renderGenerator, versions: renderVersions };
function showTab(name) {
  for (const b of document.querySelectorAll('nav.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of Object.keys(TABS)) $(`#tab-${t}`).hidden = t !== name;
  try { history.replaceState(null, '', `#${name}`); } catch { /* sandboxed */ }
  TABS[name]();
}

async function boot() {
  for (const b of document.querySelectorAll('nav.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('#access').addEventListener('click', openAccess);
  $('#accessForm').addEventListener('submit', saveAccess);
  $('#accessClose').addEventListener('click', () => $('#accessDlg').close());
  renderAccess();
  window.addEventListener('resize', () => { if (boardView && !$('#tab-levels').hidden) boardView.draw(); });
  await store.refreshHead();
  try { S.ref = await store.readJson('data/reference.json'); } catch { S.ref = null; }
  await loadIndex();
  const start = location.hash.slice(1);
  showTab(TABS[start] ? start : 'curves');
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS[t] && $(`#tab-${t}`).hidden) showTab(t); });
}
boot();
