import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { safeEqual, createLimiter } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
export const CATALOG = JSON.parse(readFileSync(join(here, '../public/controls.json'), 'utf8'));
const BY_KEY = new Map(CATALOG.controls.map((c) => [c.key, c]));
const SUPPORTED = new Set(['switch', 'select', 'number', 'cover', 'button', 'climate']);

const ON = new Set(['on', 'true', '1']);
const OFF = new Set(['off', 'false', '0']);

/**
 * Validates a UI request against the catalog extracted from the app and returns the exact
 * payload the app's MqttCommandRouter accepts. Anything outside the declared domain is rejected
 * here, so the broker never sees a command the car would have to guess about.
 */
export function validateCommand({ key, sub, value }) {
  const c = BY_KEY.get(String(key));
  if (!c || !SUPPORTED.has(c.platform)) return { error: 'unknown or unsupported control' };
  const v = String(value ?? '').trim();
  switch (c.platform) {
    case 'switch': {
      const low = v.toLowerCase();
      if (sub) return { error: 'invalid sub-key' };
      if (ON.has(low)) return { control: c, payload: 'on' };
      if (OFF.has(low)) return c.key === 'adas_aeb' ? { error: 'AEB can only be enabled remotely' } : { control: c, payload: 'off' };
      return { error: 'value must be on/off' };
    }
    case 'cover': {
      const up = v.toUpperCase();
      return !sub && ['OPEN', 'CLOSE', 'STOP'].includes(up) ? { control: c, payload: up } : { error: 'value must be OPEN/CLOSE/STOP' };
    }
    case 'button':
      return !sub && v.toUpperCase() === 'PRESS' ? { control: c, payload: 'PRESS' } : { error: 'value must be PRESS' };
    case 'select': {
      const opt = (c.options || []).find((o) => o.toLowerCase() === v.toLowerCase());
      return !sub && opt ? { control: c, payload: opt } : { error: `value must be one of ${(c.options || []).join(', ')}` };
    }
    case 'number': {
      const n = Number(v);
      if (sub || !Number.isInteger(n) || n < c.min || n > c.max) return { error: `value must be an integer in ${c.min}..${c.max}` };
      if (c.step > 0 && Math.abs((n - c.min) / c.step - Math.round((n - c.min) / c.step)) > 1e-6) return { error: `value must follow step ${c.step}` };
      return { control: c, payload: String(n) };
    }
    case 'climate': {
      if (sub === 'mode') return ['auto', 'off'].includes(v.toLowerCase()) ? { control: c, payload: v.toLowerCase() } : { error: 'mode must be auto/off' };
      if (sub === 'temperature') { const n = Number(v); return Number.isFinite(n) && n >= c.min && n <= c.max && Number.isInteger(n) ? { control: c, payload: String(n) } : { error: `temperature must be ${c.min}..${c.max}` }; }
      if (sub === 'fan_mode') { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 7 ? { control: c, payload: String(n) } : { error: 'fan_mode must be 1..7' }; }
      return { error: 'invalid sub-key' };
    }
    default: return { error: 'unsupported' };
  }
}

/**
 * Remote-control gate: PIN unlock (sliding window), rate limits and an audit trail.
 * `bridge.publishCommand(device, key, sub, payload)` delivers the command.
 */
export function createControl(cfg, bridge, { now = () => Date.now(), log = console } = {}) {
  const sessions = new Map(); // token -> expiry
  const pinLimit = createLimiter(5, 5 * 60_000, now);
  const perDevice = createLimiter(20, 60_000, now);
  const lastByKey = new Map();
  const audit = [];
  const ttl = cfg.controlUnlockSeconds * 1000;

  const record = (e) => { audit.push({ t: now(), ...e }); if (audit.length > 200) audit.shift(); log.info?.(`[control] ${JSON.stringify(e)}`); };
  const sweep = () => { for (const [k, exp] of sessions) if (exp <= now()) sessions.delete(k); };

  return {
    enabled: cfg.controlEnabled && !!bridge,
    audit: () => audit.slice().reverse(),
    unlock(pin, ip) {
      if (!pinLimit(ip)) return { error: 'too many attempts', code: 429 };
      if (!cfg.controlPin || !safeEqual(pin ?? '', cfg.controlPin)) { record({ event: 'unlock-failed', ip }); return { error: 'invalid pin', code: 401 }; }
      sweep();
      const token = randomBytes(24).toString('hex');
      sessions.set(token, now() + ttl);
      record({ event: 'unlock', ip });
      return { token, ttlSeconds: cfg.controlUnlockSeconds };
    },
    lock(token) { if (token) sessions.delete(token); },
    status(token) {
      sweep();
      const exp = sessions.get(token);
      return { enabled: this.enabled, unlocked: !!exp && exp > now(), ttlSeconds: exp ? Math.max(0, Math.round((exp - now()) / 1000)) : 0 };
    },
    async execute(token, device, body, ip, deviceOnline) {
      if (!this.enabled) return { code: 403, error: 'remote control is disabled on this server' };
      const t = token;
      const exp = t && sessions.get(t);
      if (!exp || exp <= now()) return { code: 403, error: 'locked: enter the control PIN', locked: true };
      const v = validateCommand(body || {});
      if (v.error) return { code: 400, error: v.error };
      if (!deviceOnline) return { code: 409, error: 'vehicle is offline' };
      const sub = body.sub ? String(body.sub) : undefined;
      const gapKey = `${device}:${v.control.key}`;
      if (now() - (lastByKey.get(gapKey) || 0) < 1500) return { code: 429, error: 'slow down' };
      if (!perDevice(device)) return { code: 429, error: 'rate limit' };
      lastByKey.set(gapKey, now());
      sessions.set(t, now() + ttl); // sliding window
      try {
        const topic = await bridge.publishCommand(device, v.control.key, sub, v.payload);
        record({ event: 'command', device, key: v.control.key, sub, payload: v.payload, ip, ok: true });
        return { code: 202, ok: true, topic };
      } catch (e) {
        record({ event: 'command', device, key: v.control.key, sub, payload: v.payload, ip, ok: false, error: e.message });
        return { code: 502, error: 'could not deliver the command' };
      }
    },
  };
}
