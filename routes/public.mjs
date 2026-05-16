// Public, read-only surface: the JSON changelog API, JSON Feed, RSS feed,
// per-entry public page, and the marketing-ish root index.
import express from 'express';
import { readEntries, normalize, onlyPublished } from '../lib/entries-store.mjs';
import { wantsJson, escapeHtml } from '../lib/http-helpers.mjs';

const router = express.Router();

router.get('/api/changelog', (req, res) => {
  const entries = onlyPublished(readEntries().map(normalize));
  res.json({ project: 'bearlychange', count: entries.length, entries });
});

router.get('/feed.json', (req, res) => {
  const entries = onlyPublished(readEntries().map(normalize));
  res.json({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'bearlychange',
    home_page_url: `${req.protocol}://${req.get('host')}`,
    feed_url: `${req.protocol}://${req.get('host')}/feed.json`,
    items: entries.map((e) => ({
      id: e.id,
      url: `${req.protocol}://${req.get('host')}/entries/${e.slug}`,
      title: e.title,
      content_html: `<p><strong>${e.type.toUpperCase()}</strong> · v${e.version}</p><p>${e.summary}</p>`,
      date_published: e.published_at,
      tags: [e.type, ...(e.modules || [])]
    }))
  });
});

router.get('/rss.xml', (req, res) => {
  const entries = onlyPublished(readEntries().map(normalize));
  const host = `${req.protocol}://${req.get('host')}`;
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
    <description>Changelog for humans & agents</description>
    <link>${host}</link>${items}
  </channel>
</rss>`;
  res.set('Content-Type', 'application/rss+xml');
  res.send(xml);
});

// Public per-entry view (HTML by default, JSON via Accept). Slug-addressed
// since that's what the feeds advertise. Only published entries are exposed.
router.get('/entries/:slug', (req, res) => {
  const entry = onlyPublished(readEntries().map(normalize)).find((e) => e.slug === req.params.slug);
  if (!entry) return res.status(404).send('Not found');
  if (wantsJson(req)) return res.json(entry);

  const modulesHtml = (entry.modules || []).length
    ? `<p style="color:#666;font-size:14px;">Modules: ${entry.modules.map((m) => `<code>${escapeHtml(m)}</code>`).join(' ')}</p>`
    : '';
  const machineHtml = entry.machine_summary
    ? `<details><summary>machine_summary</summary><pre style="white-space:pre-wrap;">${escapeHtml(entry.machine_summary)}</pre></details>`
    : '';

  res.type('html').send(`<!doctype html>
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

router.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset='utf-8'><title>bearlychange</title></head>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;line-height:1.5;">
  <h1>bearlychange</h1>
  <p>Changelog for humans & agents.</p>
  <ul>
    <li><a href='/api/changelog'>/api/changelog</a></li>
    <li><a href='/feed.json'>/feed.json</a></li>
    <li><a href='/rss.xml'>/rss.xml</a></li>
    <li><a href='/admin'>/admin</a> (basic auth)</li>
  </ul>
  <h2>Embed widget</h2>
  <pre>&lt;script src="${req.protocol}://${req.get('host')}/widget/widget.js" defer&gt;&lt;/script&gt;
&lt;bearly-change src="${req.protocol}://${req.get('host')}/api/changelog" limit="3"&gt;&lt;/bearly-change&gt;</pre>
</body></html>`);
});

export default router;
