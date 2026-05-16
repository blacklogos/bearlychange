// Admin surface: HTML panel + JSON API used by the CLI/agents. Every
// mutating route runs basicAuth → sameOrigin → validation inside the write
// lock, so unauthenticated, cross-origin, or invalid requests can't slip
// through.
import express from 'express';
import crypto from 'crypto';
import {
  mutateEntries,
  readEntries,
  normalize,
  applyEntryPatch,
  parseModules
} from '../lib/entries-store.mjs';
import { wantsJson, escapeHtml, basicAuth, sameOrigin } from '../lib/http-helpers.mjs';
import { validateEntryCreate, validateEntryPatch, TYPES } from '../lib/validation.mjs';

const router = express.Router();

function respondValidation(req, res, errors) {
  if (wantsJson(req)) return res.status(400).json({ ok: false, errors });
  const lines = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('\n');
  return res.status(400).type('text/plain').send(`Validation failed:\n${lines}`);
}

// JSON list of all entries (including drafts) for CLI/agent clients.
router.get('/admin/entries', basicAuth, (req, res) => {
  const entries = readEntries().map(normalize);
  res.json({ count: entries.length, entries });
});

router.get('/admin', basicAuth, (req, res) => {
  const entries = readEntries().map(normalize);
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

router.post('/admin/entries', basicAuth, sameOrigin, async (req, res) => {
  // Validation runs inside the write lock so two concurrent creates can't
  // both win the slug-uniqueness check and then both write.
  const now = new Date().toISOString();
  const draftPayload = {
    id: `bc_${crypto.randomUUID().slice(0, 8)}`,
    slug: req.body.slug,
    title: req.body.title,
    summary: req.body.summary,
    type: req.body.type || 'new',
    version: req.body.version || '0.1.0',
    modules: parseModules(req.body.modules),
    machine_summary: req.body.machine_summary || '',
    status: req.body.status === 'published' ? 'published' : 'draft',
    created_at: now,
    published_at: req.body.status === 'published' ? now : null
  };

  const result = await mutateEntries((entries) => {
    const errors = validateEntryCreate(req.body, entries);
    if (errors) return { errors };
    entries.push(draftPayload);
    return { entry: draftPayload };
  });

  if (result.errors) return respondValidation(req, res, result.errors);
  if (wantsJson(req)) return res.status(201).json({ ok: true, entry: result.entry });
  res.redirect('/admin');
});

router.post('/admin/entries/:id/status', basicAuth, sameOrigin, async (req, res) => {
  const status = req.body.status === 'published' ? 'published' : 'draft';
  const result = await mutateEntries((entries) => {
    const idx = entries.findIndex((e) => e.id === req.params.id);
    if (idx === -1) return null;
    const publishTime =
      status === 'published' && !entries[idx].published_at
        ? new Date().toISOString()
        : entries[idx].published_at;
    entries[idx] = { ...entries[idx], status, published_at: publishTime };
    return entries[idx];
  });

  if (!result) {
    if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(404).send('Not found');
  }
  if (wantsJson(req)) return res.json({ ok: true, entry: result });
  res.redirect('/admin');
});

// Full edit of an entry. Accepts a partial JSON body — only provided
// fields are overwritten. Publishing a draft auto-stamps published_at.
router.patch('/admin/entries/:id', basicAuth, sameOrigin, async (req, res) => {
  const result = await mutateEntries((entries) => {
    const idx = entries.findIndex((e) => e.id === req.params.id);
    if (idx === -1) return { notFound: true };
    const errors = validateEntryPatch(req.body || {}, entries, req.params.id);
    if (errors) return { errors };
    entries[idx] = applyEntryPatch(entries[idx], req.body || {});
    return { entry: entries[idx] };
  });

  if (result.notFound) {
    if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(404).send('Not found');
  }
  if (result.errors) return respondValidation(req, res, result.errors);
  if (wantsJson(req)) return res.json({ ok: true, entry: result.entry });
  res.redirect('/admin');
});

router.delete('/admin/entries/:id', basicAuth, sameOrigin, async (req, res) => {
  const result = await mutateEntries((entries) => {
    const idx = entries.findIndex((e) => e.id === req.params.id);
    if (idx === -1) return null;
    const [removed] = entries.splice(idx, 1);
    return removed;
  });

  if (!result) {
    if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(404).send('Not found');
  }
  if (wantsJson(req)) return res.json({ ok: true, entry: result });
  res.redirect('/admin');
});

// HTML edit form for an entry — pre-fills current values.
router.get('/admin/entries/:id/edit', basicAuth, (req, res) => {
  const entry = readEntries().map(normalize).find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).send('Not found');

  res.type('html').send(`<!doctype html>
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
router.post('/admin/entries/:id', basicAuth, sameOrigin, async (req, res) => {
  const result = await mutateEntries((entries) => {
    const idx = entries.findIndex((e) => e.id === req.params.id);
    if (idx === -1) return { notFound: true };
    const errors = validateEntryPatch(req.body || {}, entries, req.params.id);
    if (errors) return { errors };
    entries[idx] = applyEntryPatch(entries[idx], req.body || {});
    return { ok: true };
  });
  if (result.notFound) return res.status(404).send('Not found');
  if (result.errors) return respondValidation(req, res, result.errors);
  res.redirect('/admin');
});

// Form shim for delete (HTML forms can't issue DELETE).
router.post('/admin/entries/:id/delete', basicAuth, sameOrigin, async (req, res) => {
  const ok = await mutateEntries((entries) => {
    const idx = entries.findIndex((e) => e.id === req.params.id);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    return true;
  });
  if (!ok) return res.status(404).send('Not found');
  res.redirect('/admin');
});

export default router;
