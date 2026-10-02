import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, validateConfig } from './lib/config.js';
import { Store } from './lib/store.js';
import { createApp } from './lib/app.js';
import { startMqtt } from './lib/mqtt.js';
import { startSimulator } from './lib/simulator.js';

const cfg = loadConfig();
const problems = validateConfig(cfg);
if (problems.length) {
  for (const p of problems) console.error('config error:', p);
  process.exit(1);
}
if (cfg.allowInsecure) console.warn('WARNING: ALLOW_INSECURE=1 — do not expose this instance to the internet.');

const store = new Store(cfg);
let server, cloudParts = null, bridge = null;

if (cfg.accounts) {
  // ---- multi-tenant service: accounts, chassis pairing, embedded MQTT broker, reverse tunnel for the cameras ----
  const { openDb } = await import('./lib/db.js');
  const { createAccounts } = await import('./lib/accounts.js');
  const { createTunnelHub } = await import('./lib/tunnel.js');
  const { createBroker } = await import('./lib/broker.js');
  const { createCloud } = await import('./lib/cloud.js');
  const { loadSecret, saveState, loadState } = await import('./lib/persist.js');

  const secret = loadSecret(cfg);
  const db = openDb(join(cfg.dataDir, 'eg.sqlite'));
  const accounts = createAccounts(db, { secret });
  // Daily consistent snapshot (14 kept) in DATA_DIR/backups; deploy/backup.sh copies them off the container.
  const { backupDb } = await import('./lib/backup.js');
  const snap = () => { try { backupDb(db, { dir: join(cfg.dataDir, 'backups'), dataDir: cfg.dataDir, keep: +process.env.BACKUP_KEEP || 14 }); } catch (e) { console.error('backup failed:', e.message); } };
  snap(); setInterval(snap, 24 * 3600_000).unref();
  const stateFile = join(cfg.dataDir, 'state.json');
  loadState(store, stateFile);
  const hub = createTunnelHub({ accounts });
  const broker = await createBroker({ accounts, store });
  if (cfg.brokerPort) console.log(`MQTT (plain) on :${await broker.listen({ port: cfg.brokerPort })}`);
  if (cfg.brokerTlsPort) console.log(`MQTT (TLS) on :${await broker.listen({ port: cfg.brokerTlsPort, tlsOptions: { cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) } })}`);
  const cloud = createCloud({ cfg, accounts, store, hub, broker, secret });
  cloudParts = { hub, broker, stateFile, saveState, store };
  setInterval(() => { try { saveState(store, stateFile); } catch (e) { console.error('state save failed:', e.message); } }, 15_000).unref();
  server = createApp(cfg, store, cfg.controlEnabled ? broker : null, cloud);
  console.log(`accounts mode — app: ${cfg.appHost || '(any host)'}  cameras: ${cfg.viewHost || '(disabled: set VIEW_HOST)'}  signup: ${cfg.allowSignup ? 'open' : 'closed'}`);
} else {
  bridge = startMqtt(cfg, store);
  server = createApp(cfg, store, cfg.controlEnabled ? bridge : null);
  if (cfg.demo) startSimulator(store);
}

server.listen(cfg.port, cfg.host, () => console.log(`Electric Guardian webapp on http://${cfg.host}:${cfg.port}${cfg.demo ? ' (demo data)' : ''}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  if (cloudParts) { try { cloudParts.saveState(cloudParts.store, cloudParts.stateFile); } catch { /* ignore */ } cloudParts.hub.shutdown(); cloudParts.broker.close(); }
  server.shutdown(() => process.exit(0));
});
