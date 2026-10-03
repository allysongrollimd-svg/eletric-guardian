// Back office: customers, cars, subscriptions, invoices, plans, settings and audit. All text goes through textContent.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const hdr = { 'content-type': 'application/json' };
const brl = (c) => ((c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const when = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const day = (ms) => (ms ? new Date(ms).toLocaleDateString('pt-BR') : '—');
const STATE = { trial: ['Teste', 'ok'], active: ['Ativa', 'ok'], grace: ['Tolerância', 'warn'], expired: ['Vencida', 'bad'] };
let tab = 'overview', toastTimer;

async function api(path, method = 'GET', body) {
  const r = await fetch(`/api/admin/${path}`, { method, credentials: 'same-origin', headers: hdr, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Erro ${r.status}`); e.status = r.status; throw e; }
  return j;
}
function toast(msg, bad) { const t = $('toast'); t.textContent = msg; t.className = `toast${bad ? ' bad' : ''}`; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000); }
const run = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); return null; } };
const tag = (state) => el('span', `tag ${STATE[state]?.[1] || ''}`, STATE[state]?.[0] || state);
function table(cols, rows) {
  const t = el('table', 'tbl'); const h = el('tr');
  cols.forEach((c) => h.append(el('th', c.num ? 'num' : null, c.h))); t.append(el('thead')); t.firstChild.append(h);
  const b = el('tbody'); t.append(b);
  rows.forEach((r) => { const tr = el('tr'); cols.forEach((c) => { const td = el('td', c.num ? 'num' : null); td.dataset.l = c.h; const v = c.f(r); if (v instanceof Node) td.append(v); else td.textContent = v ?? '—'; tr.append(td); }); b.append(tr); });
  if (!rows.length) { const tr = el('tr'); const td = el('td', null, 'Nada por aqui.'); td.colSpan = cols.length; tr.append(td); b.append(tr); }
  const w = el('div', 'scroll'); w.append(t); return w;
}
const btn = (label, fn, cls = 'ghost mini') => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const field = (label, input) => { const l = el('label'); l.append(el('span', null, label), input); return l; };
const input = (attrs = {}) => { const i = el('input'); Object.assign(i, attrs); return i; };
function searchBar(value, onChange, extra) {
  const bar = el('div', 'abar'); const i = input({ type: 'search', placeholder: 'Buscar…', value: value || '' });
  let t; i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onChange(i.value), 300); });
  bar.append(i); if (extra) bar.append(extra); return bar;
}

const views = {
  async overview(main) {
    const o = await api('overview');
    const k = (l, v) => { const d = el('div', 'kpi'); d.append(el('span', 'label', l), el('b', null, v)); return d; };
    const g = el('div', 'kpis');
    g.append(k('Clientes', o.users), k('Carros', o.cars), k('Assinaturas ativas', o.states.active), k('Em teste', o.states.trial), k('Em tolerância', o.states.grace), k('Vencidos', o.states.expired),
      k('Receita 30 dias', brl(o.revenue30dCents)), k('Pagamentos 30 dias', o.payments30d), k('Faturas pendentes (7d)', o.pendingInvoices));
    main.append(g);
    if (!o.checkoutConfigured) { const w = el('div', 'form'); w.append(el('b', null, 'Pagamento ainda não configurado'), el('span', 'sub', 'Informe a InfiniteTag da InfinitePay em Config. para liberar o checkout.')); main.append(w); }
  },

  async users(main, st = {}) {
    const render = async (q) => {
      main.replaceChildren(searchBar(q, (v) => views.users(main, { q: v })));
      const { users } = await api(`users?q=${encodeURIComponent(q || '')}`);
      main.append(table([
        { h: 'Cliente', f: (u) => { const d = el('div'); d.append(el('b', null, u.name || u.email), el('div', 'sub', u.email)); return d; } },
        { h: 'Perfil', f: (u) => el('span', `tag ${u.role === 'admin' ? 'warn' : ''}`, u.role) },
        { h: 'Carros', num: 1, f: (u) => u.cars },
        { h: 'Criado', f: (u) => day(u.createdAt) },
        { h: 'Situação', f: (u) => (u.disabled ? el('span', 'tag bad', 'bloqueado') : el('span', 'tag ok', 'ativo')) },
        { h: '', f: (u) => { const a = el('div', 'acts');
          a.append(btn(u.disabled ? 'Desbloquear' : 'Bloquear', async () => { if (await run(() => api(`users/${u.id}`, 'PATCH', { disabled: !u.disabled }), 'Atualizado')) render(q); }));
          a.append(btn(u.role === 'admin' ? 'Tirar admin' : 'Tornar admin', async () => { if (await run(() => api(`users/${u.id}`, 'PATCH', { role: u.role === 'admin' ? 'user' : 'admin' }), 'Atualizado')) render(q); }));
          a.append(btn('Nova senha', async () => { const p = prompt('Nova senha (mínimo 10 caracteres):'); if (p) await run(() => api(`users/${u.id}/password`, 'POST', { password: p }), 'Senha alterada; a pessoa foi desconectada.'); }));
          return a; } },
      ], users));
    };
    await render(st.q || '');
    const f = el('form', 'form'); f.append(el('b', null, 'Novo cliente'));
    const two = el('div', 'two'); const e = input({ type: 'email', placeholder: 'e-mail', required: true }), n = input({ placeholder: 'nome' });
    const p = input({ type: 'text', placeholder: 'senha (mín. 10)', required: true, minLength: 10 }); const r = el('select'); ['user', 'admin'].forEach((v) => r.append(new Option(v, v)));
    two.append(field('E-mail', e), field('Nome', n), field('Senha', p), field('Perfil', r)); f.append(two);
    const s = el('button', null, 'Criar'); s.type = 'submit'; f.append(s);
    f.addEventListener('submit', async (ev) => { ev.preventDefault(); if (await run(() => api('users', 'POST', { email: e.value, name: n.value, password: p.value, role: r.value }), 'Cliente criado')) { f.reset(); render(''); } });
    main.append(f);
  },

  async cars(main, st = {}) {
    main.replaceChildren(searchBar(st.q, (v) => views.cars(main, { q: v })));
    const { cars } = await api(`cars?q=${encodeURIComponent(st.q || '')}`);
    main.append(table([
      { h: 'Carro', f: (c) => { const d = el('div'); d.append(el('b', null, c.name || '—'), el('div', 'sub', c.vin || '')); return d; } },
      { h: 'Dono', f: (c) => c.ownerEmail },
      { h: 'Assinatura', f: (c) => { const d = el('div'); d.append(tag(c.billing.state), el('div', 'sub', `até ${day(c.billing.accessUntil)}`)); return d; } },
      { h: 'Chassi', f: (c) => (c.vinVerified ? 'verificado' : 'não conferido') },
      { h: 'Ao vivo', f: (c) => {
        const l = c.live; if (!l) return '—'; const d = el('div');
        const ok = (b, t) => el('div', b ? 'ok' : 'sub', `${b ? '●' : '○'} ${t}`);
        d.append(ok(l.tunnel, 'câmeras (túnel)'), ok(l.mqtt, 'telemetria (MQTT)'));
        d.append(el('div', 'sub', l.telemetryAt ? `último dado há ${Math.round((Date.now() - l.telemetryAt) / 1000)} s · ${l.fields} campos` : 'nenhum dado de telemetria recebido'));
        const s = l.mqttStats; if (s) d.append(el('div', 'sub', `conexões ${s.connects} · mensagens ${s.msgs}${s.rejected ? ` · recusadas ${s.rejected} (${s.lastRejected})` : ''}${s.lastTopic ? ` · último tópico: ${s.lastTopic}` : ''}`));
        return d; } },
      { h: 'Visto', f: (c) => when(c.lastSeen) },
      { h: '', f: (c) => { const a = el('div', 'acts');
        a.append(btn('+ dias', async () => { const d = parseInt(prompt('Quantos dias conceder? (negativo remove)', '30'), 10); if (d) { if (await run(() => api('cars/grant', 'POST', { vin: c.vin, days: d }), 'Dias ajustados')) views.cars(main, st); } }));
        a.append(btn('Venda manual', async () => { const plan = prompt('Plano (mensal, trimestral, semestral, anual):', 'mensal'); if (plan) { const note = prompt('Observação (ex.: PIX direto):', ''); if (await run(() => api('invoices/manual', 'POST', { vin: c.vin, plan, note }), 'Baixa registrada')) views.cars(main, st); } }));
        a.append(btn('Liberar chassi', async () => { if (confirm(`Desvincular ${c.vin} da conta ${c.ownerEmail}? O chassi fica livre para outra conta.`)) { if (await run(() => api('cars/release', 'POST', { vin: c.vin }), 'Chassi liberado')) views.cars(main, st); } }, 'ghost mini danger'));
        return a; } },
    ], cars));
  },

  async invoices(main, st = {}) {
    const sel = el('select'); [['', 'Todas'], ['pending', 'Pendentes'], ['paid', 'Pagas'], ['cancelled', 'Canceladas']].forEach(([v, l]) => sel.append(new Option(l, v))); sel.value = st.status || '';
    sel.addEventListener('change', () => views.invoices(main, { ...st, status: sel.value }));
    main.replaceChildren(searchBar(st.q, (v) => views.invoices(main, { ...st, q: v }), sel));
    const { invoices } = await api(`invoices?status=${st.status || ''}&q=${encodeURIComponent(st.q || '')}`);
    const label = { pending: ['Pendente', 'warn'], paid: ['Paga', 'ok'], cancelled: ['Cancelada', 'bad'] };
    main.append(table([
      { h: 'Criada', f: (i) => when(i.createdAt) },
      { h: 'Cliente', f: (i) => { const d = el('div'); d.append(i.userEmail || '—', el('div', 'sub', `${i.car || ''} · ${i.vin}`)); return d; } },
      { h: 'Plano', f: (i) => i.plan },
      { h: 'Valor', num: 1, f: (i) => brl(i.amountCents) },
      { h: 'Status', f: (i) => { const d = el('div'); d.append(el('span', `tag ${label[i.status]?.[1] || ''}`, label[i.status]?.[0] || i.status), el('div', 'sub', `${i.source}${i.captureMethod ? ` · ${i.captureMethod}` : ''}${i.paidAt ? ` · ${when(i.paidAt)}` : ''}`)); return d; } },
      { h: '', f: (i) => { const a = el('div', 'acts');
        if (i.status === 'pending') {
          a.append(btn('Dar baixa', async () => { const note = prompt('Observação da baixa manual:', 'recebido por fora'); if (note !== null && await run(() => api(`invoices/${i.id}/settle`, 'POST', { note }), 'Baixa registrada')) views.invoices(main, st); }));
          a.append(btn('Cancelar', async () => { if (confirm('Cancelar esta fatura?') && await run(() => api(`invoices/${i.id}/cancel`, 'POST', {}), 'Cancelada')) views.invoices(main, st); }, 'ghost mini danger'));
        } else if (i.receiptUrl) { const l = el('a', null, 'Comprovante'); l.href = i.receiptUrl; l.target = '_blank'; l.rel = 'noopener'; a.append(l); }
        return a; } },
    ], invoices));
  },

  async plans(main) {
    const { plans } = await api('plans');
    const addRow = (p) => {
      const f = el('form', 'form'); const two = el('div', 'two');
      const id = input({ value: p.id, readOnly: !!p.id, placeholder: 'id (ex.: mensal)', required: true, pattern: '[a-z0-9_-]{2,24}' });
      const name = input({ value: p.name || '', placeholder: 'Nome', required: true });
      const months = input({ type: 'number', min: 1, max: 36, value: p.months || 1, required: true });
      const price = input({ type: 'number', min: 1, step: '0.01', value: p.priceCents ? (p.priceCents / 100).toFixed(2) : '', required: true });
      const active = input({ type: 'checkbox', checked: p.active !== false }); active.style.width = 'auto'; active.style.minHeight = '0';
      two.append(field('Id', id), field('Nome', name), field('Meses', months), field('Preço (R$)', price)); f.append(two);
      const row = el('div', 'abar'); const al = el('label', 'abar'); al.append(active, el('span', null, 'Disponível para venda')); row.append(al);
      const s = el('button', 'mini', 'Salvar'); s.type = 'submit'; row.append(s); f.append(row);
      f.addEventListener('submit', async (ev) => { ev.preventDefault(); if (await run(() => api(`plans/${encodeURIComponent(id.value)}`, 'PUT', { name: name.value, months: +months.value, priceCents: Math.round(parseFloat(price.value) * 100), active: active.checked, sort: p.sort ?? plans.length }), 'Plano salvo')) views.plans(main); });
      return f;
    };
    main.replaceChildren(el('p', 'sub', 'Os preços valem para novas faturas. Faturas já criadas mantêm o valor.'));
    plans.forEach((p) => main.append(addRow(p)));
    const head = el('b', null, 'Novo plano'); main.append(head, addRow({}));
  },

  async settings(main) {
    const s = await api('settings');
    const f = el('form', 'form'); const two = el('div', 'two');
    const handle = input({ value: s.infinitepayHandle, placeholder: 'sua InfiniteTag, sem o $' });
    const trial = input({ type: 'number', min: 0, max: 365, value: s.trialDays }); const grace = input({ type: 'number', min: 0, max: 60, value: s.graceDays });
    const apiUrl = input({ value: s.infinitepayApi, placeholder: 'padrão: https://api.infinitepay.io/invoices/public/checkout' });
    two.append(field('InfiniteTag (InfinitePay)', handle), field('Dias de teste grátis', trial), field('Dias de tolerância após vencer', grace), field('URL da API (avançado)', apiUrl)); f.append(two);
    f.append(el('p', 'sub', 'Teste: começa no primeiro vínculo do chassi e não reinicia se o cliente desvincular e vincular de novo. Tolerância: tudo continua funcionando; depois dela, câmeras e controles ficam bloqueados.'));
    const w = el('p', 'sub', `Webhook configurado automaticamente em cada fatura: ${location.origin}/api/billing/infinitepay/webhook`); f.append(w);
    const b = el('button', null, 'Salvar'); b.type = 'submit'; f.append(b);
    f.addEventListener('submit', async (ev) => { ev.preventDefault(); await run(() => api('settings', 'PUT', { infinitepayHandle: handle.value, trialDays: +trial.value, graceDays: +grace.value, infinitepayApi: apiUrl.value }), 'Configurações salvas'); });
    main.append(f);
  },

  async audit(main) {
    const { events } = await api('audit?limit=200');
    main.append(table([
      { h: 'Quando', f: (e) => when(e.t) }, { h: 'Quem', f: (e) => e.user || '—' }, { h: 'Evento', f: (e) => e.event },
      { h: 'Detalhe', f: (e) => { const d = el('span', 'wrap', e.detail ? JSON.stringify(e.detail) : ''); return d; } },
    ], events));
  },
};

async function show(t) {
  tab = t; document.querySelectorAll('#atabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  const main = $('amain'); main.replaceChildren();
  try { await views[t](main); } catch (e) { main.replaceChildren(el('p', 'err', e.message)); }
}
document.querySelectorAll('#atabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.t)));

(async () => {
  try { await api('overview'); } catch (e) {
    $('gate').textContent = e.status === 401 ? 'Entre na sua conta pelo app e volte a esta página.' : e.status === 403 ? 'Esta conta não tem permissão de administrador.' : e.message;
    if (e.status === 401) { const a = el('a', null, 'Abrir o app'); a.href = '/'; $('gate').append(' ', a); }
    return;
  }
  $('atabs').hidden = false; show('overview');
})();
