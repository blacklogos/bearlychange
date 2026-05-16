// Cross-cutting helpers adapted for Hono on Cloudflare Workers.
// Auth credentials come from c.env (bindings + secrets), not process.env.

export function wantsJson(c) {
  const ct = c.req.header('content-type') || '';
  const accept = c.req.header('accept') || '';
  return ct.includes('application/json') || accept.includes('application/json');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

// Constant-time string compare in pure JS — avoids reaching for node:crypto
// and the nodejs_compat flag for this one helper. Length is short-circuited
// to keep the contract simple.
function timingSafeStrEq(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function decodeBasic(header) {
  const b64 = header.slice('Basic '.length).trim();
  let decoded;
  try {
    decoded = atob(b64);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  return [decoded.slice(0, colon), decoded.slice(colon + 1)];
}

// Admin auth — Basic (humans / browser session) plus Bearer (CI / agents)
// when BEARLYCHANGE_TOKEN is configured. Bearer naturally avoids the CSRF
// surface since browsers don't auto-attach it.
export const basicAuth = async (c, next) => {
  const env = c.env || {};
  const adminUser = env.ADMIN_USER || 'admin';
  const adminPass = env.ADMIN_PASS || '';
  const token = env.BEARLYCHANGE_TOKEN || '';
  const auth = c.req.header('authorization') || '';
  const realm = token
    ? 'Bearer realm="bearlychange-admin", Basic realm="bearlychange-admin"'
    : 'Basic realm="bearlychange-admin"';

  if (token && auth.startsWith('Bearer ')) {
    const provided = auth.slice('Bearer '.length).trim();
    if (timingSafeStrEq(provided, token)) return next();
    return c.text('Invalid token', 401, { 'WWW-Authenticate': realm });
  }

  if (!auth.startsWith('Basic ')) {
    return c.text('Authentication required', 401, { 'WWW-Authenticate': realm });
  }
  const creds = decodeBasic(auth);
  if (!creds) {
    return c.text('Invalid credentials', 401, { 'WWW-Authenticate': realm });
  }
  const [user, pass] = creds;
  if (!timingSafeStrEq(user, adminUser) || !timingSafeStrEq(pass, adminPass)) {
    return c.text('Invalid credentials', 401, { 'WWW-Authenticate': realm });
  }
  return next();
};

// CSRF guard for admin mutating routes. Same logic as the Express version:
// reject if Origin/Referer is present but doesn't match host. CLI/curl
// (no Origin/Referer) passes — those carry creds intentionally, not via
// browser session reuse.
export const sameOrigin = async (c, next) => {
  const expected = new URL(c.req.url).origin;
  const origin = c.req.header('origin');
  const referer = c.req.header('referer');
  if (origin !== undefined && origin !== expected) {
    return c.text('CSRF: bad origin', 403);
  }
  if (
    origin === undefined &&
    referer &&
    !referer.startsWith(expected + '/') &&
    referer !== expected
  ) {
    return c.text('CSRF: bad referer', 403);
  }
  return next();
};
