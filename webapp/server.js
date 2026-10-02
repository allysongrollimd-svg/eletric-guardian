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
const server = createApp(cfg, store);
startMqtt(cfg, store);
if (cfg.demo) startSimulator(store);

server.listen(cfg.port, cfg.host, () => console.log(`Electric Guardian webapp on http://${cfg.host}:${cfg.port}${cfg.demo ? ' (demo data)' : ''}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
