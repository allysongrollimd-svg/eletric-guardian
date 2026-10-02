import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { AccountError, normalizeVin } from './accounts.js';
import { createInfinitePay, ProviderError } from './infinitepay.js';

const DAY = 86_400_000;
const DEFAULTS = { trial_days: '7', grace_days: '5', infinitepay_handle: '', infinitepay_api: '' };

/** Adds calendar months in UTC (31 Jan + 1 month = 28/29 Feb, never a skipped month). */
export function addMonths(ms, months) {
  const d = new Date(ms); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * Subscriptions per chassis, plans, invoices and payment reconciliation.
 * States: trial -> (paid) active -> grace (renew soon, everything still works) -> expired (cameras and remote control off).
 */
export function createBilling({ db, accounts, cfg = {}, secret, now = () => Date.now(), provider } = {}) {
  const q = {
    setting: db.prepare('SELECT v FROM settings WHERE k = ?'),
    setSetting: db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    plans: db.prepare('SELECT * FROM plans ORDER BY sort, months'),
    plan: db.prepare('SELECT * FROM plans WHERE id = ?'),
    upPlan: db.prepare('INSERT INTO plans (id, name, months, price_cents, active, sort) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, months = excluded.months, price_cents = excluded.price_cents, active = excluded.active, sort = excluded.sort'),
    access: db.prepare('SELECT * FROM vin_access WHERE vin = ?'),
    insAccess: db.prepare('INSERT INTO vin_access (vin, trial_until, paid_until, plan_id, updated_at) VALUES (?, ?, ?, ?, ?)'),
    setAccess: db.prepare('UPDATE vin_access SET trial_until = ?, paid_until = ?, plan_id = ?, updated_at = ? WHERE vin = ?'),
    insInv: db.prepare('INSERT INTO invoices (id, user_id, vin, device_id, car_name, plan_id, months, amount_cents, status, source, checkout_url, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    inv: db.prepare('SELECT * FROM invoices WHERE id = ?'),
    invByTxn: db.prepare('SELECT id FROM invoices WHERE transaction_nsu = ?'),
    invOfUser: db.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'),
    pay: db.prepare("UPDATE invoices SET status = 'paid', paid_at = ?, transaction_nsu = ?, invoice_slug = ?, capture_method = ?, paid_amount_cents = ?, receipt_url = ?, note = COALESCE(?, note) WHERE id = ? AND status != 'paid'"),
    cancel: db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'pending'"),
    setUrl: db.prepare('UPDATE invoices SET checkout_url = ? WHERE id = ?'),
    delInv: db.prepare("DELETE FROM invoices WHERE id = ? AND status = 'pending' AND checkout_url IS NULL"),
  };
  const setting = (k) => { const r = q.setting.get(k); return r ? r.v : (k === 'infinitepay_handle' ? (cfg.infinitepayHandle || '') : DEFAULTS[k] ?? ''); };
  const int = (v, d) => (Number.isInteger(+v) && +v >= 0 ? +v : d);
  const sign = (id) => createHmac('sha256', secret).update(`webhook:${id}`).digest('base64url').slice(0, 32);
  const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
  const log = (event, detail, { userId = null, deviceId = null } = {}) => accounts.log(event, { userId, deviceId, detail });
  const publicInvoice = (i) => i && {
    id: i.id, vin: i.vin, car: i.car_name, plan: i.plan_id, months: i.months, amountCents: i.amount_cents, status: i.status, source: i.source,
    createdAt: i.created_at, paidAt: i.paid_at, captureMethod: i.capture_method, receiptUrl: i.receipt_url, checkoutUrl: i.status === 'pending' ? i.checkout_url : null,
  };
  const clientProvider = () => provider || createInfinitePay({ base: setting('infinitepay_api') || undefined });

  const api = {
    sign, verifyWebhookKey: (id, k) => eq(sign(id), k || ''), publicInvoice,
    getSetting: setting,
    settings() { return { trialDays: int(setting('trial_days'), 7), graceDays: int(setting('grace_days'), 5), infinitepayHandle: setting('infinitepay_handle'), infinitepayApi: setting('infinitepay_api') }; },
    setSettings({ trialDays, graceDays, infinitepayHandle, infinitepayApi }) {
      if (trialDays !== undefined) { if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) throw new AccountError('bad_setting', 'Dias de teste: 0 a 365.'); q.setSetting.run('trial_days', String(trialDays)); }
      if (graceDays !== undefined) { if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) throw new AccountError('bad_setting', 'Dias de tolerância: 0 a 60.'); q.setSetting.run('grace_days', String(graceDays)); }
      if (infinitepayHandle !== undefined) { const h = String(infinitepayHandle).trim().replace(/^\$/, ''); if (h && !/^[A-Za-z0-9._-]{2,40}$/.test(h)) throw new AccountError('bad_setting', 'InfiniteTag inválida.'); q.setSetting.run('infinitepay_handle', h); }
      if (infinitepayApi !== undefined) { const u = String(infinitepayApi).trim(); if (u && !/^https:\/\/[^\s]+$/.test(u)) throw new AccountError('bad_setting', 'A URL da API precisa ser https.'); q.setSetting.run('infinitepay_api', u); }
    },
    checkoutConfigured: () => !!setting('infinitepay_handle'),

    // ---- plans ----
    plans({ onlyActive = false } = {}) { return q.plans.all().filter((p) => !onlyActive || p.active).map((p) => ({ id: p.id, name: p.name, months: p.months, priceCents: p.price_cents, active: !!p.active, sort: p.sort })); },
    savePlan({ id, name, months, priceCents, active = true, sort = 0 }) {
      if (!/^[a-z0-9_-]{2,24}$/.test(String(id))) throw new AccountError('bad_plan', 'Identificador do plano inválido.');
      if (!Number.isInteger(months) || months < 1 || months > 36) throw new AccountError('bad_plan', 'Meses: 1 a 36.');
      if (!Number.isInteger(priceCents) || priceCents < 100 || priceCents > 5_000_000) throw new AccountError('bad_plan', 'Preço inválido (mínimo R$ 1,00).');
      q.upPlan.run(id, String(name || id).slice(0, 40), months, priceCents, active ? 1 : 0, sort | 0);
    },

    // ---- access state ----
    /** Called when a car is linked: the first link of a chassis starts the free trial. */
    onClaim({ vin }) {
      if (q.access.get(vin)) return;
      const days = int(setting('trial_days'), 7);
      q.insAccess.run(vin, days > 0 ? now() + days * DAY : null, null, null, now());
    },
    state(vin) {
      const a = vin ? q.access.get(vin) : null; const t = now(); const grace = int(setting('grace_days'), 5) * DAY;
      if (!a) return { state: 'expired', accessUntil: null, graceUntil: null, plan: null };
      const accessUntil = Math.max(a.paid_until || 0, a.trial_until || 0) || null;
      let state;
      if (a.paid_until && t <= a.paid_until) state = 'active';
      else if (a.trial_until && t <= a.trial_until) state = 'trial';
      else if (accessUntil && t <= accessUntil + grace) state = 'grace';
      else state = 'expired';
      return { state, accessUntil, graceUntil: accessUntil ? accessUntil + grace : null, plan: a.plan_id || null, paidUntil: a.paid_until || null, trialUntil: a.trial_until || null };
    },
    stateForDevice(deviceId) { return api.state(accounts.getDevice(deviceId)?.vin); },
    /** Cameras and remote control stay on for trial, active and grace. */
    allowed(deviceId) { return api.stateForDevice(deviceId).state !== 'expired'; },
    /** Admin: grant (or remove, when negative) days of access. */
    grantDays(vin, days, { adminId } = {}) {
      vin = normalizeVin(vin);
      if (!Number.isInteger(days) || days < -3650 || days > 3650 || days === 0) throw new AccountError('bad_days', 'Informe um número de dias diferente de zero.');
      const a = q.access.get(vin);
      const base = Math.max(now(), a?.paid_until || 0, a?.trial_until || 0);
      const paid = base + days * DAY;
      if (a) q.setAccess.run(a.trial_until, paid, a.plan_id, now(), vin); else q.insAccess.run(vin, null, paid, null, now());
      log('admin_grant_days', { vin, days }, { userId: adminId });
    },

    // ---- invoices ----
    invoicesOf(userId) { return q.invOfUser.all(userId).map(publicInvoice); },
    invoice(id) { return q.inv.get(String(id)) || null; },
    /** The owner picks a plan for one of their cars; returns the hosted checkout URL. */
    async createInvoice({ userId, deviceId, planId, baseUrl, customer }) {
      if (!accounts.owns(userId, deviceId)) throw new AccountError('not_found', 'Carro não encontrado.', 404);
      const d = accounts.getDevice(deviceId); const plan = q.plan.get(String(planId));
      if (!plan || !plan.active) throw new AccountError('bad_plan', 'Plano indisponível.', 400);
      const handle = setting('infinitepay_handle');
      if (!handle) throw new AccountError('billing_off', 'Pagamento ainda não configurado. Fale com o suporte.', 503);
      api.onClaim({ vin: d.vin });
      const id = `eg_${randomBytes(12).toString('hex')}`;
      q.insInv.run(id, userId, d.vin, deviceId, d.name, plan.id, plan.months, plan.price_cents, 'pending', 'infinitepay', null, now(), null);
      try {
        const url = await clientProvider().createLink({
          handle, orderNsu: id,
          items: [{ quantity: 1, price: plan.price_cents, description: `Electric Guardian ${plan.name} - ${d.name || 'carro'}` }],
          redirectUrl: `${baseUrl}/billing/return?order=${id}`,
          webhookUrl: `${baseUrl}/api/billing/infinitepay/webhook?k=${sign(id)}`,
          customer,
        });
        q.setUrl.run(url, id);
        log('invoice_created', { id, plan: plan.id, amountCents: plan.price_cents }, { userId, deviceId });
        return publicInvoice(q.inv.get(id));
      } catch (e) {
        q.delInv.run(id);
        if (e instanceof ProviderError) throw new AccountError('provider', e.message, 502);
        throw e;
      }
    },
    /** Credits an invoice exactly once and extends the chassis' access. */
    applyPayment(id, { transactionNsu = null, slug = null, captureMethod = null, paidAmountCents = null, receiptUrl = null, source, note = null, adminId = null } = {}) {
      const inv = q.inv.get(id);
      if (!inv) throw new AccountError('not_found', 'Fatura não encontrada.', 404);
      if (inv.status === 'paid') return { already: true, invoice: publicInvoice(inv) };
      if (inv.status === 'cancelled') throw new AccountError('cancelled', 'Fatura cancelada.', 409);
      if (transactionNsu && q.invByTxn.get(transactionNsu)) return { already: true, invoice: publicInvoice(inv) };
      db.exec('BEGIN');
      try {
        const r = q.pay.run(now(), transactionNsu, slug, captureMethod, paidAmountCents ?? inv.amount_cents, receiptUrl, note, id);
        if (r.changes) {
          if (source) db.prepare('UPDATE invoices SET source = ? WHERE id = ?').run(source, id);
          const a = q.access.get(inv.vin);
          const from = Math.max(now(), a?.paid_until || 0, a?.trial_until || 0);       // paying early never burns the remaining trial days
          const paid = addMonths(from, inv.months);
          if (a) q.setAccess.run(a.trial_until, paid, inv.plan_id, now(), inv.vin); else q.insAccess.run(inv.vin, null, paid, inv.plan_id, now());
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      log('payment', { id, vin: inv.vin, plan: inv.plan_id, amountCents: inv.amount_cents, source: source || 'infinitepay', transactionNsu }, { userId: adminId || inv.user_id, deviceId: inv.device_id });
      return { already: false, invoice: publicInvoice(q.inv.get(id)) };
    },
    /**
     * Webhook / return-page entry: never trust the body, ask InfinitePay. Throws retryable ProviderError when the
     * provider cannot be reached (so the webhook answers 5xx and InfinitePay retries).
     */
    async settleFromProvider(id, { transactionNsu, slug, captureMethod, receiptUrl }) {
      const inv = q.inv.get(String(id));
      if (!inv) throw new AccountError('not_found', 'Fatura não encontrada.', 404);
      if (inv.status === 'paid') return { already: true, invoice: publicInvoice(inv) };
      const chk = await clientProvider().paymentCheck({ handle: setting('infinitepay_handle'), orderNsu: inv.id, transactionNsu, slug });
      if (!chk.paid) throw new AccountError('not_paid', 'Pagamento ainda não confirmado.', 409);
      if (chk.paidAmountCents !== null && chk.paidAmountCents < inv.amount_cents) {
        log('payment_short', { id: inv.id, expected: inv.amount_cents, got: chk.paidAmountCents }, { userId: inv.user_id });
        throw new AccountError('amount_mismatch', 'Valor pago menor que o da fatura.', 409);
      }
      return api.applyPayment(inv.id, { transactionNsu: transactionNsu || null, slug: slug || null, captureMethod: chk.captureMethod || captureMethod || null, paidAmountCents: chk.paidAmountCents, receiptUrl: receiptUrl || null, source: 'infinitepay' });
    },
    cancelInvoice(id, adminId) { const r = q.cancel.run(String(id)); if (r.changes) log('invoice_cancelled', { id }, { userId: adminId }); return !!r.changes; },
    /** Admin: manual settlement (bank transfer, cash, courtesy). */
    settleManual(id, { note, adminId }) { return api.applyPayment(String(id), { source: 'manual', note: note || 'baixa manual', adminId }); },
    /** Admin: create an already-paid invoice for a chassis (offline sale). */
    createManualPaid({ vin, planId, userId = null, note, adminId }) {
      vin = normalizeVin(vin); const plan = q.plan.get(String(planId));
      if (!plan) throw new AccountError('bad_plan', 'Plano inexistente.');
      const d = db.prepare('SELECT * FROM devices WHERE vin = ? AND owner_id IS NOT NULL').get(vin);
      const id = `eg_${randomBytes(12).toString('hex')}`;
      q.insInv.run(id, userId ?? d?.owner_id ?? null, vin, d?.id ?? null, d?.name ?? null, plan.id, plan.months, plan.price_cents, 'pending', 'manual', null, now(), null);
      return api.applyPayment(id, { source: 'manual', note: note || 'venda manual', adminId });
    },
  };
  accounts.onClaim((e) => api.onClaim(e));
  // Cars linked before billing existed get the normal trial instead of being locked out by the upgrade.
  for (const { vin } of db.prepare('SELECT DISTINCT vin FROM devices WHERE owner_id IS NOT NULL AND vin IS NOT NULL').all()) api.onClaim({ vin });
  return api;
}
