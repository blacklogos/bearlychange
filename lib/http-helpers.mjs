// Cross-cutting HTTP helpers: content negotiation, HTML escaping, admin
// auth (Basic for humans, Bearer for CI/agents), and a same-origin CSRF
// guard for browser-driven admin mutations.
import crypto from 'node:crypto';

export const ADMIN_USER = process.env.ADMIN_USER || 'admin';
export const ADMIN_PASS = process.env.ADMIN_PASS || 'bearlychange';
// Optional shared bearer token. When set, `Authorization: Bearer <token>`
// is accepted in addition to Basic. Leave empty to disable bearer entirely.
export const ADMIN_TOKEN = process.env.BEARLYCHANGE_TOKEN || '';

export function wantsJson(req) {
  return req.is('application/json') || (req.headers.accept || '').includes('application/json');
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

// Constant-time string comparison — avoids leaking match-length via timing.
// Equalize byte length before timingSafeEqual; mismatched lengths short-circuit.
function timingSafeStrEq(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Admin auth. Accepts Basic (humans / browser session) and, when
// BEARLYCHANGE_TOKEN is configured, Bearer (CI / agents). Bearer is
// preferred for non-browser callers — easier to rotate, no cached creds
// in browsers, and naturally avoids the CSRF surface entirely.
export function basicAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const wwwAuth = ADMIN_TOKEN
    ? 'Bearer realm="bearlychange-admin", Basic realm="bearlychange-admin"'
    : 'Basic realm="bearlychange-admin"';

  if (ADMIN_TOKEN && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (timingSafeStrEq(token, ADMIN_TOKEN)) return next();
    res.set('WWW-Authenticate', wwwAuth);
    return res.status(401).send('Invalid token');
  }

  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', wwwAuth);
    return res.status(401).send('Authentication required');
  }

  const [user, pass = ''] = Buffer.from(auth.split(' ')[1] || '', 'base64')
    .toString()
    .split(':');
  if (!timingSafeStrEq(user, ADMIN_USER) || !timingSafeStrEq(pass, ADMIN_PASS)) {
    res.set('WWW-Authenticate', wwwAuth);
    return res.status(401).send('Invalid credentials');
  }
  return next();
}

// CSRF guard for admin mutating routes. A malicious page in another tab
// could reuse the browser's cached Basic creds via a same-site form POST,
// so reject when Origin/Referer is present but doesn't match the host.
// CLI/curl clients send neither — they're carrying creds intentionally.
export function sameOrigin(req, res, next) {
  const expected = `${req.protocol}://${req.get('host')}`;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin !== undefined && origin !== expected) {
    return res.status(403).send('CSRF: bad origin');
  }
  if (origin === undefined && referer && !referer.startsWith(expected + '/') && referer !== expected) {
    return res.status(403).send('CSRF: bad referer');
  }
  return next();
}
