import { mkdirSync, readdirSync, unlinkSync, copyFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');   // 20261002-134500Z

/**
 * Consistent snapshot of the live SQLite database (VACUUM INTO works while the service keeps writing),
 * plus the session secret (webhook keys and sessions are signed with it), then prunes old snapshots.
 * Returns the snapshot path.
 */
export function backupDb(db, { dir, dataDir, keep = 14, now = () => Date.now() }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `eg-${stamp(now())}.sqlite`);
  if (existsSync(file)) return file;                                   // same second: already done
  db.prepare('VACUUM INTO ?').run(file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  const secret = dataDir && join(dataDir, 'session.secret');
  if (secret && existsSync(secret)) { copyFileSync(secret, join(dir, 'session.secret')); try { chmodSync(join(dir, 'session.secret'), 0o600); } catch { /* best effort */ } }
  const all = readdirSync(dir).filter((f) => /^eg-.*\.sqlite$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) { try { unlinkSync(join(dir, old)); } catch { /* ignore */ } }
  return file;
}

export const latestBackup = (dir) => {
  try { const f = readdirSync(dir).filter((x) => /^eg-.*\.sqlite$/.test(x)).sort().pop(); return f ? { file: join(dir, f), at: statSync(join(dir, f)).mtimeMs } : null; } catch { return null; }
};
