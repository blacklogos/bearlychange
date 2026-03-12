import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 4322;

app.use(express.json());
app.use('/widget', express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'data', 'entries.json');

function readEntries() {
  const raw = fs.readFileSync(dbPath, 'utf8');
  return JSON.parse(raw).sort((a,b)=> new Date(b.published_at)-new Date(a.published_at));
}

app.get('/api/changelog', (req, res) => {
  const entries = readEntries();
  res.json({ project: 'bearlychange', count: entries.length, entries });
});

app.get('/feed.json', (req, res) => {
  const entries = readEntries();
  res.json({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'bearlychange',
    home_page_url: `${req.protocol}://${req.get('host')}`,
    feed_url: `${req.protocol}://${req.get('host')}/feed.json`,
    items: entries.map(e => ({
      id: e.id,
      url: `${req.protocol}://${req.get('host')}/entries/${e.slug}`,
      title: e.title,
      content_html: `<p><strong>${e.type.toUpperCase()}</strong> · v${e.version}</p><p>${e.summary}</p>`,
      date_published: e.published_at,
      tags: [e.type, ...(e.modules || [])]
    }))
  });
});

app.get('/rss.xml', (req, res) => {
  const entries = readEntries();
  const host = `${req.protocol}://${req.get('host')}`;
  const items = entries.map(e => `
    <item>
      <title><![CDATA[${e.title}]]></title>
      <link>${host}/entries/${e.slug}</link>
      <guid>${e.id}</guid>
      <pubDate>${new Date(e.published_at).toUTCString()}</pubDate>
      <description><![CDATA[${e.summary}]]></description>
      <category>${e.type}</category>
    </item>`).join('\n');

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

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset='utf-8'><title>bearlychange</title></head>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;line-height:1.5;">
  <h1>bearlychange</h1>
  <p>Changelog for humans & agents.</p>
  <ul>
    <li><a href='/api/changelog'>/api/changelog</a></li>
    <li><a href='/feed.json'>/feed.json</a></li>
    <li><a href='/rss.xml'>/rss.xml</a></li>
  </ul>
  <h2>Embed widget</h2>
  <pre>&lt;script src="${req.protocol}://${req.get('host')}/widget/widget.js" defer&gt;&lt;/script&gt;
&lt;bearly-change src="${req.protocol}://${req.get('host')}/api/changelog" limit="3"&gt;&lt;/bearly-change&gt;</pre>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`bearlychange running on http://localhost:${PORT}`);
});
