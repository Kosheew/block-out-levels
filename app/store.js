/* Storage = this GitHub repository. Anyone can read (raw files at the branch head); writing needs a GitHub token
   with "Contents: read and write" on the repo. Every save is one commit, so git history is the iteration log. */

export const REPO = { owner: 'Kosheew', repo: 'block-out-levels', branch: 'main' };
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;
const LS = { token: 'blo.token', author: 'blo.author' };

const ls = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } },
};
export const auth = {
  get token() { return ls.get(LS.token); },
  set token(v) { ls.set(LS.token, v.trim()); },
  get author() { return ls.get(LS.author); },
  set author(v) { ls.set(LS.author, v.trim()); },
};

async function api(path, init = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...(init.headers || {}) };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(path.startsWith('http') ? path : API + path, { ...init, headers });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ' ' + (await res.json()).message; } catch { /* no body */ }
    const e = new Error(`GitHub: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

let head = null; // commit sha the reads are pinned to
export async function refreshHead() {
  try {
    head = (await api(`/commits/${REPO.branch}`)).sha;
  } catch {
    head = null; // rate limit or offline: fall back to the files served next to the page
  }
  return head;
}

const cache = new Map();
export async function readText(path, { fresh = false } = {}) {
  if (!head && !fresh) await refreshHead();
  const key = `${head}:${path}`;
  if (!fresh && cache.has(key)) return cache.get(key);
  const urls = head ? [`https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${head}/${path}`, path] : [path];
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { cache: 'no-cache' });
      if (res.ok) {
        const t = await res.text();
        cache.set(key, t);
        return t;
      }
      lastErr = new Error(`${res.status} ${path}`);
      if (res.status === 404) break;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
export const readJson = async (path, opts) => JSON.parse(await readText(path, opts));
export async function exists(path) {
  try { await readText(path); return true; } catch { return false; }
}

/* Commit several files at once: {path: text | null (delete)}. Retries when someone else committed meanwhile. */
export async function commit(files, message) {
  if (!auth.token) throw new Error('Для збереження потрібен GitHub-токен: кнопка «🔒 Лише перегляд» угорі праворуч.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await api(`/git/ref/heads/${REPO.branch}`).catch((e) => (e.status === 404 || e.status === 409 ? null : Promise.reject(e)));
    const parent = ref?.object.sha;
    const baseTree = parent ? (await api(`/git/commits/${parent}`)).tree.sha : undefined;
    const tree = [];
    for (const [path, text] of Object.entries(files)) {
      if (text == null) { tree.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
      const blob = await api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: text, encoding: 'utf-8' }) });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const t = await api('/git/trees', { method: 'POST', body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree }) });
    const who = auth.author || 'level-lab';
    const c = await api('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: `${message}\n\nvia Level Lab (${who})`, tree: t.sha, parents: parent ? [parent] : [] }),
    });
    try {
      if (parent) await api(`/git/refs/heads/${REPO.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
      else await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${REPO.branch}`, sha: c.sha }) });
      head = c.sha;
      for (const [path, text] of Object.entries(files)) if (text != null) cache.set(`${head}:${path}`, text);
      return c;
    } catch (e) {
      if (e.status !== 422 || attempt === 2) throw e; // 422: not a fast-forward, re-read and retry
    }
  }
}

export async function whoAmI() {
  if (!auth.token) return null;
  const u = await api('https://api.github.com/user');
  const repo = await api('');
  return { login: u.login, canWrite: !!repo.permissions?.push };
}

export const historyUrl = (path) => `https://github.com/${REPO.owner}/${REPO.repo}/commits/${REPO.branch}/${path}`;
export const fileUrl = (path) => `https://github.com/${REPO.owner}/${REPO.repo}/blob/${REPO.branch}/${path}`;
