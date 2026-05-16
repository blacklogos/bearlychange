// Public, read-only surface served from the edge. Same contract as the
// Express version: /, /api/changelog, /feed.json, /rss.xml, /entries/:slug.
import { Hono } from 'hono';
import { listPublished, getPublishedBySlug } from '../lib/entries-store.mjs';
import { wantsJson, escapeHtml } from '../lib/http-helpers.mjs';

const router = new Hono();

router.get('/', (c) => {
  const host = new URL(c.req.url).origin;
  return c.html(`<!doctype html>
<html><head><meta charset='utf-8'><title>bearlychange</title></head>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;line-height:1.5;">
  <h1>bearlychange</h1>
  <p>Changelog for humans &amp; agents.</p>
  <ul>
    <li><a href='/api/changelog'>/api/changelog</a></li>
    <li><a href='/feed.json'>/feed.json</a></li>
    <li><a href='/rss.xml'>/rss.xml</a></li>
    <li><a href='/admin'>/admin</a> (basic auth)</li>
  </ul>
  <h2>Embed widget</h2>
  <pre>&lt;script src="${host}/widget/widget.js" defer&gt;&lt;/script&gt;
&lt;bearly-change src="${host}/api/changelog" limit="3"&gt;&lt;/bearly-change&gt;</pre>
</body></html>`);
});

router.get('/api/changelog', async (c) => {
  const entries = await listPublished(c.env.DB);
  // Open CORS for the embed widget — public reads from any origin.
  c.header('Access-Control-Allow-Origin', '*');
  return c.json({ project: 'bearlychange', count: entries.length, entries });
});

router.get('/feed.json', async (c) => {
  const entries = await listPublished(c.env.DB);
  const host = new URL(c.req.url).origin;
  return c.json({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'bearlychange',
    home_page_url: host,
    feed_url: `${host}/feed.json`,
    items: entries.map((e) => ({
      id: e.id,
      url: `${host}/entries/${e.slug}`,
      title: e.title,
      content_html: `<p><strong>${e.type.toUpperCase()}</strong> · v${e.version}</p><p>${e.summary}</p>`,
      date_published: e.published_at,
      tags: [e.type, ...(e.modules || [])]
    }))
  });
});

router.get('/rss.xml', async (c) => {
  const entries = await listPublished(c.env.DB);
  const host = new URL(c.req.url).origin;
  const items = entries
    .map(
      (e) => `
    <item>
      <title><![CDATA[${e.title}]]></title>
      <link>${host}/entries/${e.slug}</link>
      <guid>${e.id}</guid>
      <pubDate>${new Date(e.published_at).toUTCString()}</pubDate>
      <description><![CDATA[${e.summary}]]></description>
      <category>${e.type}</category>
    </item>`
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>bearlychange</title>
    <description>Changelog for humans &amp; agents</description>
    <link>${host}</link>${items}
  </channel>
</rss>`;
  return c.text(xml, 200, { 'content-type': 'application/rss+xml' });
});

router.get('/entries/:slug', async (c) => {
  const slug = c.req.param('slug');
  const entry = await getPublishedBySlug(c.env.DB, slug);
  if (!entry) return c.text('Not found', 404);
  if (wantsJson(c)) return c.json(entry);

  const modulesHtml = (entry.modules || []).length
    ? `<p style="color:#666;font-size:14px;">Modules: ${entry.modules
        .map((m) => `<code>${escapeHtml(m)}</code>`)
        .join(' ')}</p>`
    : '';
  const machineHtml = entry.machine_summary
    ? `<details><summary>machine_summary</summary><pre style="white-space:pre-wrap;">${escapeHtml(
        entry.machine_summary
      )}</pre></details>`
    : '';

  return c.html(`<!doctype html>
<html><head><meta charset='utf-8'><title>${escapeHtml(entry.title)} — bearlychange</title></head>
<body style="font-family:system-ui;max-width:760px;margin:32px auto;line-height:1.5;">
<p><a href="/">&larr; bearlychange</a></p>
<article>
<small style="color:#666;text-transform:uppercase;">${escapeHtml(entry.type)} · v${escapeHtml(entry.version)}</small>
<h1>${escapeHtml(entry.title)}</h1>
<p style="color:#666;font-size:14px;">${new Date(entry.published_at).toUTCString()}</p>
<p>${escapeHtml(entry.summary)}</p>
${modulesHtml}
${machineHtml}
</article>
</body></html>`);
});

export default router;
