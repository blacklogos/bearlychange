// File-backed entry store. All disk I/O for entries flows through here, and
// every mutating route goes through `mutateEntries` so concurrent handlers
// are serialized on a single in-process promise chain.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// Default to <repo>/data/entries.json (one level up from lib/). Deploys
// should point BEARLYCHANGE_DATA at a path on a persistent volume so a
// redeploy doesn't overwrite live data.
const defaultDbPath = path.resolve(moduleDir, '..', 'data', 'entries.json');
export const dbPath = process.env.BEARLYCHANGE_DATA
  ? path.resolve(process.env.BEARLYCHANGE_DATA)
  : defaultDbPath;

function readEntriesRaw() {
  const raw = fs.readFileSync(dbPath, 'utf8');
  return JSON.parse(raw);
}

export function readEntries() {
  return readEntriesRaw().sort(
    (a, b) =>
      new Date(b.published_at || b.created_at || 0) -
      new Date(a.published_at || a.created_at || 0)
  );
}

function writeEntries(entries) {
  fs.writeFileSync(dbPath, JSON.stringify(entries, null, 2));
}

export function normalize(entry) {
  return {
    ...entry,
    status: entry.status || 'published',
    created_at: entry.created_at || entry.published_at || new Date().toISOString()
  };
}

export function onlyPublished(entries) {
  return entries.filter((e) => (e.status || 'published') === 'published');
}

export function parseModules(val) {
  if (Array.isArray(val)) return val.map(String).map((s) => s.trim()).filter(Boolean);
  return String(val || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

// Build the next entry from a partial body. Used by PATCH and the HTML form
// shim so they stay in lockstep on which fields are updatable.
export function applyEntryPatch(current, body) {
  const next = { ...current };
  if (body.title !== undefined) next.title = body.title;
  if (body.slug !== undefined) next.slug = body.slug;
  if (body.summary !== undefined) next.summary = body.summary;
  if (body.type !== undefined) next.type = body.type;
  if (body.version !== undefined) next.version = body.version;
  if (body.modules !== undefined) next.modules = parseModules(body.modules);
  if (body.machine_summary !== undefined) next.machine_summary = body.machine_summary;
  if (body.status !== undefined) {
    next.status = body.status === 'published' ? 'published' : 'draft';
    if (next.status === 'published' && !next.published_at) {
      next.published_at = new Date().toISOString();
    }
  }
  return next;
}

// Single-process promise chain. Express is single-process, but handlers
// interleave at await points — without this two read-modify-write requests
// could overwrite each other's changes.
let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {});
  return next;
}

// Atomic read-modify-write. `fn(entries)` may mutate the array in place
// and may return any value, which is forwarded to the caller as `result`.
// Disk is always rewritten — callers that detect no-ops (e.g. 404) pay a
// cheap idempotent rewrite, which is preferable to a more complex API.
export function mutateEntries(fn) {
  return withWriteLock(() => {
    const entries = readEntriesRaw().map(normalize);
    const result = fn(entries);
    writeEntries(entries);
    return result;
  });
}
