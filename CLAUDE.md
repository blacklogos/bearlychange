# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install: `npm install`
- Run (dev = start, no watcher): `ADMIN_USER=admin ADMIN_PASS=change-me npm run dev`
- Server listens on `PORT` (default `4322`). No build, lint, or test setup exists.
- CLI: `./bin/bearlychange.mjs <cmd>` or `npm run cli -- <cmd>`. Once installed, the `bearlychange` and `bc` bins are exposed. Talks to the HTTP server via `BEARLYCHANGE_URL` (default `http://localhost:4322`), `BEARLYCHANGE_USER`, `BEARLYCHANGE_PASS`.
- Tests: `npm test` runs `tests/smoke.sh`, which spins up a server on `:4399` with a throwaway data file and exercises the public/admin/CLI surface (~18 assertions, ~10s). Set `BEARLYCHANGE_TEST_PORT` to override the port.

## Architecture

Single-process Node/Express app. `server.mjs` only wires middleware and listens; routes live under `routes/`, shared logic under `lib/`. The embed widget is a plain Web Component.

```
server.mjs              express setup + CORS + listen
routes/public.mjs       /api/changelog, /feed.json, /rss.xml, /entries/:slug, /
routes/admin.mjs        all /admin/* (HTML panel + JSON API)
lib/entries-store.mjs   JSON-file DB, normalize, applyEntryPatch, mutateEntries
lib/http-helpers.mjs    basicAuth, sameOrigin, wantsJson, escapeHtml, env creds
lib/validation.mjs      validateEntryCreate / validateEntryPatch
bin/bearlychange.mjs    thin HTTP client (CLI) — talks to the server only
public/widget.js        <bearly-change> Web Component, served at /widget/widget.js
tests/smoke.sh          end-to-end test runner used by `npm test`
docs/solutions/         documented learnings (bugs, patterns, conventions) — symlink to ~/Dropbox/Knowledge/Lessons (shared across repos); organized by category with YAML frontmatter (module, tags, problem_type). Relevant when implementing or debugging in documented areas.
```

- **Storage**: default `data/entries.json`; override with `BEARLYCHANGE_DATA=/abs/path`. All disk I/O is in `lib/entries-store.mjs`; every mutation rewrites the whole file synchronously.
- **Write concurrency**: every mutating route goes through `mutateEntries(fn)`. It runs `fn(entries)` inside a single-process promise chain (`withWriteLock`), so concurrent handlers are serialized. New writers must use this helper or they'll race.
- **CSRF**: `sameOrigin` middleware on all admin mutating routes rejects requests whose `Origin`/`Referer` is set but doesn't match the host. CLI/curl (no Origin/Referer) passes through — they carry creds intentionally, not via browser session reuse.
- **Validation**: `validateEntryCreate` / `validateEntryPatch` run inside the write lock so slug uniqueness can't race. Failures return 400 with `{ ok:false, errors:{ field: msg } }` for JSON clients and `text/plain` for form clients. Allowed `type`/`status` and the slug/version regexes live in `lib/validation.mjs`.
- **Entry shape**: `id`, `slug`, `title`, `summary`, `type` (`new|improvement|fix|breaking`), `version`, `modules[]`, `machine_summary`, `status` (`draft|published`), `created_at`, `published_at`. `normalize()` backfills `status` and `created_at` for legacy rows.
- **Draft/publish**: public routes filter via `onlyPublished()`. Admin sees all. Status flip to `published` with null `published_at` auto-stamps "now".
- **Auth**: `basicAuth` middleware in `lib/http-helpers.mjs` gates `/admin*` only. Accepts Basic (humans) and, when `BEARLYCHANGE_TOKEN` is set, Bearer (CI/agents). Bearer is preferred for non-browser callers — easier to rotate, no cached creds in browsers, naturally sidesteps the CSRF surface. Both paths use `crypto.timingSafeEqual`. Generate a token with `openssl rand -hex 32`. The CLI uses `BEARLYCHANGE_TOKEN` if set, else falls back to `BEARLYCHANGE_USER`/`BEARLYCHANGE_PASS`. Public routes are open and send `Access-Control-Allow-Origin: *` (GET only) so the widget can fetch cross-origin.
- **Per-entry public page**: `/entries/:slug` serves HTML by default, JSON via `Accept` — same URL feeds advertise.

## Conventions

- ESM only (`"type": "module"`); use `.mjs`.
- IDs are `bc_${crypto.randomUUID().slice(0,8)}`.
- Admin HTML is inline strings in `routes/admin.mjs`; no template engine. Extend in place rather than introducing one — but always pipe user-controlled text through `escapeHtml()`.
