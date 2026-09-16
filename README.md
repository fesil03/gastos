# Gastos

Local-first personal expense tracker. Vite + React + TypeScript, Dexie (IndexedDB), Tailwind, vite-plugin-pwa. No backend, no CDN, no web fonts, no analytics — everything ships in `dist/` and works offline on a mainland-China network.

## Run

```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest: 61 tests incl. acceptance against the real export
                   # (fixtures/*.csv is personal data and not committed — those suites skip without it)
npm run build      # tsc -b && vite build → dist/  (root-path build)
npm run build:pages   # same, for GitHub Pages at /gastos/
npm run smoke:pages   # headless-Chromium end-to-end run of the /gastos/ build, all six phases
                      # (CHROMIUM_PATH=… to use a specific binary, else: npx playwright install chromium)
```

## Deploy — GitHub Pages

The live app is the `gh-pages` branch, served at `https://<user>.github.io/gastos/`. To ship a new build:

```
npm run build:pages
git worktree add ../gastos-pages gh-pages   # once
rm -rf ../gastos-pages/* && cp -r dist/* ../gastos-pages/ && touch ../gastos-pages/.nojekyll
(cd ../gastos-pages && git add -A && git commit -m "deploy" && git push)
```

`dist/` is otherwise a plain static site (Cloudflare Pages / Vercel work too: build `npm run build`, output `dist`).

On the phone: open the URL in Safari → Share → *Add to Home Screen*. Always open from the icon; that is what keeps IndexedDB persistent and the offline shell active. Settings → App shows install / offline / persistence status. The app itself never talks to the network after install — all data is in IndexedDB on the device; the URL only matters for installing and updating.

## Status — phases 1–6 done (spec v1)

| Phase | What's there |
|---|---|
| 1 | Dexie schema v2 (v1 → v2 upgrade in place) · 3-tier taxonomy seed with `isTopUp` (Cantina) · Wallet CSV importer with sha256 dedupe, collision review, idempotent re-import · seeds the declared untracked period Jan–Apr 2025 once · import screen (under Ajustes). Payment method is not stored (spec §2). |
| 2 | Entry screen: keypad open on launch, 8 chips ranked by 90-day frequency (all-time backfill), tap-to-save, long-press = repeat last amount, Hoje/Ontem toggle, "mais…" drawer (note, tags, currency + rate, custom date, income), undo toast, "today so far" strip |
| 3 | List: search (accent-insensitive; notes, items, category names), period chips + month pager, category & tag filters, day grouping with totals, top-up label on rows, edit sheet (every field), delete with undo |
| 4 | Insights: hero total, 7/30/90-day daily averages (untracked days out of the denominator), monthly columns — incomplete months hollow, declared-untracked months drawn as gaps and never averaged — group donut, ranked category bars (top-ups labelled), hour×weekday heatmap and small-ticket leakage / median ticket **without top-ups**, streak, category drift; **Cobertura** panel with one-tap "não estava registrando" that turns a suspected lapse (or a run of them) into a declared period; **Conferência de saldo** (§8.1): capture rate from two balance checks, silent otherwise, "receita não registrada" instead of >100% |
| 5 | Export: Markdown bundle (schema note names top-up categories and separates *untracked* from *incomplete* months · monthly rollup with 3-state coverage · category rollup · compact CSV) with range presets, copy / share / download; full CSV; JSON backup v2 (+ untracked periods, balance checks; reads v1 backups); restore (merge or replace) |
| 6 | PWA: manifest + icons, service worker (precache, prompt-to-update banner), install prompt (Android) / iOS hint, `navigator.storage.persist()`, base-path aware build for GitHub Pages, verified in airplane mode by the smoke test |

Acceptance (spec §6) verified against `fixtures/gastos_report_2026-05-02_203027.csv`: 1,617 rows imported, 41 categories (Cantina flagged top-up, 145 rows / 15,313.30), 9 groups, 2 income rows, 15 BRL rows, expense total −9,523,734 minor (= 95,237.34 nominal), re-import imports 0 / skips 1,617, untracked period seeded exactly once.

One thing the data showed that the spec didn't mention: the export has **9 rows in May 2023 and then nothing until January 2024**. Those seven months surface as a suspected lapse in Cobertura — one tap declares them if that was deliberate.

Two places where the data disagreed with the spec text: the export has **41** distinct categories (spec said 44), and Wallet's reference currency was already **CNY** in this export (every CNY row has `ref == amount`; BRL rows carry `fxRate ≈ 1.459`), so `refCurrency = CNY` needs no reconversion of history.

## Layout

```
src/db/          types · Dexie schema (v1→v2 upgrade) · taxonomy seed (colours validated for the dark surface) · live-query hooks · mutations (incl. untracked periods, balance checks)
src/import/      Wallet CSV primitives (PapaParse, string-arithmetic money, naive local dates, sha256) · importer
src/entry/       keypad · category chips (long-press) · picker · "mais" drawer · 90-day ranking · EntryScreen
src/list/        filter/group (pure) · ListScreen · EditSheet
src/insights/    engine (pure, tested: coverage flavours, top-up exclusions, capture rate) · charts (hand-rolled SVG) · CoveragePanel · BalancePanel · InsightsScreen
src/export/      bundle (Markdown/CSV) · backup (JSON, restore merge/replace) · deliver (share/download/copy) · ExportScreen
src/settings/    SettingsScreen (ref currency, untracked periods, PWA status, import)
src/pwa.ts       service-worker update, install prompt, storage persistence
src/lib/         money (minor units ↔ display) · dates (naive local ISO)
scripts/smoke.mjs  Playwright end-to-end (import → entry → list → insights → export → offline)
fixtures/        the real Wallet export — your data; git-ignored, lives only on your machine
```

## Invariants (spec §5)

- Money is signed integers in minor units; parsing and formatting are string-based, floats never touch a stored amount.
- Dates are local naive ISO strings (`2026-05-02T20:21:39`); no `Date` in the storage path, never `toISOString()`.
- Transactions join to categories by `categoryId`; renaming or regrouping a category never touches transaction rows.
- `refCurrency` lives in settings (default `CNY`). Each transaction stores `fxRate` at entry; totals use `refAmountMinor`.

## Dedupe

`externalHash = sha256(date|amountMinor|currency|category)`. For a hash with *m* copies in the DB and *k* in the file: copies 1..*m* are skipped, the next is imported, further copies are held as *collisions* for review. Accepting collisions imports them; running the same file again afterwards is still a no-op.

## Coverage & top-ups (spec §3, §8)

- A month wholly inside a declared untracked period is `untracked`: drawn as a dotted gap, never a zero, never in any mean or baseline. Rolling daily averages divide by tracked days only.
- Otherwise a month is `incomplete` when its expense count is below 40% of the median of the trailing six baseline months; a partially untracked month is judged against a threshold scaled by its tracked-day share and stays out of the baseline.
- Top-up categories (`isTopUp`) stay in every spend total and every breakdown, and are removed only from the heatmap, small-ticket leakage and median/mean ticket.

## Not in v1 (spec §7, phase 7)

Budgets, recurring engine, receipt photos, bank sync, multi-user, cloud accounts, payment method. Tag/category management UI beyond inline create (rename / archive / regroup / toggle top-up) and structured-note editing are the natural phase-7 items.
