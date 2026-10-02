// Local demo of the whole service: accounts mode + a paired fake car (MQTT telemetry, control echo and a
// stand-in "car web UI" behind the tunnel). No car needed.
//   npm run dev:cloud   ->  http://localhost:8790   login: demo@example.com / demo-password-123
import net from 'node:net';
import http from 'node:http';
import { rmSync } from 'node:fs';
import mqtt from 'mqtt';
import WebSocket, { WebSocketServer } from 'ws';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { createAccounts } from '../lib/accounts.js';
import { Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { createTunnelHub, T, INITIAL_CREDIT } from '../lib/tunnel.js';
import { createBroker } from '../lib/broker.js';
import { createCloud } from '../lib/cloud.js';
import { makeSample } from '../lib/simulator.js';

const PORT = +process.env.PORT || 8790;
const cfg = { ...loadConfig({ AUTH_MODE: 'accounts', ALLOW_SIGNUP: '1', APP_HOST: `localhost:${PORT}`, VIEW_HOST: `view.localhost:${PORT}`, PUBLIC_SCHEME: 'http', CONTROL_ENABLED: '1', VIEW_COOKIE_SAMESITE: 'None' }), port: PORT };
const SECRET = 'dev-secret-'.padEnd(40, 'x');
const accounts = createAccounts(openDb(':memory:'), { secret: SECRET });
const store = new Store({ historyMinGapMs: 1000 });
const hub = createTunnelHub({ accounts, log: {} });
const broker = await createBroker({ accounts, store, log: {} });
const mqttPort = await broker.listen({ port: 0, host: '127.0.0.1' });
// Stand-in for the InfinitePay checkout: the "hosted page" is the return URL itself and any transaction counts as paid in full.
const amounts = new Map();
const provider = {
  createLink: async ({ orderNsu, items, redirectUrl }) => { amounts.set(orderNsu, items[0].price); return `${redirectUrl}&transaction_nsu=dev-${orderNsu}&slug=dev&capture_method=pix`; },
  paymentCheck: async ({ orderNsu }) => ({ paid: true, paidAmountCents: amounts.get(orderNsu) ?? 0, captureMethod: 'pix' }),
};
const cloud = createCloud({ cfg, accounts, store, hub, broker, secret: SECRET, provider });
cloud.billing.setSettings({ infinitepayHandle: 'dev-tag' });
const server = createApp(cfg, store, broker, cloud);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// demo account + paired car
const CAR = { deviceId: 'dddddddd-0000-4000-8000-000000000001', deviceKey: 'demo-device-key-'.padEnd(44, 'k') };
const VIN = 'LGXC16DG2R0123456';
const user = await accounts.signup({ email: 'demo@example.com', password: 'demo-password-123', name: 'Demo', role: 'admin' });
accounts.claim(user.id, { vin: VIN, code: accounts.registerDevice({ ...CAR, vin: VIN }).code, name: 'Dolphin GS (demo)' });

// the car's "local web UI" served through the tunnel
const page = (title, body = '') => `<!doctype html><meta charset=utf-8><title>${title}</title><body style="margin:0;background:#101418;color:#e4e8ec;font:16px system-ui"><div style="padding:16px"><h2>${title} <small style="color:#8bdc5c">(demo do carro)</small></h2>${body}</div>`;
// demo recordings (what the car's /api/recordings would answer): two days, sentry + dashcam clips with a 2x2 mosaic thumbnail
const isoDay = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const REC = [];
for (let d = 0; d < 2; d++) for (let i = 0; i < 7; i++) {
  const sentry = i % 2 === 0, h = 8 + i * 2, m = (i * 13) % 60;
  REC.push({ id: `r${d}${i}`, type: sentry ? 'sentry' : 'normal', date: isoDay(d), time: `${h}:${m}`, timeFormatted: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`, dateFormatted: isoDay(d), size: 20e6, sizeFormatted: `${15 + i} MB`,
    peakSeverity: sentry ? ['INFO', 'ALERT', 'CRITICAL', 'INFO'][i % 4] : undefined, personCount: sentry && i % 4 === 2 ? 2 : 0, vehicleCount: sentry && i % 4 === 0 ? 1 : 0,
    place: { short: 'Rua Pe. Estevão', displayName: 'Rua Padre Estevão, São Paulo' }, thumbnailUrl: `/thumb/id/r${d}${i}`, videoUrl: `/video/id/r${d}${i}` });
}
const mosaic = (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" fill="#222"/>${[0, 1, 2, 3].map((q) => `<rect x="${(q % 2) * 80 + 2}" y="${Math.floor(q / 2) * 50 + 2}" width="76" height="46" fill="hsl(${(id.charCodeAt(2) * 37 + q * 50) % 360} 25% 30%)"/>`).join('')}</svg>`;
const local = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const sendJson = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/api/recordings/dates') return sendJson({ success: true, dates: [0, 1].map((d) => ({ date: isoDay(d), count: 7, hasSentry: true })) });
  if (p === '/api/recordings') {
    const q = new URL(req.url, 'http://x').searchParams; const rows = REC.filter((r) => (!q.get('type') || r.type === q.get('type')) && (!q.get('date') || r.date === q.get('date')));
    const size = +q.get('pageSize') || 12, page = +q.get('page') || 1;
    return sendJson({ success: true, recordings: rows.slice((page - 1) * size, page * size), totalCount: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), page, pageSize: size });
  }
  if (p.startsWith('/api/events/id/')) return sendJson({ layout: p.endsWith('1') ? 'dashcam' : 'standard', durationMs: 33000, events: [] });
  if (p.startsWith('/thumb/id/')) {                                 // like the car: 202 "generating" on the first ask
    const id = p.slice(10); if (!globalThis.__thumbSeen) globalThis.__thumbSeen = new Set();
    if (!globalThis.__thumbSeen.has(id)) { globalThis.__thumbSeen.add(id); res.writeHead(202, { 'content-type': 'application/json', 'retry-after': '1' }); return res.end('{"status":"generating"}'); }
    res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(mosaic(id));
  }
  const body = p === '/live-view.html'
    ? `<canvas id=c width=640 height=360 style="width:100%;max-width:900px;background:#000;border:1px solid #333"></canvas><p id=t>conectando ao /ws…</p><script>let n=0,c=document.getElementById('c').getContext('2d');const w=new WebSocket((location.protocol=='https:'?'wss':'ws')+'://'+location.host+'/ws');w.onmessage=e=>{n++;const x=(n*7)%640;c.fillStyle='#111';c.fillRect(0,0,640,360);c.fillStyle='#8bdc5c';c.fillRect(x,150,60,60);document.getElementById('t').textContent='frames recebidos: '+n};</script>`
    : '<p>Página do carro servida pelo túnel.</p><ul><li><a href="/live-view.html">Ao vivo</a></li><li><a href="/recording.html">Gravações</a></li></ul>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' }); res.end(page(p === '/' ? 'Painel do carro' : p, body));
});
new WebSocketServer({ server: local, path: '/ws' }).on('connection', (s) => { const i = setInterval(() => s.send('frame'), 100); s.on('close', () => clearInterval(i)); });
await new Promise((r) => local.listen(0, '127.0.0.1', r));

// the car's tunnel client (same protocol as the Android one)
const frame = (type, id, payload = Buffer.alloc(0)) => { const b = Buffer.alloc(5 + payload.length); b[0] = type; b.writeUInt32BE(id, 1); payload.copy(b, 5); return b; };
function tunnel() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/tunnel`, { headers: { authorization: `Bearer ${CAR.deviceId}.${CAR.deviceKey}` } });
  const locals = new Map(), credit = new Map();
  ws.on('message', (raw) => {
    const type = raw[0], id = raw.readUInt32BE(1), payload = raw.subarray(5);
    if (type === T.OPEN) { const s = net.connect(local.address().port, '127.0.0.1'); locals.set(id, s); credit.set(id, INITIAL_CREDIT);
      s.on('data', (d) => { credit.set(id, credit.get(id) - d.length); for (let o = 0; o < d.length; o += 16384) ws.send(frame(T.DATA, id, d.subarray(o, o + 16384))); if (credit.get(id) <= 0) s.pause(); });
      s.on('close', () => { if (locals.delete(id)) ws.send(frame(T.CLOSE, id)); }); s.on('error', () => {});
    } else if (type === T.DATA) locals.get(id)?.write(payload);
    else if (type === T.CREDIT) { credit.set(id, (credit.get(id) ?? 0) + payload.readUInt32BE(0)); if (credit.get(id) > 0) locals.get(id)?.resume(); }
    else if (type === T.CLOSE) { locals.get(id)?.destroy(); locals.delete(id); }
  });
  ws.on('close', () => setTimeout(tunnel, 2000)); ws.on('error', () => {});
}
tunnel();

// the car's telemetry over MQTT (Home Assistant per-field mode) + it logs the commands it receives
const car = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, { username: CAR.deviceId, password: CAR.deviceKey, clientId: `eg-${CAR.deviceId}` });
const base = `electric-guardian/${CAR.deviceId}/telemetry`;
car.on('connect', () => { car.publish(`${base}/availability`, 'online'); car.subscribe([`${base}/+/set`, `${base}/+/+/set`]); });
car.on('message', (t, m) => console.log(`[car] command ${t.slice(base.length)} = ${m}`));
const t0 = Date.now();
setInterval(() => { if (!car.connected) return; for (const [k, v] of Object.entries(makeSample((Date.now() - t0) / 1000))) car.publish(`${base}/${k}`, String(v)); car.publish(`${base}/vin`, VIN); }, 1000).unref();

console.log(`\nElectric Guardian (demo, accounts mode)\n  http://localhost:${PORT}\n  login: demo@example.com / demo-password-123\n  (cameras use http://view.localhost:${PORT} — works in Chrome/Edge/Firefox)\n`);
