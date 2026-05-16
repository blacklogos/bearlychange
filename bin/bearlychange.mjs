#!/usr/bin/env node
// bearlychange CLI — thin HTTP client over the admin/public API.
// All write operations require BEARLYCHANGE_USER/BEARLYCHANGE_PASS (Basic auth).
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { stdin, stdout, stderr } from 'node:process';

const BASE = (process.env.BEARLYCHANGE_URL || 'http://localhost:4322').replace(/\/$/, '');
const USER = process.env.BEARLYCHANGE_USER || 'admin';
const PASS = process.env.BEARLYCHANGE_PASS || '';
// Prefer bearer-token auth when configured — easier to scope/rotate for CI
// than handing out a shared admin password.
const TOKEN = process.env.BEARLYCHANGE_TOKEN || '';

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_FOUND: 3, AUTH: 4, NETWORK: 5 };

function die(code, msg) {
  if (msg) stderr.write(`bearlychange: ${msg}\n`);
  process.exit(code);
}

function authHeader() {
  if (TOKEN) return 'Bearer ' + TOKEN;
  return 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
}

async function request(method, path, body, { auth = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = authHeader();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    });
  } catch (e) {
    die(EXIT.NETWORK, `network error: ${e.message}`);
  }
  if (res.status === 401) {
    const hint = TOKEN ? 'check BEARLYCHANGE_TOKEN' : 'check BEARLYCHANGE_USER/BEARLYCHANGE_PASS';
    die(EXIT.AUTH, `auth failed (${hint})`);
  }
  if (res.status === 404) die(EXIT.NOT_FOUND, 'not found');
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { raw: text }; }
  }
  if (res.status < 200 || res.status >= 300) {
    die(EXIT.FAIL, `request failed (${res.status}): ${text || res.statusText}`);
  }
  return data;
}

async function readStdin() {
  let buf = '';
  for await (const chunk of stdin) buf += chunk;
  return buf;
}

function buildPayloadFromFlags(values) {
  const p = {};
  for (const k of ['title', 'slug', 'summary', 'type', 'version', 'status']) {
    if (values[k] !== undefined) p[k] = values[k];
  }
  if (values['machine-summary'] !== undefined) p.machine_summary = values['machine-summary'];
  if (values.modules !== undefined) {
    p.modules = values.modules.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return p;
}

async function mergeStdinJson(payload, values) {
  if (!values['from-stdin']) return payload;
  const raw = await readStdin();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { die(EXIT.USAGE, 'invalid JSON on stdin'); }
  return { ...payload, ...parsed };
}

function printTable(entries) {
  if (!entries.length) { stdout.write('(no entries)\n'); return; }
  const headers = ['ID', 'STATUS', 'VER', 'TYPE', 'SLUG', 'TITLE'];
  const rows = entries.map((e) => [e.id, e.status, e.version, e.type, e.slug, e.title]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const fmt = (r) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  stdout.write(fmt(headers) + '\n');
  for (const r of rows) stdout.write(fmt(r) + '\n');
}

function printHelp() {
  stdout.write(`bearlychange — changelog CLI

Usage:
  bearlychange <command> [options]
  bc <command> [options]

Commands:
  list [--status draft|published|all] [--json]
  show <id|slug> [--json]
  create --title T --slug S --summary M --version V
         [--type new|improvement|fix|breaking] [--modules a,b]
         [--status draft|published] [--machine-summary X]
         [--from-stdin]   read JSON payload from stdin (merged over flags)
  edit <id> [--title ...] [--slug ...] [--summary ...] [--type ...]
            [--version ...] [--modules a,b] [--status ...]
            [--machine-summary ...] [--from-stdin]
  publish <id>
  unpublish <id>
  rm <id> [--force]

Env (auth: BEARLYCHANGE_TOKEN preferred when set, else Basic):
  BEARLYCHANGE_URL    default http://localhost:4322
  BEARLYCHANGE_TOKEN  bearer token; if set, used instead of Basic
  BEARLYCHANGE_USER   default "admin"
  BEARLYCHANGE_PASS   (required for Basic-auth writes & drafts list)

Examples:
  bc list
  bc list --status all --json
  bc create --title "Fix bug" --slug fix-x --summary "..." --version 0.3.0 --type fix
  echo '{"title":"X","slug":"x","summary":"y","version":"0.4.0"}' | bc create --from-stdin
  bc edit bc_abc12345 --summary "rewrite"
  bc publish bc_abc12345
  bc rm bc_abc12345 --force
`);
}

const optionsSpec = {
  title: { type: 'string' },
  slug: { type: 'string' },
  summary: { type: 'string' },
  version: { type: 'string' },
  type: { type: 'string' },
  modules: { type: 'string' },
  status: { type: 'string' },
  'machine-summary': { type: 'string' },
  'from-stdin': { type: 'boolean' },
  json: { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
};

function parseSub(argv) {
  return parseArgs({ args: argv, options: optionsSpec, allowPositionals: true, strict: false });
}

async function cmdList(values) {
  const status = values.status || 'published';
  let entries;
  if (status === 'published') {
    const data = await request('GET', '/api/changelog');
    entries = data.entries || [];
  } else {
    const data = await request('GET', '/admin/entries', undefined, { auth: true });
    entries = data.entries || [];
    if (status === 'draft') entries = entries.filter((e) => e.status === 'draft');
    else if (status !== 'all') die(EXIT.USAGE, `unknown --status: ${status}`);
  }
  if (values.json) stdout.write(JSON.stringify(entries, null, 2) + '\n');
  else printTable(entries);
}

async function cmdShow(values, positionals) {
  const key = positionals[1];
  if (!key) die(EXIT.USAGE, 'show requires <id|slug>');
  const data = await request('GET', '/admin/entries', undefined, { auth: true });
  const found = (data.entries || []).find((e) => e.id === key || e.slug === key);
  if (!found) die(EXIT.NOT_FOUND, `no entry: ${key}`);
  if (values.json) stdout.write(JSON.stringify(found, null, 2) + '\n');
  else {
    for (const [k, v] of Object.entries(found)) {
      stdout.write(`${k.padEnd(16)} ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
    }
  }
}

async function cmdCreate(values) {
  const payload = await mergeStdinJson(buildPayloadFromFlags(values), values);
  for (const required of ['title', 'slug', 'summary', 'version']) {
    if (!payload[required]) die(EXIT.USAGE, `--${required} required (or supply via --from-stdin)`);
  }
  const data = await request('POST', '/admin/entries', payload, { auth: true });
  if (values.json) stdout.write(JSON.stringify(data.entry, null, 2) + '\n');
  else stdout.write(`created ${data.entry.id} (${data.entry.status})\n`);
}

async function cmdEdit(values, positionals) {
  const id = positionals[1];
  if (!id) die(EXIT.USAGE, 'edit requires <id>');
  const payload = await mergeStdinJson(buildPayloadFromFlags(values), values);
  if (!Object.keys(payload).length) die(EXIT.USAGE, 'no fields to update');
  const data = await request('PATCH', `/admin/entries/${id}`, payload, { auth: true });
  if (values.json) stdout.write(JSON.stringify(data.entry, null, 2) + '\n');
  else stdout.write(`updated ${data.entry.id}\n`);
}

async function cmdSetStatus(id, status, values) {
  const data = await request('PATCH', `/admin/entries/${id}`, { status }, { auth: true });
  if (values.json) stdout.write(JSON.stringify(data.entry, null, 2) + '\n');
  else stdout.write(`${status === 'published' ? 'published' : 'unpublished'} ${data.entry.id}\n`);
}

async function cmdRm(values, positionals) {
  const id = positionals[1];
  if (!id) die(EXIT.USAGE, 'rm requires <id>');
  if (!values.force) {
    if (!stdin.isTTY) die(EXIT.USAGE, 'non-TTY delete requires --force');
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question(`delete ${id}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') { stdout.write('aborted\n'); return; }
  }
  const data = await request('DELETE', `/admin/entries/${id}`, undefined, { auth: true });
  if (values.json) stdout.write(JSON.stringify(data.entry, null, 2) + '\n');
  else stdout.write(`deleted ${id}\n`);
}

async function printVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  stdout.write(`${pkg.version}\n`);
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') { printHelp(); return; }
  if (sub === '--version' || sub === '-V') { await printVersion(); return; }

  const { values, positionals } = parseSub([sub, ...rest]);
  if (values.help) { printHelp(); return; }

  switch (sub) {
    case 'list': return cmdList(values);
    case 'show': return cmdShow(values, positionals);
    case 'create': return cmdCreate(values);
    case 'edit': return cmdEdit(values, positionals);
    case 'publish': {
      const id = positionals[1]; if (!id) die(EXIT.USAGE, 'publish requires <id>');
      return cmdSetStatus(id, 'published', values);
    }
    case 'unpublish': {
      const id = positionals[1]; if (!id) die(EXIT.USAGE, 'unpublish requires <id>');
      return cmdSetStatus(id, 'draft', values);
    }
    case 'rm':
    case 'delete':
      return cmdRm(values, positionals);
    default:
      die(EXIT.USAGE, `unknown command: ${sub}`);
  }
}

main().catch((e) => die(EXIT.FAIL, e?.message || String(e)));
