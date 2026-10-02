import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { parseCookies } from './auth.js';

const TICKET_MS = 60_000;
const COOKIE_MS = 2 * 3600_000;

/**
 * Access to the car's own web UI (live view, recordings, sentry) happens on a separate host
 * (VIEW_HOST). The app issues a one-time ticket; the view host swaps it for a signed cookie that is
 * re-validated on EVERY request against the database (owner, account state, session version).
 */
export function createViewSessions({ secret, accounts, now = () => Date.now() }) {
  const tickets = new Map();                                     // ticket -> { userId, deviceId, exp }
  const sign = (body) => createHmac('sha256', secret).update(`view:${body}`).digest('base64url');
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const sweep = () => { for (const [k, v] of tickets) if (v.exp <= now()) tickets.delete(k); };

  return {
    cookieMaxAge: COOKIE_MS / 1000,
    issueTicket(userId, deviceId) {
      if (!accounts.owns(userId, deviceId)) return null;
      sweep();
      const t = randomBytes(24).toString('base64url');
      tickets.set(t, { userId, deviceId, exp: now() + TICKET_MS });
      return t;
    },
    /** One-time: returns the cookie value, or null. */
    redeem(ticket) {
      const v = tickets.get(ticket); tickets.delete(ticket);
      if (!v || v.exp <= now() || !accounts.owns(v.userId, v.deviceId)) return null;
      const body = Buffer.from(JSON.stringify({ u: v.userId, d: v.deviceId, v: accounts.sessionVersion(v.userId), e: now() + COOKIE_MS })).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    /** Used by the proxy on every request. */
    authorize(req) {
      const raw = parseCookies(req.headers.cookie).eg_view;
      if (!raw) return null;
      const [body, sig] = raw.split('.');
      if (!body || !sig || !eq(sig, sign(body))) return null;
      let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
      if (!p || p.e <= now() || accounts.sessionVersion(p.u) !== p.v || !accounts.owns(p.u, p.d)) return null;
      return { userId: p.u, deviceId: p.d, name: accounts.getDevice(p.d)?.name };
    },
  };
}
