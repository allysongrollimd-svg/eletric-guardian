import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../lib/db.js';
import { backupDb, latestBackup } from '../lib/backup.js';

test('backup: consistent snapshot of a live database, secret copied, old snapshots pruned', () => {
  const root = mkdtempSync(join(tmpdir(), 'eg-bk-'));
  const db = openDb(join(root, 'eg.sqlite'));
  writeFileSync(join(root, 'session.secret'), 'topsecret');
  db.prepare("INSERT INTO users (id, email, name, pass_hash, created_at) VALUES ('u1', 'a@b.co', 'A', 'x', 1)").run();
  let t = Date.UTC(2026, 9, 2, 12, 0, 0);
  const dir = join(root, 'backups');
  for (let i = 0; i < 4; i++) { backupDb(db, { dir, dataDir: root, keep: 3, now: () => t }); t += 24 * 3600_000; }
  const snaps = readdirSync(dir).filter((f) => f.endsWith('.sqlite'));
  assert.equal(snaps.length, 3);                                                   // oldest pruned
  assert.ok(readdirSync(dir).includes('session.secret'));
  const copy = new DatabaseSync(join(dir, snaps.sort().pop()));
  assert.equal(copy.prepare('SELECT email FROM users').get().email, 'a@b.co');       // readable, with the data
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 4);
  assert.ok(latestBackup(dir).file.endsWith('.sqlite'));
  copy.close(); db.close();
});
