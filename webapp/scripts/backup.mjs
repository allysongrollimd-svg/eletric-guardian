// On-demand backup:  docker compose exec -T eg node scripts/backup.mjs     (prints the snapshot path)
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { backupDb } from '../lib/backup.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'eg.sqlite'));
console.log(backupDb(db, { dir: join(cfg.dataDir, 'backups'), dataDir: cfg.dataDir, keep: +process.env.BACKUP_KEEP || 14 }));
