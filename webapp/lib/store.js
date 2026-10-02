import { EventEmitter } from 'node:events';
import { HISTORY_KEYS, sanitizeDeviceId } from './telemetry.js';

/** In-memory device state + bounded history. Emits 'update' ({device, state}) and 'status'. */
export class Store extends EventEmitter {
  constructor({ historyMax = 4000, historyMinGapMs = 2000, offlineAfterSeconds = 90, now = () => Date.now() } = {}) {
    super();
    this.historyMax = historyMax;
    this.historyMinGapMs = historyMinGapMs;
    this.offlineAfterMs = offlineAfterSeconds * 1000;
    this.now = now;
    this.devices = new Map();
  }

  _dev(id) {
    const device = sanitizeDeviceId(id);
    let d = this.devices.get(device);
    if (!d) {
      d = { device, data: {}, lastSeen: 0, availability: null, history: [] };
      this.devices.set(device, d);
    }
    return d;
  }

  update(id, fields) {
    const d = this._dev(id);
    const t = this.now();
    for (const [k, v] of Object.entries(fields)) { if (v === null) delete d.data[k]; else d.data[k] = v; }
    d.lastSeen = t;
    const last = d.history[d.history.length - 1];
    if (!last || t - last.t >= this.historyMinGapMs) {
      const p = { t };
      for (const k of HISTORY_KEYS) if (typeof d.data[k] === 'number') p[k] = d.data[k];
      d.history.push(p);
      if (d.history.length > this.historyMax) d.history.splice(0, d.history.length - this.historyMax);
    }
    this.emit('update', { device: d.device, state: this.view(d) });
    return d;
  }

  setAvailability(id, online) {
    const d = this._dev(id);
    d.availability = !!online;
    this.emit('status', { device: d.device, state: this.view(d) });
  }

  isOnline(d) {
    if (d.availability === false) return false;
    return d.lastSeen > 0 && this.now() - d.lastSeen <= this.offlineAfterMs;
  }

  view(d) {
    return { device: d.device, online: this.isOnline(d), lastSeen: d.lastSeen || null, data: d.data };
  }

  list() { return [...this.devices.values()].map((d) => this.view(d)); }
  get(id) { const d = this.devices.get(sanitizeDeviceId(id)); return d ? this.view(d) : null; }

  history(id, minutes = 30) {
    const d = this.devices.get(sanitizeDeviceId(id));
    if (!d) return [];
    const since = this.now() - Math.min(Math.max(minutes, 1), 24 * 60) * 60000;
    return d.history.filter((p) => p.t >= since);
  }
}
