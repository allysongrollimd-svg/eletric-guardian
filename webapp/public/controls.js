// Remote-control UI. Built from /controls.json (extracted from the Android app's catalog), so
// every control/value shown here is one the car accepts. All text goes through textContent.
const $ = (id) => document.getElementById(id);
const GROUP_PT = { clima: 'Clima e conforto', acesso: 'Acesso e vidros', luzes: 'Luzes', carga: 'Carga', conducao: 'Condução', adas: 'Assistências (ADAS)', outros: 'Outros' };
const OPT_PT = { off: 'Desligado', low: 'Baixo', high: 'Alto', auto: 'Auto', parking: 'Posição', low_beam: 'Farol baixo', normal: 'Normal', eco: 'Eco', sport: 'Sport', snow: 'Neve',
  horizontal: 'Horizontal', vertical: 'Vertical', front: 'Frente', front_wide: 'Frente ampla', rear: 'Traseira', rear_wide: 'Traseira ampla', left: 'Esquerda', right: 'Direita', left_right: 'Laterais',
  ev: 'EV', hev: 'Híbrido', standard: 'Padrão', comfort: 'Conforto', on: 'Ligar',
  at_current: 'Manter atual', at_target: 'Até a meta', at_floor: 'Até o mínimo' };
const ERR_PT = { 'slow down': 'Aguarde um instante antes de repetir esse comando.', 'rate limit': 'Muitos comandos seguidos. Aguarde um minuto.',
  'vehicle is offline': 'O carro está offline.', 'could not deliver the command': 'Não foi possível entregar o comando ao carro (broker fora do ar?).',
  'unknown vehicle': 'Veículo desconhecido.', 'remote control is disabled on this server': 'O controle remoto está desativado neste servidor.',
  'AEB can only be enabled remotely': 'A frenagem autônoma só pode ser ligada remotamente, nunca desligada.' };
const errPt = (m) => ERR_PT[m] || (/^locked/.test(m || '') ? 'Controles bloqueados: digite o PIN.' : m);
const COVER_PT = { OPEN: 'Abrir', CLOSE: 'Fechar', STOP: 'Parar' };
const optLabel = (o) => OPT_PT[o] || o[0].toUpperCase() + o.slice(1).replace(/_/g, ' ');
const truthy = (v) => v === true || v === 1 || /^(1|on|true)$/i.test(String(v));

export function initControls({ getDevice, getData, isOnline, rpc }) {
  let catalog = null, status = { enabled: false, unlocked: false, ttlSeconds: 0 };
  let statusAt = 0;

  const toast = (msg, bad = false) => {
    const t = $('toast'); t.textContent = msg; t.className = `toast${bad ? ' bad' : ''}`; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 3500);
  };

  async function refreshStatus() {
    try { const r = await rpc('status'); if (r.ok) { status = r.body; statusAt = Date.now(); } } catch { /* keep last */ }
    renderBanner();
  }

  function ask(title, text) {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title; $('confirmText').textContent = text;
      const d = $('confirmDlg'); d.returnValue = ''; d.onclose = () => resolve(d.returnValue === 'ok'); d.showModal();
    });
  }
  function askPin() {
    return new Promise((resolve) => {
      const d = $('pinDlg'); $('pin').value = ''; $('pinErr').textContent = ''; d.returnValue = '';
      $('pinOk').onclick = async (ev) => {
        ev.preventDefault();
        const r = await rpc('unlock', { pin: $('pin').value });
        if (r.ok) { d.close('ok'); await refreshStatus(); resolve(true); }
        else $('pinErr').textContent = r.status === 429 ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Credencial inválida.';
      };
      d.onclose = () => { if (d.returnValue !== 'ok') resolve(false); };
      d.showModal(); $('pin').focus();
    });
  }

  async function send(c, value, sub, label) {
    if (c.confirm && !(await ask('Confirmar comando', `${c.label}: ${label || value}?${c.sensitive ? ' O carro vai se mover fisicamente.' : ''}`))) return;
    if (!status.unlocked && !(await askPin())) return;
    const device = getDevice();
    const t0 = performance.now();
    let r = await rpc('cmd', { device, key: c.key, sub, value });
    if (r.status === 403) { if (await askPin()) r = await rpc('cmd', { device, key: c.key, sub, value }); }
    const body = r.body || {};
    if (r.ok) toast(`Comando entregue ao broker em ${Math.round(performance.now() - t0)} ms. O carro não confirma: confira o estado na tela.`);
    else toast(errPt(body.error) || `Erro ${r.status}`, true);
    refreshStatus();
  }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (text, fn, cls = 'act') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };

  function widget(c) {
    const data = getData() || {}, st = c.stateKey ? data[c.stateKey] : undefined;
    const w = el('div');
    switch (c.platform) {
      case 'switch': {
        const known = st !== undefined && st !== '';
        if (known) { const on = truthy(st); const b = btn(on ? 'Ligado' : 'Desligado', () => send(c, on ? 'off' : 'on', undefined, on ? 'desligar' : 'ligar'), `act sw${on ? ' on' : ''}`); w.append(b); }
        else { w.className = 'seg'; w.append(btn('Ligar', () => send(c, 'on', undefined, 'ligar')), btn('Desligar', () => send(c, 'off', undefined, 'desligar'))); }
        break;
      }
      case 'select': {
        w.className = 'seg';
        for (const o of c.options) { const b = btn(optLabel(o), () => send(c, o, undefined, optLabel(o)), 'act'); if (st !== undefined && String(st).toLowerCase() === o.toLowerCase()) b.classList.add('on'); w.append(b); }
        break;
      }
      case 'cover': w.className = 'seg'; for (const v of ['OPEN', 'STOP', 'CLOSE']) w.append(btn(COVER_PT[v], () => send(c, v, undefined, COVER_PT[v].toLowerCase()), v === 'STOP' ? 'act' : 'act danger')); break;
      case 'button': w.append(btn('Executar', () => send(c, 'PRESS', undefined, 'executar'))); break;
      case 'number': {
        w.className = 'slider';
        const r = el('input'); r.type = 'range'; r.min = c.min; r.max = c.max; r.step = c.step || 1; r.value = st != null && st !== '' && !isNaN(st) ? st : c.min;
        const o = el('b', null, `${r.value}${c.unit || ''}`); r.addEventListener('input', () => (o.textContent = `${r.value}${c.unit || ''}`));
        w.append(r, o, btn('Aplicar', () => send(c, r.value, undefined, `${r.value}${c.unit || ''}`)));
        break;
      }
      case 'climate': {
        w.className = 'seg';
        let temp = 22;
        const out = el('b', null, `${temp}°`);
        const step = (d) => { temp = Math.max(c.min, Math.min(c.max, temp + d)); out.textContent = `${temp}°`; };
        const st2 = el('span', 'stepper'); st2.append(btn('−', () => step(-1)), out, btn('+', () => step(1)), btn('Aplicar', () => send(c, String(temp), 'temperature', `${temp} °C`)));
        w.append(btn('Auto', () => send(c, 'auto', 'mode', 'ligar automático')), btn('Desligar', () => send(c, 'off', 'mode', 'desligar')), st2);
        for (const n of [1, 3, 5, 7]) w.append(btn(`Vent ${n}`, () => send(c, String(n), 'fan_mode', `ventilação ${n}`)));
        break;
      }
    }
    return w;
  }

  function renderBanner() {
    const b = $('ctlBanner'); b.replaceChildren(); b.classList.remove('warn');
    if (!status.enabled) { b.classList.add('warn'); b.append(el('span', null, 'Controle remoto desativado neste servidor (CONTROL_ENABLED).')); return; }
    if (!isOnline()) { b.classList.add('warn'); b.append(el('span', null, 'Carro offline: os comandos ficam desativados até ele reconectar.')); return; }
    if (status.unlocked) {
      b.append(el('span', null, `Controles desbloqueados (${Math.max(0, status.ttlSeconds - Math.round((Date.now() - statusAt) / 1000))} s). Comandos sem confirmação do carro: verifique o estado.`),
        btn('Bloquear', async () => { await rpc('lock'); refreshStatus(); }, 'ghost'));
    } else b.append(el('span', null, 'Controles bloqueados.'), btn('Desbloquear', askPin, 'act'));
  }

  function render() {
    if (!catalog) return;
    const host = $('ctlGroups'); host.replaceChildren();
    const usable = status.enabled && isOnline();
    for (const g of catalog.groups) {
      const items = catalog.controls.filter((c) => c.group === g && c.platform !== 'text');
      if (!items.length) continue;
      const card = el('section', 'card cgroup'); card.append(el('h3', null, GROUP_PT[g] || g));
      for (const c of items) {
        const row = el('div', 'crow'); const nm = el('div', 'nm', c.label);
        if (c.confirm) nm.append(el('small', null, 'pede confirmação'));
        row.append(nm, widget(c));
        if (!usable) row.querySelectorAll('button,input').forEach((x) => (x.disabled = true));
        card.append(row);
      }
      host.append(card);
    }
    renderBanner();
  }

  (async () => { catalog = await (await fetch('/controls.json')).json(); await refreshStatus(); render(); })();
  setInterval(() => { if (!$('controls').hidden) renderBanner(); }, 1000);
  setInterval(refreshStatus, 30000);
  return { render, refreshStatus };
}
