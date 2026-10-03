// Thin client for the InfinitePay "Checkout Integrado" (hosted checkout links, Pix and card).
// The merchant is identified by its InfiniteTag (`handle`); there is no API key. Amounts are integer cents (BRL).
//   POST {base}/links          -> { url }                       create a checkout link for a basket of items
//   POST {base}/payment_check  -> { paid, amount, paid_amount… } confirm a payment server to server
// The approved-payment webhook is not signed, so the server never credits from the webhook body alone:
// it asks payment_check, which is the authority.
export const DEFAULT_BASE = 'https://api.infinitepay.io/invoices/public/checkout';

export class ProviderError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) { super(message); this.status = status; this.retryable = retryable; }
}

export function createInfinitePay({ base = DEFAULT_BASE, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  base = String(base || DEFAULT_BASE).replace(/\/+$/, '');
  async function post(path, body) {
    let r;
    try {
      r = await fetchImpl(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new ProviderError('Não foi possível falar com a InfinitePay agora.', { retryable: true }); }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) throw new ProviderError(`InfinitePay respondeu ${r.status}.`, { retryable: r.status >= 500 || r.status === 429 });
    return json ?? {};
  }
  return {
    async createLink({ handle, orderNsu, items, redirectUrl, webhookUrl, customer }) {
      const j = await post('/links', {
        handle, order_nsu: orderNsu, items, redirect_url: redirectUrl, webhook_url: webhookUrl,
        ...(customer && Object.keys(customer).length ? { customer } : {}),
      });
      const url = j.url || j.checkout_url || j.payment_url || j.link;
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new ProviderError('A InfinitePay não devolveu o link de pagamento.');
      return url;
    },
    async paymentCheck({ handle, orderNsu, transactionNsu, slug }) {
      const j = await post('/payment_check', { handle, order_nsu: orderNsu, transaction_nsu: transactionNsu, slug });
      const paid = j.paid === true || j.success === true && j.paid !== false;
      const cents = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
      return { paid, paidAmountCents: cents(j.paid_amount ?? j.amount), captureMethod: j.capture_method || null, installments: j.installments ?? null, raw: j };
    },
  };
}
