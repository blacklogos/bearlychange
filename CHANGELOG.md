# Changelog

All notable changes to bearlychange are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## v0.1.0 — 2026-05-18

First tagged release. Embed-first changelog with a machine-readable surface, running on Cloudflare Workers + D1. The hosted reference deployment is at <https://bearlychange.mtri-vo.workers.dev>.

### New features

- **Embed-first widget** — `<bearly-change>` Web Component served from `/widget/widget.js`. Two lines of HTML in any Astro, Next, WordPress, or plain page.
- **Public read surfaces** — `/api/changelog` (JSON), `/feed.json` (JSON Feed 1.1), `/rss.xml`, `/entries/:slug` (HTML + JSON via `Accept`). Open CORS on the read paths.
- **Admin panel + JSON API** — `/admin/*` for create, update, delete, draft↔publish. Basic auth for humans, bearer token (`BEARLYCHANGE_TOKEN`) for CI and agents. Constant-time compare on both paths.
- **Zero-dep Node CLI** — `bin/bearlychange.mjs` (also `bc` / `bearlychange` when installed). Talks to any deployment over HTTP. Supports `create --from-stdin` for piped JSON from agents.
- **Validation + safety net** — server-side validation (`validateEntryCreate` / `validateEntryPatch`), D1 `CHECK` constraints on enums, `UNIQUE(slug)` race protection translated back to a friendly field error.
- **CSRF guard** — `sameOrigin` middleware on every admin mutating route. Browsers blocked on cross-origin Origin/Referer; CLI/curl (no Origin) passes.
- **Draft → publish workflow** — drafts hidden from public surfaces; status flip auto-stamps `published_at`.

### Architecture

- Cloudflare Workers (Hono router) + Cloudflare D1, edge-served reads.
- Single migration (`migrations/0001_initial.sql`); modules stored as `modules_json` and (de)serialized at the store boundary.
- Static assets (the `<bearly-change>` widget) served via the `ASSETS` binding from `public/widget/`.
- Marketing landing page lives in a separate repo: <https://github.com/blacklogos/bearlychange-site>.

### Tooling

- End-to-end smoke test (`tests/smoke.sh`) — 24 assertions across public reads, auth, validation, CSRF, CLI lifecycle, bearer auth, and 20-parallel-create concurrency. ~15s on a fresh local D1.
- GitHub Actions auto-deploy to Cloudflare Workers on push to `main`.
