// Pushes fake telemetry to a running server's HTTP ingest (no MQTT needed).
//   BASE_URL=http://localhost:8787 INGEST_TOKEN=dev DEVICE=demo node scripts/simulate.mjs
import { makeSample } from '../lib/simulator.js';
const base = process.env.BASE_URL || 'http://localhost:8787';
const token = process.env.INGEST_TOKEN || '';
const device = process.env.DEVICE || 'demo';
const t0 = Date.now();
setInterval(async () => {
  try {
    const r = await fetch(`${base}/api/ingest/${device}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(makeSample((Date.now() - t0) / 1000)) });
    if (!r.ok) console.error('ingest failed', r.status);
  } catch (e) { console.error(e.message); }
}, 1000);
console.log(`simulating "${device}" -> ${base}`);
