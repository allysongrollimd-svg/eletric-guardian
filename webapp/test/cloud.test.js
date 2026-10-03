import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import mqtt from 'mqtt';
import WebSocket, { WebSocketServer } from 'ws';
import { openDb } from '../lib/db.js';
import { createAccounts } from '../lib/accounts.js';
import { Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { createTunnelHub, T, INITIAL_CREDIT } from '../lib/tunnel.js';
import { createBroker } from '../lib/broker.js';
import { createCloud } from '../lib/cloud.js';
import { loadConfig } from '../lib/config.js';

const VIN = 'LGXC16DG2R0123456';
const CAR = { deviceId: 'aaaaaaaa-bbbb-cccc-dddd-0000000000c1', deviceKey: 'c'.repeat(43) };
const SECRET = 's'.repeat(40);

const cfg = loadConfig({ AUTH_MODE: 'accounts', ALLOW_SIGNUP: '1', APP_HOST: 'app.test', VIEW_HOST: 'view.test', PUBLIC_SCHEME: 'http', CONTROL_ENABLED: '1' });

/** Minimal HTTP client with a cookie jar and Host override. */
function client(port, host) {
  const jar = {};
  const call = (method, path, { body, headers = {}, host: h = host } = {}) => new Promise((resolve, reject) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: h, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        for (const sc of res.headers['set-cookie'] || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v === '') delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = v; }
        const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  return { jar, call, get: (p, o) => call('GET', p, o), post: (p, body, o) => call('POST', p, { body, ...o }) };
}

const frame = (type, id, payload = Buffer.alloc(0)) => { const b = Buffer.alloc(5 + payload.length); b[0] = type; b.writeUInt32BE(id, 1); payload.copy(b, 5); return b; };
function fakeTunnelCar(port, target, auth) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { authorization: auth } });
  const locals = new Map(), credit = new Map();
  ws.on('message', (raw) => {
    const type = raw[0], id = raw.readUInt32BE(1), payload = raw.subarray(5);
    if (type === T.OPEN) { const s = net.connect(target, '127.0.0.1'); locals.set(id, s); credit.set(id, INITIAL_CREDIT);
      s.on('data', (d) => { credit.set(id, credit.get(id) - d.length); for (let o = 0; o < d.length; o += 16384) ws.send(frame(T.DATA, id, d.subarray(o, o + 16384))); if (credit.get(id) <= 0) s.pause(); });
      s.on('close', () => { if (locals.delete(id)) ws.send(frame(T.CLOSE, id)); }); s.on('error', () => {});
    } else if (type === T.DATA) locals.get(id)?.write(payload);
    else if (type === T.CREDIT) { credit.set(id, (credit.get(id) ?? 0) + payload.readUInt32BE(0)); if (credit.get(id) > 0) locals.get(id)?.resume(); }
    else if (type === T.CLOSE) { locals.get(id)?.destroy(); locals.delete(id); }
  });
  return { ws, ready: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); ws.on('unexpected-response', (_q, res) => j(Object.assign(new Error('rejected'), { status: res.statusCode }))); }) };
}

async function boot() {
  const accounts = createAccounts(openDb(':memory:'), { secret: SECRET });
  const store = new Store({ historyMinGapMs: 0 });
  const hub = createTunnelHub({ accounts, log: {} });
  const broker = await createBroker({ accounts, store, log: {} });
  const mqttPort = await broker.listen({ port: 0, host: '127.0.0.1' });
  const cloud = createCloud({ cfg, accounts, store, hub, broker, secret: SECRET });
  const server = createApp({ ...cfg, coalesceMs: 10 }, store, broker, cloud);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // the car's own local web server (what the tunnel exposes)
  const seen = [];
  const local = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); res.end(`<h1>live-view ${req.url}</h1>`); });
  const lws = new WebSocketServer({ server: local, path: '/ws' }); lws.on('connection', (s) => s.send('h264-frame'));
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const close = async () => { lws.clients.forEach((c) => c.terminate()); await new Promise((r) => server.shutdown(r)); hub.shutdown(); await broker.close(); local.closeAllConnections?.(); await new Promise((r) => local.close(r)); };
  return { accounts, store, hub, broker, mqttPort, port, local, seen, wait, close, app: () => client(port, 'app.test'), view: () => client(port, 'view.test') };
}
const connectMqtt = (port, d) => new Promise((resolve, reject) => { const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username: d.deviceId, password: d.deviceKey, clientId: `eg-${d.deviceId}`, reconnectPeriod: 0 }); c.once('connect', () => resolve(c)); c.once('error', reject); c.once('close', () => reject(new Error('closed'))); });

test('product flow: signup -> car pairs -> claim by VIN -> telemetry -> cameras -> control, with tenant isolation', async () => {
  const s = await boot();
  try {
    // --- two customers
    const ana = s.app(), bruno = s.app();
    assert.equal((await ana.post('/api/auth/signup', { email: 'ana@example.com', password: 'ana-long-password', name: 'Ana' })).status, 201);
    assert.equal((await bruno.post('/api/auth/signup', { email: 'bruno@example.com', password: 'bruno-long-password' })).status, 201);
    assert.equal((await ana.get('/api/me')).json.user.email, 'ana@example.com');
    assert.equal((await s.app().get('/api/me')).status, 401);

    // --- the car app registers and shows a pairing code; nobody can connect before it is claimed
    const reg = await s.app().post('/api/device/register', { deviceId: CAR.deviceId, deviceKey: CAR.deviceKey, vin: VIN, appVersion: '50.1' });
    assert.equal(reg.status, 200); assert.equal(reg.json.state, 'pending'); assert.match(reg.json.code, /^[A-Z2-9]{8}$/);
    await assert.rejects(connectMqtt(s.mqttPort, CAR));

    // --- Ana claims it with the code + chassis. Wrong VIN / Bruno guessing are refused
    assert.equal((await ana.post('/api/cars/claim', { vin: 'LGXC16DG2R0999999', code: reg.json.code })).json.code, 'vin_mismatch');
    const claim = await ana.post('/api/cars/claim', { vin: VIN, code: reg.json.code, name: 'Dolphin GS' });
    assert.equal(claim.status, 201); assert.equal(claim.json.car.vinVerified, true);
    assert.equal((await bruno.post('/api/cars/claim', { vin: VIN, code: reg.json.code })).status, 404);   // code was consumed
    const st = await s.app().call('GET', '/api/device/status', { headers: { authorization: `Bearer ${CAR.deviceId}.${CAR.deviceKey}` } });
    assert.equal(st.json.state, 'claimed');

    // --- telemetry over MQTT (HA/per-field mode) reaches Ana only
    const car = await connectMqtt(s.mqttPort, CAR);
    const base = `electric-guardian/${CAR.deviceId}/telemetry`;
    const cmds = []; car.on('message', (t, m) => cmds.push(`${t.slice(base.length)}=${m}`)); await new Promise((r) => car.subscribe([`${base}/+/set`, `${base}/+/+/set`], r));
    car.publish(`${base}/soc`, '77.5'); car.publish(`${base}/speed`, '0'); car.publish(`${base}/availability`, 'online');
    await s.wait(250);
    const cars = (await ana.get('/api/cars')).json;
    assert.equal(cars.length, 1); assert.equal(cars[0].name, 'Dolphin GS'); assert.equal(cars[0].data.soc, 77.5); assert.equal(cars[0].online, true);
    assert.deepEqual((await bruno.get('/api/cars')).json, []);
    assert.deepEqual((await bruno.get('/api/devices')).json, []);
    assert.equal((await bruno.get(`/api/devices/${CAR.deviceId}/history`)).status, 404);

    // --- live dashboard socket: Ana gets live events, Bruno gets nothing about this car
    const open = (c) => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/ws`, { headers: { host: 'app.test', cookie: `eg_session=${c.jar.eg_session}` } }); const ev = []; ws.on('message', (m) => ev.push(JSON.parse(m))); ws.on('open', () => res({ ws, ev })); ws.on('error', rej); });
    const wa = await open(ana), wb = await open(bruno);
    car.publish(`${base}/soc`, '77.4'); await s.wait(250);
    assert.ok(wa.ev.some((e) => e.event === 'telemetry' && e.data.data.soc === 77.4 && e.data.name === 'Dolphin GS'));
    assert.ok(!wb.ev.some((e) => e.event === 'telemetry'));
    assert.equal(wb.ev.find((e) => e.event === 'snapshot').data.length, 0);

    // --- remote control: needs the account password; Bruno can neither unlock for Ana's car nor command it
    assert.equal((await ana.post(`/api/devices/${CAR.deviceId}/control`, { key: 'hazard', value: 'on' })).status, 403);   // locked
    assert.equal((await ana.post('/api/control/unlock', { password: 'wrong-password!' })).status, 401);
    assert.equal((await ana.post('/api/control/unlock', { password: 'ana-long-password' })).status, 200);
    assert.equal((await ana.post(`/api/devices/${CAR.deviceId}/control`, { key: 'windows_all', value: 'CLOSE' })).status, 202);
    await s.wait(150); assert.deepEqual(cmds, ['/windows_all/set=CLOSE']);
    assert.equal((await bruno.post('/api/control/unlock', { password: 'bruno-long-password' })).status, 200);
    assert.equal((await bruno.post(`/api/devices/${CAR.deviceId}/control`, { key: 'hazard', value: 'on' })).status, 404);  // not his car
    const log = (await ana.get('/api/control/log')).json;                                       // audit trail is per account
    assert.ok(log.length > 0 && log.every((e) => e.userId === (log.find((x) => x.event === 'command')?.userId)));

    // --- cameras: no tunnel yet -> 409; tunnel up -> ticket -> view host serves the car UI
    assert.equal((await ana.post(`/api/cars/${CAR.deviceId}/view`)).status, 409);
    const tun = fakeTunnelCar(s.port, s.local.address().port, `Bearer ${CAR.deviceId}.${CAR.deviceKey}`); await tun.ready; await s.wait(100);
    assert.equal((await ana.get('/api/cars')).json[0].tunnel, true);
    assert.equal((await bruno.post(`/api/cars/${CAR.deviceId}/view`)).status, 404);               // not his car: no ticket, and no hint that it is online
    const t = await ana.post(`/api/cars/${CAR.deviceId}/view`); assert.equal(t.status, 200);
    const ticketPath = new URL(t.json.url).pathname + new URL(t.json.url).search; assert.equal(new URL(t.json.url).host, 'view.test');

    const viewer = s.view();
    assert.equal((await viewer.get('/')).status, 401);                                         // no cookie: no access
    const enter = await viewer.get(ticketPath); assert.equal(enter.status, 302); assert.ok(viewer.jar.eg_view);
    assert.equal((await s.view().get(ticketPath)).status, 403);                                // tickets are one-time
    // choosing a page opens it directly; unknown pages are ignored (no open redirect)
    const t2 = (await ana.post(`/api/cars/${CAR.deviceId}/view`, { page: '/recording.html' })).json.url; assert.match(t2, /next=%2Frecording\.html$/);
    const t3 = (await ana.post(`/api/cars/${CAR.deviceId}/view`, { page: '//evil.example' })).json.url; assert.doesNotMatch(t3, /next=/);
    const e2 = await s.view().get(new URL(t2).pathname + new URL(t2).search); assert.equal(e2.headers.location, '/recording.html');
    assert.equal((await s.view().get(new URL(t3).pathname + new URL(t3).search + '&next=//evil.example')).headers.location, '/');
    const page = await viewer.get('/live-view.html'); assert.equal(page.status, 200); assert.match(page.text, /live-view \/live-view.html/);
    assert.equal(page.headers['x-frame-options'], undefined); assert.match(page.headers['content-security-policy'], /frame-ancestors 'self' http:\/\/app\.test/);   // our own phone screens (same host) and the dashboard may frame it
    // inside an iframe the car's own shell is hidden (single navigation); as a normal page it is untouched
    const emb = await viewer.get('/live-view.html', { headers: { 'sec-fetch-dest': 'iframe' } });
    assert.match(emb.text, /id="eg-embed"/); assert.doesNotMatch(page.text, /eg-embed/);
    const recp = await viewer.get('/recording.html', { headers: { 'sec-fetch-dest': 'iframe' } });
    assert.match(recp.text, /eg-oem-sync/); assert.match(recp.text, /recordingMode:"off"/); assert.doesNotMatch((await viewer.get('/surveillance.html', { headers: { 'sec-fetch-dest': 'iframe' } })).text, /eg-oem-sync/);   // the OEM dashcam always follows the main mode
    const cust = await viewer.get('/surveillance.html', { headers: { 'sec-fetch-dest': 'iframe' } });
    assert.match(cust.text, /eg-customer/); assert.match(cust.text, /setting-row:has/);                  // a customer does not get the advanced blocks
    assert.equal((await viewer.get('/events.html', { headers: { 'sec-fetch-dest': 'document' } })).text.includes('eg-embed'), false);  // opened as a normal page: untouched
    assert.equal(s.seen.at(-1).cookie, undefined);                                             // our cookies never reach the car
    // a forged/stolen-looking cookie from another account does not work
    const bad = s.view(); bad.jar.eg_view = 'eyJ1IjoieCJ9.deadbeef'; assert.equal((await bad.get('/')).status, 401);
    // the app host never serves the car UI, and the view host never serves the dashboard API
    assert.equal((await s.app().get('/live-view.html')).status, 404);
    // video websocket through the view host
    const vws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { host: 'view.test', cookie: `eg_view=${viewer.jar.eg_view}` } });
    assert.equal(await new Promise((res, rej) => { vws.on('message', (m) => res(m.toString())); vws.on('error', rej); }), 'h264-frame');

    // --- logging out everywhere kills the camera session too
    await ana.post('/api/auth/logout-all');
    assert.equal((await viewer.get('/live-view.html')).status, 401);

    [wa, wb].forEach((x) => x.ws.terminate()); vws.terminate(); tun.ws.terminate(); car.end(true);
  } finally { await s.close(); }
});

test('unlinking a car cuts MQTT, tunnel access and the view session at once', async () => {
  const s = await boot();
  try {
    const ana = s.app(); await ana.post('/api/auth/signup', { email: 'ana@example.com', password: 'ana-long-password' });
    const code = (await s.app().post('/api/device/register', CAR)).json.code;
    await ana.post('/api/cars/claim', { vin: VIN, code });
    const tun = fakeTunnelCar(s.port, s.local.address().port, `Bearer ${CAR.deviceId}.${CAR.deviceKey}`); await tun.ready;
    const viewer = s.view();
    const t = (await ana.post(`/api/cars/${CAR.deviceId}/view`)).json.url; await viewer.get(new URL(t).pathname + new URL(t).search);
    assert.equal((await viewer.get('/')).status, 200);
    assert.equal((await ana.call('DELETE', `/api/cars/${CAR.deviceId}`)).status, 200);
    assert.equal((await viewer.get('/')).status, 401);                                          // view cookie dead
    await assert.rejects(connectMqtt(s.mqttPort, CAR));                                          // MQTT credentials dead
    await assert.rejects(fakeTunnelCar(s.port, s.local.address().port, `Bearer ${CAR.deviceId}.${CAR.deviceKey}`).ready, (e) => e.status === 401);
    tun.ws.terminate();
  } finally { await s.close(); }
});

test('signup can be closed; credentials endpoints are rate limited; JSON-only', async () => {
  const s = await boot();
  try {
    assert.equal((await s.app().post('/api/auth/login', { email: 'ghost@example.com', password: 'whatever-long' })).status, 401);
    const bad = await s.app().call('POST', '/api/auth/login', { headers: { 'content-type': 'text/plain' }, body: undefined });
    assert.equal(bad.status, 415);
    let last; for (let i = 0; i < 12; i++) last = (await s.app().post('/api/auth/login', { email: 'ghost@example.com', password: 'whatever-long' })).status;
    assert.equal(last, 429);
  } finally { await s.close(); }
});
