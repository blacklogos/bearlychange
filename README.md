# bearlychange

**Changelog for humans & agents.** Embed-first changelog with a machine-readable surface. One Web Component for your site, JSON Feed and RSS for AI agents, a tiny CLI for CI. Edge-native on Cloudflare Workers + D1. MIT.

## Public surfaces

| Path | What it is |
| --- | --- |
| `/api/changelog` | JSON of published entries (primary agent + widget feed) |
| `/feed.json` | JSON Feed 1.1 |
| `/rss.xml` | RSS 2.0 |
| `/entries/:slug` | Per-entry page (HTML; `Accept: application/json` for JSON) |
| `/widget/widget.js` | The `<bearly-change>` Web Component |
| `/admin` | HTML admin + JSON API (Basic auth or `Authorization: Bearer …`) |

## Embed the widget

Two lines into any HTML page (Astro, Next, WordPress, plain HTML — anywhere custom elements run):

```html
<script src="https://YOUR-DOMAIN/widget/widget.js" defer></script>
<bearly-change src="https://YOUR-DOMAIN/api/changelog" limit="3"></bearly-change>
```

CORS is open on the public read paths.

## Deploy your own

Prereqs: a Cloudflare account, `npm`, and `npx wrangler login`.

```bash
git clone https://github.com/blacklogos/bearlychange
cd bearlychange
npm install

# 1. Create your D1 database, then paste its id into wrangler.toml (database_id).
npx wrangler d1 create bearlychange-prod

# 2. Apply schema.
npm run db:migrate:remote

# 3. Set admin secrets (used by /admin and the CLI).
npx wrangler secret put ADMIN_PASS
npx wrangler secret put BEARLYCHANGE_TOKEN   # any random string; openssl rand -hex 32

# 4. Ship.
npm run deploy
```

`ADMIN_USER` lives in `wrangler.toml [vars]`; everything sensitive is a secret.

## Post entries from CI (or an agent)

The repo ships a zero-dep Node CLI at `bin/bearlychange.mjs`. Point it at any deployment over HTTP.

```bash
export BEARLYCHANGE_URL=https://YOUR-DOMAIN
export BEARLYCHANGE_TOKEN=<the-token-you-set-above>

./bin/bearlychange.mjs create \
  --title "Shipped bearer-token auth" --slug bearer-auth \
  --summary "BEARLYCHANGE_TOKEN now accepted for CI." --version 0.4.0

# Pipe a JSON payload from an agent
echo '{"title":"X","slug":"x","summary":"y","version":"0.4.1"}' \
  | ./bin/bearlychange.mjs create --from-stdin
```

`BEARLYCHANGE_TOKEN` is preferred for non-browser callers (no browser session → no CSRF surface). Basic auth (`BEARLYCHANGE_USER` / `BEARLYCHANGE_PASS`) works too.

## Local dev

```bash
npm install
npm run db:migrate:local            # one-time, seeds the local D1
cp .dev.vars.example .dev.vars      # or create one with ADMIN_PASS=… BEARLYCHANGE_TOKEN=…
npm run dev                         # wrangler dev on :8787
npm test                            # end-to-end smoke (~24 assertions, ~15s)
```

## Architecture

Cloudflare Worker (Hono router) + D1. `src/index.mjs` mounts routers; routes live in `src/routes/`, shared logic in `src/lib/`. Single migration in `migrations/0001_initial.sql`. The widget is a Web Component served statically from `public/widget/widget.js` via the ASSETS binding.

See `CLAUDE.md` for the agent-readable layout brief.

## License

MIT.
