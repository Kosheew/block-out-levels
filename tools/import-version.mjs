#!/usr/bin/env node
/* Imports the game's level folder (Assets/Resources/Levels) as a version of this site.

     node tools/import-version.mjs <Levels dir> <version-id> [--title "..."] [--note "..."] [--author name]

   Writes versions/<id>/<set>.json (all levels of the set in one "blockout-levels/2" file), <set>.stats.json and
   meta.json, and adds the version to versions/index.json. The site does the same in the browser on upload. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise, measure, packStats, toSetFile, validate } from '../app/metrics.js';

const [dir, id] = process.argv.slice(2);
const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
if (!dir || !id) { console.error('usage: import-version.mjs <Levels dir> <version-id> [--title t] [--note n] [--author a]'); process.exit(1); }
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vdir = path.join(root, 'versions', id);
fs.mkdirSync(vdir, { recursive: true });

const sets = {};
for (const set of fs.readdirSync(dir)) {
  const p = path.join(dir, set);
  if (!fs.statSync(p).isDirectory()) continue;
  const levels = fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort()
    .flatMap((f) => normalise(JSON.parse(fs.readFileSync(path.join(p, f), 'utf8'))));
  if (!levels.length) continue;
  levels.sort((a, b) => a.id - b.id);
  const bad = levels.map((L) => [L.id, validate(L)]).filter(([, e]) => e.length);
  if (bad.length) console.warn(`${set}: ${bad.length} invalid levels, e.g. ${bad[0][0]}: ${bad[0][1].join('; ')}`);
  const stats = levels.map((L, k) => measure(L, k));
  fs.writeFileSync(path.join(vdir, `${set}.json`), toSetFile(levels));
  fs.writeFileSync(path.join(vdir, `${set}.stats.json`), JSON.stringify(packStats(stats)));
  sets[set] = { count: levels.length };
  console.log(`${set}: ${levels.length} levels`);
}

const meta = { id, title: opt('title', id), note: opt('note', ''), author: opt('author', 'import'), date: new Date().toISOString(), parent: null, source: 'import', sets };
fs.writeFileSync(path.join(vdir, 'meta.json'), JSON.stringify(meta, null, 2));
const indexFile = path.join(root, 'versions', 'index.json');
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { versions: [] };
index.versions = index.versions.filter((v) => v.id !== id).concat([meta]);
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
console.log('version', id, 'written');
