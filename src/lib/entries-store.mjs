// D1-backed entry store. All disk persistence lives in the Cloudflare D1
// database bound as `DB`. Callers pass the binding so handlers stay testable
// against any compatible interface (e.g. miniflare's in-memory D1).
//
// Storage shape note: `modules` is serialized to JSON in the `modules_json`
// column. The boundary functions translate to/from the canonical entry
// shape that the API exposes (with `modules` as an array, no
// `modules_json`).

function rowToEntry({ modules_json, ...rest }) {
  return { ...rest, modules: JSON.parse(modules_json || '[]') };
}

function modulesToJson(value) {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(String).map((s) => s.trim()).filter(Boolean));
  }
  return JSON.stringify(
    String(value || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
}

// Reads -----------------------------------------------------------------------

export async function listPublished(db) {
  const { results } = await db
    .prepare(
      "SELECT * FROM entries WHERE status = 'published' " +
        'ORDER BY datetime(published_at) DESC'
    )
    .all();
  return results.map(rowToEntry);
}

export async function listAll(db) {
  // Sort by published_at when present, else created_at — same total ordering
  // the JSON-file backend used.
  const { results } = await db
    .prepare(
      'SELECT * FROM entries ' +
        'ORDER BY datetime(COALESCE(published_at, created_at)) DESC'
    )
    .all();
  return results.map(rowToEntry);
}

export async function getPublishedBySlug(db, slug) {
  const row = await db
    .prepare("SELECT * FROM entries WHERE slug = ?1 AND status = 'published'")
    .bind(slug)
    .first();
  return row ? rowToEntry(row) : null;
}

export async function getById(db, id) {
  const row = await db.prepare('SELECT * FROM entries WHERE id = ?1').bind(id).first();
  return row ? rowToEntry(row) : null;
}

// Writes (used in phase 3) ----------------------------------------------------

export async function insertEntry(db, entry) {
  await db
    .prepare(
      `INSERT INTO entries
        (id, slug, title, summary, type, version, modules_json, machine_summary, status, created_at, published_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    )
    .bind(
      entry.id,
      entry.slug,
      entry.title,
      entry.summary,
      entry.type,
      entry.version,
      modulesToJson(entry.modules),
      entry.machine_summary || '',
      entry.status,
      entry.created_at,
      entry.published_at
    )
    .run();
}

export async function updateEntry(db, id, patch) {
  const current = await getById(db, id);
  if (!current) return null;
  const next = { ...current };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.slug !== undefined) next.slug = patch.slug;
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.version !== undefined) next.version = patch.version;
  if (patch.modules !== undefined) next.modules = patch.modules;
  if (patch.machine_summary !== undefined) next.machine_summary = patch.machine_summary;
  if (patch.status !== undefined) {
    next.status = patch.status === 'published' ? 'published' : 'draft';
    if (next.status === 'published' && !next.published_at) {
      next.published_at = new Date().toISOString();
    }
  }

  await db
    .prepare(
      `UPDATE entries SET
        slug = ?1, title = ?2, summary = ?3, type = ?4, version = ?5,
        modules_json = ?6, machine_summary = ?7, status = ?8,
        created_at = ?9, published_at = ?10
       WHERE id = ?11`
    )
    .bind(
      next.slug,
      next.title,
      next.summary,
      next.type,
      next.version,
      modulesToJson(next.modules),
      next.machine_summary || '',
      next.status,
      next.created_at,
      next.published_at,
      id
    )
    .run();

  return next;
}

export async function deleteEntry(db, id) {
  const current = await getById(db, id);
  if (!current) return null;
  await db.prepare('DELETE FROM entries WHERE id = ?1').bind(id).run();
  return current;
}

export async function slugTaken(db, slug, excludeId = null) {
  const row = excludeId
    ? await db
        .prepare('SELECT 1 FROM entries WHERE slug = ?1 AND id != ?2')
        .bind(slug, excludeId)
        .first()
    : await db.prepare('SELECT 1 FROM entries WHERE slug = ?1').bind(slug).first();
  return row !== null;
}
