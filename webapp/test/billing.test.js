import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../lib/db.js';
import { createAccounts, AccountError } from '../lib/accounts.js';
import { createBilling, addMonths } from '../lib/billing.js';
import { createAdmin } from '../lib/admin.js';
import { ProviderError } from '../lib/infinitepay.js';
import { Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { createTunnelHub } from '../lib/tunnel.js';
import { createCloud } from '../lib/cloud.js';
import { loadConfig } from '../lib/config.js';

const DAY = 86_400_000;
const SECRET = 's'.repeat(40);
const VIN = 'LGXC16DG2R0123456';
const dev = (n = 1) => ({ deviceId: `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`, deviceKey: `k${n}`.padEnd(43, 'x') });
const throwsCode = (fn, code) => assert.rejects(async () => fn(), (e) => e instanceof AccountError && e.code === code, code);

/** A stand-in for the InfinitePay API: records link requests and answers payment_check from a table. */
function fakeProvider() {
  const p = { links: [], paid: new Map(), down: false };
  p.createLink = async (req) => { p.links.push(req); return `https://checkout.example/${req.orderNsu}`; };
  p.paymentCheck = async ({ orderNsu, transactionNsu }) => {
    if (p.down) throw new ProviderError('down', { retryable: true });
    const rec = p.paid.get(orderNsu);
    return rec && rec.tx === transactionNsu ? { paid: true, paidAmountCents: rec.cents, captureMethod: 'pix', installments: 1 } : { paid: false, paidAmountCents: null };
  };
  return p;
}

function setup({ handle = 'minha-tag' } = {}) {
  let t = Date.UTC(2026, 0, 31, 12);
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const db = openDb(':memory:');
  const accounts = createAccounts(db, { secret: SECRET, now: clock.now });
  const provider = fakeProvider();
  const billing = createBilling({ db, accounts, cfg: {}, secret: SECRET, now: clock.now, provider });
  if (handle) billing.setSettings({ infinitepayHandle: handle });
  const admin = createAdmin({ db, accounts, billing, now: clock.now });
  return { clock, db, accounts, billing, admin, provider };
}
async function linkedCar(s, n = 1, vin = VIN, email = `u${n}@x.com`) {
  const u = await s.accounts.signup({ email, password: 'senha-forte-123', name: `U${n}` });
  const d = { ...dev(n), vin };
  const car = s.accounts.claim(u.id, { code: s.accounts.registerDevice(d).code });
  return { u, d, car };
}

test('addMonths never skips a month at month ends', () => {
  assert.equal(new Date(addMonths(Date.UTC(2026, 0, 31), 1)).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(new Date(addMonths(Date.UTC(2028, 0, 31), 1)).toISOString().slice(0, 10), '2028-02-29');
  assert.equal(new Date(addMonths(Date.UTC(2026, 10, 30), 3)).toISOString().slice(0, 10), '2027-02-28');
  assert.equal(new Date(addMonths(Date.UTC(2026, 5, 15), 12)).toISOString().slice(0, 10), '2027-06-15');
});

test('first link of a chassis starts the trial; trial -> grace -> expired; re-linking never restarts it', async () => {
  const s = setup(); const { u, d, car } = await linkedCar(s);
  assert.equal(s.billing.state(VIN).state, 'trial');
  assert.equal(s.billing.allowed(car.id), true);
  s.clock.advance(7 * DAY + 1000);
  assert.equal(s.billing.state(VIN).state, 'grace'); assert.equal(s.billing.allowed(car.id), true);
  s.clock.advance(5 * DAY);
  assert.equal(s.billing.state(VIN).state, 'expired'); assert.equal(s.billing.allowed(car.id), false);
  // unlink and link again (even a fresh app install) does not give a new trial
  s.accounts.unlink(u.id, car.id);
  s.accounts.claim(u.id, { code: s.accounts.registerDevice({ ...dev(2), vin: VIN }).code });
  assert.equal(s.billing.state(VIN).state, 'expired');
});

test('cars linked before billing existed get the trial when billing starts', async () => {
  const s = setup(); const { car } = await linkedCar(s);
  s.db.exec('DELETE FROM vin_access');                                   // simulate the database from before this feature
  assert.equal(s.billing.allowed(car.id), false);
  const again = createBilling({ db: s.db, accounts: s.accounts, cfg: {}, secret: SECRET, now: s.clock.now, provider: s.provider });
  assert.equal(again.state(VIN).state, 'trial');
});

test('checkout: needs a configured handle, only the owner can pay for a car, plan must be active', async () => {
  const s = setup({ handle: '' }); const { u, car } = await linkedCar(s);
  const o = await s.accounts.signup({ email: 'other@x.com', password: 'senha-forte-123' });
  await throwsCode(() => s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'mensal', baseUrl: 'https://a.test' }), 'billing_off');
  s.billing.setSettings({ infinitepayHandle: '$minha-tag' });
  assert.equal(s.billing.getSetting('infinitepay_handle'), 'minha-tag');                        // the "$" of the InfiniteTag is dropped
  await throwsCode(() => s.billing.createInvoice({ userId: o.id, deviceId: car.id, planId: 'mensal', baseUrl: 'https://a.test' }), 'not_found');
  await throwsCode(() => s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'nope', baseUrl: 'https://a.test' }), 'bad_plan');
  s.billing.savePlan({ id: 'anual', name: 'Anual', months: 12, priceCents: 29990, active: false });
  await throwsCode(() => s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'anual', baseUrl: 'https://a.test' }), 'bad_plan');
  const inv = await s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'trimestral', baseUrl: 'https://a.test', customer: { email: 'u1@x.com' } });
  assert.equal(inv.status, 'pending'); assert.equal(inv.amountCents, 8490); assert.match(inv.checkoutUrl, /^https:\/\/checkout\.example\/eg_/);
  const sent = s.provider.links[0];
  assert.equal(sent.handle, 'minha-tag'); assert.equal(sent.items[0].price, 8490); assert.equal(sent.orderNsu, inv.id);
  assert.equal(sent.redirectUrl, `https://a.test/billing/return?order=${inv.id}`);
  assert.ok(s.billing.verifyWebhookKey(inv.id, new URL(sent.webhookUrl).searchParams.get('k')));
  assert.equal(s.billing.verifyWebhookKey(inv.id, 'forged'), false);
});

test('payment: provider is the authority, amounts are checked, credit happens once, access stacks', async () => {
  const s = setup(); const { u, car } = await linkedCar(s);
  const inv = await s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'mensal', baseUrl: 'https://a.test' });
  // webhook claims a payment the provider does not know about -> nothing is credited
  await throwsCode(() => s.billing.settleFromProvider(inv.id, { transactionNsu: 'tx-1' }), 'not_paid');
  assert.equal(s.billing.state(VIN).state, 'trial');
  // paid, but less than the invoice
  s.provider.paid.set(inv.id, { tx: 'tx-1', cents: 100 });
  await throwsCode(() => s.billing.settleFromProvider(inv.id, { transactionNsu: 'tx-1' }), 'amount_mismatch');
  // paid in full
  s.provider.paid.set(inv.id, { tx: 'tx-1', cents: 2990 });
  const r = await s.billing.settleFromProvider(inv.id, { transactionNsu: 'tx-1', slug: 'slug-1', receiptUrl: 'https://r.test/1' });
  assert.equal(r.already, false); assert.equal(r.invoice.status, 'paid'); assert.equal(r.invoice.captureMethod, 'pix');
  const st = s.billing.state(VIN);
  assert.equal(st.state, 'active');
  assert.equal(new Date(st.paidUntil).toISOString().slice(0, 10), '2026-03-07');                // trial ends 7 Feb (kept) + 1 month
  // the same webhook again (retry) changes nothing
  const again = await s.billing.settleFromProvider(inv.id, { transactionNsu: 'tx-1' });
  assert.equal(again.already, true); assert.equal(s.billing.state(VIN).paidUntil, st.paidUntil);
  // renewing while active stacks on top of the current end date
  const inv2 = await s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'trimestral', baseUrl: 'https://a.test' });
  s.provider.paid.set(inv2.id, { tx: 'tx-2', cents: 8490 });
  await s.billing.settleFromProvider(inv2.id, { transactionNsu: 'tx-2' });
  assert.equal(new Date(s.billing.state(VIN).paidUntil).toISOString().slice(0, 10), '2026-06-07');
  // one provider transaction can never pay two invoices
  const inv3 = await s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'mensal', baseUrl: 'https://a.test' });
  s.provider.paid.set(inv3.id, { tx: 'tx-2', cents: 2990 });
  const dup = await s.billing.settleFromProvider(inv3.id, { transactionNsu: 'tx-2' });
  assert.equal(dup.already, true); assert.equal(s.billing.invoice(inv3.id).status, 'pending');
  // a provider outage surfaces as retryable
  s.provider.down = true;
  await assert.rejects(() => s.billing.settleFromProvider(inv3.id, { transactionNsu: 'tx-9' }), (e) => e instanceof ProviderError && e.retryable);
  // paying after expiry restarts from "now", not from the old end date
  s.provider.down = false; s.clock.advance(400 * DAY);
  assert.equal(s.billing.state(VIN).state, 'expired');
  s.provider.paid.set(inv3.id, { tx: 'tx-3', cents: 2990 });
  await s.billing.settleFromProvider(inv3.id, { transactionNsu: 'tx-3' });
  assert.ok(s.billing.state(VIN).paidUntil > s.clock.now() + 27 * DAY && s.billing.state(VIN).state === 'active');
});

test('admin: manual settlement, grants, cancel, last-admin protection, audit', async () => {
  const s = setup(); const { u, car } = await linkedCar(s);
  const adm = await s.accounts.signup({ email: 'adm@x.com', password: 'senha-forte-123', role: 'admin' });
  const inv = await s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'semestral', baseUrl: 'https://a.test' });
  const r = s.billing.settleManual(inv.id, { note: 'PIX direto', adminId: adm.id });
  assert.equal(r.invoice.status, 'paid'); assert.equal(s.billing.invoice(inv.id).source, 'manual');
  assert.equal(new Date(s.billing.state(VIN).paidUntil).toISOString().slice(0, 10), '2026-08-07');
  const sale = s.billing.createManualPaid({ vin: VIN, planId: 'mensal', adminId: adm.id });
  assert.equal(sale.invoice.status, 'paid');
  const before = s.billing.state(VIN).paidUntil; s.billing.grantDays(VIN, 10, { adminId: adm.id });
  assert.equal(s.billing.state(VIN).paidUntil - before, 10 * DAY);
  const inv2 = await s.billing.createInvoice({ userId: u.id, deviceId: car.id, planId: 'mensal', baseUrl: 'https://a.test' });
  assert.equal(s.billing.cancelInvoice(inv2.id, adm.id), true);
  await throwsCode(() => s.billing.settleManual(inv2.id, { adminId: adm.id }), 'cancelled');
  await throwsCode(() => s.admin.updateUser(adm.id, { role: 'user' }, adm.id), 'last_admin');
  await throwsCode(() => s.admin.updateUser(adm.id, { disabled: true }, 'someone-else'), 'last_admin');
  s.admin.updateUser(u.id, { disabled: true }, adm.id);
  assert.equal(s.admin.users({ q: 'u1@' })[0].disabled, true);
  const ov = s.admin.overview(); assert.equal(ov.cars, 1); assert.equal(ov.states.active, 1); assert.ok(ov.revenue30dCents > 0);
  assert.ok(s.admin.audit().some((e) => e.event === 'payment'));
  assert.equal(s.admin.invoices({ status: 'paid' }).length, 2);
});

// ---------------- over HTTP ----------------
const cfg = loadConfig({ AUTH_MODE: 'accounts', ALLOW_SIGNUP: '1', APP_HOST: 'app.test', VIEW_HOST: 'view.test', PUBLIC_SCHEME: 'https', CONTROL_ENABLED: '1' });
function call(port, method, path, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: 'app.test', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, json, text, cookie: (res.headers['set-cookie'] || [])[0]?.split(';')[0] }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

test('HTTP: webhook is key-protected and verified server-side; admin API is role-gated; expired cars lose cameras and control', async () => {
  const s = setup();
  const store = new Store({ historyMinGapMs: 0 });
  const hub = createTunnelHub({ accounts: s.accounts, log: {} });
  const cloud = createCloud({ cfg, accounts: s.accounts, store, hub, broker: null, secret: SECRET, provider: s.provider });
  const server = createApp({ ...cfg, coalesceMs: 10 }, store, null, cloud);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const login = async (email) => (await call(port, 'POST', '/api/auth/login', { body: { email, password: 'senha-forte-123' } })).cookie;
    const { u, car } = await linkedCar(s);
    await s.accounts.signup({ email: 'adm@x.com', password: 'senha-forte-123', role: 'admin' });
    const ana = await login('u1@x.com'), adm = await login('adm@x.com');
    store.update(car.id, { soc: 50 });

    // customer: billing overview and checkout
    const ov = await call(port, 'GET', '/api/billing', { cookie: ana });
    assert.equal(ov.status, 200); assert.equal(ov.json.plans.length, 4); assert.equal(ov.json.cars[0].state, 'trial'); assert.equal(ov.json.checkout, true);
    const co = await call(port, 'POST', '/api/billing/checkout', { cookie: ana, body: { device: car.id, plan: 'mensal' } });
    assert.equal(co.status, 201); const id = co.json.invoice.id;
    assert.equal(s.provider.links[0].redirectUrl, `https://app.test/billing/return?order=${id}`);          // built from APP_HOST, not from the request

    // webhook: wrong key -> 403; right key but unpaid -> 400; paid -> 200 and credited; provider down -> 503
    const key = s.billing.sign(id);
    assert.equal((await call(port, 'POST', `/api/billing/infinitepay/webhook?k=bad`, { body: { order_nsu: id, transaction_nsu: 't1' } })).status, 403);
    assert.equal((await call(port, 'POST', `/api/billing/infinitepay/webhook?k=${key}`, { body: { order_nsu: id, transaction_nsu: 't1' } })).status, 400);
    s.provider.down = true;
    assert.equal((await call(port, 'POST', `/api/billing/infinitepay/webhook?k=${key}`, { body: { order_nsu: id, transaction_nsu: 't1' } })).status, 503);
    s.provider.down = false; s.provider.paid.set(id, { tx: 't1', cents: 2990 });
    const ok = await call(port, 'POST', `/api/billing/infinitepay/webhook?k=${key}`, { body: { order_nsu: id, transaction_nsu: 't1', invoice_slug: 's1', capture_method: 'pix', paid_amount: 2990 } });
    assert.equal(ok.status, 200); assert.equal(ok.json.success, true);
    assert.equal((await call(port, 'GET', `/api/billing/invoices/${id}`, { cookie: ana })).json.invoice.status, 'paid');
    assert.equal((await call(port, 'GET', `/api/billing/invoices/${id}`, { cookie: adm })).status, 404);      // not the admin's invoice
    // return-page fallback verifies the same way and is idempotent
    assert.equal((await call(port, 'POST', '/api/billing/confirm', { cookie: ana, body: { order: id, transaction_nsu: 't1' } })).json.invoice.status, 'paid');

    // admin API
    assert.equal((await call(port, 'GET', '/api/admin/overview', { cookie: ana })).status, 403);
    assert.equal((await call(port, 'GET', '/api/admin/overview')).status, 401);
    const aov = await call(port, 'GET', '/api/admin/overview', { cookie: adm });
    assert.equal(aov.status, 200); assert.equal(aov.json.states.active, 1);
    assert.equal((await call(port, 'GET', '/api/admin/invoices?status=paid', { cookie: adm })).json.invoices.length, 1);
    assert.equal((await call(port, 'PUT', '/api/admin/plans/mensal', { cookie: adm, body: { name: 'Mensal', months: 1, priceCents: 3490 } })).json.plans.find((p) => p.id === 'mensal').priceCents, 3490);
    assert.equal((await call(port, 'PUT', '/api/admin/settings', { cookie: adm, body: { trialDays: 14 } })).json.trialDays, 14);
    assert.equal((await call(port, 'POST', '/api/admin/cars/grant', { cookie: adm, body: { vin: VIN, days: 5 } })).status, 200);
    assert.equal((await call(port, 'PUT', '/api/admin/settings', { cookie: adm, headers: { 'content-type': 'text/plain' }, body: undefined })).status, 415);

    // expiry: cameras and remote control are blocked, telemetry and billing stay available
    s.clock.advance(400 * DAY);
    assert.equal(s.billing.allowed(car.id), false);
    const ana2 = await login('u1@x.com');                                                                   // sessions expire with the clock too
    const view = await call(port, 'POST', `/api/cars/${car.id}/view`, { cookie: ana2, body: {} });
    assert.equal(view.status, 402); assert.equal(view.json.code, 'subscription_expired');
    const ctl = await call(port, 'POST', `/api/devices/${car.id}/control`, { cookie: ana2, body: { key: 'hazard', value: 'on' } });
    assert.equal(ctl.status, 402);
    assert.equal((await call(port, 'GET', '/api/devices', { cookie: ana2 })).json[0].billing.state, 'expired');
    assert.equal((await call(port, 'GET', '/api/billing', { cookie: ana2 })).status, 200);
  } finally { await new Promise((r) => server.shutdown(r)); hub.shutdown(); }
});
