/* Supabase: sign-in (email + password, access granted by the owner), versions / variations (table lab_entries)
   and level files (bucket `levels`, gzip). Schema: supabase/schema.sql. */
import { SUPABASE } from './config.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
const LIB_SRI = 'sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const BUCKET = 'levels';

export const db = {
  configured: !!(SUPABASE.url && SUPABASE.anonKey),
  client: null,
  user: null, // {id, email, name}
  isMember: false,
  isOwner: false,
  requests: [],
  status: 'off', // off | ok | err
  error: '',
};
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = (what) => listeners.forEach((fn) => { try { fn(what); } catch (e) { console.error(e); } });

const isNetwork = (m) => /failed to fetch|networkerror|load failed|network request/i.test(m || '');
function authError(error) {
  const m = error?.message || String(error || '');
  if (/invalid login credentials/i.test(m)) return 'Невірний email або пароль';
  if (/email not confirmed/i.test(m)) return 'Акаунт ще не підтверджено — попросіть власника видати доступ ще раз';
  if (/rate limit|too many/i.test(m)) return 'Забагато спроб — зачекайте кілька хвилин';
  if (/signups not allowed|user not found/i.test(m)) return 'Такого акаунта немає — залиште запит на доступ';
  if (/row-level security|permission denied|not authorized|unauthorized/i.test(m)) return 'Немає прав: потрібен доступ редактора';
  if (isNetwork(m)) return 'Немає зв\'язку з Supabase — перевірте інтернет';
  return m;
}
const fail = (error) => { throw new Error(authError(error)); };

function loadLibrary() {
  return new Promise((resolve, reject) => {
    if (window.supabase?.createClient) return resolve();
    const s = document.createElement('script');
    s.src = LIB; s.integrity = LIB_SRI; s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не вдалося завантажити бібліотеку Supabase'));
    document.head.append(s);
  });
}

/* ------------------------------------------------------------------ auth -- */
async function loadUser(session) {
  const u = session?.user;
  if (!u) { Object.assign(db, { user: null, isMember: false, isOwner: false, requests: [] }); return; }
  const email = (u.email || '').toLowerCase();
  db.user = { id: u.id, email, name: (u.user_metadata?.name || '').trim() || email.split('@')[0] };
  const [m, o] = await Promise.all([db.client.rpc('is_member'), db.client.rpc('is_owner')]);
  db.isMember = !m.error && m.data === true;
  db.isOwner = !o.error && o.data === true;
  await loadRequests();
}
async function loadRequests() {
  if (!db.isOwner) { db.requests = []; return; }
  const { data, error } = await db.client.from('access_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false });
  if (!error) db.requests = data || [];
}

let authUserId = null;
async function afterAuth(session) {
  authUserId = session?.user?.id || null;
  await loadUser(session);
  emit('user');
  if (db.isMember) cleanup().catch(() => {});
}

export async function start() {
  if (!db.configured) return;
  try {
    await loadLibrary();
    db.client = window.supabase.createClient(SUPABASE.url, SUPABASE.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });
    const { data } = await db.client.auth.getSession();
    db.status = 'ok';
    await afterAuth(data.session);
    // Do not await other Supabase calls inside onAuthStateChange: it blocks the client.
    db.client.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return;
      setTimeout(() => { if (event === 'USER_UPDATED' || (session?.user?.id || null) !== authUserId) afterAuth(session); }, 0);
    });
    db.client.channel('lab')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lab_entries' }, () => emit('entries'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'access_requests' }, async () => { await loadRequests(); emit('requests'); })
      .subscribe();
  } catch (e) {
    db.status = 'err';
    db.error = authError(e);
    emit('user');
  }
}

export async function signInPassword(email, password) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return 'Перевірте email';
  if (!password) return 'Введіть пароль';
  const { data, error } = await db.client.auth.signInWithPassword({ email, password });
  if (error) return authError(error);
  await afterAuth(data.session);
  return '';
}
export async function signInLink(email) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return 'Перевірте email';
  const { error } = await db.client.auth.signInWithOtp({
    email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  return error ? authError(error) : '';
}
export async function requestAccess(email, name, note) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return 'Перевірте email';
  if (!(name || '').trim()) return 'Введіть ім\'я';
  const { data, error } = await db.client.rpc('request_access', { p_email: email, p_name: name, p_note: note || null });
  if (error) return authError(error);
  return { ok: '', member: 'Цей email уже має доступ — увійдіть з паролем', full: 'Забагато запитів у черзі — напишіть власнику напряму', bad_email: 'Перевірте email' }[data] ?? '';
}
export async function setPassword(password) {
  if ((password || '').length < 8) return 'Пароль має бути щонайменше 8 символів';
  const { error } = await db.client.auth.updateUser({ password });
  return error ? authError(error) : '';
}
export async function setName(name) {
  name = (name || '').trim().slice(0, 40);
  if (!name) return 'Введіть ім\'я';
  const { error } = await db.client.auth.updateUser({ data: { name } });
  if (error) return authError(error);
  await db.client.auth.refreshSession(); // the new name reaches the token the database reads
  db.user.name = name;
  emit('user');
  return '';
}
export async function signOut() {
  await db.client?.auth.signOut();
  await afterAuth(null);
}

/* ----------------------------------------------------------------- owner -- */
function generatePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = [...crypto.getRandomValues(new Uint8Array(14))].map((b) => abc[b % abc.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 9)}-${raw.slice(9)}`;
}
export const owner = {
  async members() {
    const { data, error } = await db.client.rpc('owner_members');
    if (error) fail(error);
    return data || [];
  },
  /* Creates the account (or a new password for an existing one) and adds it to the editors. Returns the password. */
  async grant(email, name) {
    const password = generatePassword();
    const { error } = await db.client.rpc('owner_grant', { p_email: email, p_name: name || null, p_password: password });
    if (error) fail(error);
    await loadRequests();
    emit('requests');
    return password;
  },
  async reject(id) {
    const { error } = await db.client.rpc('owner_reject', { p_id: id });
    if (error) fail(error);
    await loadRequests();
    emit('requests');
  },
  async remove(email) {
    const { error } = await db.client.rpc('owner_remove', { p_email: email });
    if (error) fail(error);
  },
  async keepDays() {
    const { data } = await db.client.from('lab_settings').select('value').eq('key', 'variation_keep_days').maybeSingle();
    return data ? +data.value : 14;
  },
  async setKeepDays(n) {
    const { error } = await db.client.from('lab_settings').upsert({ key: 'variation_keep_days', value: Math.max(1, Math.round(n)) });
    if (error) fail(error);
  },
};

/* ---------------------------------------------------------- level files -- */
async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
async function gunzip(blob) {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
export const filePath = (id, set, stats) => `${id}/${set}${stats ? '.stats' : ''}.json.gz`;

export async function upload(path, text) {
  const body = await gzip(text);
  const { error } = await db.client.storage.from(BUCKET).upload(path, body, { upsert: true, contentType: 'application/gzip', cacheControl: '31536000' });
  if (error) fail(error);
}
/* `ver` (the entry's updated_at) busts the browser cache after a file is replaced. */
export async function download(path, ver) {
  const url = `${SUPABASE.url}/storage/v1/object/public/${BUCKET}/${path}${ver ? `?v=${encodeURIComponent(ver)}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}: ${path}`);
  return gunzip(await res.blob());
}

/* -------------------------------------------------------------- entries -- */
export async function listEntries() {
  if (!db.client) return [];
  const { data, error } = await db.client.from('lab_entries')
    .select('id,kind,title,note,parent,sets,gen_set,gen_range,summary,pinned,created_at,updated_at,author_name,updated_by_name')
    .order('created_at', { ascending: true });
  if (error) fail(error);
  return data || [];
}
export async function getConfig(id) {
  const { data, error } = await db.client.from('lab_entries').select('config').eq('id', id).maybeSingle();
  if (error) fail(error);
  return data?.config || null;
}
/* files: [{set, levelsText, statsText}] are uploaded first, then the row is written. */
export async function saveEntry(row, files = []) {
  if (!db.isMember) throw new Error('Потрібен доступ редактора — увійдіть');
  for (const f of files) {
    await upload(filePath(row.id, f.set), f.levelsText);
    await upload(filePath(row.id, f.set, true), f.statsText);
  }
  const { data, error } = await db.client.from('lab_entries').upsert(row).select('id,updated_at').single();
  if (error) fail(error);
  return data;
}
export async function updateEntry(id, patch) {
  const { error } = await db.client.from('lab_entries').update(patch).eq('id', id);
  if (error) fail(error);
}
/* Deletes rows and their own files. Entries that other entries inherit sets from are kept. */
export async function deleteEntries(entries, all) {
  const used = new Set();
  for (const e of all) for (const s of Object.values(e.sets || {})) if (s.from) used.add(s.from);
  const drop = entries.filter((e) => !used.has(e.id));
  if (!drop.length) return 0;
  const paths = drop.flatMap((e) => Object.entries(e.sets || {}).filter(([, s]) => !s.from).flatMap(([set]) => [filePath(e.id, set), filePath(e.id, set, true)]));
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await db.client.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (error) fail(error);
  }
  const { error } = await db.client.from('lab_entries').delete().in('id', drop.map((e) => e.id));
  if (error) fail(error);
  return drop.length;
}

/* Old unpinned variations go away on their own: any editor's visit cleans up, at most once an hour. */
const CLEAN_KEY = 'blo.cleanup';
export async function cleanup(force = false) {
  if (!db.isMember) return 0;
  let last = 0;
  try { last = +localStorage.getItem(CLEAN_KEY) || 0; } catch { /* private mode */ }
  if (!force && Date.now() - last < 3600e3) return 0;
  try { localStorage.setItem(CLEAN_KEY, String(Date.now())); } catch { /* private mode */ }
  const { data, error } = await db.client.rpc('lab_expired');
  if (error || !data?.length) return 0;
  const n = await deleteEntries(data, await listEntries());
  if (n) emit('entries');
  return n;
}
/* "Clear DB cache": every unpinned variation, now. */
export async function clearVariations() {
  const all = await listEntries();
  const n = await deleteEntries(all.filter((e) => e.kind === 'variation' && !e.pinned), all);
  emit('entries');
  return n;
}
