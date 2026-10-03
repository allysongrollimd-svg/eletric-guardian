import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const FIELDS = JSON.parse(readFileSync(join(here, '../public/fields.json'), 'utf8'));

const MAX_KEYS = 400;
const NUMERIC = /^-?\d+(\.\d+)?$/;
// Keys whose history we keep for the charts.
export const HISTORY_KEYS = ['soc', 'speed', 'power', 'charge_power', 'batt_temp', 'ext_temp', 'cabin_temp', 'ev_range_km'];

/** Device ids end up in URLs and map keys: keep them boring. */
export function sanitizeDeviceId(id) {
  const s = String(id ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 48);
  return s || 'car';
}

/**
 * Normalizes an untrusted telemetry payload into a flat { key: number|boolean|string }.
 * Nested values are dropped; numeric strings become numbers unless the catalog says "text".
 */
export function normalizeTelemetry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (++n > MAX_KEYS) break;
    if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) continue;
    const kind = FIELDS[k]?.kind;
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = v; }
    else if (typeof v === 'string') {
      const s = v.slice(0, 200);
      if (kind !== 'text' && /^(true|false)$/i.test(s)) { out[k] = /^true$/i.test(s); continue; }
      if (kind === 'binary' && /^(true|false|on|off)$/i.test(s)) out[k] = /^(true|on)$/i.test(s);
      else if (kind !== 'text' && NUMERIC.test(s)) out[k] = Number(s);
      else out[k] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalizes one per-field MQTT value (Home Assistant mode publishes one retained topic per
 * field). Returns undefined for unusable input and null for an explicit tombstone (empty payload).
 */
export function normalizeField(key, raw) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) return undefined;
  const s = String(raw).trim();
  if (s === '') return null;
  return normalizeTelemetry({ [key]: s })?.[key];
}

/**
 * MQTT topic -> { device, kind, key? } for the topics the Android app publishes:
 *   <base>                    aggregate JSON            (kind "telemetry")
 *   <base>/availability       online/offline            (kind "availability")
 *   <base>/<field>            one value, HA mode        (kind "field")
 * where <base> = electric-guardian/<device>/telemetry. Also accepts <prefix>/<device>/availability
 * and a bare "<prefix>/telemetry" (device "car"). <base>/<key>/set (commands) is never matched.
 */
export function parseTopic(topic) {
  const parts = String(topic).split('/').filter(Boolean);
  let kind = null, key;
  const last = parts[parts.length - 1];
  if (last === 'availability') { kind = 'availability'; parts.pop(); }
  else if (last === 'telemetry') kind = 'telemetry';
  else if (parts.length >= 3 && parts[parts.length - 2] === 'telemetry' && last !== 'location') { kind = 'field'; key = parts.pop(); }
  else return null;
  if (parts[parts.length - 1] === 'telemetry') parts.pop();
  else if (kind !== 'availability') return null;
  const device = parts.length >= 2 ? parts[parts.length - 1] : 'car';
  return kind === 'field' ? { device: sanitizeDeviceId(device), kind, key } : { device: sanitizeDeviceId(device), kind };
}
