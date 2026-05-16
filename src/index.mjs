// Worker entry. Mounts the Hono app onto Cloudflare Workers' request handler.
// Routes live under src/routes/*; shared helpers under src/lib/*.
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => {
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

export default app;
