import { test } from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { openDb } from '../lib/db.js';
import { createAccounts } from '../lib/accounts.js';
import { Store } from '../lib/store.js';
import { createBroker } from '../lib/broker.js';

const A = { deviceId: 'aaaaaaaa-bbbb-cccc-dddd-00000000000a', deviceKey: 'a'.repeat(43) };
const B = { deviceId: 'aaaaaaaa-bbbb-cccc-dddd-00000000000b', deviceKey: 'b'.repeat(43) };
const C = { deviceId: 'aaaaaaaa-bbbb-cccc-dddd-00000000000c', deviceKey: 'c'.repeat(43) };   // registered, never claimed
const VIN = (n) => `LGXC16DG2R01234${n}0`.slice(0, 17);

async function setup() {
  const acc = createAccounts(openDb(':memory:'), { secret: 'x'.repeat(40) });
  const u = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  acc.claim(u.id, { vin: VIN(1), code: acc.registerDevice(A).code }); acc.claim(u.id, { vin: VIN(2), code: acc.registerDevice(B).code });
  acc.registerDevice(C);
  const store = new Store({ historyMinGapMs: 0 });
  const broker = await createBroker({ accounts: acc, store, log: {} });
  const port = await broker.listen({ port: 0, host: '127.0.0.1' });
  const connect = (d, opts = {}) => new Promise((resolve, reject) => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username: d.deviceId, password: d.deviceKey, clientId: `eg-${d.deviceId}-1`, reconnectPeriod: 0, ...opts });
    c.once('connect', () => resolve(c)); c.once('error', reject); c.once('close', () => reject(new Error('closed')));
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return { acc, store, broker, port, connect, wait, close: () => broker.close() };
}

test('only claimed devices with the right key can connect', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.connect({ deviceId: A.deviceId, deviceKey: 'wrong'.padEnd(43, 'x') }));
    await assert.rejects(s.connect(C));                                                // unclaimed
    await assert.rejects(s.connect({ deviceId: 'nope', deviceKey: A.deviceKey }));
    const ok = await s.connect(A); await s.wait(100); assert.equal(s.broker.connected(A.deviceId), true); ok.end();
  } finally { await s.close(); }
});

test('app-style telemetry (aggregate JSON and per-field/HA mode) lands in the store under the right car', async () => {
  const s = await setup();
  try {
    const car = await s.connect(A);
    const base = `electric-guardian/${A.deviceId}/telemetry`;
    car.publish(base, JSON.stringify({ soc: 71.5, speed: 12, vin: VIN(1), nested: { x: 1 } }), { qos: 0 });
    car.publish(`${base}/gear`, 'D', { retain: true });
    car.publish(`${base}/is_charging`, 'false');
    car.publish(`${base}/availability`, 'online', { retain: true });
    car.publish(`homeassistant/sensor/x/config`, '{}', { retain: true });             // HA discovery: tolerated, ignored
    await s.wait(200);
    const v = s.store.get(A.deviceId);
    assert.deepEqual(v.data, { soc: 71.5, speed: 12, vin: VIN(1), gear: 'D', is_charging: false });
    assert.equal(v.online, true);
    assert.equal(s.store.get(B.deviceId), null);                                        // nothing leaked to the other car
    assert.equal(s.acc.getDevice(A.deviceId).reported_vin, VIN(1));                     // VIN from telemetry feeds the chassis check
    assert.ok(s.broker.aedes.connectedClients >= 1);
    car.end();
  } finally { await s.close(); }
});

test('isolation: a car cannot publish to, or listen on, another car\'s topics', async () => {
  const s = await setup();
  try {
    const a = await s.connect(A), b = await s.connect(B);
    const got = [];
    b.on('message', (t, m) => got.push(`${t}=${m}`));
    // B tries to listen on A's commands and on everything (#): the broker must deliver nothing but B's own topic
    await new Promise((r) => b.subscribe([`electric-guardian/${A.deviceId}/telemetry/+/set`, `electric-guardian/${B.deviceId}/telemetry/+/set`, '#', '$SYS/#'], r));
    await s.broker.publishCommand(A.deviceId, 'hazard', undefined, 'off');               // must NOT reach B
    // A tries to write into B's telemetry: the broker drops A's connection (MQTT has no per-publish error)
    const closed = new Promise((r) => a.once('close', r));
    a.publish(`electric-guardian/${B.deviceId}/telemetry`, JSON.stringify({ soc: 1 }));
    await closed;
    assert.equal(s.store.get(B.deviceId), null);
    await s.broker.publishCommand(B.deviceId, 'hazard', undefined, 'on');
    await s.wait(150);
    assert.deepEqual(got, [`electric-guardian/${B.deviceId}/telemetry/hazard/set=on`]);
    b.end();
  } finally { await s.close(); }
});

test('commands reach only the target car; offline car is refused; nothing is retained', async () => {
  const s = await setup();
  try {
    const a = await s.connect(A), b = await s.connect(B);
    const ga = [], gb = [];
    a.on('message', (t, m) => ga.push(`${t}=${m}`)); b.on('message', (t, m) => gb.push(`${t}=${m}`));
    const bA = `electric-guardian/${A.deviceId}/telemetry`, bB = `electric-guardian/${B.deviceId}/telemetry`;
    await new Promise((r) => a.subscribe([`${bA}/+/set`, `${bA}/+/+/set`], r)); await new Promise((r) => b.subscribe([`${bB}/+/set`], r));
    await s.broker.publishCommand(A.deviceId, 'windows_all', undefined, 'CLOSE');
    await s.broker.publishCommand(A.deviceId, 'climate', 'temperature', '22');
    await s.wait(150);
    assert.deepEqual(ga, [`${bA}/windows_all/set=CLOSE`, `${bA}/climate/temperature/set=22`]); assert.deepEqual(gb, []);
    b.end(); await s.wait(100);
    await assert.rejects(s.broker.publishCommand(B.deviceId, 'hazard', undefined, 'on'), /not connected/);
    // a new subscriber must NOT receive the old command (retain=false)
    const late = await s.connect(A, { clientId: 'late' }); const lg = [];
    late.on('message', (t, m) => lg.push(m.toString())); await new Promise((r) => late.subscribe(`${bA}/+/set`, r)); await s.wait(150);
    assert.deepEqual(lg, []);
    a.end(); late.end();
  } finally { await s.close(); }
});

test('disconnect marks the car offline in the store', async () => {
  const s = await setup();
  try {
    const car = await s.connect(A);
    car.publish(`electric-guardian/${A.deviceId}/telemetry/soc`, '50'); await s.wait(100);
    assert.equal(s.store.get(A.deviceId).online, true);
    await new Promise((r) => car.end(false, {}, r)); await s.wait(150);
    assert.equal(s.store.get(A.deviceId).online, false);
  } finally { await s.close(); }
});
