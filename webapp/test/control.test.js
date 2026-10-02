import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { validateCommand, CATALOG } from '../lib/control.js';
import { parseTopic, normalizeField } from '../lib/telemetry.js';
import { loadConfig, validateConfig } from '../lib/config.js';

const cfg = loadConfig({ DASHBOARD_TOKEN: 'dash-secret', MQTT_URL: 'mqtt://x', CONTROL_ENABLED: '1', CONTROL_PIN: '246810' });
const H = { authorization: 'Bearer dash-secret', 'content-type': 'application/json' };

async function withServer(fn, { online = true } = {}) {
  const store = new Store({ historyMinGapMs: 0 });
  const sent = [];
  const bridge = { publishCommand: async (device, key, sub, payload) => { sent.push({ device, key, sub, payload }); return `t/${key}/set`; } };
  const server = createApp(cfg, store, bridge);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (online) store.update('seal', { soc: 70 });
  try { await fn(base, store, sent); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const unlock = async (base, pin = '246810') => {
  const r = await fetch(`${base}/api/control/unlock`, { method: 'POST', headers: H, body: JSON.stringify({ pin }) });
  return { r, cookie: r.headers.get('set-cookie')?.split(';')[0] };
};
const cmd = (base, cookie, body, device = 'seal') => fetch(`${base}/api/devices/${device}/control`, { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify(body) });

test('catalog extracted from the app has the expected shape', () => {
  assert.ok(CATALOG.controls.length >= 50);
  for (const c of CATALOG.controls.filter((x) => x.platform === 'select')) assert.ok(c.options?.length, c.key);
  for (const c of CATALOG.controls.filter((x) => x.platform === 'number')) assert.ok(c.min != null && c.max != null, c.key);
  assert.ok(CATALOG.controls.find((c) => c.key === 'windows_all').confirm);
});

test('validateCommand enforces the same domains as the app', () => {
  assert.deepEqual(validateCommand({ key: 'hazard', value: 'ON' }).payload, 'on');
  assert.ok(validateCommand({ key: 'hazard', value: 'maybe' }).error);
  assert.ok(validateCommand({ key: 'adas_aeb', value: 'off' }).error);          // enable-only
  assert.equal(validateCommand({ key: 'windows_all', value: 'close' }).payload, 'CLOSE');
  assert.ok(validateCommand({ key: 'windows_all', value: 'half' }).error);
  assert.equal(validateCommand({ key: 'seat_heat_driver', value: 'HIGH' }).payload, 'high');
  assert.ok(validateCommand({ key: 'seat_heat_driver', value: 'scorching' }).error);
  assert.equal(validateCommand({ key: 'charge_cap_percent', value: '80' }).payload, '80');
  assert.ok(validateCommand({ key: 'charge_cap_percent', value: '83' }).error);   // step 5
  assert.ok(validateCommand({ key: 'charge_cap_percent', value: '101' }).error);
  assert.equal(validateCommand({ key: 'climate', sub: 'temperature', value: '22' }).payload, '22');
  assert.ok(validateCommand({ key: 'climate', sub: 'temperature', value: '40' }).error);
  assert.ok(validateCommand({ key: 'climate', sub: 'bogus', value: '1' }).error);
  assert.ok(validateCommand({ key: 'nope', value: 'on' }).error);
  assert.ok(validateCommand({ key: 'remote_climate_start', value: 'x' }).error);  // text: unsupported
});

test('HA-mode topics: field / availability / aggregate; command topics never match', () => {
  assert.deepEqual(parseTopic('electric-guardian/car/telemetry/soc'), { device: 'car', kind: 'field', key: 'soc' });
  assert.deepEqual(parseTopic('electric-guardian/car/telemetry/availability'), { device: 'car', kind: 'availability' });
  assert.deepEqual(parseTopic('electric-guardian/car/telemetry'), { device: 'car', kind: 'telemetry' });
  assert.equal(parseTopic('electric-guardian/car/telemetry/tailgate/set'), null);
  assert.equal(parseTopic('electric-guardian/car/telemetry/location'), null);
  assert.equal(normalizeField('soc', '81.5'), 81.5);
  assert.equal(normalizeField('is_charging', 'true'), true);
  assert.equal(normalizeField('gear', 'D'), 'D');
  assert.equal(normalizeField('soc', ''), null);               // tombstone
});

test('store: tombstone removes a field', () => {
  const s = new Store({ historyMinGapMs: 0 });
  s.update('a', { soc: 1, cabin_temp: 20 }); s.update('a', { cabin_temp: null });
  assert.deepEqual(s.get('a').data, { soc: 1 });
});

test('config: control needs MQTT, a long PIN, different from the dashboard token', () => {
  assert.ok(validateConfig(loadConfig({ DASHBOARD_TOKEN: 't', CONTROL_ENABLED: '1', CONTROL_PIN: '123456' })).length > 0);
  assert.ok(validateConfig(loadConfig({ DASHBOARD_TOKEN: 't', MQTT_URL: 'mqtt://x', CONTROL_ENABLED: '1', CONTROL_PIN: '123' })).length > 0);
  assert.ok(validateConfig(loadConfig({ DASHBOARD_TOKEN: 'samesame', MQTT_URL: 'mqtt://x', CONTROL_ENABLED: '1', CONTROL_PIN: 'samesame' })).length > 0);
  assert.equal(validateConfig(cfg).length, 0);
});

test('control API: locked by default, PIN unlocks, command reaches the bridge', async () => {
  await withServer(async (base, store, sent) => {
    assert.equal((await cmd(base, '', { key: 'hazard', value: 'on' })).status, 403);   // locked
    assert.equal((await fetch(`${base}/api/devices/seal/control`, { method: 'POST', body: '{}' })).status, 401); // no dashboard auth
    const bad = await unlock(base, '000000'); assert.equal(bad.r.status, 401);
    const { r, cookie } = await unlock(base); assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    const ok = await cmd(base, cookie, { key: 'hazard', value: 'on' });
    assert.equal(ok.status, 202);
    assert.deepEqual(sent, [{ device: 'seal', key: 'hazard', sub: undefined, payload: 'on' }]);
    const st = await (await fetch(`${base}/api/control/status`, { headers: { ...H, cookie } })).json();
    assert.equal(st.unlocked, true);
    const log = await (await fetch(`${base}/api/control/log`, { headers: H })).json();
    assert.equal(log[0].event, 'command'); assert.equal(log[0].ok, true);
  });
});

test('control API: invalid value, offline car, unknown car, repeated key and wrong content-type', async () => {
  await withServer(async (base, store, sent) => {
    const { cookie } = await unlock(base);
    assert.equal((await cmd(base, cookie, { key: 'windows_all', value: 'half' })).status, 400);
    assert.equal((await cmd(base, cookie, { key: 'hazard', value: 'on' }, 'ghost')).status, 404);
    assert.equal((await cmd(base, cookie, { key: 'hazard', value: 'on' })).status, 202);
    assert.equal((await cmd(base, cookie, { key: 'hazard', value: 'off' })).status, 429);   // same key < 1.5 s
    const wrongType = await fetch(`${base}/api/devices/seal/control`, { method: 'POST', headers: { authorization: 'Bearer dash-secret', 'content-type': 'text/plain', cookie }, body: '{}' });
    assert.equal(wrongType.status, 415);
    assert.equal(sent.length, 1);
  });
});

test('control API: refuses commands for an offline vehicle (409) without publishing', async () => {
  await withServer(async (base, store, sent) => {
    const { cookie } = await unlock(base);
    store.setAvailability('seal', false);
    assert.equal((await cmd(base, cookie, { key: 'drl', value: 'on' })).status, 409);
    assert.equal(sent.length, 0);
  });
});

test('PIN brute force is rate limited', async () => {
  await withServer(async (base) => {
    let last;
    for (let i = 0; i < 7; i++) last = (await unlock(base, `bad${i}xx`)).r.status;
    assert.equal(last, 429);
    assert.equal((await unlock(base)).r.status, 429);          // even the right PIN is refused while limited
  });
});
