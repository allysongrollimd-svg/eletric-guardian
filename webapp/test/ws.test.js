import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';

const cfg = { ...loadConfig({ DASHBOARD_TOKEN: 'dash-secret', MQTT_URL: 'mqtt://x', CONTROL_ENABLED: '1', CONTROL_PIN: '246810' }), coalesceMs: 150 };

async function withServer(fn) {
  const store = new Store({ historyMinGapMs: 0 });
  const sent = [];
  const bridge = { publishCommand: async (device, key, sub, payload) => { sent.push({ device, key, sub, payload }); return 't'; } };
  const server = createApp(cfg, store, bridge);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  store.update('seal', { soc: 70 });
  try { await fn({ port, store, sent }); } finally { await new Promise((r) => server.shutdown(r)); }
}

/** Opens a socket and exposes next(event) / rpc(type, body) helpers. */
function client(port, headers = { authorization: 'Bearer dash-secret' }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
    const queue = [], waiters = [];
    ws.on('message', (raw) => { const m = JSON.parse(raw); const w = waiters.findIndex((x) => x.match(m)); if (w >= 0) waiters.splice(w, 1)[0].res(m); else queue.push(m); });
    const next = (match) => new Promise((res) => { const i = queue.findIndex(match); if (i >= 0) return res(queue.splice(i, 1)[0]); waiters.push({ match, res }); });
    let id = 0;
    const rpc = async (type, body = {}) => { const n = ++id; ws.send(JSON.stringify({ type, id: n, ...body })); return next((m) => m.event === 'rpc' && m.id === n); };
    ws.on('open', () => resolve({ ws, next, rpc }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}

test('websocket handshake needs auth and a same-origin Origin', async () => {
  await withServer(async ({ port }) => {
    await assert.rejects(client(port, {}), (e) => e.status === 401);
    await assert.rejects(client(port, { authorization: 'Bearer dash-secret', origin: 'https://evil.example' }), (e) => e.status === 403);
    const ok = await client(port, { authorization: 'Bearer dash-secret', origin: `http://127.0.0.1:${port}` });
    ok.ws.close();
  });
});

test('websocket: snapshot, live telemetry push and ping/pong', async () => {
  await withServer(async ({ port, store }) => {
    const c = await client(port);
    const snap = await c.next((m) => m.event === 'snapshot');
    assert.equal(snap.data[0].data.soc, 70);
    store.update('seal', { soc: 69.5 });
    const t = await c.next((m) => m.event === 'telemetry');
    assert.equal(t.data.data.soc, 69.5);
    c.ws.send(JSON.stringify({ type: 'ping', t: 123 }));
    assert.equal((await c.next((m) => m.event === 'pong')).t, 123);
    c.ws.close();
  });
});

test('websocket: first update is pushed immediately, a burst is merged into one trailing push', async () => {
  await withServer(async ({ port, store }) => {
    const c = await client(port);
    await c.next((m) => m.event === 'snapshot');
    await new Promise((r) => setTimeout(r, 200));               // let the throttle window expire
    const t0 = Date.now();
    store.update('seal', { speed: 10 });
    await c.next((m) => m.event === 'telemetry');
    assert.ok(Date.now() - t0 < 100, 'leading push must not wait for the 150 ms coalesce window');
    for (let i = 0; i < 50; i++) store.update('seal', { speed: 11 + i });
    const burst = await c.next((m) => m.event === 'telemetry');
    assert.equal(burst.data.data.speed, 60);                    // one merged push carries the final value
  });
});

test('websocket: control over the same connection (locked -> PIN -> command)', async () => {
  await withServer(async ({ port, sent }) => {
    const c = await client(port);
    assert.equal((await c.rpc('cmd', { device: 'seal', key: 'hazard', value: 'on' })).status, 403);
    assert.equal((await c.rpc('unlock', { pin: '000000' })).status, 401);
    assert.equal((await c.rpc('unlock', { pin: '246810' })).ok, true);
    assert.equal((await c.rpc('status')).body.unlocked, true);
    assert.equal((await c.rpc('cmd', { device: 'seal', key: 'hazard', value: 'on' })).status, 202);
    assert.equal((await c.rpc('cmd', { device: 'seal', key: 'windows_all', value: 'half' })).status, 400);
    assert.equal((await c.rpc('cmd', { device: 'ghost', key: 'hazard', value: 'on' })).status, 404);
    assert.deepEqual(sent, [{ device: 'seal', key: 'hazard', sub: undefined, payload: 'on' }]);
    await c.rpc('lock');
    assert.equal((await c.rpc('status')).body.unlocked, false);
    c.ws.close();
  });
});

test('websocket: oversize and malformed messages do not crash the server', async () => {
  await withServer(async ({ port }) => {
    const c = await client(port);
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'ping', t: 1 }));
    assert.equal((await c.next((m) => m.event === 'pong')).t, 1);   // still alive after garbage
    const big = await client(port);
    const closed = new Promise((r) => big.ws.on('close', r));
    big.ws.send('x'.repeat(20000));                                  // > maxPayload: socket is closed by the server
    await closed;
    c.ws.close();
  });
});
