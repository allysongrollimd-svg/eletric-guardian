import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { openDb } from '../lib/db.js';
import { createAccounts } from '../lib/accounts.js';
import { createTunnelHub, T, INITIAL_CREDIT } from '../lib/tunnel.js';
import { createViewProxy } from '../lib/viewproxy.js';

const VIN = 'LGXC16DG2R0123456';
const DEV = { deviceId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001', deviceKey: 'k'.repeat(43) };

const frame = (type, id, payload = Buffer.alloc(0)) => { const b = Buffer.alloc(5 + payload.length); b[0] = type; b.writeUInt32BE(id, 1); payload.copy(b, 5); return b; };

/** A fake car: speaks the tunnel protocol and pipes streams to a local TCP target (like the Android client). */
function fakeCar(wsUrl, targetPort, { auth = `Bearer ${DEV.deviceId}.${DEV.deviceKey}` } = {}) {
  const ws = new WebSocket(wsUrl, { headers: auth ? { authorization: auth } : {} });
  const locals = new Map(), credit = new Map();
  ws.on('message', (raw) => {
    const type = raw[0], id = raw.readUInt32BE(1), payload = raw.subarray(5);
    if (type === T.OPEN) {
      const sock = net.connect(targetPort, '127.0.0.1'); locals.set(id, sock); credit.set(id, INITIAL_CREDIT);
      sock.on('data', (d) => {
        credit.set(id, credit.get(id) - d.length);
        for (let o = 0; o < d.length; o += 16384) ws.send(frame(T.DATA, id, d.subarray(o, o + 16384)));
        if (credit.get(id) <= 0) sock.pause();
      });
      sock.on('close', () => { if (locals.delete(id)) ws.send(frame(T.CLOSE, id)); });
      sock.on('error', () => {});
    } else if (type === T.DATA) locals.get(id)?.write(payload);
    else if (type === T.CREDIT) { credit.set(id, (credit.get(id) ?? 0) + payload.readUInt32BE(0)); if (credit.get(id) > 0) locals.get(id)?.resume(); }
    else if (type === T.CLOSE) { locals.get(id)?.destroy(); locals.delete(id); }
  });
  return { ws, ready: new Promise((r, j) => { ws.on('open', r); ws.on('unexpected-response', (_q, res) => j(Object.assign(new Error('rejected'), { status: res.statusCode }))); ws.on('error', j); }), locals };
}

async function setup() {
  const acc = createAccounts(openDb(':memory:'), { secret: 'x'.repeat(40) });
  const u = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  acc.claim(u.id, { vin: VIN, code: acc.registerDevice(DEV).code, name: 'Dolphin' });
  const hub = createTunnelHub({ accounts: acc, log: {} });
  const proxy = createViewProxy({ hub, authorize: (req) => (req.headers['x-test-user'] === 'ok' ? { userId: u.id, deviceId: DEV.deviceId, name: 'Dolphin' } : null) });
  const front = http.createServer(proxy.handle);
  front.on('upgrade', (req, s, h) => (req.url.startsWith('/tunnel') ? hub.handleUpgrade(req, s, h) : proxy.handleUpgrade(req, s, h)));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const seen = [];
  const local = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.alloc(3 * 1024 * 1024, 7)); return; }
    if (req.url === '/echo' && req.method === 'POST') { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { res.writeHead(200); res.end(Buffer.concat(c)); }); return; }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-frame-options': 'DENY', 'set-cookie': 'carsess=1' }); res.end(`hello ${req.url}`);
  });
  const lws = new WebSocketServer({ server: local, path: '/ws' });
  lws.on('connection', (s) => { s.send('video-frame-1'); s.on('message', (m) => s.send(`echo:${m}`)); });
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const car = fakeCar(`ws://127.0.0.1:${front.address().port}/tunnel`, local.address().port);
  await car.ready;
  const base = `http://127.0.0.1:${front.address().port}`;
  const close = async () => { car.ws.terminate(); hub.shutdown(); front.closeAllConnections?.(); local.closeAllConnections?.(); await Promise.all([new Promise((r) => front.close(r)), new Promise((r) => local.close(r))]); };
  return { acc, hub, base, front, local, car, seen: () => seen, close };
}

test('tunnel rejects unknown, wrong-key and unclaimed devices', async () => {
  const acc = createAccounts(openDb(':memory:'), { secret: 'x'.repeat(40) });
  const hub = createTunnelHub({ accounts: acc, log: {} });
  const srv = http.createServer(); srv.on('upgrade', (q, s, h) => hub.handleUpgrade(q, s, h));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.address().port}/tunnel`;
  acc.registerDevice(DEV);                                                    // registered but NOT claimed
  for (const auth of [null, 'Bearer nonsense', `Bearer ${DEV.deviceId}.${DEV.deviceKey}`, `Bearer ${DEV.deviceId}.${'z'.repeat(43)}`]) {
    await assert.rejects(fakeCar(url, 1, { auth }).ready, (e) => e.status === 401);
  }
  hub.shutdown(); srv.close();
});

test('viewer request is proxied through the tunnel; headers are sanitized', async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(`${s.base}/hello`)).status, 401);                // no viewer auth
    const r = await fetch(`${s.base}/hello?x=1`, { headers: { 'x-test-user': 'ok', 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '9.9.9.9', cookie: 'eg_session=SECRET; keep=me' } });
    assert.equal(r.status, 200); assert.equal(await r.text(), 'hello /hello?x=1');
    assert.equal(r.headers.get('x-frame-options'), null);                      // stripped so we can embed
    assert.equal(r.headers.get('set-cookie'), 'carsess=1');
    const h = s.seen()[0].headers;
    assert.equal(h['x-forwarded-for'], undefined); assert.equal(h['cf-connecting-ip'], undefined);   // car must NOT think it is behind a tunnel
    assert.equal(h.cookie, 'keep=me');                                          // our session cookie never reaches the car
  } finally { await s.close(); }
});

test('request bodies and large responses (flow control) survive the tunnel intact', async () => {
  const s = await setup();
  try {
    const body = Buffer.alloc(300 * 1024, 5);
    const echo = await fetch(`${s.base}/echo`, { method: 'POST', headers: { 'x-test-user': 'ok' }, body });
    assert.deepEqual(Buffer.from(await echo.arrayBuffer()), body);
    const big = await fetch(`${s.base}/big`, { headers: { 'x-test-user': 'ok' } });
    const buf = Buffer.from(await big.arrayBuffer());
    assert.equal(buf.length, 3 * 1024 * 1024); assert.ok(buf.every((b) => b === 7));
  } finally { await s.close(); }
});

test('WebSocket (video) passes through the tunnel in both directions', async () => {
  const s = await setup();
  try {
    const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws', { headers: { 'x-test-user': 'ok' } });
    const got = [];
    await new Promise((res, rej) => { ws.on('message', (m) => { got.push(m.toString()); if (got.length === 1) ws.send('ping'); if (got.length === 2) res(); }); ws.on('error', rej); });
    assert.deepEqual(got, ['video-frame-1', 'echo:ping']);
    ws.close();
    await assert.rejects(new Promise((_r, rej) => { const w = new WebSocket(s.base.replace('http', 'ws') + '/ws'); w.on('unexpected-response', (_q, res) => rej(Object.assign(new Error('x'), { status: res.statusCode }))); w.on('error', rej); }), (e) => e.status === 401);
  } finally { await s.close(); }
});

test('offline car gives a friendly 503; reconnecting restores service; many viewers share one tunnel', async () => {
  const s = await setup();
  try {
    await Promise.all(Array.from({ length: 20 }, async (_, i) => assert.equal(await (await fetch(`${s.base}/p${i}`, { headers: { 'x-test-user': 'ok' } })).text(), `hello /p${i}`)));
    s.car.ws.terminate();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(s.hub.isConnected(DEV.deviceId), false);
    const off = await fetch(`${s.base}/x`, { headers: { 'x-test-user': 'ok' } });
    assert.equal(off.status, 503); assert.match(await off.text(), /offline/);
    const car2 = fakeCar(`ws://127.0.0.1:${s.front.address().port}/tunnel`, s.local.address().port); await car2.ready;
    assert.equal((await fetch(`${s.base}/x`, { headers: { 'x-test-user': 'ok' } })).status, 200);
    car2.ws.terminate();
  } finally { await s.close(); }
});

test('a newer tunnel for the same car replaces the older one', async () => {
  const s = await setup();
  try {
    const closed = new Promise((r) => s.car.ws.on('close', (code) => r(code)));
    const car2 = fakeCar(`ws://127.0.0.1:${s.front.address().port}/tunnel`, s.local.address().port); await car2.ready;
    assert.equal(await closed, 4000);
    assert.equal(s.hub.isConnected(DEV.deviceId), true);
    car2.ws.terminate();
  } finally { await s.close(); }
});
