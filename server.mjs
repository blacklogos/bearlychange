import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 4322;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'bearlychange';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/widget', express.static(path.join(__dirname, 'public')));

// CORS for client-side fetch from the Astro site
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const dbPath = path.join(__dirname, 'data', 'entries.json');

function readEntriesRaw() {
  const raw = fs.readFileSync(dbPath, 'utf8');
  return JSON.parse(raw);
}

function readEntries() {
  return readEntriesRaw().sort((a, b) => new Date(b.published_at || b.created_at || 0) - new Date(a.published_at || a.created_at || 0));
}

function writeEntries(entries) {
  fs.writeFileSync(dbPath, JSON.stringify(entries, null, 2));
}

function normalize(entry) {
  return {
    ...entry,
    status: entry.status || 'published',
    created_at: entry.created_at || entry.published_at || new Date().toISOString()
  };
}

function onlyPublished(entries) {
  return entries.filter((e) => (e.status || 'published') === 'published');
}

function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="bearlychange-admin"');
    return res.status(401).send('Authentication required');
  }

  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="bearlychange-admin"');
    return res.status(401).send('Invalid credentials');
  }

  return next();
}

app.get('/api/changelog', (req, res) => {
  const entries = onlyPublished(readEntries().map(normalize));
  res.json({ project: 'bearlychange', count: entries.length, entries });
});

app.get('/feed.json', (req, res) => {
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

app.get('/rss.xml', (req, res) => {
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

app.get('/admin', basicAuth, (req, res) => {
  const entries = readEntries().map(normalize);
  const rows = entries
    .map(
      (e) => `<tr>
<td>${e.id}</td>
<td>${e.title}</td>
<td>${e.status}</td>
<td>${e.version}</td>
<td>${e.type}</td>
<td>
<form method="post" action="/admin/entries/${e.id}/status" style="display:inline-flex;gap:6px;">
<select name="status">
<option value="draft" ${e.status === 'draft' ? 'selected' : ''}>draft</option>
<option value="published" ${e.status === 'published' ? 'selected' : ''}>published</option>
</select>
<button type="submit">Update</button>
</form>
</td>
</tr>`
    )
    .join('');

  res.type('html').send(`<!doctype html>
<html><head><meta charset='utf-8'><title>bearlychange admin</title></head>
<body style="font-family:system-ui;max-width:980px;margin:32px auto;line-height:1.4;">
<h1>bearlychange admin</h1>
<p>Create draft or publish immediately.</p>
<form method="post" action="/admin/entries" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
<input name="title" placeholder="Title" required />
<input name="slug" placeholder="Slug" required />
<input name="summary" placeholder="Summary" required />
<input name="version" placeholder="Version (e.g. 0.2.0)" required />
<select name="type"><option>new</option><option>improvement</option><option>fix</option><option>breaking</option></select>
<select name="status"><option value="draft">draft</option><option value="published">published</option></select>
<input name="modules" placeholder="modules comma-separated" style="grid-column:1/3" />
<textarea name="machine_summary" placeholder="machine_summary" rows="3" style="grid-column:1/3"></textarea>
<button type="submit" style="grid-column:1/3">Create entry</button>
</form>
<h2>Entries</h2>
<table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;width:100%;font-size:14px;">
<thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Version</th><th>Type</th><th>Action</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`);
});

app.post('/admin/entries', basicAuth, (req, res) => {
  const entries = readEntriesRaw().map(normalize);
  const now = new Date().toISOString();
  const id = `bc_${crypto.randomUUID().slice(0, 8)}`;
  const payload = {
    id,
    slug: req.body.slug,
    title: req.body.title,
    summary: req.body.summary,
    type: req.body.type || 'new',
    version: req.body.version || '0.1.0',
    modules: String(req.body.modules || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    machine_summary: req.body.machine_summary || '',
    status: req.body.status === 'published' ? 'published' : 'draft',
    created_at: now,
    published_at: req.body.status === 'published' ? now : null
  };

  entries.push(payload);
  writeEntries(entries);
  res.redirect('/admin');
});

app.post('/admin/entries/:id/status', basicAuth, (req, res) => {
  const entries = readEntriesRaw().map(normalize);
  const status = req.body.status === 'published' ? 'published' : 'draft';
  const updated = entries.map((e) => {
    if (e.id !== req.params.id) return e;
    const publishTime = status === 'published' && !e.published_at ? new Date().toISOString() : e.published_at;
    return { ...e, status, published_at: publishTime };
  });

  writeEntries(updated);
  res.redirect('/admin');
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
    <li><a href='/admin'>/admin</a> (basic auth)</li>
  </ul>
  <h2>Embed widget</h2>
  <pre>&lt;script src="${req.protocol}://${req.get('host')}/widget/widget.js" defer&gt;&lt;/script&gt;
&lt;bearly-change src="${req.protocol}://${req.get('host')}/api/changelog" limit="3"&gt;&lt;/bearly-change&gt;</pre>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`bearlychange running on http://localhost:${PORT}`);
  console.log(`admin auth: ${ADMIN_USER} / ${ADMIN_PASS}`);
});