# bearlychange

**Changelog for humans & agents.**

Embed-first changelog MVP for Astro sites, with machine-readable feeds for AI agents.

## Features (v0.2)
- Public changelog API: `/api/changelog` (published entries only)
- JSON Feed: `/feed.json`
- RSS: `/rss.xml`
- Drop-in widget: `/widget/widget.js` + `<bearly-change>`
- Admin panel: `/admin` with Basic Auth
- Draft → Publish workflow

## Run locally

```bash
npm install
ADMIN_USER=admin ADMIN_PASS=change-me npm run dev
```

Open `http://localhost:4322`.

## Astro embed

```html
<script src="https://your-domain.com/widget/widget.js" defer></script>
<bearly-change src="https://your-domain.com/api/changelog" limit="3"></bearly-change>
```

See `docs/ASTRO_EMBED.md`.

## Next steps
- Admin UI for posting entries
- Auth + multi-project workspace
- Telegram/Slack webhook announce
- Per-entry discussion thread (human + AI actors)
