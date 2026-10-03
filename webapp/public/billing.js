// Customer side of the subscription: plans, checkout (InfinitePay hosted page), invoices and the return page.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const j = { 'content-type': 'application/json' };
const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: j, body: JSON.stringify(body || {}) });
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const day = (ms) => (ms ? new Date(ms).toLocaleDateString('pt-BR') : '—');
const STATE_LABEL = { trial: 'Teste grátis', active: 'Ativa', grace: 'Renovar', expired: 'Vencida' };
const INV_LABEL = { pending: 'Aguardando pagamento', paid: 'Paga', cancelled: 'Cancelada' };

function stateText(c) {
  if (c.state === 'trial') return `Teste grátis até ${day(c.accessUntil)}.`;
  if (c.state === 'active') return `Assinatura ativa até ${day(c.accessUntil)}.`;
  if (c.state === 'grace') return `Venceu em ${day(c.accessUntil)}. Renove até ${day(c.graceUntil)} para manter câmeras e controles.`;
  return 'Assinatura vencida: câmeras e controles bloqueados. O painel continua mostrando os dados do carro.';
}

export function initBilling({ getCurrent }) {
  async function load() { const r = await fetch('/api/billing', { credentials: 'same-origin' }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  function render(b) {
    $('billErr').textContent = '';
    $('billIntro').textContent = b.checkout ? 'Pague por Pix ou cartão. A confirmação é automática e o acesso é liberado em segundos.' : 'O pagamento ainda não está configurado. Fale com o suporte.';
    const host = $('billCars'); host.replaceChildren();
    if (!b.cars.length) host.append(el('p', 'sub', 'Vincule um carro para assinar.'));
    for (const c of b.cars) {
      const card = el('div', 'bcar'); const head = el('header');
      const t = el('div'); t.append(el('b', null, c.name || 'Carro'), el('small', null, `Chassi final ${c.vinLast4 || '—'}`));
      head.append(t, el('span', `state ${c.state}`, STATE_LABEL[c.state] || c.state));
      card.append(head, el('div', 'sub', stateText(c)));
      if (b.checkout) {
        const plans = el('div', 'plans');
        for (const p of b.plans) {
          const btn = el('button', 'plan'); btn.type = 'button';
          btn.append(el('b', null, p.name), el('span', 'p', brl(p.priceCents)), el('small', null, p.months > 1 ? `${brl(Math.round(p.priceCents / p.months))}/mês` : 'por mês'));
          btn.addEventListener('click', () => pay(c.id, p.id, btn));
          plans.append(btn);
        }
        card.append(plans);
      }
      host.append(card);
    }
    const inv = $('billInvoices'); inv.replaceChildren();
    if (!b.invoices.length) inv.append(el('p', 'sub', 'Nenhuma fatura ainda.'));
    for (const i of b.invoices) {
      const row = el('div', 'invrow'); const l = el('div');
      l.append(el('b', null, `${i.plan} · ${brl(i.amountCents)}`), el('small', null, `${i.car || ''} · ${day(i.createdAt)} · ${INV_LABEL[i.status] || i.status}`));
      const r = el('div');
      if (i.status === 'pending' && i.checkoutUrl) { const a = el('a', null, 'Pagar'); a.href = i.checkoutUrl; r.append(a); }
      else if (i.receiptUrl) { const a = el('a', null, 'Comprovante'); a.href = i.receiptUrl; a.target = '_blank'; a.rel = 'noopener'; r.append(a); }
      row.append(l, r); inv.append(row);
    }
  }

  async function pay(device, plan, btn) {
    btn.disabled = true; $('billErr').textContent = '';
    const r = await post('/api/billing/checkout', { device, plan });
    const b = await r.json().catch(() => ({}));
    if (r.ok && b.invoice?.checkoutUrl) { location.href = b.invoice.checkoutUrl; return; }     // hosted checkout (Pix / card)
    btn.disabled = false; $('billErr').textContent = b.error || `Erro ${r.status}`;
  }

  async function open() {
    $('billDlg').showModal();
    try { render(await load()); } catch { $('billErr').textContent = 'Não foi possível carregar a assinatura.'; }
  }
  $('billBtn').addEventListener('click', open);
  $('billClose').addEventListener('click', () => $('billDlg').close());
  $('billBannerBtn').addEventListener('click', open);

  /** Banner above the dashboard for the selected car: trial days left, renew soon, or expired. */
  function refreshBanner() {
    const car = getCurrent(); const b = car?.billing; const box = $('billBanner');
    if (!b || b.state === 'active') { box.hidden = true; return; }
    const left = b.accessUntil ? Math.ceil((b.accessUntil - Date.now()) / 86400000) : 0;
    box.className = `bill-banner ${b.state === 'trial' ? '' : b.state === 'grace' ? 'warn' : 'bad'}`;
    $('billBannerText').textContent = b.state === 'trial' ? `Teste grátis: ${Math.max(left, 0)} dia(s) restantes.`
      : b.state === 'grace' ? `Assinatura vencida. Renove até ${day(b.graceUntil)} para manter câmeras e controles.`
      : 'Assinatura vencida. Câmeras e controles bloqueados.';
    box.hidden = false;
  }

  /** /billing/return?order=…&transaction_nsu=…&slug=…: confirm server-side (the webhook may already have done it). */
  async function handleReturn() {
    if (location.pathname !== '/billing/return') return;
    const q = new URLSearchParams(location.search); const order = q.get('order');
    const done = () => { history.replaceState(null, '', '/'); $('retDlg').close(); };
    $('retClose').onclick = done; $('retDlg').showModal();
    if (!order) { $('retTitle').textContent = 'Pagamento'; $('retText').textContent = 'Não encontramos o pedido.'; $('retClose').hidden = false; return; }
    for (let i = 0; i < 6; i++) {
      const r = await post('/api/billing/confirm', { order, transaction_nsu: q.get('transaction_nsu'), slug: q.get('slug'), capture_method: q.get('capture_method'), receipt_url: q.get('receipt_url') });
      const b = await r.json().catch(() => ({}));
      if (r.ok && b.invoice?.status === 'paid') { $('retTitle').textContent = 'Pagamento confirmado'; $('retText').textContent = `Assinatura ativa até ${day(b.billing.accessUntil)}. Obrigado!`; $('retClose').hidden = false; return; }
      if (r.status === 404 || r.status === 401) break;
      await new Promise((res) => setTimeout(res, 2500));
    }
    $('retTitle').textContent = 'Pagamento em análise';
    $('retText').textContent = 'Ainda não recebemos a confirmação. Se você pagou, o acesso é liberado automaticamente em alguns minutos.';
    $('retClose').hidden = false;
  }

  return { open, refreshBanner, handleReturn };
}
