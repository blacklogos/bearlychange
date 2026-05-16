# Plan: Migrate bearlychange to Cloudflare Workers (Hono + D1)

Status: draft — needs sign-off before implementation.
Date: 2026-05-17

## Goal

Run the existing bearlychange API on Cloudflare Workers backed by a D1 database. Keep the same HTTP contract so the CLI (`bin/bearlychange.mjs`) and the widget (`public/widget.js`) work unchanged. Public reads stay fast at the edge; admin writes go through D1.

## Non-goals

- No feature additions. Pure port.
- No multi-tenant / projects yet — single-database deployment.
- No new auth scheme — keep Basic + Bearer (BEARLYCHANGE_TOKEN).

## What changes

| Concern | Today | After |
| --- | --- | --- |
| Server framework | Express on Node | **Hono** on Workers (handler signatures swap, routes stay 1:1) |
| Process model | Long-lived `node server.mjs` | Request/response Worker, no persistent process |
| Storage | `data/entries.json` rewritten atomically | **D1** `entries` table |
| Write serialization | In-process `withWriteLock` mutex | D1 transactions + UNIQUE constraint on `slug` |
| Static asset (widget) | `express.static('public', '/widget')` | Workers Static Assets binding (or inlined route) |
| Secrets/config | env vars (`ADMIN_USER`, `ADMIN_PASS`, `BEARLYCHANGE_TOKEN`) | Wrangler secrets + `vars` block |
| Local dev | `npm run dev` (node) | `npm run dev` → `wrangler dev` (workerd + local D1) |
| Smoke test | curl against `localhost:4399` | curl against `localhost:8787` (wrangler default) — assertions unchanged |
| CLI | unchanged | unchanged — it's an HTTP client |

## Target tree

```
src/
  index.mjs               Worker entry: `export default { fetch }`, mounts the Hono app
  routes/public.mjs       Hono router for /, /api/changelog, /feed.json, /rss.xml, /entries/:slug
  routes/admin.mjs        Hono router for /admin*
  lib/entries-store.mjs   D1-backed: list/get/insert/update/delete + mutateEntries (transactional)
  lib/http-helpers.mjs    Hono middleware: basicAuth, sameOrigin, wantsJson, escapeHtml
  lib/validation.mjs      unchanged (pure functions)
  lib/widget-asset.mjs    serves public/widget.js content (either via static binding or inlined)
public/widget.js          source of truth for the widget (also referenced from wrangler [assets])
migrations/
  0001_initial.sql        CREATE TABLE entries + seed the two original rows
wrangler.toml             config: D1 binding, [vars], [assets], compatibility_flags
tests/smoke.sh            unchanged contract; PORT/BASE points at wrangler dev
bin/bearlychange.mjs      unchanged
```

`server.mjs`, top-level `lib/`, top-level `routes/`, and `data/entries.json` are removed at the end. The plain Express setup is replaced, not paralleled — one path to maintain.

## D1 schema (single migration)

```sql
CREATE TABLE entries (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('new','improvement','fix','breaking')),
  version         TEXT NOT NULL,
  modules_json    TEXT NOT NULL DEFAULT '[]',  -- JSON-encoded array
  machine_summary TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at      TEXT NOT NULL,
  published_at    TEXT
);

CREATE INDEX entries_published_idx ON entries(status, published_at DESC);

-- Seed (preserves the two existing entries)
INSERT INTO entries VALUES (...);
INSERT INTO entries VALUES (...);
```

`modules` is stored as JSON in a TEXT column to keep the schema flat. Parsed/serialized at the store boundary.

`UNIQUE(slug)` makes the validation rule a hard constraint — the app still validates first for friendly errors, but a race that slips past validation still fails cleanly at the DB.

## Auth on Workers

- `crypto.timingSafeEqual` is available via `node:crypto` with the `nodejs_compat` compatibility flag in Workers. Use it. If it ever bites us we fall back to a constant-time XOR loop (3 lines).
- Secrets via `wrangler secret put ADMIN_PASS` and `wrangler secret put BEARLYCHANGE_TOKEN`. `ADMIN_USER` stays in `[vars]`.

## CSRF / same-origin

Unchanged logic. Hono exposes the same `Origin`/`Referer` headers via `c.req.header(...)`. The `req.protocol + req.get('host')` reconstruction becomes `new URL(c.req.url).origin`.

## Widget asset

Two options, will pick during implementation:
- **Workers Static Assets** (`[assets] directory = "public"`) — files served from edge cache. Need to confirm the `/widget/widget.js` URL maps correctly (may need to reshape `public/`).
- **Inline route** — `app.get('/widget/widget.js', c => c.text(WIDGET_JS, 200, { 'content-type': 'application/javascript' }))`. Trivial; one file, ~46 lines.

Default to static assets; fall back to inline route if the path mapping is awkward.

## Smoke test

`tests/smoke.sh` keeps the same 23 assertions. Two changes:
- Boot via `wrangler dev --local --port 8787 --persist-to ./.wrangler/state` (background, same PID-array pattern we already use).
- `BASE` becomes `http://localhost:8787`.
- The seed step writes to a throwaway D1 (via the `--persist-to` path) instead of `BEARLYCHANGE_DATA`. The script provisions it by running `wrangler d1 execute --local <db> --file=migrations/0001_initial.sql` before assertions.

Concurrency assertion (20 parallel creates) still applies — D1 transactional writes should handle it just like the in-process mutex did.

## Phased execution

Each phase is a separate commit so progress is reviewable. Smoke test goes green at every phase boundary.

1. **Scaffold** (no behavior change)
   - Add `wrangler.toml`, `migrations/0001_initial.sql`, install `hono` and `wrangler` (devDep).
   - `src/index.mjs` with a minimal `GET /` returning the existing root HTML.
   - `wrangler dev` boots; manual curl passes.

2. **Port public routes**
   - `src/routes/public.mjs` — `/api/changelog`, `/feed.json`, `/rss.xml`, `/entries/:slug`, `/`.
   - Backed by D1 reads. Smoke test public-surface block goes green against wrangler dev.

3. **Port admin routes + write lock semantics**
   - `src/routes/admin.mjs` with all 8 admin handlers.
   - `mutateEntries` rewritten over D1 transactions.
   - Auth + CSRF middleware ported.
   - Smoke test auth + CRUD + CSRF + validation + concurrency blocks all green.

4. **Bearer auth + CLI smoke**
   - Confirm bearer-token assertions pass with `BEARLYCHANGE_TOKEN` set via `wrangler secret put` (or via `.dev.vars` for local).
   - CLI exercised against wrangler dev exactly like today.

5. **Cut over**
   - Delete `server.mjs`, top-level `lib/`, top-level `routes/`, `data/entries.json`.
   - Update CLAUDE.md architecture map.
   - `npm run dev` now means wrangler dev.

6. **Deploy**
   - `wrangler d1 create bearlychange-prod` (production DB).
   - Run migration against prod.
   - Push secrets: `wrangler secret put ADMIN_PASS` + `wrangler secret put BEARLYCHANGE_TOKEN`.
   - `wrangler deploy`.
   - Smoke-test against the deployed URL with a couple of read assertions (no destructive writes against prod).
   - Optional follow-up: a GitHub Actions workflow that runs `npm test` (local wrangler dev) + `wrangler deploy` on push to main.

## Open questions for you

1. **D1 database name** for prod — `bearlychange-prod` ok, or different?
2. **Worker name / route** — `bearlychange.<your-cf-zone>` or a fresh subdomain you'll add via your domain-dns-ops setup?
3. **Github Actions auto-deploy** on push to main — yes/no for now? I can leave it manual (`wrangler deploy`) for the first cut.
4. **Local D1 persistence** in dev — wipe between runs (simple) or persist across runs (more realistic but tests need teardown discipline)?
5. **GET /admin/entries/:id/edit + form shims** were added so a browser session can edit/delete via HTML forms. Keep those on Workers (same HTML) or drop them in favor of CLI-only admin? I'd keep them.

## Estimate

~2–3 hours focused work, broken across the 6 phases above. I'll commit at each phase boundary and pause for review at phase 3 (the riskiest — admin writes against D1 with concurrency).
