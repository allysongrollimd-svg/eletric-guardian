import { randomBytes, randomUUID, scrypt as scryptCb, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O/1/I/L: easy to read off a car screen
export const PAIR_TTL_MS = 15 * 60_000;
const SESSION_MS = 30 * 24 * 3600_000;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;                           // ISO 3779: no I, O or Q

export const normalizeVin = (v) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
export const isValidVin = (v) => VIN_RE.test(normalizeVin(v));
const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const isUuidish = (s) => /^[a-f0-9-]{32,40}$/i.test(String(s ?? ''));

export class AccountError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Users, sessions, devices and chassis pairing on top of a node:sqlite database. */
export function createAccounts(db, { secret, now = () => Date.now() } = {}) {
  if (!secret || secret.length < 32) throw new Error('accounts: a session secret of >= 32 chars is required');
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insUser: db.prepare('INSERT INTO users (id, email, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    bumpVer: db.prepare('UPDATE users SET session_ver = session_ver + 1 WHERE id = ?'),
    setPass: db.prepare('UPDATE users SET pass_hash = ?, session_ver = session_ver + 1 WHERE id = ?'),
    dev: db.prepare('SELECT * FROM devices WHERE id = ?'),
    insDev: db.prepare('INSERT INTO devices (id, key_hash, reported_vin, app_version, created_at) VALUES (?, ?, ?, ?, ?)'),
    devByVin: db.prepare('SELECT * FROM devices WHERE vin = ? AND owner_id IS NOT NULL'),
    carsOf: db.prepare('SELECT * FROM devices WHERE owner_id = ? ORDER BY created_at'),
    claimDev: db.prepare('UPDATE devices SET owner_id = ?, vin = ?, name = ?, claimed_at = ? WHERE id = ?'),
    release: db.prepare('UPDATE devices SET owner_id = NULL, vin = NULL, claimed_at = NULL WHERE id = ?'),
    rename: db.prepare('UPDATE devices SET name = ? WHERE id = ? AND owner_id = ?'),
    touch: db.prepare('UPDATE devices SET last_seen = ?, app_version = COALESCE(?, app_version), reported_vin = COALESCE(?, reported_vin) WHERE id = ?'),
    pairIns: db.prepare('INSERT INTO pairings (code, device_id, expires_at) VALUES (?, ?, ?)'),
    pairByCode: db.prepare('SELECT * FROM pairings WHERE code = ?'),
    pairByDev: db.prepare('SELECT * FROM pairings WHERE device_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1'),
    pairDelDev: db.prepare('DELETE FROM pairings WHERE device_id = ?'),
    pairPrune: db.prepare('DELETE FROM pairings WHERE expires_at <= ?'),
    pendingCount: db.prepare('SELECT COUNT(*) AS n FROM pairings WHERE expires_at > ?'),
    audit: db.prepare('INSERT INTO audit (t, user_id, device_id, event, detail) VALUES (?, ?, ?, ?, ?)'),
    auditList: db.prepare('SELECT * FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 100'),
  };
  const log = (event, { userId = null, deviceId = null, detail = null } = {}) => q.audit.run(now(), userId, deviceId, event, detail == null ? null : JSON.stringify(detail));
  const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, role: u.role };
  const publicCar = (d) => d && {
    id: d.id, name: d.name, vin: d.vin, vinReported: d.reported_vin || null,
    vinVerified: !!(d.reported_vin && d.vin && d.reported_vin === d.vin),
    claimedAt: d.claimed_at, lastSeen: d.last_seen, appVersion: d.app_version,
  };

  const hash = async (password) => {
    const salt = randomBytes(16);
    const h = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${b64u(salt)}$${b64u(h)}`;
  };
  const verifyHash = async (password, stored) => {
    const [alg, N, r, p, salt, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expect = Buffer.from(h, 'base64url');
    const got = await scrypt(password, Buffer.from(salt, 'base64url'), expect.length, { N: +N, r: +r, p: +p });
    return timingSafeEqual(got, expect);
  };
  // A fixed hash so that login for an unknown e-mail costs the same as a real one (no user enumeration by timing).
  let dummy;

  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');

  const api = {
    publicUser, publicCar, normalizeVin, isValidVin,

    async signup({ email, password, name = '', role = 'user' }) {
      email = normEmail(email);
      if (!EMAIL_RE.test(email)) throw new AccountError('bad_email', 'E-mail inválido.');
      if (typeof password !== 'string' || password.length < 10) throw new AccountError('weak_password', 'A senha precisa ter pelo menos 10 caracteres.');
      if (password.length > 200) throw new AccountError('bad_password', 'Senha longa demais.');
      if (q.userByEmail.get(email)) throw new AccountError('email_taken', 'Este e-mail já está cadastrado.', 409);
      const id = randomUUID();
      q.insUser.run(id, email, String(name).trim().slice(0, 80), await hash(password), role, now());
      log('signup', { userId: id });
      return publicUser(q.userById.get(id));
    },

    async login({ email, password }) {
      email = normEmail(email);
      const u = q.userByEmail.get(email);
      dummy ??= await hash('dummy-password-for-timing');
      const ok = await verifyHash(String(password ?? ''), u ? u.pass_hash : dummy);
      if (!u || !ok || u.disabled) { log('login_failed', { userId: u?.id ?? null }); throw new AccountError('bad_credentials', 'E-mail ou senha incorretos.', 401); }
      log('login', { userId: u.id });
      return publicUser(u);
    },

    /** Stateless signed session; invalidated by bumping users.session_ver. */
    makeSession(userId) {
      const u = q.userById.get(userId);
      const body = b64u(JSON.stringify({ u: userId, v: u.session_ver, e: now() + SESSION_MS }));
      return { token: `${body}.${sign(body)}`, maxAgeSeconds: Math.floor(SESSION_MS / 1000) };
    },
    userFromSession(token) {
      if (typeof token !== 'string') return null;
      const [body, sig] = token.split('.');
      if (!body || !sig || !eq(sig, sign(body))) return null;
      let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
      if (!p || p.e <= now()) return null;
      const u = q.userById.get(p.u);
      return u && !u.disabled && u.session_ver === p.v ? publicUser(u) : null;
    },
    logoutAll(userId) { q.bumpVer.run(userId); },
    /** Re-authentication (e.g. unlocking remote control): checks the account password. */
    async verifyPassword(userId, password) {
      const u = q.userById.get(userId);
      return !!u && !u.disabled && (await verifyHash(String(password ?? ''), u.pass_hash));
    },
    sessionVersion(userId) { return q.userById.get(userId)?.session_ver ?? 0; },
    async changePassword(userId, current, next) {
      const u = q.userById.get(userId);
      if (!u || !(await verifyHash(String(current ?? ''), u.pass_hash))) throw new AccountError('bad_credentials', 'Senha atual incorreta.', 401);
      if (typeof next !== 'string' || next.length < 10) throw new AccountError('weak_password', 'A nova senha precisa ter pelo menos 10 caracteres.');
      q.setPass.run(await hash(next), userId);
    },

    // ---------------- devices (cars) ----------------
    /**
     * Called by the car app. Creates the device on first contact (unclaimed) and hands out a pairing code
     * the owner types into the web app. A device that already exists must prove it owns the key.
     */
    registerDevice({ deviceId, deviceKey, vin, appVersion }) {
      if (!isUuidish(deviceId)) throw new AccountError('bad_device', 'deviceId inválido.');
      if (typeof deviceKey !== 'string' || deviceKey.length < 32 || deviceKey.length > 200) throw new AccountError('bad_device', 'deviceKey inválida.');
      deviceId = deviceId.toLowerCase();
      const reported = vin && isValidVin(vin) ? normalizeVin(vin) : null;
      let d = q.dev.get(deviceId);
      if (!d) {
        if (q.pendingCount.get(now()).n >= 5000) throw new AccountError('busy', 'Muitos pareamentos pendentes. Tente mais tarde.', 503);
        q.insDev.run(deviceId, sha256(deviceKey), reported, appVersion ? String(appVersion).slice(0, 40) : null, now());
        d = q.dev.get(deviceId);
      } else if (!eq(d.key_hash, sha256(deviceKey))) {
        throw new AccountError('bad_key', 'Este dispositivo já existe com outra chave.', 403);
      } else if (reported && reported !== d.reported_vin) q.touch.run(now(), appVersion ?? null, reported, deviceId);
      return api.pairingState(deviceId);
    },

    deviceAuth(deviceId, deviceKey) {
      if (!isUuidish(deviceId) || typeof deviceKey !== 'string') return null;
      const d = q.dev.get(String(deviceId).toLowerCase());
      return d && eq(d.key_hash, sha256(deviceKey)) ? d : null;
    },

    /** State for the car: claimed, or pending with a (re)generated code. */
    pairingState(deviceId) {
      const d = q.dev.get(deviceId);
      if (d.owner_id) return { state: 'claimed', name: d.name, vin: d.vin };
      q.pairPrune.run(now());
      let p = q.pairByDev.get(deviceId, now());
      if (!p) {
        q.pairDelDev.run(deviceId);
        for (let i = 0; i < 5; i++) {
          const code = Array.from(randomBytes(8), (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
          try { q.pairIns.run(code, deviceId, now() + PAIR_TTL_MS); p = q.pairByCode.get(code); break; } catch { /* collision: retry */ }
        }
      }
      return { state: 'pending', code: p.code, expiresAt: p.expires_at };
    },

    /** The owner's side: bind a car (by the code on its screen) to this account and a VIN. */
    claim(userId, { vin, code, name }) {
      const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const p = q.pairByCode.get(c);
      if (!p || p.expires_at <= now()) throw new AccountError('bad_code', 'Código inválido ou expirado. Gere um novo na tela do carro.', 404);
      const d = q.dev.get(p.device_id);
      if (d.owner_id) throw new AccountError('already_claimed', 'Este carro já está vinculado.', 409);
      // The chassis comes from the car itself (APK). A typed VIN is only accepted when the car has not reported one.
      let v;
      if (d.reported_vin) {
        v = d.reported_vin;
        if (vin && normalizeVin(vin) !== v) throw new AccountError('vin_mismatch', 'O chassi informado não confere com o que o carro reportou.', 409);
      } else {
        v = normalizeVin(vin);
        if (!v) throw new AccountError('vin_pending', 'O carro ainda não informou o chassi. Aguarde alguns segundos e tente de novo.', 409);
        if (!isValidVin(v)) throw new AccountError('bad_vin', 'Chassi (VIN) inválido: são 17 caracteres, sem I, O ou Q.');
      }
      const holder = q.devByVin.get(v);
      if (holder && holder.owner_id !== userId) throw new AccountError('vin_taken', 'Este chassi já está vinculado a outra conta. Peça a liberação ao suporte.', 409);
      if (holder && holder.owner_id === userId) { q.release.run(holder.id); log('rebind', { userId, deviceId: holder.id }); }   // same owner reinstalled the app
      q.claimDev.run(userId, v, String(name || '').trim().slice(0, 60) || 'Meu carro', now(), d.id);
      q.pairDelDev.run(d.id);
      log('claim', { userId, deviceId: d.id, detail: { vin: v } });
      return publicCar(q.dev.get(d.id));
    },

    listCars(userId) { return q.carsOf.all(userId).map(publicCar); },
    getDevice(id) { return q.dev.get(String(id)) || null; },
    ownerOf(id) { return q.dev.get(String(id))?.owner_id ?? null; },
    owns(userId, id) { return !!userId && q.dev.get(String(id))?.owner_id === userId; },
    renameCar(userId, id, name) { q.rename.run(String(name).trim().slice(0, 60) || 'Meu carro', id, userId); },
    unlink(userId, id) {
      if (!api.owns(userId, id)) throw new AccountError('not_found', 'Carro não encontrado.', 404);
      q.release.run(id); log('unlink', { userId, deviceId: id });
    },
    /** Support/admin: free a chassis so another account can claim it. */
    adminReleaseVin(vin) { const d = q.devByVin.get(normalizeVin(vin)); if (d) { q.release.run(d.id); log('admin_release', { deviceId: d.id }); } return !!d; },
    touch(id, { vin, appVersion } = {}) { q.touch.run(now(), appVersion ?? null, vin && isValidVin(vin) ? normalizeVin(vin) : null, id); },
    audit(userId) { return q.auditList.all(userId); },
    log,
  };
  return api;
}
