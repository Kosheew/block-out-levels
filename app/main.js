import { DEFAULT_CONFIG, SET_NAMES, lerp } from './generator.js';
import { normalise, measure, validate, packStats, unpackStats, toSetFile, rolling, bands, DEFAULT_BANDS, TIERS } from './metrics.js';
import * as store from './store.js';
import * as pool from './pool.js';
import * as D from './db.js';
import { Chart } from './chart.js';
import { BoardView } from './board.js';

const { db } = D;

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
const PALETTE = ['#3b6fe0', '#d9480f', '#2b8a3e', '#ae3ec9', '#1098ad', '#f08c00', '#c2255c', '#5c7cfa', '#e64980', '#0ca678'];
const SITE_URL = 'https://kosheew.github.io/block-out-levels/';
const toast = (msg, kind = '') => {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
};
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яіїєґ]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40);
const download = (name, blob) => { const a = h('a', { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

/* --------------------------------------------------------------- state -- */
/* Entries: versions committed to the repo (source 'static', read-only) + versions and variations in Supabase. */
const S = {
  entries: [],
  ref: null,
  stats: new Map(), // `${id}/${set}` -> stats[]
  levels: new Map(), // `${id}/${set}` -> levels[]
  draft: null, // {set, config, levels, stats, base, from, to, full, savedId}
  set: 'normal',
  shown: new Set(),
};
const DRAFT = '__draft';

const entryById = (id) => S.entries.find((v) => v.id === id);
const versions = () => S.entries.filter((e) => e.kind === 'version');
const variations = (set) => S.entries.filter((e) => e.kind === 'variation' && (!set || e.gen_set === set));
const canEdit = () => db.isMember;
const isMine = (e) => e && e.source === 'db';

/* Entry that really holds the files of a set (inherited sets point to it with `from`). */
function setHome(id, set) {
  let v = entryById(id);
  for (let k = 0; v && k < 50; k++) {
    const s = v.sets?.[set];
    if (!s) return null;
    if (!s.from) return v;
    v = entryById(s.from);
  }
  return null;
}
async function readSetFile(home, set, stats) {
  if (home.source === 'static') return store.readText(`versions/${home.id}/${set}${stats ? '.stats' : ''}.json`);
  return D.download(D.filePath(home.id, set, stats), home.updated_at);
}
async function getStats(id, set) {
  if (id === DRAFT) return S.draft?.set === set ? S.draft.stats : null;
  const home = setHome(id, set);
  if (!home) return null;
  const key = `${home.id}/${set}@${home.updated_at || ''}`;
  if (!S.stats.has(key)) S.stats.set(key, unpackStats(JSON.parse(await readSetFile(home, set, true))));
  return S.stats.get(key);
}
async function getLevels(id, set) {
  if (id === DRAFT) return S.draft?.set === set ? S.draft.levels : null;
  const home = setHome(id, set);
  if (!home) return null;
  const key = `${home.id}/${set}@${home.updated_at || ''}`;
  if (!S.levels.has(key)) S.levels.set(key, normalise(JSON.parse(await readSetFile(home, set, false))));
  return S.levels.get(key);
}
const metricOf = (s, m) => (s == null ? NaN : m === 'area' ? s.w * s.h : s[m]);
function entriesWith(set, { withVariations = true } = {}) {
  const list = S.entries.filter((e) => setHome(e.id, set) && (e.kind === 'version' || (withVariations && e.gen_set === set))).slice().reverse();
  if (S.draft?.set === set && !S.draft.savedId) list.unshift({ id: DRAFT, title: '✱ Чернетка (не збережено)', kind: 'variation' });
  return list;
}
function colourOf(id) {
  const ids = [DRAFT, ...S.entries.map((v) => v.id).reverse()];
  return PALETTE[Math.max(0, ids.indexOf(id)) % PALETTE.length];
}
const labelOf = (e) => (e.kind === 'variation' ? `${e.pinned ? '★ ' : ''}${e.title}` : e.title);

async function loadEntries() {
  let stat = [];
  try { stat = (await store.readJson('versions/index.json')).versions.map((v) => ({ ...v, kind: 'version', source: 'static', created_at: v.date, author_name: v.author })); } catch { /* none */ }
  let dyn = [];
  if (db.client) {
    try { dyn = (await D.listEntries()).map((e) => ({ ...e, source: 'db' })); } catch (err) { toast(err.message, 'error'); }
  }
  S.entries = [...stat, ...dyn];
  if (!S.shown.size && S.entries.length) S.shown.add(versions().slice(-1)[0]?.id || S.entries[0].id);
}

/* ------------------------------------------------------------- saving -- */
const newId = (prefix) => `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${prefix}-${Math.random().toString(36).slice(2, 6)}`;
const summaryOf = (stats) => ({ count: stats.length, C: median(stats.map((s) => s?.C)), blocks: median(stats.map((s) => s?.n)), spare: median(stats.map((s) => s?.spare)) });

/* Sets of `parent` other than `set`, inherited by reference. */
function inheritSets(parent, except) {
  const sets = {};
  if (!parent) return sets;
  for (const name of SET_NAMES) {
    if (name === except) continue;
    const home = setHome(parent, name);
    if (home) sets[name] = { count: home.sets[name].count, from: home.id };
  }
  return sets;
}

async function createEntry({ kind, title, note, parent, set, levels, stats, config, range }) {
  const id = newId(kind === 'variation' ? `var-${set}` : slug(title) || 'v');
  const row = {
    id, kind, title, note: note || '', parent: parent || null,
    sets: { ...inheritSets(parent, set), [set]: { count: levels.length } },
    gen_set: set, gen_range: range || null, config: config || null, summary: summaryOf(stats), pinned: kind === 'version',
  };
  const saved = await D.saveEntry(row, [{ set, levelsText: toSetFile(levels), statsText: JSON.stringify(packStats(stats)) }]);
  const entry = { ...row, source: 'db', updated_at: saved.updated_at, created_at: saved.updated_at, author_name: db.user?.name };
  S.entries.push(entry);
  S.levels.set(`${id}/${set}@${saved.updated_at}`, levels);
  S.stats.set(`${id}/${set}@${saved.updated_at}`, stats);
  return entry;
}

/* Replace one set of an existing Supabase entry (it gets its own files if the set was inherited). */
async function replaceSet(entry, set, levels, stats) {
  const sets = { ...entry.sets, [set]: { count: levels.length } };
  const saved = await D.saveEntry({ id: entry.id, kind: entry.kind, title: entry.title, sets, summary: entry.gen_set === set ? summaryOf(stats) : entry.summary },
    [{ set, levelsText: toSetFile(levels), statsText: JSON.stringify(packStats(stats)) }]);
  Object.assign(entry, { sets, updated_at: saved.updated_at });
  S.levels.set(`${entry.id}/${set}@${saved.updated_at}`, levels);
  S.stats.set(`${entry.id}/${set}@${saved.updated_at}`, stats);
}

/* ------------------------------------------------------------- account -- */
function renderAccount() {
  const btn = $('#access');
  btn.classList.remove('ok');
  if (!db.configured) btn.textContent = '🔒 Лише перегляд';
  else if (!db.user) btn.textContent = 'Увійти';
  else {
    btn.textContent = `${db.isMember ? '✎' : '👁'} ${db.user.name}`;
    btn.classList.toggle('ok', db.isMember);
    if (db.isOwner && db.requests.length) btn.append(h('span', { class: 'count' }, db.requests.length));
  }
}
const dlg = () => $('#dlg');
function openDialog(...content) {
  const d = dlg();
  $('#dlgBody', d).replaceChildren(...content);
  if (!d.open) d.showModal();
}
function field(label, input) { return h('label', {}, label, input); }
const msgLine = () => h('p', { class: 'small msg' });
const setMsg = (el, text, ok) => { el.textContent = text; el.className = `small msg ${ok ? 'ok' : text ? 'error' : ''}`; };

function openAccount() {
  if (!db.configured) {
    return openDialog(h('h2', {}, 'Вхід ще не налаштовано'), h('p', { class: 'small' }, 'Власник має підключити Supabase (README → «Налаштування»). До того сайт працює лише на перегляд.'));
  }
  if (db.status === 'err') return openDialog(h('h2', {}, 'Немає зв\'язку'), h('p', { class: 'small error' }, db.error));
  if (!db.user) return openLogin();
  return openProfile();
}

function openLogin(tab = 'in') {
  const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const msg = msgLine();
  const login = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    setMsg(msg, 'Входжу…', true);
    const err = await D.signInPassword(email.value, pass.value);
    if (err) return setMsg(msg, err);
    dlg().close();
    toast(db.isMember ? `Вітаю, ${db.user.name}` : 'Ви увійшли, але ще не маєте права редагувати');
  } },
  field('Email', email), field('Пароль', pass), msg,
  h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Увійти'),
    h('button', { type: 'button', onclick: async () => { setMsg(msg, 'Надсилаю…', true); const err = await D.signInLink(email.value); setMsg(msg, err || 'Посилання для входу надіслано на пошту', !err); } }, 'Не пам\'ятаю пароль')));
  const rName = h('input', { type: 'text', maxlength: 40, placeholder: 'Як вас підписувати' });
  const rEmail = h('input', { type: 'email', placeholder: 'you@example.com' });
  const rNote = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Хто ви / навіщо доступ (необов\'язково)' });
  const rMsg = msgLine();
  const req = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const err = await D.requestAccess(rEmail.value, rName.value, rNote.value);
    setMsg(rMsg, err || 'Запит надіслано. Власник підтвердить його і перешле вам пароль.', !err);
  } },
  h('p', { class: 'small muted' }, 'Переглядати сайт можна без входу. Щоб генерувати й зберігати варіації, редагувати рівні й завантажувати файли, потрібен доступ — власник його підтвердить.'),
  field('Ім\'я', rName), field('Email', rEmail), field('Коментар', rNote), rMsg,
  h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Надіслати запит')));
  const tabs = h('div', { class: 'seg' },
    h('button', { type: 'button', class: tab === 'in' ? 'on' : '', onclick: () => openLogin('in') }, 'Вхід'),
    h('button', { type: 'button', class: tab === 'req' ? 'on' : '', onclick: () => openLogin('req') }, 'Запросити доступ'));
  openDialog(h('h2', {}, 'Level Lab'), tabs, tab === 'in' ? login : req);
}

function openProfile() {
  const name = h('input', { type: 'text', maxlength: 40, value: db.user.name });
  const nMsg = msgLine();
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'щонайменше 8 символів' });
  const pMsg = msgLine();
  const body = [
    h('h2', {}, db.user.name), h('p', { class: 'small muted' }, db.user.email, ' · ', db.isOwner ? 'власник' : db.isMember ? 'редактор' : 'лише перегляд (доступ не видано)'),
    h('div', { class: 'row' }, field('Ім\'я в історії', name), h('button', { onclick: async () => { const e = await D.setName(name.value); setMsg(nMsg, e || 'Збережено', !e); } }, 'Зберегти')), nMsg,
    h('div', { class: 'row' }, field('Новий пароль', pass), h('button', { onclick: async () => { const e = await D.setPassword(pass.value); setMsg(pMsg, e || 'Пароль змінено', !e); if (!e) pass.value = ''; } }, 'Змінити')), pMsg,
    h('div', { class: 'row' }, h('button', { onclick: async () => { await D.signOut(); dlg().close(); toast('Ви вийшли'); } }, 'Вийти')),
  ];
  if (db.isOwner) body.push(h('hr'), ownerPanel());
  openDialog(...body);
}

function grantText(email, password) {
  return `Доступ до Block Out Level Lab\n${SITE_URL}\nEmail: ${email}\nПароль: ${password}\n\nУвійдіть кнопкою «Увійти» вгорі праворуч. Пароль можна змінити в профілі.`;
}
function showGrant(email, password, host) {
  const text = grantText(email, password);
  const ta = h('textarea', { rows: 6, readonly: true }, text);
  host.replaceChildren(h('div', { class: 'grant' }, h('p', { class: 'small ok' }, `Доступ для ${email} видано. Перешліть цей текст:`), ta,
    h('button', { class: 'primary', onclick: async (e) => { try { await navigator.clipboard.writeText(text); e.target.textContent = 'Скопійовано ✓'; } catch { ta.select(); } } }, 'Копіювати')));
}

function ownerPanel() {
  const box = h('div', { class: 'owner' });
  const out = h('div', {});
  const reqs = h('div', {});
  const members = h('div', {});
  const settings = h('div', {});
  const renderReqs = () => {
    reqs.replaceChildren(h('h3', {}, `Запити на доступ${db.requests.length ? ` (${db.requests.length})` : ''}`),
      db.requests.length ? h('table', {}, h('tbody', {}, db.requests.map((r) => h('tr', {},
        h('td', {}, h('b', {}, r.name || '—'), h('div', { class: 'small muted' }, r.email), r.note ? h('div', { class: 'small' }, r.note) : null, h('div', { class: 'small muted' }, fmtDate(r.created_at))),
        h('td', { class: 'nowrap' },
          h('button', { class: 'primary', onclick: async () => { try { showGrant(r.email, await D.owner.grant(r.email, r.name), out); renderReqs(); loadMembers(); } catch (err) { toast(err.message, 'error'); } } }, 'Підтвердити'),
          ' ', h('button', { onclick: async () => { try { await D.owner.reject(r.id); renderReqs(); } catch (err) { toast(err.message, 'error'); } } }, 'Відхилити'))))))
        : h('p', { class: 'small muted' }, 'Нових запитів немає.'));
  };
  const loadMembers = async () => {
    try {
      const list = await D.owner.members();
      members.replaceChildren(h('h3', {}, `Редактори (${list.length})`), h('table', {}, h('tbody', {}, list.map((m) => h('tr', {},
        h('td', {}, h('b', {}, m.name), m.is_owner ? h('span', { class: 'badge' }, 'власник') : null, h('div', { class: 'small muted' }, m.email, m.last_sign_in ? ` · був ${fmtDate(m.last_sign_in)}` : m.joined ? '' : ' · ще не входив')),
        h('td', { class: 'nowrap' },
          h('button', { onclick: async () => { try { showGrant(m.email, await D.owner.grant(m.email, m.name), out); } catch (err) { toast(err.message, 'error'); } } }, 'Новий пароль'),
          m.is_owner ? null : [' ', h('button', { onclick: async () => { if (!confirm(`Прибрати ${m.email} з редакторів?`)) return; try { await D.owner.remove(m.email); loadMembers(); } catch (err) { toast(err.message, 'error'); } } }, 'Прибрати')]))))));
    } catch (err) { members.replaceChildren(h('p', { class: 'error small' }, err.message)); }
  };
  const addEmail = h('input', { type: 'email', placeholder: 'email' });
  const addName = h('input', { type: 'text', placeholder: 'ім\'я', maxlength: 40 });
  const add = h('div', {}, h('h3', {}, 'Додати вручну'), h('div', { class: 'row' }, addEmail, addName,
    h('button', { class: 'primary', onclick: async () => { try { showGrant(addEmail.value.trim().toLowerCase(), await D.owner.grant(addEmail.value, addName.value), out); addEmail.value = ''; addName.value = ''; loadMembers(); } catch (err) { toast(err.message, 'error'); } } }, 'Видати доступ')));
  (async () => {
    const days = h('input', { type: 'number', min: 1, max: 365, value: await D.owner.keepDays() });
    const count = variations().filter((e) => !e.pinned && e.source === 'db').length;
    settings.replaceChildren(h('h3', {}, 'Кеш варіацій'),
      h('p', { class: 'small muted' }, 'Кожна генерація зберігається як варіація. Незакріплені (без ★) видаляються автоматично через вказану кількість днів.'),
      h('div', { class: 'row' }, h('label', {}, 'Зберігати ', days, ' днів'), h('button', { onclick: async () => { try { await D.owner.setKeepDays(+days.value); toast('Збережено'); } catch (err) { toast(err.message, 'error'); } } }, 'Зберегти')),
      h('div', { class: 'row' }, h('button', { class: 'danger', onclick: (e) => clearCache(e.target) }, `Очистити кеш БД (${count} незакріплених варіацій)`)));
  })();
  renderReqs();
  loadMembers();
  box.append(out, reqs, members, add, settings);
  return box;
}

async function clearCache(btn) {
  const n = variations().filter((e) => !e.pinned && e.source === 'db').length;
  if (!confirm(`Видалити всі незакріплені варіації (${n}) разом із файлами? Версії й закріплені (★) лишаться. Це не скасувати.`)) return;
  busy(btn, true, 'Видаляю…');
  try {
    const k = await D.clearVariations();
    S.stats.clear(); S.levels.clear();
    await loadEntries();
    toast(`Видалено варіацій: ${k}`);
    busy(btn, false, 'Очистити кеш БД (0 незакріплених варіацій)');
    rerender();
  } catch (err) { toast(err.message, 'error'); busy(btn, false, 'Очистити кеш БД'); }
}

/* -------------------------------------------------------------- curves -- */
let curveChart;
async function renderCurves() {
  const root = $('#tab-curves');
  const st = (root.state ||= { metric: 'C', smooth: 25, from: '', to: '', ref: true });
  root.replaceChildren();
  const vs = entriesWith(S.set);
  const chip = (v) => h('label', { class: 'chip', style: `--c:${colourOf(v.id)}`, title: v.note || '' },
    h('input', { type: 'checkbox', checked: S.shown.has(v.id), onchange: (e) => { e.target.checked ? S.shown.add(v.id) : S.shown.delete(v.id); draw(); } }), ' ', labelOf(v));
  const vers = vs.filter((v) => v.kind === 'version');
  const vars = vs.filter((v) => v.kind === 'variation');
  const varsShown = vars.filter((v, i) => i < 12 || v.pinned || S.shown.has(v.id));
  const controls = h('div', { class: 'controls' },
    h('label', {}, 'Набір ', h('select', { onchange: (e) => { S.set = e.target.value; renderCurves(); } }, SET_NAMES.map((s) => opt(s, SET_LABEL[s], s === S.set)))),
    h('label', {}, 'Метрика ', h('select', { onchange: (e) => { st.metric = e.target.value; renderCurves(); } }, Object.entries(METRICS).map(([k, v]) => opt(k, v, k === st.metric)))),
    h('label', {}, 'Згладжування ', h('select', { onchange: (e) => { st.smooth = +e.target.value; renderCurves(); } },
      [[0, 'немає'], [5, '±5'], [12, '±12'], [25, '±25'], [50, '±50']].map(([k, v]) => opt(k, v, k === st.smooth)))),
    h('label', {}, 'Рівні ', h('input', { type: 'number', min: 1, placeholder: 'від', value: st.from, onchange: (e) => { st.from = e.target.value; draw(); } }),
      '–', h('input', { type: 'number', min: 1, placeholder: 'до', value: st.to, onchange: (e) => { st.to = e.target.value; draw(); } })),
    h('label', {}, h('input', { type: 'checkbox', checked: st.ref, onchange: (e) => { st.ref = e.target.checked; draw(); } }), ' Reference (Tap Block Out)'),
  );
  const picks = h('div', {},
    h('div', { class: 'chips' }, h('span', { class: 'muted small' }, 'Версії:'), vers.length ? vers.map(chip) : h('span', { class: 'muted small' }, 'немає')),
    vars.length ? h('div', { class: 'chips' }, h('span', { class: 'muted small' }, 'Варіації:'), varsShown.map(chip), vars.length > varsShown.length ? h('span', { class: 'muted small' }, `ще ${vars.length - varsShown.length} — у «Генераторі»`) : null) : null);
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
    const cols = [];
    for (const v of vs) {
      if (!S.shown.has(v.id)) continue;
      let stats;
      try { stats = await getStats(v.id, S.set); } catch (err) { toast(`${v.title}: ${err.message}`, 'error'); continue; }
      if (!stats) continue;
      const raw = stats.map((s) => metricOf(s, m));
      const smooth = st.smooth ? rolling(raw, st.smooth).med : raw;
      series.push({ name: labelOf(v), color: colourOf(v.id), values: smooth, dots: st.smooth ? raw : null, width: 2 });
      cols.push({ name: labelOf(v), color: colourOf(v.id), stats });
    }
    const bandsList = [];
    const ref = S.ref?.sets?.[S.set];
    const refRoll = ref?.rolling?.[m];
    if (st.ref && refRoll) {
      bandsList.push({ name: 'Reference p10–p90', color: 'rgba(128,128,140,0.18)', lo: refRoll.p10, hi: refRoll.p90 });
      series.unshift({ name: 'Reference медіана', color: css('--ref'), values: refRoll.med, dash: [6, 4], width: 2 });
    }
    curveChart.set({ series, bands: bandsList, from: +st.from || null, to: +st.to || null });
    const q = (arr, p) => { const t = arr.filter(Number.isFinite).sort((a, b) => a - b); return t.length ? t[Math.min(t.length - 1, Math.floor(p * t.length))] : NaN; };
    const f = (x) => (Number.isFinite(x) ? +x.toFixed(x < 10 ? 2 : 1) : '–');
    const head = h('tr', {}, h('th', {}, 'Рівні'), st.ref && refRoll ? h('th', {}, 'Reference') : null, cols.map((c) => h('th', { style: `color:${c.color}` }, c.name)));
    const rows = DEFAULT_BANDS[S.set].map(([a, b]) => h('tr', {}, h('td', {}, `${a}–${b}`),
      st.ref && refRoll ? h('td', {}, f(q(refRoll.med.slice(a - 1, b), 0.5))) : null,
      cols.map((c) => {
        const part = c.stats.slice(a - 1, b);
        const vals = part.map((s) => metricOf(s, m));
        return h('td', {}, part.length ? h('span', {}, `${f(q(vals, 0.5))}`, h('span', { class: 'muted' }, ` p90 ${f(q(vals, 0.9))} · H/SH ${Math.round(100 * part.filter((s) => s?.tier === 1).length / part.length)}/${Math.round(100 * part.filter((s) => s?.tier === 2).length / part.length)}%`)) : '–');
      })));
    table.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, rows)),
      h('p', { class: 'muted small' }, `Медіана метрики «${METRICS[m]}» у діапазоні; для версій ще p90 і частка HARD / SUPER HARD.`));
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
  const vs = entriesWith(view.set);
  if (!vs.some((v) => v.id === view.vid)) view.vid = vs.find((v) => v.kind === 'version')?.id || vs[0]?.id || null;
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
  const cur = entryById(view.vid);
  const go = (p) => { view.pos = p; renderLevels(); };
  const controls = h('div', { class: 'controls' },
    h('label', {}, 'Версія ', h('select', { onchange: (e) => { view.vid = e.target.value; renderLevels(); } },
      h('optgroup', { label: 'Версії' }, vs.filter((v) => v.kind === 'version').map((v) => opt(v.id, v.title, v.id === view.vid))),
      h('optgroup', { label: 'Варіації' }, vs.filter((v) => v.kind === 'variation').map((v) => opt(v.id, labelOf(v), v.id === view.vid))))),
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
  root.append(h('section', { class: 'card' }, controls, h('div', { class: 'levelGrid' }, h('div', {}, h('div', { class: 'boardWrap' }, canvas), status), info)));

  boardView = new BoardView(canvas, { onChange: (why) => refresh(why) });
  boardView.mode = view.mode;
  boardView.showFree = view.showFree;
  boardView.load(L);

  function refresh(why) {
    const lv = boardView.level;
    if (view.mode === 'play') {
      status.textContent = boardView.won ? `Пройдено! Лишилось ходів: ${boardView.movesLeft}` : boardView.movesLeft <= 0 ? 'Ходи скінчились' : `Ходів: ${boardView.movesLeft} · блоків: ${boardView.board.left()}`;
      status.className = 'status ' + (boardView.won ? 'win' : boardView.movesLeft <= 0 ? 'lose' : '');
    } else {
      status.textContent = 'Клік — повернути напрямок · Shift+клік — зовнішній шар · правий клік / Alt+клік — видалити блок';
      status.className = 'status';
    }
    if (why === 'edit' || why === 'reset') {
      json.value = JSON.stringify(lv);
      const e = validate(lv);
      errs.replaceChildren(...(e.length ? e.map((x) => h('div', { class: 'error' }, '⚠ ' + x)) : [h('div', { class: 'ok' }, '✓ Рівень коректний і розв\'язний')]));
      if (why === 'edit') renderInfo(measure(lv, view.pos - 1), true);
    }
  }

  function renderInfo(m, edited) {
    const row = (k, v) => h('tr', {}, h('th', {}, k), h('td', {}, v));
    const tierSel = h('select', { disabled: view.mode !== 'edit', onchange: (e) => { boardView.level.tier = e.target.value; refresh('edit'); } }, TIERS.map((t) => opt(t, { easy: 'Normal', tricky: 'Hard', expert: 'Super Hard' }[t], t === boardView.level.tier)));
    const movesIn = h('input', { type: 'number', min: 1, value: boardView.level.moves, disabled: view.mode !== 'edit', onchange: (e) => { boardView.level.moves = +e.target.value; boardView.reset(); refresh('edit'); } });
    const saveButtons = !canEdit()
      ? h('p', { class: 'small muted' }, 'Щоб зберегти зміни, увійдіть з доступом редактора.')
      : view.vid === DRAFT
        ? h('button', { class: 'primary', onclick: (e) => saveLevel(e.target, 'draft') }, 'Застосувати до чернетки')
        : [isMine(cur) ? h('button', { class: 'primary', onclick: (e) => saveLevel(e.target, 'here') }, cur.kind === 'variation' ? 'Зберегти у варіацію' : 'Зберегти у версію') : null,
          ' ', h('button', { onclick: (e) => saveLevel(e.target, 'new') }, 'Зберегти як нову версію')];
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
          h('div', { class: 'row' }, h('button', { onclick: () => { boardView.load(L); renderInfo(s || measure(L, view.pos - 1)); refresh('reset'); } }, 'Скасувати зміни'), saveButtons)),
      h('h4', {}, 'Складність навколо'),
      h('div', { class: 'miniChart' }),
    );
    if (stats) {
      levelChart = new Chart($('.miniChart', info), { height: 140, onPick: (x) => go(x) });
      const raw = stats.map((x) => x?.C);
      const ref = S.ref?.sets?.[view.set]?.rolling?.C;
      levelChart.set({
        series: [...(ref ? [{ name: 'Reference', color: css('--ref'), values: ref.med, dash: [4, 3], width: 1 }] : []), { name: 'C', color: colourOf(view.vid), values: rolling(raw, 5).med, dots: raw }],
        bands: [], from: Math.max(1, view.pos - 40), to: Math.min(stats.length, view.pos + 40), mark: view.pos,
      });
    }
  }

  async function saveLevel(btn, where) {
    const lv = boardView.level;
    const e = validate(lv);
    if (e.length) { toast('Рівень некоректний: ' + e[0], 'error'); return; }
    const next = levels.slice();
    next[view.pos - 1] = lv;
    const nextStats = (stats || []).slice();
    nextStats[view.pos - 1] = measure(lv, view.pos - 1);
    if (where === 'draft') { S.draft.levels = next; S.draft.stats = nextStats; toast('Застосовано до чернетки'); renderLevels(); return; }
    let title = null;
    if (where === 'new') { title = prompt('Назва нової версії', `${cur.title} · правка рівня ${view.pos}`); if (!title) return; }
    busy(btn, true, 'Зберігаю…');
    try {
      if (where === 'here') await replaceSet(cur, view.set, next, nextStats);
      else view.vid = (await createEntry({ kind: 'version', title, note: `Правка рівня ${view.pos} (${view.set})`, parent: view.vid, set: view.set, levels: next, stats: nextStats })).id;
      toast('Збережено ✓');
      renderLevels();
    } catch (err) { toast(err.message, 'error'); busy(btn, false, 'Зберегти'); }
  }
  renderInfo(s || measure(L, view.pos - 1));
  refresh('reset');
}

/* ----------------------------------------------------------- generator -- */
const gen = { base: null, set: 'normal', config: structuredClone(DEFAULT_CONFIG), from: 1, to: 100, key: 'blocks' };
async function renderGenerator() {
  const root = $('#tab-gen');
  root.replaceChildren();
  const section = gen.config[gen.set];
  const tables = Object.entries(section).filter(([, v]) => Array.isArray(v) && Array.isArray(v[0]) && typeof v[0][1] === 'number').map(([k]) => k);
  if (!tables.includes(gen.key)) gen.key = tables[0] || null;
  const area = h('textarea', { rows: 22, spellcheck: false, class: 'code' }, JSON.stringify(section, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2]'));
  const common = h('textarea', { rows: 4, spellcheck: false, class: 'code' }, JSON.stringify({ seed: gen.config.seed, weights: gen.config.weights }));
  const msg = h('div', { class: 'small' });
  const apply = () => {
    try {
      gen.config = { ...gen.config, ...JSON.parse(common.value), [gen.set]: JSON.parse(area.value) };
      area.classList.remove('invalid'); common.classList.remove('invalid');
      msg.textContent = '';
      return true;
    } catch (err) { msg.textContent = 'JSON: ' + err.message; msg.className = 'small error'; area.classList.add('invalid'); return false; }
  };
  area.addEventListener('input', () => { if (apply()) drawTable(); });
  common.addEventListener('input', apply);
  const bar = h('progress', { max: 1, value: 0, hidden: true });
  const result = h('div', {});
  const varsHost = h('div', {});
  const tableHost = h('div', { class: 'chartHost' });
  const baseList = S.entries.filter((e) => e.kind === 'version' || e.gen_set === gen.set).slice().reverse();

  root.append(
    h('section', { class: 'card' },
      h('h2', {}, 'Генератор рівнів'),
      h('p', { class: 'muted small' }, 'Порт tools/gen-levels.mjs з гри: однаковий конфіг дає ті самі рівні, що й у грі. Криві — таблиці точок [рівень, значення], між точками лінійно. Генерація йде у фонових потоках браузера. ',
        canEdit() ? 'Кожен запуск зберігається як варіація.' : h('b', {}, 'Увійдіть, щоб кожен запуск зберігався як варіація.')),
      h('div', { class: 'controls' },
        h('label', {}, 'Конфіг і база ', h('select', { onchange: async (e) => { await loadConfig(e.target.value); renderGenerator(); } },
          opt('', 'стандартний (як у грі)', !gen.base),
          h('optgroup', { label: 'Версії' }, baseList.filter((v) => v.kind === 'version').map((v) => opt(v.id, v.title, v.id === gen.base))),
          h('optgroup', { label: 'Варіації' }, baseList.filter((v) => v.kind === 'variation').map((v) => opt(v.id, labelOf(v), v.id === gen.base))))),
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
    varsHost,
  );
  const tChart = new Chart(tableHost, { height: 200 });
  function drawTable() {
    const pts = gen.config[gen.set][gen.key];
    if (!Array.isArray(pts)) return;
    const n = gen.config[gen.set].count || 5000;
    const vals = Array.from({ length: n }, (_, i) => lerp(pts, i + 1));
    const to = Math.min(n, Math.max(20, Math.round(pts[pts.length - 1][0] * 1.25)));
    tChart.set({ series: [{ name: gen.key, color: '#3b6fe0', values: vals, width: 2 }], bands: [], to });
  }
  drawTable();
  if (S.draft && S.draft.set === gen.set) renderDraft(result);
  renderVariations(varsHost);

  async function run(from, to) {
    if (!apply()) return;
    from = Math.max(1, from); to = Math.min(gen.config[gen.set].count, to);
    if (to < from) return;
    bar.hidden = false; bar.value = 0;
    const t0 = performance.now();
    try {
      const out = await pool.generate(structuredClone(gen.config), gen.set, from, to, (p) => { bar.value = p; });
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      // the draft is the base's set with the generated range replaced (or just the range when there is no base)
      const baseId = gen.base && setHome(gen.base, gen.set) ? gen.base : versions().slice().reverse().find((v) => setHome(v.id, gen.set))?.id;
      const full = from === 1 && to === gen.config[gen.set].count;
      let levels = out.levels;
      let stats = out.stats;
      if (!full && baseId) {
        levels = (await getLevels(baseId, gen.set)).slice();
        stats = (await getStats(baseId, gen.set)).slice();
        out.levels.forEach((L, k) => { levels[from - 1 + k] = L; stats[from - 1 + k] = out.stats[k]; });
      }
      S.draft = { set: gen.set, config: structuredClone(gen.config), levels, stats, base: baseId, from, to, full, secs, savedId: null };
      bar.hidden = true;
      toast(`Згенеровано ${out.levels.length} рівнів за ${secs} с`);
      if (canEdit()) {
        try {
          const e = await createEntry({
            kind: 'variation', title: `${SET_LABEL[gen.set]} ${full ? 'весь набір' : `${from}–${to}`} · ${new Date().toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })}`,
            parent: baseId, set: gen.set, levels, stats, config: S.draft.config, range: { from, to, full },
          });
          S.draft.savedId = e.id;
          S.shown.add(e.id);
          toast('Варіацію збережено ✓');
        } catch (err) { toast(`Варіацію не збережено: ${err.message}`, 'error'); S.shown.add(DRAFT); }
      } else S.shown.add(DRAFT);
      renderDraft(result);
      renderVariations(varsHost);
    } catch (err) { bar.hidden = true; if (!/terminated/.test(err.message)) toast(err.message, 'error'); }
  }
}

async function loadConfig(id) {
  gen.base = id || null;
  if (!id) { gen.config = structuredClone(DEFAULT_CONFIG); return; }
  const e = entryById(id);
  let cfg = null;
  try { cfg = e?.source === 'db' ? await D.getConfig(id) : await store.readJson(`versions/${id}/config.json`); } catch { cfg = null; }
  gen.config = { ...structuredClone(DEFAULT_CONFIG), ...(cfg || {}) };
  if (!cfg) toast('У цього запису немає збереженого конфігу — взято стандартний.');
}

function renderDraft(host) {
  const d = S.draft;
  const saved = d.savedId && entryById(d.savedId);
  const vid = saved ? saved.id : DRAFT;
  const chartHost = h('div', { class: 'chartHost' });
  const title = h('input', { type: 'text', placeholder: 'Назва версії, напр. «Normal: більше піків»', size: 40 });
  const note = h('textarea', { rows: 2, placeholder: 'Що змінено і навіщо' });
  const tb = h('div', { class: 'tableWrap' });
  host.replaceChildren(h('section', { class: 'card' },
    h('h2', {}, saved ? `Остання генерація: ${saved.title}` : `Чернетка: ${SET_LABEL[d.set]}`),
    h('p', { class: 'muted small' }, d.full ? `Увесь набір, ${d.levels.length} рівнів.` : `Рівні ${d.from}–${d.to} перегенеровано, решта взята з «${entryById(d.base)?.title || '—'}».`,
      saved ? ' Збережено як варіацію.' : canEdit() ? '' : ' Не збережено: потрібен вхід.'),
    chartHost,
    tb,
    h('div', { class: 'controls' },
      h('button', { onclick: () => openLevel(vid, d.set, d.from) }, 'Переглянути рівні'),
      h('button', { onclick: () => { S.set = d.set; showTab('curves'); } }, 'Порівняти на «Кривих»'),
      h('button', { onclick: () => download(`${d.set}.json`, new Blob([toSetFile(d.levels)], { type: 'application/json' })) }, 'Завантажити JSON')),
    canEdit() ? h('div', { class: 'saveRow' }, title, note,
      h('button', { class: 'primary', onclick: async (e) => {
        if (!title.value.trim()) { title.focus(); toast('Вкажіть назву версії'); return; }
        busy(e.target, true, 'Зберігаю…');
        try {
          if (saved) {
            await D.updateEntry(saved.id, { kind: 'version', title: title.value.trim(), note: note.value.trim(), pinned: true });
            Object.assign(saved, { kind: 'version', title: title.value.trim(), note: note.value.trim(), pinned: true });
          } else {
            await createEntry({ kind: 'version', title: title.value.trim(), note: note.value.trim(), parent: d.base, set: d.set, levels: d.levels, stats: d.stats, config: d.config, range: { from: d.from, to: d.to, full: d.full } });
          }
          S.draft = null; S.shown.delete(DRAFT);
          toast('Версію збережено ✓');
          renderGenerator();
        } catch (err) { toast(err.message, 'error'); busy(e.target, false, 'Зробити версією'); }
      } }, 'Зробити версією')) : null,
  ));
  const ch = new Chart(chartHost, { height: 260, onPick: (x) => openLevel(vid, d.set, x) });
  (async () => {
    const series = [];
    const bandsList = [];
    const ref = S.ref?.sets?.[d.set]?.rolling?.C;
    if (ref) { bandsList.push({ name: 'Reference p10–p90', color: 'rgba(128,128,140,0.18)', lo: ref.p10, hi: ref.p90 }); series.push({ name: 'Reference медіана', color: css('--ref'), values: ref.med, dash: [6, 4], width: 2 }); }
    if (d.base) { const bs = await getStats(d.base, d.set).catch(() => null); if (bs) series.push({ name: entryById(d.base).title, color: colourOf(d.base), values: rolling(bs.map((s) => s?.C), 25).med, width: 1.5 }); }
    const raw = d.stats.map((s) => s?.C);
    series.push({ name: 'Нова генерація', color: colourOf(vid), values: rolling(raw, 25).med, dots: raw, width: 2.2 });
    ch.set({ series, bands: bandsList, from: d.full ? null : Math.max(1, d.from - 50), to: d.full ? null : d.to + 50 });
    const rows = bands(d.stats.map((s) => s || {}), DEFAULT_BANDS[d.set]);
    const refB = S.ref?.sets?.[d.set]?.bands || [];
    tb.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Рівні', 'Поле', 'Блоків', 'Запас', 'C', 'C p90', 'HARD', 'SUPER', 'Ref C', 'Ref p90'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((b, i) => h('tr', {}, [b.band, b.board, `${b.blocks} (${b.blocksP10}–${b.blocksP90})`, b.spare, b.C, b.Cp90, `${b.tricky}%`, `${b.expert}%`, refB[i]?.C ?? '–', refB[i]?.Cp90 ?? '–'].map((x) => h('td', {}, x)))))));
  })();
}

/* Variations of the generator's set: every run, newest first. */
function renderVariations(host) {
  const list = variations(gen.set).slice().reverse();
  if (!db.configured) { host.replaceChildren(); return; }
  const rows = list.map((v) => {
    const r = v.gen_range || {};
    const sm = v.summary || {};
    const mine = canEdit();
    return h('tr', {},
      h('td', {}, h('button', { class: 'icon', title: v.pinned ? 'Відкріпити (тоді з часом видалиться)' : 'Закріпити (не видалятиметься)', disabled: !mine,
        onclick: async () => { try { await D.updateEntry(v.id, { pinned: !v.pinned }); v.pinned = !v.pinned; renderVariations(host); } catch (err) { toast(err.message, 'error'); } } }, v.pinned ? '★' : '☆')),
      h('td', {}, h('span', { class: 'swatch', style: `background:${colourOf(v.id)}` }), ' ',
        mine ? h('input', { class: 'inline', value: v.title, onchange: async (e) => { try { await D.updateEntry(v.id, { title: e.target.value }); v.title = e.target.value; } catch (err) { toast(err.message, 'error'); } } }) : v.title,
        h('div', { class: 'small muted' }, `${v.author_name || '—'} · ${fmtDate(v.created_at)}`)),
      h('td', { class: 'small' }, r.full ? 'весь набір' : `${r.from}–${r.to}`, h('div', { class: 'muted' }, `база: ${entryById(v.parent)?.title || '—'}`)),
      h('td', { class: 'small' }, `C ${sm.C ?? '–'} · блоків ${sm.blocks ?? '–'} · запас ${sm.spare ?? '–'}`),
      h('td', { class: 'small nowrap' },
        h('label', {}, h('input', { type: 'checkbox', checked: S.shown.has(v.id), onchange: (e) => { e.target.checked ? S.shown.add(v.id) : S.shown.delete(v.id); } }), ' на графік'), ' · ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLevel(v.id, v.gen_set, r.from || 1); } }, 'рівні'), ' · ',
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await loadConfig(v.id); renderGenerator(); } }, 'взяти конфіг'),
        mine ? [' · ', h('a', { href: '#', onclick: async (e) => {
          e.preventDefault();
          const t = prompt('Назва версії', v.title);
          if (!t) return;
          try { await D.updateEntry(v.id, { kind: 'version', title: t, pinned: true }); Object.assign(v, { kind: 'version', title: t, pinned: true }); toast('Тепер це версія'); renderVariations(host); } catch (err) { toast(err.message, 'error'); }
        } }, 'зробити версією'), ' · ', h('a', { href: '#', class: 'danger', onclick: async (e) => {
          e.preventDefault();
          if (!confirm(`Видалити варіацію «${v.title}»?`)) return;
          try { const n = await D.deleteEntries([v], S.entries); if (!n) return toast('Ця варіація — база для іншого запису, її не видалено', 'error'); S.entries = S.entries.filter((x) => x.id !== v.id); renderVariations(host); } catch (err) { toast(err.message, 'error'); }
        } }, 'видалити')] : null));
  });
  host.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', {}, `Варіації: ${SET_LABEL[gen.set]} (${list.length})`),
      db.isOwner ? h('button', { class: 'danger', onclick: (e) => clearCache(e.target) }, 'Очистити кеш БД') : null),
    h('p', { class: 'small muted' }, 'Кожен запуск генератора зберігається тут. ★ — закріплені, їх не видаляє автоочищення; решта видаляється через кілька днів (налаштовує власник у профілі).'),
    list.length ? h('div', { class: 'tableWrap' }, h('table', {}, h('tbody', {}, rows))) : h('p', { class: 'muted' }, 'Ще немає варіацій.')));
}

/* ------------------------------------------------------------ versions -- */
async function renderVersions() {
  const root = $('#tab-versions');
  root.replaceChildren();
  const list = versions().slice().reverse();
  const rows = list.map((v) => h('tr', {},
    h('td', {}, h('b', {}, v.title), h('div', { class: 'muted small' }, v.source === 'static' ? `${v.id} · у репозиторії (лише читання)` : v.id), v.note ? h('div', { class: 'small' }, v.note) : null),
    h('td', { class: 'small' }, v.author_name || '—', h('div', { class: 'muted' }, fmtDate(v.created_at)), v.updated_by_name && v.updated_at !== v.created_at ? h('div', { class: 'muted' }, `змінив ${v.updated_by_name}, ${fmtDate(v.updated_at)}`) : null,
      v.parent ? h('div', { class: 'muted' }, `від: ${entryById(v.parent)?.title || v.parent}`) : null),
    h('td', { class: 'small' }, SET_NAMES.filter((s) => v.sets?.[s]).map((s) => h('div', {}, `${SET_LABEL[s]}: ${v.sets[s].count}`, v.sets[s].from ? h('span', { class: 'muted' }, ' (успадковано)') : null,
      ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); downloadSet(v.id, s, 'one'); } }, 'json'),
      ' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); downloadSet(v.id, s, 'chunks'); } }, 'zip для гри')))),
    h('td', { class: 'small' },
      h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); S.shown.add(v.id); showTab('curves'); } }, 'на графік')),
      v.source === 'static' ? h('div', {}, h('a', { href: store.historyUrl(`versions/${v.id}`), target: '_blank', rel: 'noopener' }, 'історія ↗')) : null,
      isMine(v) && canEdit() ? h('div', {}, h('a', { href: '#', class: 'danger', onclick: async (e) => {
        e.preventDefault();
        if (!confirm(`Видалити версію «${v.title}» з файлами? Це не скасувати.`)) return;
        try { const n = await D.deleteEntries([v], S.entries); if (!n) return toast('Інші записи успадковують її набори — не видалено', 'error'); S.entries = S.entries.filter((x) => x.id !== v.id); renderVersions(); } catch (err) { toast(err.message, 'error'); }
      } }, 'видалити')) : null),
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
      canEdit() ? [drop, files, up] : h('p', { class: 'small muted' }, 'Щоб завантажувати файли, увійдіть з доступом редактора.')),
    h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Версії'),
      h('span', {}, db.isOwner ? h('button', { class: 'danger', onclick: (e) => clearCache(e.target) }, 'Очистити кеш БД') : null, ' ', h('button', { onclick: async () => { await loadEntries(); renderVersions(); } }, '⟳ Оновити'))),
      list.length ? h('div', { class: 'tableWrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Версія', 'Автор', 'Набори', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows)))
        : h('p', { class: 'muted' }, 'Ще немає версій.')),
  );
}

async function downloadSet(vid, set, how) {
  try {
    const levels = await getLevels(vid, set);
    if (how === 'one') return download(`${vid}-${set}.json`, new Blob([toSetFile(levels)], { type: 'application/json' }));
    const zip = new window.JSZip();
    for (let c = 0; c * 50 < levels.length; c++) zip.file(`${set}/${set}_${String(c).padStart(3, '0')}.json`, toSetFile(levels.slice(c * 50, c * 50 + 50)));
    zip.file('index-entry.json', JSON.stringify({ [set]: { count: levels.length, ids: [levels[0].id, levels[levels.length - 1].id] } }, null, 2));
    download(`${vid}-${set}-chunks.zip`, await zip.generateAsync({ type: 'blob' }));
  } catch (err) { toast(err.message, 'error'); }
}

async function prepareUpload(fileList, host) {
  if (!fileList.length) return;
  host.replaceChildren(h('p', { class: 'muted' }, 'Читаю файли…'));
  const levels = [];
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
  const ids = new Map();
  for (const L of levels) ids.set(L.id, (ids.get(L.id) || 0) + 1);
  const dups = [...ids].filter(([, c]) => c > 1).map(([id]) => id);
  if (dups.length) errors.unshift({ id: dups.slice(0, 10).join(', '), errs: [`повторюються id (${dups.length}) — рівні з однаковим id з різних файлів`] });
  const setSel = h('select', {}, SET_NAMES.map((s) => opt(s, SET_LABEL[s], s === guess)));
  const target = h('select', {}, opt('new', 'нова версія'), versions().filter(isMine).slice().reverse().map((v) => opt(v.id, `замінити набір у «${v.title}»`)));
  const parent = h('select', {}, opt('', '— без успадкування —'), versions().slice().reverse().map((v, i) => opt(v.id, v.title, i === 0)));
  const title = h('input', { type: 'text', placeholder: 'Назва версії', size: 36 });
  const note = h('textarea', { rows: 2, placeholder: 'Опис (звідки рівні, що змінилось)' });
  const blocking = errors.filter((e) => e.errs.some((x) => !x.startsWith('ходів')));
  host.replaceChildren(...[
    h('p', {}, `Рівнів: ${levels.length} · id ${levels[0].id}–${levels[levels.length - 1].id}`),
    bad.length ? h('div', { class: 'error small' }, bad.map((b) => h('div', {}, b))) : null,
    errors.length ? h('details', { open: blocking.length > 0 }, h('summary', { class: blocking.length ? 'error' : 'warn' }, `Проблеми у ${errors.length} рівнях${blocking.length ? ` (${blocking.length} — нерозв'язні або зламані)` : ''}`),
      h('div', { class: 'small' }, errors.slice(0, 50).map((e) => h('div', {}, `id ${e.id}: ${e.errs.join('; ')}`)))) : h('p', { class: 'ok small' }, '✓ Усі рівні коректні й розв\'язні'),
    h('div', { class: 'controls' }, h('label', {}, 'Набір ', setSel), h('label', {}, 'Куди ', target), h('label', {}, 'Інші набори взяти з ', parent)),
    h('div', { class: 'saveRow' }, title, note, h('button', { class: 'primary', disabled: blocking.length > 0, onclick: async (e) => {
      const fixed = stats.map((s, i) => s || measure(levels[i], i));
      busy(e.target, true, 'Зберігаю…');
      try {
        if (target.value === 'new') {
          if (!title.value.trim()) { title.focus(); busy(e.target, false, 'Зберегти'); return toast('Вкажіть назву'); }
          await createEntry({ kind: 'version', title: title.value.trim(), note: note.value.trim(), parent: parent.value || null, set: setSel.value, levels, stats: fixed });
        } else {
          await replaceSet(entryById(target.value), setSel.value, levels, fixed);
        }
        toast('Збережено ✓');
        renderVersions();
      } catch (err) { toast(err.message, 'error'); busy(e.target, false, 'Зберегти'); }
    } }, 'Зберегти')),
  ].filter(Boolean));
}

/* ---------------------------------------------------------------- tabs -- */
const TABS = { curves: renderCurves, levels: renderLevels, gen: renderGenerator, versions: renderVersions };
let current = 'curves';
function showTab(name) {
  current = name;
  for (const b of document.querySelectorAll('nav.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of Object.keys(TABS)) $(`#tab-${t}`).hidden = t !== name;
  try { history.replaceState(null, '', `#${name}`); } catch { /* sandboxed */ }
  TABS[name]();
}
/* Re-render lists after someone else changed data, but not the level board (it would lose a game or an edit). */
const rerender = () => { if (current !== 'levels') TABS[current](); };

async function boot() {
  for (const b of document.querySelectorAll('nav.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('#access').addEventListener('click', openAccount);
  $('#dlgClose').addEventListener('click', () => dlg().close());
  renderAccount();
  window.addEventListener('resize', () => { if (boardView && !$('#tab-levels').hidden) boardView.draw(); });
  let entriesTimer = 0;
  D.onChange(async (what) => {
    renderAccount();
    if (what === 'requests' && dlg().open && db.isOwner && $('#dlgBody .owner')) openProfile();
    if (what === 'requests' && db.isOwner && db.requests.length) toast(`Нових запитів на доступ: ${db.requests.length}`);
    if (what === 'entries') { clearTimeout(entriesTimer); entriesTimer = setTimeout(async () => { await loadEntries(); rerender(); }, 400); }
    if (what === 'user') rerender();
  });
  try { S.ref = await store.readJson('data/reference.json'); } catch { S.ref = null; }
  await D.start();
  await loadEntries();
  const start = location.hash.slice(1);
  showTab(TABS[start] ? start : 'curves');
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS[t] && $(`#tab-${t}`).hidden) showTab(t); });
}
boot();
