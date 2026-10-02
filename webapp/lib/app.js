import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { isDashboardAuthed, isIngestAuthed, safeEqual, createLimiter } from './auth.js';
import { normalizeTelemetry, sanitizeDeviceId } from './telemetry.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-src https://www.openstreetmap.org; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
};

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

export function createApp(cfg, store) {
  const loginLimit = createLimiter(10, 60_000);
  const clients = new Set();

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  store.on('update', ({ state }) => clients.forEach((c) => send(c, 'telemetry', state)));
  store.on('status', ({ state }) => clients.forEach((c) => send(c, 'status', state)));
  // Online -> offline transitions happen by timeout, so re-evaluate periodically.
  const sweep = setInterval(() => {
    for (const s of store.list()) clients.forEach((c) => send(c, 'status', s));
  }, 15_000);
  sweep.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;

      if (path === '/healthz') return json(res, 200, { ok: true });

      // ---- Telemetry ingest (cars / gateways that cannot speak MQTT) ----
      const ingest = path.match(/^\/api\/ingest\/([^/]+)$/);
      if (ingest && req.method === 'POST') {
        if (!isIngestAuthed(req, cfg)) return json(res, 401, { error: 'unauthorized' });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'invalid body' }); }
        const fields = normalizeTelemetry(body);
        if (!fields) return json(res, 400, { error: 'no usable fields' });
        store.update(decodeURIComponent(ingest[1]), fields);
        return json(res, 202, { ok: true });
      }

      // ---- Login ----
      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || '?';
        if (!loginLimit(ip)) return json(res, 429, { error: 'too many attempts' });
        let body; try { body = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: 'invalid body' }); }
        if (!cfg.dashboardToken || !safeEqual(body?.token ?? '', cfg.dashboardToken)) return json(res, 401, { error: 'invalid token' });
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return json(res, 200, { ok: true }, { 'Set-Cookie': `eg_token=${encodeURIComponent(cfg.dashboardToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'eg_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }

      // ---- Authenticated read API ----
      if (path.startsWith('/api/')) {
        if (!isDashboardAuthed(req, cfg)) return json(res, 401, { error: 'unauthorized' });
        if (path === '/api/devices') return json(res, 200, store.list());
        const hist = path.match(/^\/api\/devices\/([^/]+)\/history$/);
        if (hist) return json(res, 200, store.history(decodeURIComponent(hist[1]), Number(url.searchParams.get('minutes')) || 30));
        if (path === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
          res.write('retry: 3000\n\n');
          send(res, 'snapshot', store.list());
          clients.add(res);
          const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
          req.on('close', () => { clearInterval(hb); clients.delete(res); });
          return;
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---- Static dashboard (public: the login screen must load; data is behind the API) ----
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      const rel = path === '/' ? 'index.html' : normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
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
  server.on('close', () => { clearInterval(sweep); clients.forEach((c) => c.end()); });
  return server;
}
