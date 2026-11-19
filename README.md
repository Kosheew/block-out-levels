# Block Out Level Lab

A static site for the Block Out level sets: generate levels in the browser, look at the difficulty curves, play and
edit single levels, upload JSON files, and keep every generation run and every iteration.

Site: https://kosheew.github.io/block-out-levels/ (GitHub Pages, deployed by `.github/workflows/pages.yml` on every
push to `main`).

## What it does

| Tab | |
| --- | --- |
| Криві | Per-level metrics of any versions and variations on one chart, smoothed, against the reference game's aggregate curve (p10–p90 band + median), plus a per-band table. Click a point to open that level. |
| Рівні | Draw, play (tap = slide out) and edit a level: click turns a block, Shift+click cycles its outer layer, right click deletes it; moves and tier are editable. Live validation (solvable, no overlaps, moves ≥ taps). Save into the version / variation or as a new version. |
| Генератор | `app/generator.js` is the browser port of `block-out/tools/gen-levels.mjs`; the default config reproduces the game's levels byte for byte. Edit the curve tables (JSON), generate a range or a whole set in Web Workers, compare with the base and the reference. **Every run is saved as a variation** (config, range, metrics, levels); the list below the generator lets you pin (★), rename, compare, take its config, turn it into a version or delete it. |
| Версії і файли | Versions with author, date, note and parent; download a set as one JSON or as the game's 50-level chunks (zip). Upload JSON files (game chunks, an array, a single level or the `gridSize`/`blockList` editor format) — validated and measured before saving. |

## Access

Reading needs nothing. Editing needs an account, given by the owner (same flow as The Agency 6 task board):

1. A person clicks **Увійти → Запросити доступ** and leaves a name and email.
2. The owner sees the request (a counter on the account button), opens the profile → **Підтвердити**. The site
   generates a password, the database creates the account and adds the person to the editors, and the site shows
   a ready text (address, email, password) with a **Копіювати** button.
3. The owner forwards the text; the person signs in with email + password, and the browser remembers the login.

In the profile the owner can also add people by hand, give anyone a new password, remove editors, set how long
unpinned variations are kept, and **Очистити кеш БД** (delete every unpinned variation now). Everyone can change
their name and password. Fallback sign-in: **Не пам'ятаю пароль** sends a login link by email.

### Variations and the cache

Every generator run is stored as a *variation*. Unpinned ones are a cache: they are deleted (row and files)
`variation_keep_days` days after they were made (14 by default, set by the owner), checked at most once an hour
when an editor opens the site. Pinned variations (★) and versions are never deleted automatically. A variation or
version that another one inherits sets from is never deleted.

## Setup (once, owner, ~5 min)

1. **Project.** [supabase.com/dashboard](https://supabase.com/dashboard) → New project (free plan).
2. **Database.** SQL Editor → New query → paste [`supabase/schema.sql`](supabase/schema.sql) → at the very end replace
   `owner@example.com` with your email → **Run**. Running it again is safe.
3. **Your account.** Authentication → Users → **Add user → Create new user**: your email, a password,
   *Auto Confirm User* on. (Everyone else gets an account from the site.)
4. **Site address.** Authentication → URL Configuration: Site URL `https://kosheew.github.io/block-out-levels/`,
   Redirect URLs → add `https://kosheew.github.io/block-out-levels/**`.
5. **Keys.** Project Settings → API → copy **Project URL** and the **anon public** key into
   [`app/config.js`](app/config.js), commit and push. The anon key is public by design (the database checks every
   write with Row Level Security). **Never put the service_role key here.**

Until `app/config.js` is filled, the site is read-only: the reference curves and the versions committed in
`versions/`.

## Where data lives

```
index.html, app/          the site (plain ES modules, no build step)
  generator.js            level generator (pure, also runs in Node)
  metrics.js              formats, validation, playthrough metrics (C, depth, free blocks …)
  db.js                   Supabase: sign-in, owner tools, versions / variations, gzip level files
  store.js                read-only files next to the page
  worker.js, pool.js      background generation / measuring
supabase/schema.sql       tables, RLS, access requests, storage bucket `levels`
data/reference.json       reference game aggregates only (rolling medians / percentiles, band tables)
versions/                 versions committed to the repo (read-only on the site), e.g. the game's levels
tools/                    Node scripts (below)
```

Supabase: table `lab_entries` (kind `version` / `variation`, sets, config, summary, author set by the database),
bucket `levels` with `<id>/<set>.json.gz` and `<id>/<set>.stats.json.gz` (a full 5000-level set is ~1.5 MB). An entry
stores only the sets it changed; the others point to the entry they came from (`"from": "<id>"`).

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
