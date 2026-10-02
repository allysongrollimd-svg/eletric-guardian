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
      if (kind === 'binary' && /^(true|false|on|off)$/i.test(s)) out[k] = /^(true|on)$/i.test(s);
      else if (kind !== 'text' && NUMERIC.test(s)) out[k] = Number(s);
      else out[k] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * MQTT topic -> { device, kind }. The Android app publishes aggregate JSON to <topic> and its
 * Last-Will/online state to <topic>/availability, so both of these are understood:
 *   electric-guardian/<device>/telemetry
 *   electric-guardian/<device>/telemetry/availability
 * (and <base>/<device>/availability). A bare "<base>/telemetry" maps to device "car".
 */
export function parseTopic(topic) {
  const parts = String(topic).split('/').filter(Boolean);
  let kind = 'telemetry';
  if (parts[parts.length - 1] === 'availability') { kind = 'availability'; parts.pop(); }
  if (parts[parts.length - 1] === 'telemetry') parts.pop();
  else if (kind === 'telemetry') return null;
  const device = parts.length >= 2 ? parts[parts.length - 1] : 'car';
  return { device: sanitizeDeviceId(device), kind };
}
