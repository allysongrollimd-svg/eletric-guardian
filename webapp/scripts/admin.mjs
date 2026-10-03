// Operator CLI for the accounts mode. Run on the server, next to the data directory:
//   DATA_DIR=./data node scripts/admin.mjs create-user you@example.com 'a-long-password' 'Your Name' [admin]
//   DATA_DIR=./data node scripts/admin.mjs release-vin LGXC16DG2R0123456
//   DATA_DIR=./data node scripts/admin.mjs set-password you@example.com 'a-new-long-password'
//   DATA_DIR=./data node scripts/admin.mjs list
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { createAccounts } from '../lib/accounts.js';
import { loadSecret } from '../lib/persist.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'eg.sqlite'));
const acc = createAccounts(db, { secret: loadSecret(cfg) });
const [cmd, ...a] = process.argv.slice(2);

if (cmd === 'create-user') {
  const [email, password, name = '', role = 'user'] = a;
  const u = await acc.signup({ email, password, name, role });
  console.log('created', u);
} else if (cmd === 'release-vin') {
  console.log(acc.adminReleaseVin(a[0]) ? 'released' : 'VIN not found / not claimed');
} else if (cmd === 'list') {
  for (const u of db.prepare('SELECT id, email, name, role, disabled FROM users').all()) {
    console.log(`${u.email} (${u.role}${u.disabled ? ', disabled' : ''})`);
    for (const c of acc.listCars(u.id)) console.log(`   ${c.name}  VIN ${c.vin}  ${c.vinVerified ? 'verified' : 'unverified'}  last seen ${c.lastSeen ? new Date(c.lastSeen).toISOString() : '-'}`);
  }
} else if (cmd === 'set-password') {
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(String(a[0]).toLowerCase());
  if (!u) console.log('user not found');
  else { await acc.adminSetPassword(u.id, a[1]); console.log('password changed'); }
} else if (cmd === 'make-admin') {
  const r = db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(String(a[0]).toLowerCase()); console.log(r.changes ? 'promoted to admin' : 'user not found');
} else if (cmd === 'disable-user') {
  db.prepare('UPDATE users SET disabled = 1 WHERE email = ?').run(String(a[0]).toLowerCase()); console.log('disabled');
} else {
  console.log('commands: set-password <email> <new-password> | make-admin <email> | create-user <email> <password> [name] [role] | release-vin <VIN> | list | disable-user <email>');
}
