# Astro Embed (quick start)

```astro
---
const changelogApi = 'https://your-bearlychange-domain.com/api/changelog';
---

<script src="https://your-bearlychange-domain.com/widget/widget.js" defer></script>
<bearly-change src={changelogApi} limit="4"></bearly-change>
```

## Notes
- Works in Astro/Next/WordPress/Webflow because it's a plain web component.
- Keep CORS open for your site origin.
- Recommended: self-host widget.js on your own CDN domain.
