// Admin surface for the Workers runtime. Every mutating route runs
// basicAuth → sameOrigin → validation, with the D1 UNIQUE(slug) constraint
// as a safety net for any race that slips past validation (two concurrent
// creates both validating against the same pre-insert snapshot).
import { Hono } from 'hono';
import {
  listAll,
  getById,
  insertEntry,
  updateEntry,
  deleteEntry
} from '../lib/entries-store.mjs';
import { wantsJson, escapeHtml, basicAuth, sameOrigin } from '../lib/http-helpers.mjs';
import { validateEntryCreate, validateEntryPatch, TYPES } from '../lib/validation.mjs';

const router = new Hono();

// Body parser: JSON when the request says so, else form data.
async function parseBody(c) {
  const ct = c.req.header('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  }
  return await c.req.parseBody();
}

function respondValidation(c, errors) {
  if (wantsJson(c)) return c.json({ ok: false, errors }, 400);
  const lines = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('\n');
  return c.text(`Validation failed:\n${lines}`, 400, { 'content-type': 'text/plain; charset=utf-8' });
}

function isUniqueSlugError(err) {
  return String(err && err.message).includes('UNIQUE constraint failed: entries.slug');
}

router.use('/admin/*', async (c, next) => {
  // basicAuth gates the entire admin tree; mutating routes additionally
  // apply sameOrigin inline so curl/CLI (no Origin) stays usable.
  return basicAuth(c, next);
});

// JSON list of all entries (including drafts) for CLI/agent clients.
router.get('/admin/entries', async (c) => {
  const entries = await listAll(c.env.DB);
  return c.json({ count: entries.length, entries });
});

router.get('/admin', async (c) => {
  const entries = await listAll(c.env.DB);
  const rows = entries
    .map(
      (e) => `<tr>
<td>${escapeHtml(e.id)}</td>
<td>${escapeHtml(e.title)}</td>
<td>${escapeHtml(e.status)}</td>
<td>${escapeHtml(e.version)}</td>
<td>${escapeHtml(e.type)}</td>
<td style="white-space:nowrap;">
<form method="post" action="/admin/entries/${e.id}/status" style="display:inline-flex;gap:4px;">
<select name="status">
<option value="draft" ${e.status === 'draft' ? 'selected' : ''}>draft</option>
<option value="published" ${e.status === 'published' ? 'selected' : ''}>published</option>
</select>
<button type="submit">Update</button>
</form>
<a href="/admin/entries/${e.id}/edit" style="margin-left:6px;">Edit</a>
<form method="post" action="/admin/entries/${e.id}/delete" style="display:inline;margin-left:6px;" onsubmit="return confirm('Delete ${escapeHtml(e.id)}?');">
<button type="submit" style="color:#b00;">Delete</button>
</form>
</td>
</tr>`
    )
    .join('');

  return c.html(`<!doctype html>
<html><head><meta charset='utf-8'><title>bearlychange admin</title></head>
<body style="font-family:system-ui;max-width:980px;margin:32px auto;line-height:1.4;">
<h1>bearlychange admin</h1>
<p>Create draft or publish immediately.</p>
<form method="post" action="/admin/entries" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
<input name="title" placeholder="Title" required />
<input name="slug" placeholder="Slug" required />
<input name="summary" placeholder="Summary" required />
<input name="version" placeholder="Version (e.g. 0.2.0)" required />
<select name="type">${TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
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

router.post('/admin/entries', sameOrigin, async (c) => {
  const body = await parseBody(c);

  // App-level validation first (friendly errors). Listing entries for the
  // uniqueness check costs a single SELECT — fine for the volumes we expect.
  const existing = await listAll(c.env.DB);
  const errors = validateEntryCreate(body, existing);
  if (errors) return respondValidation(c, errors);

  const now = new Date().toISOString();
  const payload = {
    id: `bc_${crypto.randomUUID().slice(0, 8)}`,
    slug: body.slug,
    title: body.title,
    summary: body.summary,
    type: body.type || 'new',
    version: body.version || '0.1.0',
    modules: body.modules,
    machine_summary: body.machine_summary || '',
    status: body.status === 'published' ? 'published' : 'draft',
    created_at: now,
    published_at: body.status === 'published' ? now : null
  };

  try {
    await insertEntry(c.env.DB, payload);
  } catch (err) {
    // Safety net: another writer slipped a row in between our validate
    // and our INSERT. UNIQUE(slug) caught it — surface the same error.
    if (isUniqueSlugError(err)) return respondValidation(c, { slug: 'already in use' });
    throw err;
  }

  if (wantsJson(c)) return c.json({ ok: true, entry: payload }, 201);
  return c.redirect('/admin');
});

router.post('/admin/entries/:id/status', sameOrigin, async (c) => {
  const body = await parseBody(c);
  const status = body.status === 'published' ? 'published' : 'draft';
  const updated = await updateEntry(c.env.DB, c.req.param('id'), { status });

  if (!updated) {
    if (wantsJson(c)) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.text('Not found', 404);
  }
  if (wantsJson(c)) return c.json({ ok: true, entry: updated });
  return c.redirect('/admin');
});

// Full edit of an entry. Accepts a partial JSON body — only provided
// fields are overwritten. Publishing a draft auto-stamps published_at.
router.patch('/admin/entries/:id', sameOrigin, async (c) => {
  const body = await parseBody(c);
  const id = c.req.param('id');

  const current = await getById(c.env.DB, id);
  if (!current) {
    if (wantsJson(c)) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.text('Not found', 404);
  }

  const existing = await listAll(c.env.DB);
  const errors = validateEntryPatch(body, existing, id);
  if (errors) return respondValidation(c, errors);

  let updated;
  try {
    updated = await updateEntry(c.env.DB, id, body);
  } catch (err) {
    if (isUniqueSlugError(err)) return respondValidation(c, { slug: 'already in use' });
    throw err;
  }

  if (wantsJson(c)) return c.json({ ok: true, entry: updated });
  return c.redirect('/admin');
});

router.delete('/admin/entries/:id', sameOrigin, async (c) => {
  const removed = await deleteEntry(c.env.DB, c.req.param('id'));
  if (!removed) {
    if (wantsJson(c)) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.text('Not found', 404);
  }
  if (wantsJson(c)) return c.json({ ok: true, entry: removed });
  return c.redirect('/admin');
});

// HTML edit form for an entry — pre-fills current values.
router.get('/admin/entries/:id/edit', async (c) => {
  const entry = await getById(c.env.DB, c.req.param('id'));
  if (!entry) return c.text('Not found', 404);

  return c.html(`<!doctype html>
<html><head><meta charset='utf-8'><title>edit ${escapeHtml(entry.id)}</title></head>
<body style="font-family:system-ui;max-width:760px;margin:32px auto;line-height:1.4;">
<p><a href="/admin">&larr; back</a></p>
<h1>Edit ${escapeHtml(entry.id)}</h1>
<form method="post" action="/admin/entries/${entry.id}" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
<input name="title" value="${escapeHtml(entry.title)}" placeholder="Title" required />
<input name="slug" value="${escapeHtml(entry.slug)}" placeholder="Slug" required />
<input name="summary" value="${escapeHtml(entry.summary)}" placeholder="Summary" required style="grid-column:1/3" />
<input name="version" value="${escapeHtml(entry.version)}" placeholder="Version" required />
<select name="type">
${TYPES.map((t) => `<option ${t === entry.type ? 'selected' : ''}>${t}</option>`).join('')}
</select>
<select name="status">
<option value="draft" ${entry.status === 'draft' ? 'selected' : ''}>draft</option>
<option value="published" ${entry.status === 'published' ? 'selected' : ''}>published</option>
</select>
<input name="modules" value="${escapeHtml((entry.modules || []).join(', '))}" placeholder="modules comma-separated" style="grid-column:1/3" />
<textarea name="machine_summary" placeholder="machine_summary" rows="3" style="grid-column:1/3">${escapeHtml(entry.machine_summary)}</textarea>
<button type="submit" style="grid-column:1/3">Save</button>
</form>
</body></html>`);
});

// Form shim for the edit page — applies the same patch + validation as PATCH.
router.post('/admin/entries/:id', sameOrigin, async (c) => {
  const body = await parseBody(c);
  const id = c.req.param('id');

  const current = await getById(c.env.DB, id);
  if (!current) return c.text('Not found', 404);

  const existing = await listAll(c.env.DB);
  const errors = validateEntryPatch(body, existing, id);
  if (errors) return respondValidation(c, errors);

  try {
    await updateEntry(c.env.DB, id, body);
  } catch (err) {
    if (isUniqueSlugError(err)) return respondValidation(c, { slug: 'already in use' });
    throw err;
  }
  return c.redirect('/admin');
});

// Form shim for delete (HTML forms can't issue DELETE).
router.post('/admin/entries/:id/delete', sameOrigin, async (c) => {
  const removed = await deleteEntry(c.env.DB, c.req.param('id'));
  if (!removed) return c.text('Not found', 404);
  return c.redirect('/admin');
});

export default router;
