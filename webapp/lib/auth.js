import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a, b) {
  return timingSafeEqual(sha(a), sha(b));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Dashboard auth: Bearer header or the HttpOnly `eg_token` cookie set by /api/login. */
export function isDashboardAuthed(req, cfg) {
  if (cfg.allowInsecure && !cfg.dashboardToken) return true;
  const t = bearer(req) || parseCookies(req.headers.cookie).eg_token || '';
  return !!t && !!cfg.dashboardToken && safeEqual(t, cfg.dashboardToken);
}

export function isIngestAuthed(req, cfg) {
  if (cfg.allowInsecure && !cfg.ingestToken) return true;
  const t = bearer(req);
  return !!t && !!cfg.ingestToken && safeEqual(t, cfg.ingestToken);
}

/** Tiny fixed-window limiter for the login endpoint. */
export function createLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const e = hits.get(key);
    if (!e || t - e.start > windowMs) { hits.set(key, { start: t, n: 1 }); return true; }
    e.n += 1;
    return e.n <= max;
  };
}
