-- bearlychange schema. Single `entries` table; `modules` stored as a JSON
-- string in a TEXT column to keep the schema flat. The UNIQUE index on
-- `slug` makes our app-level slug-uniqueness check a hard DB constraint —
-- the app still validates first so users get a friendly error, but a race
-- that slips past validation will still fail cleanly at the DB.

CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('new','improvement','fix','breaking')),
  version         TEXT NOT NULL,
  modules_json    TEXT NOT NULL DEFAULT '[]',
  machine_summary TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at      TEXT NOT NULL,
  published_at    TEXT
);

CREATE INDEX IF NOT EXISTS entries_published_idx
  ON entries(status, published_at DESC);

-- Seed: preserve the two original entries so URLs/feeds keep working.
INSERT OR IGNORE INTO entries
  (id, slug, title, summary, type, version, modules_json, machine_summary, status, created_at, published_at)
VALUES
  ('bc_001',
   'launch-mvp-widget',
   'Launch embed widget MVP',
   'Added a framework-agnostic web component for Astro and any static site.',
   'new',
   '0.1.0',
   '["widget","embed"]',
   'Web component widget available at /widget/widget.js using <bearly-change> tag.',
   'published',
   '2026-03-12T06:40:00.000Z',
   '2026-03-12T06:40:00.000Z'),
  ('bc_002',
   'add-ai-readable-feeds',
   'Add JSON feed and RSS',
   'Exposed /feed.json and /rss.xml so AI agents can monitor updates easily.',
   'improvement',
   '0.1.0',
   '["api","feeds"]',
   'Machine-readable feeds now available for polling and subscriptions.',
   'published',
   '2026-03-12T06:45:00.000Z',
   '2026-03-12T06:45:00.000Z');
