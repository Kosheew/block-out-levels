/* Static, read-only data served next to the page (GitHub Pages): the reference aggregates and the versions
   committed to the repo (versions/index.json). Everything people save goes to Supabase (db.js). */

export const REPO = { owner: 'Kosheew', repo: 'block-out-levels', branch: 'main' };

const cache = new Map();
export async function readText(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  const t = await res.text();
  cache.set(path, t);
  return t;
}
export const readJson = async (path) => JSON.parse(await readText(path));
export const historyUrl = (path) => `https://github.com/${REPO.owner}/${REPO.repo}/commits/${REPO.branch}/${path}`;
