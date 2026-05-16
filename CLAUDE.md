# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install: `npm install`
- Local dev: `npm run dev` → `wrangler dev` (boots workerd on `:8787` with a local D1). One-time setup: `npm run db:migrate:local` to seed the local DB.
- Tests: `npm test` runs `tests/smoke.sh` — boots an isolated `wrangler dev` against a throwaway local D1, ~24 assertions, ~15–20 s. Override the port with `BEARLYCHANGE_TEST_PORT`.
- CLI: `./bin/bearlychange.mjs <cmd>` or `npm run cli -- <cmd>` (also exposed as `bearlychange` / `bc` once installed). Talks to the HTTP API via `BEARLYCHANGE_URL` (default `http://localhost:4322` — override for wrangler dev and prod), `BEARLYCHANGE_TOKEN` (preferred if set), else `BEARLYCHANGE_USER` / `BEARLYCHANGE_PASS`.
- Deploy: `npm run db:migrate:remote` (once per schema change), then `npm run deploy` → `wrangler deploy`.

## Architecture

Cloudflare Worker (Hono router) backed by Cloudflare D1. `src/index.mjs` only mounts routers; everything else lives under `src/routes/` (handlers) and `src/lib/` (shared logic). Public reads run at the edge from D1.

```
src/index.mjs              Worker entry: `export default app` (Hono)
src/routes/public.mjs      /, /api/changelog, /feed.json, /rss.xml, /entries/:slug
src/routes/admin.mjs       all /admin/* (HTML panel + JSON API)
src/lib/entries-store.mjs  D1 reads + writes (list/get/insert/update/delete + slugTaken)
src/lib/http-helpers.mjs   basicAuth, sameOrigin, wantsJson, escapeHtml
src/lib/validation.mjs     validateEntryCreate / validateEntryPatch
bin/bearlychange.mjs       zero-dep Node CLI (HTTP client; works against any URL)
public/widget/widget.js    <bearly-change> Web Component, served via ASSETS binding at /widget/widget.js
migrations/0001_initial.sql  D1 schema + seed
wrangler.toml              D1 binding `DB` (bearlychange-prod), [vars] ADMIN_USER, [assets] → public/
tests/smoke.sh             end-to-end runner (24 assertions)
docs/solutions/            documented learnings (bugs, patterns, conventions) — symlink to ~/Dropbox/Knowledge/Lessons (shared across repos); organized by category with YAML frontmatter (module, tags, problem_type). Relevant when implementing or debugging in documented areas.
```

- **Storage**: D1 `entries` table. Single migration `migrations/0001_initial.sql`. `modules` is stored as a JSON string in `modules_json`; `lib/entries-store.mjs` serializes/deserializes at the boundary so handlers see `entry.modules` as an array.
- **Write concurrency**: validation runs first for friendly errors, then the D1 `UNIQUE(slug)` constraint catches anything that races past validate→insert. `isUniqueSlugError(err)` in `routes/admin.mjs` translates the SQLite error back into `{slug: "already in use"}`. No in-process mutex needed — D1 serializes writes.
- **CSRF**: `sameOrigin` middleware on every admin mutating route rejects requests whose `Origin`/`Referer` is set but doesn't match the host. CLI/curl (no Origin/Referer) passes through.
- **Auth**: `basicAuth` middleware in `src/lib/http-helpers.mjs` gates `/admin/*` via the `app.use('/admin/*', ...)` route. Accepts Basic (humans) and Bearer (CI/agents, when `BEARLYCHANGE_TOKEN` secret is set). Bearer is preferred for non-browser callers — no browser session reuse → no CSRF surface. Both paths use a pure-JS constant-time compare (avoids needing `nodejs_compat`). Generate a token with `openssl rand -hex 32`.
- **Validation**: `validateEntryCreate` / `validateEntryPatch` run inline in the handlers. Failures → `{ok:false, errors:{field:msg}}` (JSON) or `text/plain` newline-separated list (forms). Enums (`type`, `status`) and the slug/version regexes live in `src/lib/validation.mjs`. The same validation rules are enforced again at the DB layer via `CHECK` constraints on `type`/`status` and `UNIQUE` on `slug`.
- **Entry shape**: `id`, `slug`, `title`, `summary`, `type` (`new|improvement|fix|breaking`), `version`, `modules[]`, `machine_summary`, `status` (`draft|published`), `created_at`, `published_at`.
- **Draft/publish**: public routes filter via `WHERE status = 'published'` in SQL. Admin sees all. Status flip to `published` with null `published_at` auto-stamps "now".
- **Public per-entry page**: `/entries/:slug` serves HTML by default, JSON via `Accept` — same URL the feeds advertise.
- **Widget**: served from `public/widget/widget.js` via Workers Static Assets (binding `ASSETS` in `wrangler.toml`). URL `/widget/widget.js` is matched by the asset binding before the Worker handler, so it streams from the edge cache.

## Secrets & env

- Local: `.dev.vars` (gitignored) holds `ADMIN_PASS` and `BEARLYCHANGE_TOKEN`. Wrangler dev picks them up automatically.
- Prod: `wrangler secret put ADMIN_PASS` and `wrangler secret put BEARLYCHANGE_TOKEN`. `ADMIN_USER` lives in `wrangler.toml [vars]`.
- Smoke test injects per-run secrets via `wrangler dev --var KEY:VALUE`, so it never touches `.dev.vars`.

## Conventions

- ESM only (`"type": "module"`); use `.mjs`.
- IDs are `bc_${crypto.randomUUID().slice(0,8)}`. `crypto` is Web Crypto in Workers — no import needed.
- HTML is inline strings in route files; always pipe user-controlled text through `escapeHtml()`.
- Adding a new entry field: update `migrations/000X_*.sql` (new migration, never edit the existing one), `entries-store.mjs` (insert/update/rowToEntry), `validation.mjs` (if validated), and the admin HTML form fields. Re-run smoke.
