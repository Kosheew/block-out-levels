# Block Out Level Lab

A static site (GitHub Pages) for the Block Out level sets: generate levels in the browser, look at the
difficulty curves, play and edit single levels, upload JSON files, and keep every iteration as a version.

Site: https://kosheew.github.io/block-out-levels/ (once Pages is on: *Settings → Pages → Deploy from a branch →
`main` / root*).

## What it does

| Tab | |
| --- | --- |
| Криві | Per-level metrics of any versions on one chart, smoothed, against the reference game's aggregate curve (p10–p90 band + median), plus a per-band table. Click a point to open that level. |
| Рівні | Draw, play (tap = slide out) and edit a level: click turns a block, Shift+click cycles its outer layer, right click deletes it; moves and tier are editable. Live validation (solvable, no overlaps, moves ≥ taps). Save into the version or as a new one. |
| Генератор | `app/generator.js` is the browser port of `block-out/tools/gen-levels.mjs`; the default config reproduces the game's levels byte for byte. Edit the curve tables (JSON), generate a range or a whole set in Web Workers, compare with the base version and the reference, save as a version (its `config.json` is saved too). Regenerating a range keeps the rest of the base version. |
| Версії і файли | Every version with author, date, note and parent; GitHub history per version; download a set as one JSON or as the game's 50-level chunks (zip). Upload JSON files (game chunks, an array, a single level or the `gridSize`/`blockList` editor format) — they are validated and measured before saving. |

Reading needs nothing. Saving needs a GitHub fine-grained token with **Contents: Read and write** on this repo
(the 🔒 button explains it). The token stays in that browser's localStorage. Every save is one commit, so git
history is the full log of iterations.

## Layout

```
index.html, app/          the site (plain ES modules, no build step)
  generator.js            level generator (pure, also runs in Node)
  metrics.js              formats, validation, playthrough metrics (C, depth, free blocks …)
  store.js                GitHub read/commit
  worker.js, pool.js      background generation / measuring
data/reference.json       reference game aggregates only (rolling medians / percentiles, band tables)
versions/index.json       list of versions
versions/<id>/            meta.json, config.json (generated versions), <set>.json, <set>.stats.json
tools/                    Node scripts (below)
```

A version stores only the sets it changed; the others point to the version they came from (`"from": "<id>"`).

## Metrics

- taps = blocks + outer layers; spare = move limit − taps.
- **C (complexity)** = taps × median over steps of 1 / (blocks free at that step), mean of 8 random playthroughs.
  High when the board stays a narrow chain for many taps.
- depth = rounds needed when every free block is tapped at once; free0 = blocks free at the start.

## Node tools

```bash
node tools/import-version.mjs ../block-out/Assets/Resources/Levels <id> --title "..." --note "..."
node tools/build-reference.mjs <level-complexity.html | its DATA .json | folder of LevelData*.json>
```

## Rule

After Funjo's DMCA notice (2026-11-11) no level layout of Tap Block Out (or any other game) may be stored here,
uploaded through the site or used as a base for ours. `data/reference.json` holds aggregates only.
