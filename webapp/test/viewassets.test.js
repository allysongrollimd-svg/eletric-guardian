import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../lib/db.js';
import { createAccounts } from '../lib/accounts.js';
import { Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { createTunnelHub } from '../lib/tunnel.js';
import { createCloud } from '../lib/cloud.js';
import { loadConfig } from '../lib/config.js';

const cfg = loadConfig({ AUTH_MODE: 'accounts', APP_HOST: 'app.test', VIEW_HOST: 'view.test', PUBLIC_SCHEME: 'https' });
const get = (port, path, { host = 'view.test', cookie } = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
  }).on('error', reject);
});

test('phone screens on the camera host: pages need a view session, assets are public, nothing escapes the folder', async () => {
  const accounts = createAccounts(openDb(':memory:'), { secret: 's'.repeat(40) });
  const store = new Store({ historyMinGapMs: 0 }); const hub = createTunnelHub({ accounts, log: {} });
  const cloud = createCloud({ cfg, accounts, store, hub, broker: null, secret: 's'.repeat(40) });
  const server = createApp({ ...cfg, coalesceMs: 10 }, store, null, cloud);
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  try {
    const u = await accounts.signup({ email: 'a@x.com', password: 'senha-forte-123' });
    const car = accounts.claim(u.id, { code: accounts.registerDevice({ deviceId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001', deviceKey: 'k'.padEnd(43, 'x'), vin: 'LGXC16DG2R0123456' }).code });
    assert.equal((await get(port, '/_eg/sentinela.html')).status, 401);                                        // no session
    const t = cloud.view.issueTicket(u.id, car.id);
    const enter = await get(port, `/_enter?t=${encodeURIComponent(t)}&next=${encodeURIComponent('/_eg/sentinela.html')}`);
    assert.equal(enter.status, 302); assert.equal(enter.headers.location, '/_eg/sentinela.html');              // whitelisted landing page
    const cookie = enter.headers['set-cookie'][0].split(';')[0];
    const page = await get(port, '/_eg/sentinela.html', { cookie });
    assert.equal(page.status, 200); assert.match(page.text, /data-type="sentry"/); assert.match(page.text, /href="https:\/\/app\.test\/"/);   // {{APP_URL}} filled in
    assert.match(page.headers['content-security-policy'], /script-src 'self'/); assert.equal(page.headers['cache-control'], 'no-store');
    assert.match((await get(port, '/_eg/dashcam.html', { cookie })).text, /data-type="normal"/);
    assert.equal((await get(port, '/_eg/rec.js')).status, 200);                                                // static assets carry nothing private
    for (const bad of ['/_eg/..%2Fserver.js', '/_eg/nope.html', '/_eg/rec.json', '/_eg/']) assert.equal((await get(port, bad, { cookie })).status, 404, bad);
    const dotdot = await get(port, '/_eg/../server.js', { cookie });                                           // normalised to /server.js: proxied to the (offline) car, never read from disk
    assert.notEqual(dotdot.status, 200); assert.ok(!dotdot.text.includes('createApp'));
    assert.equal((await get(port, '/_enter?t=x&next=%2F_eg%2Fevil.html')).status, 403);                        // bad ticket
    // a non-whitelisted `next` falls back to the car's home page
    const t2 = cloud.view.issueTicket(u.id, car.id);
    assert.equal((await get(port, `/_enter?t=${encodeURIComponent(t2)}&next=${encodeURIComponent('/_eg/evil.html')}`)).headers.location, '/');
  } finally { await new Promise((r) => server.shutdown(r)); hub.shutdown(); }
});
