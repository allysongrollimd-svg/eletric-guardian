import { AccountError } from './accounts.js';

const DAY = 86_400_000;
const like = (s) => `%${String(s ?? '').trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
const clampInt = (v, d, max) => Math.min(Math.max(Number.isInteger(+v) ? +v : d, 0), max);

/** Back-office queries and actions. Every mutating call is recorded in the audit log under the admin's id. */
export function createAdmin({ db, accounts, billing, now = () => Date.now(), live = () => null }) {
  const q = {
    users: db.prepare(`SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at,
        (SELECT COUNT(*) FROM device_members m WHERE m.user_id = u.id) AS cars
      FROM users u WHERE (u.email LIKE ?1 ESCAPE '\\' OR u.name LIKE ?1 ESCAPE '\\') ORDER BY u.created_at DESC LIMIT ?2 OFFSET ?3`),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    setDisabled: db.prepare('UPDATE users SET disabled = ?, session_ver = session_ver + 1 WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0"),
    cars: db.prepare(`SELECT d.id, d.name, d.vin, d.reported_vin, d.controls_off, d.owner_id, d.last_seen, d.app_version, d.claimed_at, u.email AS owner_email
      FROM devices d LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.owner_id IS NOT NULL AND (d.vin LIKE ?1 ESCAPE '\\' OR d.name LIKE ?1 ESCAPE '\\' OR u.email LIKE ?1 ESCAPE '\\')
      ORDER BY d.claimed_at DESC LIMIT ?2 OFFSET ?3`),
    invoices: db.prepare(`SELECT i.*, u.email AS user_email FROM invoices i LEFT JOIN users u ON u.id = i.user_id
      WHERE (?1 = '' OR i.status = ?1) AND (i.id LIKE ?2 ESCAPE '\\' OR i.vin LIKE ?2 ESCAPE '\\' OR COALESCE(u.email, '') LIKE ?2 ESCAPE '\\')
      ORDER BY i.created_at DESC LIMIT ?3 OFFSET ?4`),
    revenue: db.prepare("SELECT COALESCE(SUM(COALESCE(paid_amount_cents, amount_cents)), 0) AS c, COUNT(*) AS n FROM invoices WHERE status = 'paid' AND paid_at >= ?"),
    pending: db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'pending' AND created_at >= ?"),
    audit: db.prepare('SELECT a.*, u.email AS user_email FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?1 OFFSET ?2'),
    carsAll: db.prepare('SELECT vin FROM devices WHERE owner_id IS NOT NULL AND vin IS NOT NULL'),
  };
  const mustUser = (id) => { const u = q.user.get(String(id)); if (!u) throw new AccountError('not_found', 'Usuário não encontrado.', 404); return u; };
  const row = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.created_at, cars: u.cars ?? undefined });

  return {
    overview() {
      const states = { trial: 0, active: 0, grace: 0, expired: 0 };
      for (const { vin } of q.carsAll.all()) states[billing.state(vin).state]++;
      const month = q.revenue.get(now() - 30 * DAY);
      return {
        users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
        cars: Object.values(states).reduce((a, b) => a + b, 0), states,
        revenue30dCents: month.c, payments30d: month.n,
        pendingInvoices: q.pending.get(now() - 7 * DAY).n,
        checkoutConfigured: billing.checkoutConfigured(),
      };
    },
    users({ q: s = '', limit = 50, offset = 0 } = {}) { return q.users.all(like(s), clampInt(limit, 50, 200), clampInt(offset, 0, 1e6)).map(row); },
    async createUser({ email, password, name, role = 'user' }, adminId) {
      if (!['user', 'admin'].includes(role)) throw new AccountError('bad_role', 'Perfil inválido.');
      const u = await accounts.signup({ email, password, name, role });
      accounts.log('admin_create_user', { userId: adminId, detail: { target: u.id, role } });
      return u;
    },
    updateUser(id, { disabled, role, name }, adminId) {
      const u = mustUser(id);
      const demoting = (role && role !== 'admin' && u.role === 'admin') || (disabled === true && u.role === 'admin');
      if (demoting && (u.id === adminId || q.adminCount.get().n <= 1)) throw new AccountError('last_admin', 'Não é possível remover ou desativar o último administrador (nem você mesmo).', 409);
      if (role !== undefined) { if (!['user', 'admin'].includes(role)) throw new AccountError('bad_role', 'Perfil inválido.'); q.setRole.run(role, u.id); }
      if (disabled !== undefined) q.setDisabled.run(disabled ? 1 : 0, u.id);
      if (name !== undefined) q.setName.run(String(name).trim().slice(0, 80), u.id);
      accounts.log('admin_update_user', { userId: adminId, detail: { target: u.id, disabled, role, name: name !== undefined } });
    },
    async setPassword(id, password, adminId) { const u = mustUser(id); await accounts.adminSetPassword(u.id, password); accounts.log('admin_set_password', { userId: adminId, detail: { target: u.id } }); },
    cars({ q: s = '', limit = 50, offset = 0 } = {}) {
      return q.cars.all(like(s), clampInt(limit, 50, 200), clampInt(offset, 0, 1e6)).map((d) => ({
        id: d.id, name: d.name, vin: d.vin, vinVerified: d.reported_vin === d.vin, ownerId: d.owner_id, ownerEmail: d.owner_email,
        lastSeen: d.last_seen, appVersion: d.app_version, claimedAt: d.claimed_at, billing: billing.state(d.vin), live: live(d.id), controlsOff: accounts.controlsOff(d.id),
      }));
    },
    releaseCar(vin, adminId) { const ok = accounts.adminReleaseVin(vin); accounts.log('admin_release_car', { userId: adminId, detail: { vin } }); return ok; },
    invoices({ status = '', q: s = '', limit = 50, offset = 0 } = {}) {
      if (status && !['pending', 'paid', 'cancelled'].includes(status)) throw new AccountError('bad_status', 'Status inválido.');
      return q.invoices.all(status, like(s), clampInt(limit, 50, 200), clampInt(offset, 0, 1e6)).map((i) => ({ ...billing.publicInvoice(i), userEmail: i.user_email, note: i.note, transactionNsu: i.transaction_nsu }));
    },
    audit({ limit = 100, offset = 0 } = {}) { return q.audit.all(clampInt(limit, 100, 500), clampInt(offset, 0, 1e6)).map((a) => ({ t: a.t, user: a.user_email, device: a.device_id, event: a.event, detail: a.detail ? JSON.parse(a.detail) : null })); },
  };
}
