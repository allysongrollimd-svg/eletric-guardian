import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createAccounts, AccountError, PAIR_ALPHABET, PAIR_TTL_MS, isValidVin } from '../lib/accounts.js';

const SECRET = 'x'.repeat(40);
const VIN = 'LGXC16DG2R0123456';
const VIN2 = 'LGXC16DG2R0654321';
const dev = (n = 1) => ({ deviceId: `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`, deviceKey: `k${n}`.padEnd(43, 'x') });

function make() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const acc = createAccounts(openDb(':memory:'), { secret: SECRET, now: clock.now });
  return { acc, clock };
}
const throwsCode = async (fn, code) => assert.rejects(async () => fn(), (e) => e instanceof AccountError && e.code === code, code);

test('signup validates input and rejects duplicates (case-insensitive)', async () => {
  const { acc } = make();
  await throwsCode(() => acc.signup({ email: 'nope', password: 'longenoughpass' }), 'bad_email');
  await throwsCode(() => acc.signup({ email: 'a@b.co', password: 'short' }), 'weak_password');
  const u = await acc.signup({ email: 'Ana@Example.com ', password: 'a-long-password', name: 'Ana' });
  assert.equal(u.email, 'ana@example.com');
  assert.equal(u.pass_hash, undefined);
  await throwsCode(() => acc.signup({ email: 'ANA@example.com', password: 'another-long-pass' }), 'email_taken');
});

test('login: right password ok; wrong password and unknown e-mail give the same error', async () => {
  const { acc } = make();
  await acc.signup({ email: 'ana@example.com', password: 'a-long-password' });
  assert.equal((await acc.login({ email: 'ANA@example.com', password: 'a-long-password' })).email, 'ana@example.com');
  await throwsCode(() => acc.login({ email: 'ana@example.com', password: 'wrong-password!' }), 'bad_credentials');
  await throwsCode(() => acc.login({ email: 'ghost@example.com', password: 'a-long-password' }), 'bad_credentials');
});

test('sessions: valid, tampered, expired, and revoked by logout-all / password change', async () => {
  const { acc, clock } = make();
  const u = await acc.signup({ email: 'ana@example.com', password: 'a-long-password' });
  const { token } = acc.makeSession(u.id);
  assert.equal(acc.userFromSession(token).id, u.id);
  const [body, sig] = token.split('.');
  assert.equal(acc.userFromSession(`${body}.${sig.slice(0, -2)}xx`), null);
  const forged = Buffer.from(JSON.stringify({ u: u.id, v: 1, e: clock.now() + 1e9 })).toString('base64url');
  assert.equal(acc.userFromSession(`${forged}.${sig}`), null);
  assert.equal(acc.userFromSession('garbage'), null);
  acc.logoutAll(u.id);
  assert.equal(acc.userFromSession(token), null);
  const t2 = acc.makeSession(u.id).token;
  await acc.changePassword(u.id, 'a-long-password', 'a-new-long-password');
  assert.equal(acc.userFromSession(t2), null);
  const t3 = acc.makeSession(u.id).token;
  clock.advance(31 * 24 * 3600_000);
  assert.equal(acc.userFromSession(t3), null);
});

test('VIN validation (ISO 3779: 17 chars, no I/O/Q)', () => {
  assert.ok(isValidVin(VIN)); assert.ok(isValidVin('lgxc16dg2r0123456')); assert.ok(isValidVin('LGX-C16DG2R 0123456'));
  assert.ok(!isValidVin('LGXC16DG2R012345')); assert.ok(!isValidVin('LGXC16DG2R012345O')); assert.ok(!isValidVin('LGXC16DG2R012345I'));
});

test('device registration: pending state with a readable code; re-register is idempotent; wrong key rejected', () => {
  const { acc } = make();
  const d = dev(1);
  const s = acc.registerDevice(d);
  assert.equal(s.state, 'pending');
  assert.match(s.code, new RegExp(`^[${PAIR_ALPHABET}]{8}$`));
  assert.equal(acc.registerDevice(d).code, s.code);                              // same code while valid
  assert.throws(() => acc.registerDevice({ ...d, deviceKey: 'other'.padEnd(43, 'y') }), (e) => e.code === 'bad_key');
  assert.throws(() => acc.registerDevice({ deviceId: 'nope', deviceKey: d.deviceKey }), (e) => e.code === 'bad_device');
  assert.throws(() => acc.registerDevice({ deviceId: d.deviceId, deviceKey: 'short' }), (e) => e.code === 'bad_device');
  assert.ok(acc.deviceAuth(d.deviceId, d.deviceKey));
  assert.equal(acc.deviceAuth(d.deviceId, 'wrong'), null);
});

test('claim: code + VIN bind the car to the account; code is single-use', async () => {
  const { acc } = make();
  const u = await acc.signup({ email: 'ana@example.com', password: 'a-long-password' });
  const d = dev(1); const { code } = acc.registerDevice(d);
  await throwsCode(() => acc.claim(u.id, { vin: 'BAD', code }), 'bad_vin');
  await throwsCode(() => acc.claim(u.id, { vin: VIN, code: 'ZZZZZZZZ' }), 'bad_code');
  const car = acc.claim(u.id, { vin: VIN.toLowerCase(), code: code.toLowerCase(), name: 'Dolphin GS' });
  assert.equal(car.vin, VIN); assert.equal(car.name, 'Dolphin GS');
  assert.equal(acc.owns(u.id, d.deviceId), true);
  assert.equal(acc.registerDevice(d).state, 'claimed');
  await throwsCode(() => acc.claim(u.id, { vin: VIN, code }), 'bad_code');                        // consumed
  assert.deepEqual(acc.listCars(u.id).map((c) => c.id), [d.deviceId]);
});

test('isolation: another account cannot see, own or unlink the car', async () => {
  const { acc } = make();
  const a = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  const b = await acc.signup({ email: 'b@example.com', password: 'b-long-password' });
  const d = dev(1); acc.claim(a.id, { vin: VIN, code: acc.registerDevice(d).code });
  assert.equal(acc.owns(b.id, d.deviceId), false);
  assert.deepEqual(acc.listCars(b.id), []);
  assert.throws(() => acc.unlink(b.id, d.deviceId), (e) => e.code === 'not_found');
  acc.renameCar(b.id, d.deviceId, 'hacked');
  assert.notEqual(acc.listCars(a.id)[0].name, 'hacked');
});

test('chassis uniqueness: a VIN cannot be claimed by two accounts; release by owner or admin frees it', async () => {
  const { acc } = make();
  const a = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  const b = await acc.signup({ email: 'b@example.com', password: 'b-long-password' });
  const d1 = dev(1), d2 = dev(2);
  acc.claim(a.id, { vin: VIN, code: acc.registerDevice(d1).code });
  await throwsCode(() => acc.claim(b.id, { vin: VIN, code: acc.registerDevice(d2).code }), 'vin_taken');
  acc.unlink(a.id, d1.deviceId);
  acc.claim(b.id, { vin: VIN, code: acc.registerDevice(d2).code });                                 // now free
  assert.equal(acc.adminReleaseVin(VIN), true);
  assert.equal(acc.owns(b.id, d2.deviceId), false);
});

test('same owner reinstalling the app (new deviceId) rebinds the chassis', async () => {
  const { acc } = make();
  const a = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  const d1 = dev(1), d2 = dev(2);
  acc.claim(a.id, { vin: VIN, code: acc.registerDevice(d1).code });
  acc.claim(a.id, { vin: VIN, code: acc.registerDevice(d2).code });
  assert.deepEqual(acc.listCars(a.id).map((c) => c.id), [d2.deviceId]);
});

test('VIN reported by the car must match the one the owner declares', async () => {
  const { acc } = make();
  const a = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  const d = { ...dev(1), vin: VIN };
  const { code } = acc.registerDevice(d);
  await throwsCode(() => acc.claim(a.id, { vin: VIN2, code }), 'vin_mismatch');
  const car = acc.claim(a.id, { vin: VIN, code });
  assert.equal(car.vinVerified, true);
});

test('pairing codes expire and are regenerated', async () => {
  const { acc, clock } = make();
  const a = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  const d = dev(1); const first = acc.registerDevice(d);
  clock.advance(PAIR_TTL_MS + 1);
  await throwsCode(() => acc.claim(a.id, { vin: VIN, code: first.code }), 'bad_code');
  const second = acc.registerDevice(d);
  assert.notEqual(second.code, first.code);
  assert.ok(second.expiresAt > clock.now());
});

test('telemetry-reported VIN is stored and drives the verified flag', async () => {
  const { acc } = make();
  const a = await acc.signup({ email: 'a@example.com', password: 'a-long-password' });
  const d = dev(1); acc.claim(a.id, { vin: VIN, code: acc.registerDevice(d).code });
  assert.equal(acc.listCars(a.id)[0].vinVerified, false);
  acc.touch(d.deviceId, { vin: VIN, appVersion: '50.1' });
  const c = acc.listCars(a.id)[0];
  assert.equal(c.vinVerified, true); assert.equal(c.appVersion, '50.1'); assert.ok(c.lastSeen);
});

test('claim without typing the VIN uses the one the car reported; falls back to typed VIN only if none', async () => {
  const { acc } = make();
  const a = await acc.signup({ email: 'qr@x.com', password: 'senha-forte-123', name: 'Q' });
  const d1 = { ...dev(7), vin: VIN };
  const code = acc.registerDevice(d1).code;
  assert.equal(acc.claim(a.id, { code }).vin, VIN);
  const d2 = dev(8);                                                                    // car that has not reported a VIN yet
  const c2 = acc.registerDevice(d2).code;
  await throwsCode(() => acc.claim(a.id, { code: c2 }), 'vin_pending');
  acc.registerDevice({ ...d2, vin: VIN2 });                                             // VIN learned later: re-register is idempotent
  assert.equal(acc.claim(a.id, { code: acc.pairingState(d2.deviceId).code }).vin, VIN2);
});

test('várias pessoas por carro: código do carro adiciona, acesso é igual, o último que sai libera o carro', async () => {
  const { acc } = make();
  const ana = await acc.signup({ email: 'ana@example.com', password: 'a-long-password', name: 'Ana' });
  const bia = await acc.signup({ email: 'bia@example.com', password: 'a-long-password', name: 'Bia' });
  const caio = await acc.signup({ email: 'caio@example.com', password: 'a-long-password', name: 'Caio' });
  const d = dev(7);
  const st = acc.registerDevice({ ...d, vin: VIN });
  acc.claim(ana.id, { code: st.code, name: 'Dolphin' });
  assert.equal(acc.owns(ana.id, d.deviceId), true);
  assert.equal(acc.owns(bia.id, d.deviceId), false);

  // sem código novo no carro, ninguém entra
  await throwsCode(() => acc.claim(bia.id, { code: 'ABCD2345' }), 'bad_code');
  const add = acc.requestAddCode(d.deviceId);
  const car = acc.claim(bia.id, { code: add.code });
  assert.equal(car.id, d.deviceId);
  assert.equal(acc.owns(bia.id, d.deviceId), true);
  assert.equal(acc.listCars(bia.id).length, 1);
  await throwsCode(() => acc.claim(caio.id, { code: add.code }), 'bad_code');          // código de uso único
  assert.equal(acc.pairingState(d.deviceId).members.length, 2);
  assert.ok(acc.pairingState(d.deviceId).members.some((m) => /^bi\*+@example\.com$/.test(m.email)));   // a tela do carro mascara o e-mail

  acc.removeMember(d.deviceId, ana.id);                                                   // quem era dono sai: a Bia assume
  assert.equal(acc.owns(ana.id, d.deviceId), false);
  assert.equal(acc.ownerOf(d.deviceId), bia.id);   // quem sobrou
  assert.equal(acc.pairingState(d.deviceId).state, 'claimed');
  acc.unlink(bia.id, d.deviceId);                                                         // último a sair libera o carro
  assert.equal(acc.pairingState(d.deviceId).state, 'pending');
  await throwsCode(() => acc.removeMember(d.deviceId, bia.id), 'not_found');
});

test('reinstalar o app mantém todas as pessoas do carro', async () => {
  const { acc } = make();
  const ana = await acc.signup({ email: 'ana@example.com', password: 'a-long-password' });
  const bia = await acc.signup({ email: 'bia@example.com', password: 'a-long-password' });
  const a = dev(1), b = dev(2);
  acc.claim(ana.id, { code: acc.registerDevice({ ...a, vin: VIN }).code });
  acc.claim(bia.id, { code: acc.requestAddCode(a.deviceId).code });
  const st = acc.registerDevice({ ...b, vin: VIN });                                      // novo id, mesmo chassi
  acc.claim(ana.id, { code: st.code });
  assert.equal(acc.owns(ana.id, b.deviceId), true);
  assert.equal(acc.owns(bia.id, b.deviceId), true);
  assert.equal(acc.owns(ana.id, a.deviceId), false);
});

test('controles que o carro não tem: o admin desliga e a lista fica salva', () => {
  const { acc } = make();
  const d = dev(9); acc.registerDevice(d);
  assert.deepEqual(acc.controlsOff(d.deviceId), []);
  assert.deepEqual(acc.setControlsOff(d.deviceId, ['adas_bsd', 'adas_bsd', 'sunroof']), ['adas_bsd', 'sunroof']);
  assert.deepEqual(acc.controlsOff(d.deviceId), ['adas_bsd', 'sunroof']);
  assert.throws(() => acc.setControlsOff('nao-existe', ['x']), (e) => e.code === 'not_found');
});
