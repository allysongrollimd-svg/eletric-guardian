import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Session secret: from env, else generated once and kept (0600) in DATA_DIR so restarts keep users logged in. */
export function loadSecret(cfg) {
  if (cfg.sessionSecret) return cfg.sessionSecret;
  const file = join(cfg.dataDir, 'session.secret');
  mkdirSync(cfg.dataDir, { recursive: true });
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const s = randomBytes(48).toString('base64url');
  writeFileSync(file, s, { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return s;
}

export function saveState(store, file) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store.dump()));
  renameSync(tmp, file);                                  // atomic: never leaves a half-written file
}

export function loadState(store, file) {
  try { store.restore(JSON.parse(readFileSync(file, 'utf8'))); return true; } catch { return false; }
}
