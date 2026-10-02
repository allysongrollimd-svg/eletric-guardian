import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { isDashboardAuthed, isIngestAuthed, safeEqual, createLimiter, parseCookies } from './auth.js';
import { normalizeTelemetry } from './telemetry.js';
import { createControl } from './control.js';
import { createViewProxy } from './viewproxy.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const securityHeaders = (frameSrc = '') => ({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; frame-src https://www.openstreetmap.org ${frameSrc}; ` +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
});
let SECURITY_HEADERS = securityHeaders();

const json = (res, code, body, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(cfg, store, bridge = null, cloud = null) {
  const loginLimit = createLimiter(10, 60_000);
  const control = createControl(cfg, bridge, { verifySecret: cloud ? (userId, pw) => cloud.accounts.verifyPassword(userId, pw) : null });
  const viewUrl = cloud?.viewHost ? `${cfg.publicScheme || 'https'}://${cloud.viewHost}` : '';
  SECURITY_HEADERS = securityHeaders(viewUrl);

  /** Who is calling, and which cars may they see? Token mode: the single owner sees everything. */
  const principal = (req) => {
    if (cloud) return cloud.userFrom(req);
    return isDashboardAuthed(req, cfg) ? { id: 'owner', all: true } : null;
  };
  const canSee = (p, deviceId) => !!p && (p.all || cloud.can(p, deviceId));
  const decorate = (v) => (cloud ? cloud.decorate(v) : v);
  const listFor = (p) => (p.all ? store.list() : cloud.listFor(p));
  const clientIp = (req) => {
    if (cfg.trustProxy) { const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (xf) return xf; }
    return req.socket.remoteAddress || '?';
  };
  const secureCookie = (req) => (req.headers['x-forwarded-proto'] === 'https' || cfg.publicScheme === 'https' ? '; Secure' : '');
  const viewProxy = cloud?.viewHost ? createViewProxy({ hub: cloud.hub, authorize: (req) => cloud.view.authorize(req), frameAncestors: cloud.appHost ? `${cfg.publicScheme || 'https'}://${cloud.appHost}` : null }) : null;
  const clients = new Set();
  const ctlToken = (req) => parseCookies(req.headers.cookie).eg_ctl;

  // A "sink" is one connected browser: an SSE response or a WebSocket. Both receive {event, data}.
  const sseSink = (res, p) => ({ p, send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), end: () => res.end() });
  const wsSink = (ws, p) => ({ p, send: (event, data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ event, data })); }, end: () => ws.close() });
  const send = (sink, event, data) => sink.send(event, data);
  /** Sends a per-car event only to browsers whose account owns that car. */
  const broadcast = (event, view) => clients.forEach((c) => { if (canSee(c.p, view.device)) send(c, event, decorate(view)); });
  // Home Assistant mode delivers one MQTT message per field (hundreds right after connect):
  // coalesce them so browsers get at most ~4 full-state pushes per second per vehicle.
  // Leading + trailing throttle: the first change goes out immediately (lowest latency for a lone
  // update); a burst is merged into one trailing push after COALESCE_MS.
  const COALESCE_MS = cfg.coalesceMs ?? 60;
  const lastPush = new Map(), pending = new Map();
  const push = (device) => { lastPush.set(device, Date.now()); const s = store.get(device); if (s) broadcast('telemetry', s); };
  store.on('update', ({ device }) => {
    if (pending.has(device)) return;
    const wait = COALESCE_MS - (Date.now() - (lastPush.get(device) || 0));
    if (wait <= 0) return push(device);
    pending.set(device, setTimeout(() => { pending.delete(device); push(device); }, wait).unref());
  });
  store.on('status', ({ state }) => broadcast('status', state));
  // Online -> offline transitions happen by timeout, so re-evaluate periodically.
  // A car connecting/disconnecting its tunnel changes what the UI can offer (cameras): tell the owners.
  if (cloud) for (const ev of ['connected', 'disconnected']) cloud.hub.on(ev, (id) => { const v = store.get(id) || { device: id, online: false, lastSeen: null, data: {} }; broadcast('status', v); });
  const sweep = setInterval(() => {
    for (const s of store.list()) broadcast('status', s);
  }, 15_000);
  sweep.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      const host = String(req.headers.host || '').toLowerCase();

      // Car UI (live view / recordings / sentry) lives on its own host and is proxied through the tunnel.
      if (viewProxy && host === cloud.viewHost) {
        if (cloud.handleViewEntry(req, res, { path, url, secureCookie })) return;
        return viewProxy.handle(req, res);
      }

      if (path === '/healthz') return json(res, 200, { ok: true });
      if (cloud && path === '/api/config' || cloud && /^\/api\/(auth|me|cars|device|billing|admin)(\/|$)/.test(path)) {
        if (await cloud.handleApi(req, res, { path, json, readBody, clientIp, secureCookie })) return;
      }

      // ---- Telemetry ingest (cars / gateways that cannot speak MQTT) ----
      const ingest = path.match(/^\/api\/ingest\/([^/]+)$/);
      if (ingest && req.method === 'POST' && !cloud) {
        if (!isIngestAuthed(req, cfg)) return json(res, 401, { error: 'unauthorized' });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'invalid body' }); }
        const fields = normalizeTelemetry(body);
        if (!fields) return json(res, 400, { error: 'no usable fields' });
        store.update(decodeURIComponent(ingest[1]), fields);
        return json(res, 202, { ok: true });
      }

      // ---- Login ----
      if (!cloud && path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || '?';
        if (!loginLimit(ip)) return json(res, 429, { error: 'too many attempts' });
        let body; try { body = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: 'invalid body' }); }
        if (!cfg.dashboardToken || !safeEqual(body?.token ?? '', cfg.dashboardToken)) return json(res, 401, { error: 'invalid token' });
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return json(res, 200, { ok: true }, { 'Set-Cookie': `eg_token=${encodeURIComponent(cfg.dashboardToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
      }
      if (!cloud && path === '/api/logout' && req.method === 'POST') {
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'eg_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }

      // ---- Authenticated read API ----
      if (path.startsWith('/api/')) {
        const me = principal(req);
        if (!me) return json(res, 401, { error: 'unauthorized' });

        // ---- Remote control (dashboard session + control PIN / account password) ----
        const jsonOnly = () => String(req.headers['content-type'] || '').startsWith('application/json');
        if (path === '/api/control/status') return json(res, 200, control.status(ctlToken(req), me.id));
        if (path === '/api/control/log') return json(res, 200, control.audit(cloud ? me.id : null));
        if (path === '/api/control/unlock' && req.method === 'POST') {
          if (!jsonOnly()) return json(res, 415, { error: 'json required' });
          let body; try { body = JSON.parse(await readBody(req, 1024)); } catch { return json(res, 400, { error: 'invalid body' }); }
          const r = await control.unlock(body?.pin ?? body?.password, clientIp(req), me.id);
          if (r.error) return json(res, r.code, { error: r.error });
          const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
          return json(res, 200, { ok: true, ttlSeconds: r.ttlSeconds }, { 'Set-Cookie': `eg_ctl=${r.token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${r.ttlSeconds}${secure}` });
        }
        if (path === '/api/control/lock' && req.method === 'POST') {
          control.lock(ctlToken(req));
          return json(res, 200, { ok: true }, { 'Set-Cookie': 'eg_ctl=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0' });
        }
        const cmd = path.match(/^\/api\/devices\/([^/]+)\/control$/);
        if (cmd && req.method === 'POST') {
          if (!jsonOnly()) return json(res, 415, { error: 'json required' });
          let body; try { body = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: 'invalid body' }); }
          const device = decodeURIComponent(cmd[1]);
          const dev = canSee(me, device) ? store.get(device) : null;
          if (!dev) return json(res, 404, { error: 'unknown vehicle' });
          if (cloud && !cloud.billing.allowed(dev.device)) return json(res, 402, { error: 'Assinatura vencida. Renove para usar os controles.' });
          const r = await control.execute(ctlToken(req), dev.device, body, clientIp(req), decorate(dev).online, me.id);
          return json(res, r.code, r.error ? { error: r.error, locked: r.locked } : { ok: true });
        }
        if (path === '/api/devices') return json(res, 200, listFor(me));
        const hist = path.match(/^\/api\/devices\/([^/]+)\/history$/);
        if (hist) return canSee(me, decodeURIComponent(hist[1])) ? json(res, 200, store.history(decodeURIComponent(hist[1]), Number(url.searchParams.get('minutes')) || 30)) : json(res, 404, { error: 'unknown vehicle' });
        if (path === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
          res.write('retry: 3000\n\n');
          const sink = sseSink(res, me);
          send(sink, 'snapshot', listFor(me));
          clients.add(sink);
          const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
          req.on('close', () => { clearInterval(hb); clients.delete(sink); });
          return;
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---- Static dashboard (public: the login screen must load; data is behind the API) ----
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      const rel = path === '/' || path === '/pair' || path === '/billing/return' ? 'index.html' : path === '/admin' ? 'admin.html' : normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !TYPES[extname(file)]) return json(res, 404, { error: 'not found' });
      try {
        const buf = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600', ...SECURITY_HEADERS });
        res.end(req.method === 'HEAD' ? undefined : buf);
      } catch { json(res, 404, { error: 'not found' }); }
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end();
    }
  });
  // ---- WebSocket: same events as SSE, plus request/response ops (status/unlock/lock/cmd/ping) ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  const wsLimit = createLimiter(120, 60_000); // messages per minute per socket
  const mqttWss = cloud?.broker ? new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false) }) : null;
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const host = String(req.headers.host || '').toLowerCase();
    const upath = new URL(req.url, 'http://x').pathname;
    if (viewProxy && host === cloud.viewHost) return viewProxy.handleUpgrade(req, socket, head);
    if (cloud && upath === '/tunnel') return cloud.hub.handleUpgrade(req, socket, head);                       // cars: Bearer deviceId.key
    if (mqttWss && upath === '/mqtt') return mqttWss.handleUpgrade(req, socket, head, (ws) => cloud.broker.handleWs(ws));
    if (upath !== '/api/ws') return reject(404, 'Not Found');
    const me = principal(req);
    if (!me) return reject(401, 'Unauthorized');
    // Cross-site WebSocket hijacking guard: a browser always sends Origin; it must be this host.
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return reject(403, 'Forbidden'); } catch { return reject(403, 'Forbidden'); } }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ctl = ctlToken(req);                       // control session carried over from the HTTP cookie, if any
      ws.ip = clientIp(req);
      ws.alive = true;
      ws.me = me;
      const sink = wsSink(ws, me);
      send(sink, 'snapshot', listFor(me));
      clients.add(sink);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('close', () => clients.delete(sink));
      ws.on('error', () => clients.delete(sink));
      ws.on('message', async (raw) => {
        const reply = (id, status, body) => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'rpc', id, ok: status >= 200 && status < 300, status, body }));
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'ping') return ws.send(JSON.stringify({ event: 'pong', t: m.t }));   // latency probe
        if (!wsLimit(ws.ip + ':' + (ws._id ??= Math.random()))) return reply(m.id, 429, { error: 'rate limit' });
        if (m.type === 'status') return reply(m.id, 200, control.status(ws.ctl, me.id));
        if (m.type === 'lock') { control.lock(ws.ctl); ws.ctl = undefined; return reply(m.id, 200, { ok: true }); }
        if (m.type === 'unlock') {
          const r = await control.unlock(m.pin ?? m.password, ws.ip, me.id);
          if (r.error) return reply(m.id, r.code, { error: r.error });
          ws.ctl = r.token; return reply(m.id, 200, { ok: true, ttlSeconds: r.ttlSeconds });
        }
        if (m.type === 'cmd') {
          const dev = canSee(me, String(m.device ?? '')) ? store.get(String(m.device)) : null;
          if (!dev) return reply(m.id, 404, { error: 'unknown vehicle' });
          if (cloud && !cloud.billing.allowed(dev.device)) return reply(m.id, 402, { error: 'Assinatura vencida. Renove para usar os controles.' });
          const r = await control.execute(ws.ctl, dev.device, { key: m.key, sub: m.sub, value: m.value }, ws.ip, decorate(dev).online, me.id);
          return reply(m.id, r.code, r.error ? { error: r.error, locked: r.locked } : { ok: true });
        }
      });
    });
  });
  const beat = setInterval(() => wss.clients.forEach((ws) => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 20_000);
  beat.unref();
  server.on('close', () => { clearInterval(sweep); clearInterval(beat); clients.forEach((c) => c.end()); wss.close(); mqttWss?.close(); });
  /** Graceful stop: upgraded WebSocket sockets are not tracked by http.Server#close(), so end them explicitly. */
  server.shutdown = (cb) => {
    wss.clients.forEach((ws) => ws.terminate());
    mqttWss?.clients.forEach((ws) => ws.terminate());
    server.close(cb);
    server.closeAllConnections?.();
  };
  return server;
}
