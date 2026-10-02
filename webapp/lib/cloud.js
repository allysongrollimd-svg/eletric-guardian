import { createLimiter, parseCookies } from './auth.js';
import { AccountError } from './accounts.js';
import { createViewSessions } from './viewsession.js';
import { createBilling } from './billing.js';
import { createAdmin } from './admin.js';
import { ProviderError } from './infinitepay.js';

const SESSION_COOKIE = 'eg_session';
// Pages of the car's own web UI that the dashboard can open directly.
const VIEW_PAGES = new Set(['/', '/live-view.html', '/recording.html', '/surveillance.html', '/parking.html', '/events.html', '/performance.html']);

/**
 * Multi-tenant ("accounts") mode: users, cars bound to a chassis (VIN), and the routes around them.
 * app.js asks this object who the caller is and which cars they may see; everything else is unchanged.
 */
export function createCloud({ cfg, accounts, store, hub, broker, secret, provider }) {
  const billing = createBilling({ db: accounts.db, accounts, cfg, secret, now: accounts.now, provider });
  const admin = createAdmin({ db: accounts.db, accounts, billing, now: accounts.now });
  const view = createViewSessions({ secret, accounts, isAllowed: (deviceId) => billing.allowed(deviceId) });
  const limits = {
    signup: createLimiter(5, 3600_000), login: createLimiter(10, 60_000), loginEmail: createLimiter(10, 15 * 60_000),
    claim: createLimiter(10, 60_000), webhook: createLimiter(120, 60_000), checkout: createLimiter(10, 60_000), register: createLimiter(20, 3600_000), status: createLimiter(120, 60_000),
  };

  const cloud = {
    mode: 'accounts', accounts, hub, broker, view, billing, admin,
    appHost: cfg.appHost || null, viewHost: cfg.viewHost ? cfg.viewHost.toLowerCase() : null,

    userFrom(req) { return accounts.userFromSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]); },
    can(user, deviceId) { return !!user && accounts.owns(user.id, deviceId); },

    /** Store view + account data (name, VIN) + tunnel presence. */
    decorate(v) {
      const d = accounts.getDevice(v.device);
      return { ...v, name: d?.name || v.device, vin: d?.vin || null, billing: billing.stateForDevice(v.device), tunnel: hub.isConnected(v.device), online: v.online || hub.isConnected(v.device) || (broker?.connected(v.device) ?? false) };
    },
    /** Every car the user owns, even those that never sent telemetry. */
    listFor(user) {
      return accounts.listCars(user.id).map((c) => {
        const live = store.get(c.id);
        return cloud.decorate(live || { device: c.id, online: false, lastSeen: c.lastSeen, data: {} });
      });
    },
    viewFor(user, deviceId) { const v = store.get(deviceId); return cloud.can(user, deviceId) && v ? cloud.decorate(v) : null; },
  };

  /** Handles /api/config, /api/auth/*, /api/me, /api/cars*, /api/device/*. Returns true if it answered. */
  cloud.handleApi = async (req, res, { path, json, readBody, clientIp, secureCookie, cookies }) => {
    const send = (code, body, headers) => json(res, code, body, headers);
    const jsonOnly = () => String(req.headers['content-type'] || '').startsWith('application/json');
    const body = async (limit = 8 * 1024) => { try { return JSON.parse(await readBody(req, limit)); } catch (e) { throw new AccountError('bad_body', 'Corpo inválido.', e.code === 413 ? 413 : 400); } };
    const sessionCookie = (token, maxAge) => `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie(req)}`;
    const ip = clientIp(req);

    try {
      if (path === '/api/config' && req.method === 'GET') return send(200, { mode: 'accounts', signup: !!cfg.allowSignup, brand: 'Electric Guardian' }), true;

      // ---- car-facing (bearer = deviceId.deviceKey) ----
      if (path === '/api/device/register' && req.method === 'POST') {
        if (!limits.register(ip)) return send(429, { error: 'rate limit' }), true;
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        const b = await body();
        const s = accounts.registerDevice({ deviceId: b.deviceId, deviceKey: b.deviceKey, vin: b.vin, appVersion: b.appVersion });
        return send(200, { ...s, mqtt: cfg.mqttPublic || null }), true;
      }
      if (path === '/api/device/status' && req.method === 'GET') {
        if (!limits.status(ip)) return send(429, { error: 'rate limit' }), true;
        const m = /^Bearer ([a-f0-9-]{32,40})\.(.{32,200})$/i.exec(req.headers.authorization || '');
        const d = m && accounts.deviceAuth(m[1], m[2]);
        if (!d) return send(401, { error: 'unauthorized' }), true;
        accounts.touch(d.id);
        return send(200, { ...accounts.pairingState(d.id), mqtt: cfg.mqttPublic || null }), true;
      }

      // ---- payment provider webhook (public; the body is never trusted, see billing.settleFromProvider) ----
      if (path === '/api/billing/infinitepay/webhook' && req.method === 'POST') {
        if (!limits.webhook(ip)) return send(429, { success: false, message: 'rate limit' }), true;
        const b = await body(16 * 1024);
        const id = String(b.order_nsu ?? '');
        const key = new URL(req.url, 'http://x').searchParams.get('k');
        if (!billing.verifyWebhookKey(id, key)) return send(403, { success: false, message: 'forbidden' }), true;
        try {
          await billing.settleFromProvider(id, { transactionNsu: b.transaction_nsu, slug: b.invoice_slug || b.slug, captureMethod: b.capture_method, receiptUrl: b.receipt_url, via: 'webhook' });
          return send(200, { success: true, message: null }), true;
        } catch (e) {
          if (e instanceof ProviderError) return send(503, { success: false, message: 'provider unavailable, retry' }), true;
          if (e instanceof AccountError) return send(e.status >= 500 ? e.status : 400, { success: false, message: e.message }), true;
          throw e;
        }
      }

      // ---- accounts ----
      if (path === '/api/auth/signup' && req.method === 'POST') {
        if (!cfg.allowSignup) return send(403, { error: 'Cadastro desativado. Peça um convite ao suporte.' }), true;
        if (!limits.signup(ip)) return send(429, { error: 'Muitas tentativas. Tente mais tarde.' }), true;
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        const b = await body();
        const u = await accounts.signup({ email: b.email, password: b.password, name: b.name });
        const s = accounts.makeSession(u.id);
        return send(201, { user: u }, { 'Set-Cookie': sessionCookie(s.token, s.maxAgeSeconds) }), true;
      }
      if (path === '/api/auth/login' && req.method === 'POST') {
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        const b = await body();
        if (!limits.login(ip) || !limits.loginEmail(String(b.email ?? '').toLowerCase())) return send(429, { error: 'Muitas tentativas. Aguarde alguns minutos.' }), true;
        const u = await accounts.login({ email: b.email, password: b.password });
        const s = accounts.makeSession(u.id);
        return send(200, { user: u }, { 'Set-Cookie': sessionCookie(s.token, s.maxAgeSeconds) }), true;
      }
      if (path === '/api/auth/logout' && req.method === 'POST') return send(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) }), true;

      // everything below needs a logged-in user
      const user = cloud.userFrom(req);
      if (!user) return send(401, { error: 'unauthorized' }), true;

      if (path === '/api/me' && req.method === 'GET') return send(200, { user }), true;
      if (path === '/api/auth/logout-all' && req.method === 'POST') { accounts.logoutAll(user.id); return send(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) }), true; }
      if (path === '/api/auth/password' && req.method === 'POST') {
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        const b = await body(); await accounts.changePassword(user.id, b.current, b.next);
        const s = accounts.makeSession(user.id);                   // changing the password revoked all sessions: issue a fresh one
        return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(s.token, s.maxAgeSeconds) }), true;
      }
      if (path === '/api/cars' && req.method === 'GET') return send(200, cloud.listFor(user)), true;
      if (path === '/api/cars/claim' && req.method === 'POST') {
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        if (!limits.claim(user.id) || !limits.claim(ip)) return send(429, { error: 'Muitas tentativas. Aguarde um minuto.' }), true;
        const b = await body();
        const car = accounts.claim(user.id, { vin: b.vin, code: b.code, name: b.name });
        return send(201, { car }), true;
      }
      // ---- billing (customer) ----
      if (path === '/api/billing' && req.method === 'GET') {
        const cars = accounts.listCars(user.id).map((c) => ({ id: c.id, name: c.name, vinLast4: String(c.vin || '').slice(-4), ...billing.stateForDevice(c.id) }));
        const st = billing.settings();
        return send(200, { plans: billing.plans({ onlyActive: true }), cars, invoices: billing.invoicesOf(user.id), checkout: billing.checkoutConfigured(), trialDays: st.trialDays, graceDays: st.graceDays }), true;
      }
      if (path === '/api/billing/checkout' && req.method === 'POST') {
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        if (!limits.checkout(user.id)) return send(429, { error: 'Muitas tentativas. Aguarde um minuto.' }), true;
        const b = await body();
        const baseUrl = `${cfg.publicScheme || 'https'}://${cfg.appHost || req.headers.host}`;
        const invoice = await billing.createInvoice({ userId: user.id, deviceId: String(b.device ?? ''), planId: b.plan, baseUrl, customer: { name: user.name || undefined, email: user.email } });
        return send(201, { invoice }), true;
      }
      const invId = path.match(/^\/api\/billing\/invoices\/([^/]+)$/);
      if (invId && req.method === 'GET') {
        const i = billing.invoice(invId[1]);
        return i && i.user_id === user.id ? send(200, { invoice: billing.publicInvoice(i), billing: billing.state(i.vin) }) : send(404, { error: 'Fatura não encontrada.' }), true;
      }
      if (path === '/api/billing/confirm' && req.method === 'POST') {
        // Return-from-checkout fallback in case the webhook is late: same server-side verification.
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        if (!limits.checkout(user.id)) return send(429, { error: 'Muitas tentativas. Aguarde um minuto.' }), true;
        const b = await body();
        const i = billing.invoice(String(b.order ?? ''));
        if (!i || i.user_id !== user.id) return send(404, { error: 'Fatura não encontrada.' }), true;
        try {
          const r = await billing.settleFromProvider(i.id, { transactionNsu: b.transaction_nsu, slug: b.slug, captureMethod: b.capture_method, receiptUrl: b.receipt_url, via: 'retorno' });
          return send(200, { invoice: r.invoice, billing: billing.state(i.vin) }), true;
        } catch (e) {
          if (e instanceof ProviderError) return send(503, { error: 'Não foi possível confirmar agora. Tente de novo em instantes.' }), true;
          throw e;
        }
      }

      // ---- admin (role = admin) ----
      if (path.startsWith('/api/admin/')) {
        if (user.role !== 'admin') return send(403, { error: 'forbidden' }), true;
        const url = new URL(req.url, 'http://x'); const qs = Object.fromEntries(url.searchParams);
        const m = req.method; const w = m !== 'GET';
        if (w && !jsonOnly()) return send(415, { error: 'json required' }), true;
        const b = w ? await body(16 * 1024) : {};
        const p = path.slice('/api/admin/'.length);
        let r;
        if (p === 'overview' && m === 'GET') r = admin.overview();
        else if (p === 'users' && m === 'GET') r = { users: admin.users(qs) };
        else if (p === 'users' && m === 'POST') return send(201, { user: await admin.createUser(b, user.id) }), true;
        else if ((r = p.match(/^users\/([^/]+)$/)) && m === 'PATCH') { admin.updateUser(r[1], b, user.id); r = { ok: true }; }
        else if ((r = p.match(/^users\/([^/]+)\/password$/)) && m === 'POST') { await admin.setPassword(r[1], b.password, user.id); r = { ok: true }; }
        else if (p === 'cars' && m === 'GET') r = { cars: admin.cars(qs) };
        else if (p === 'cars/release' && m === 'POST') r = { released: admin.releaseCar(b.vin, user.id) };
        else if (p === 'cars/grant' && m === 'POST') { billing.grantDays(b.vin, b.days, { adminId: user.id }); r = { billing: billing.state(String(b.vin).toUpperCase()) }; }
        else if (p === 'invoices' && m === 'GET') r = { invoices: admin.invoices(qs) };
        else if (p === 'invoices/manual' && m === 'POST') r = billing.createManualPaid({ vin: b.vin, planId: b.plan, note: b.note, adminId: user.id });
        else if ((r = p.match(/^invoices\/([^/]+)\/settle$/)) && m === 'POST') r = billing.settleManual(r[1], { note: b.note, adminId: user.id });
        else if ((r = p.match(/^invoices\/([^/]+)\/cancel$/)) && m === 'POST') r = { cancelled: billing.cancelInvoice(r[1], user.id) };
        else if (p === 'plans' && m === 'GET') r = { plans: billing.plans() };
        else if ((r = p.match(/^plans\/([^/]+)$/)) && m === 'PUT') { billing.savePlan({ id: r[1], name: b.name, months: b.months, priceCents: b.priceCents, active: b.active !== false, sort: b.sort }); r = { plans: billing.plans() }; }
        else if (p === 'settings' && m === 'GET') r = billing.settings();
        else if (p === 'settings' && m === 'PUT') { billing.setSettings(b); r = billing.settings(); }
        else if (p === 'audit' && m === 'GET') r = { events: admin.audit(qs) };
        else return send(404, { error: 'not found' }), true;
        return send(200, r), true;
      }

      const one = path.match(/^\/api\/cars\/([^/]+)$/);
      if (one && req.method === 'PATCH') {
        if (!jsonOnly()) return send(415, { error: 'json required' }), true;
        if (!accounts.owns(user.id, one[1])) return send(404, { error: 'Carro não encontrado.' }), true;
        accounts.renameCar(user.id, one[1], (await body()).name); return send(200, { ok: true }), true;
      }
      if (one && req.method === 'DELETE') { accounts.unlink(user.id, one[1]); return send(200, { ok: true }), true; }
      const vw = path.match(/^\/api\/cars\/([^/]+)\/view$/);
      if (vw && req.method === 'POST') {
        if (!cloud.viewHost) return send(501, { error: 'Visualização de câmeras não configurada (VIEW_HOST).' }), true;
        if (!accounts.owns(user.id, vw[1])) return send(404, { error: 'Carro não encontrado.' }), true;     // ownership first: never reveal another account's car state
        if (!billing.allowed(vw[1])) return send(402, { error: 'Assinatura vencida. Renove para ver as câmeras.', code: 'subscription_expired' }), true;
        if (!hub.isConnected(vw[1])) return send(409, { error: 'O carro não está conectado ao túnel (offline).' }), true;
        const t = view.issueTicket(user.id, vw[1]);
        let page = '/';
        if (jsonOnly()) { const b = await body(1024).catch(() => ({})); if (VIEW_PAGES.has(b?.page)) page = b.page; }   // only known pages of the car UI
        const scheme = cfg.publicScheme || 'https';
        return send(200, { url: `${scheme}://${cloud.viewHost}/_enter?t=${encodeURIComponent(t)}${page === '/' ? '' : `&next=${encodeURIComponent(page)}`}` }), true;
      }
      return false;
    } catch (e) {
      if (e instanceof AccountError) return send(e.status, { error: e.message, code: e.code }), true;
      throw e;
    }
  };

  /** Request handler for VIEW_HOST: ticket exchange, then everything is proxied to the car. */
  cloud.handleViewEntry = (req, res, { path, url, secureCookie }) => {
    if (path !== '/_enter') return false;
    const cookie = view.redeem(url.searchParams.get('t') || '');
    if (!cookie) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Link expirado. Abra a câmera novamente pelo painel.'); return true; }
    const next = url.searchParams.get('next');
    res.writeHead(302, { Location: VIEW_PAGES.has(next) ? next : '/', 'Set-Cookie': `eg_view=${cookie}; HttpOnly; SameSite=${cfg.viewCookieSameSite || 'Strict'}; Path=/; Max-Age=${view.cookieMaxAge}${cfg.viewCookieSameSite === 'None' ? '; Secure' : secureCookie(req)}`, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  };

  return cloud;
}
