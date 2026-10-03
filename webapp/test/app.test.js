import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { normalizeTelemetry, parseTopic, sanitizeDeviceId } from '../lib/telemetry.js';
import { loadConfig, validateConfig } from '../lib/config.js';
import { createLimiter } from '../lib/auth.js';
import { makeSample } from '../lib/simulator.js';

const cfg = loadConfig({ DASHBOARD_TOKEN: 'dash-secret', INGEST_TOKEN: 'ingest-secret' });

async function withServer(fn, c = cfg) {
  const store = new Store({ historyMinGapMs: 0 });
  const server = createApp(c, store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, store); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('normalizeTelemetry coerces, filters and caps', () => {
  const out = normalizeTelemetry({ soc: '81.5', speed: 40, gear: 'D', is_charging: 'true', nested: { a: 1 }, 'bad key!': 1, nan: NaN });
  assert.deepEqual(out, { soc: 81.5, speed: 40, gear: 'D', is_charging: true });
  assert.equal(normalizeTelemetry([1]), null);
  assert.equal(normalizeTelemetry({ nested: {} }), null);
});

test('parseTopic / sanitizeDeviceId', () => {
  assert.deepEqual(parseTopic('electric-guardian/seal/telemetry'), { device: 'seal', kind: 'telemetry' });
  assert.deepEqual(parseTopic('electric-guardian/seal/telemetry/availability'), { device: 'seal', kind: 'availability' });
  assert.deepEqual(parseTopic('electric-guardian/seal/availability'), { device: 'seal', kind: 'availability' });
  assert.deepEqual(parseTopic('electric-guardian/telemetry'), { device: 'car', kind: 'telemetry' });
  assert.equal(parseTopic('electric-guardian/seal/other'), null);
  assert.equal(sanitizeDeviceId('../Meu Carro!'), '..-meu-carro-');
  assert.equal(sanitizeDeviceId(''), 'car');
});

test('config requires a dashboard token unless ALLOW_INSECURE=1', () => {
  assert.ok(validateConfig(loadConfig({ MQTT_URL: 'mqtt://x' })).length > 0);
  assert.equal(validateConfig(loadConfig({ DASHBOARD_TOKEN: 't', MQTT_URL: 'mqtt://x' })).length, 0);
  assert.equal(validateConfig(loadConfig({ ALLOW_INSECURE: '1' })).length, 0);
});

test('ingest requires the ingest token; reads require the dashboard token', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ soc: 77, speed: 12 });
    assert.equal((await fetch(`${base}/api/ingest/seal`, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(`${base}/api/ingest/seal`, { method: 'POST', body, headers: { authorization: 'Bearer dash-secret' } })).status, 401);
    assert.equal((await fetch(`${base}/api/ingest/seal`, { method: 'POST', body, headers: { authorization: 'Bearer ingest-secret' } })).status, 202);

    assert.equal((await fetch(`${base}/api/devices`)).status, 401);
    const r = await fetch(`${base}/api/devices`, { headers: { authorization: 'Bearer dash-secret' } });
    const list = await r.json();
    assert.equal(list[0].device, 'seal'); assert.equal(list[0].data.soc, 77); assert.equal(list[0].online, true);
  });
});

test('login sets an HttpOnly cookie that authorizes the API; wrong token rejected', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'nope' }) })).status, 401);
    const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'dash-secret' }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.equal((await fetch(`${base}/api/devices`, { headers: { cookie: cookie.split(';')[0] } })).status, 200);
  });
});

test('SSE streams a snapshot then live telemetry', async () => {
  await withServer(async (base, store) => {
    store.update('seal', { soc: 50 });
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { authorization: 'Bearer dash-secret' }, signal: ac.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    const readUntil = async (needle) => { while (!buf.includes(needle)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
    await readUntil('event: snapshot');
    store.update('seal', { soc: 49.5 });
    await readUntil('event: telemetry');
    assert.match(buf, /"soc":49\.5/);
    ac.abort();
  });
});

test('static files: index served, traversal and unknown types blocked', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/fields.json`)).status, 200);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  });
});

test('store: offline timeout, availability and bounded history', () => {
  let t = 1000;
  const s = new Store({ historyMax: 3, historyMinGapMs: 0, offlineAfterSeconds: 10, now: () => t });
  for (let i = 0; i < 5; i++) { t += 1000; s.update('a', { soc: i }); }
  assert.equal(s.history('a', 60).length, 3);
  assert.equal(s.get('a').online, true);
  t += 11_000; assert.equal(s.get('a').online, false);
  s.update('a', { soc: 1 }); s.setAvailability('a', false); assert.equal(s.get('a').online, false);
});

test('limiter and simulator sanity', () => {
  let t = 0; const lim = createLimiter(2, 1000, () => t);
  assert.ok(lim('x') && lim('x') && !lim('x')); t = 2000; assert.ok(lim('x'));
  const s = makeSample(10); assert.ok(s.soc > 0 && s.soc <= 100); assert.equal(typeof s.is_charging, 'boolean');
});
