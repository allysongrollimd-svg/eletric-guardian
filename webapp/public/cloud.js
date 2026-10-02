// Accounts mode UI: login / sign-up, "my cars" (pair by chassis), and the Cameras tab.
// Only loaded behaviour-wise when /api/config says mode === "accounts". All text via textContent.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const j = { 'content-type': 'application/json' };
const post = (path, body, method = 'POST') => fetch(path, { method, credentials: 'same-origin', headers: j, body: JSON.stringify(body || {}) });
const ago = (ms) => (!ms ? 'nunca' : (() => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; })());

export async function loadConfig() {
  try { const r = await fetch('/api/config'); if (r.ok) { const c = await r.json(); if (c.mode === 'accounts') return c; } } catch { /* token mode */ }
  return null;
}

export function initCloud({ getCars, getCurrent, onAuthChanged, onCarsChanged }) {
  let mode = 'login', cfg = null;

  // ---------------- auth ----------------
  function showAuth(config) {
    cfg = config; $('auth').hidden = false; $('signupTab').hidden = !config.signup; setMode('login');
  }
  function setMode(m) {
    mode = m;
    document.querySelectorAll('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('authName').hidden = m !== 'signup'; $('authSubmit').textContent = m === 'signup' ? 'Criar conta' : 'Entrar';
    $('authPass').autocomplete = m === 'signup' ? 'new-password' : 'current-password'; $('authErr').textContent = '';
  }
  document.querySelectorAll('#authTabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('authForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); $('authErr').textContent = '';
    const body = { email: $('authEmail').value, password: $('authPass').value, name: $('authName').value };
    const r = await post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', body);
    if (r.ok) { $('authPass').value = ''; $('auth').hidden = true; onAuthChanged(); }
    else $('authErr').textContent = (await r.json().catch(() => ({}))).error || `Erro ${r.status}`;
  });

  // ---------------- cars dialog ----------------
  function renderCars() {
    const host = $('carList'); host.replaceChildren();
    const cars = getCars();
    if (!cars.length) host.append(el('p', 'sub', 'Nenhum carro vinculado ainda.'));
    for (const c of cars) {
      const row = el('div', 'carrow');
      const info = el('div'); const nm = el('b', null, c.name || c.device);
      nm.append(el('span', `badge ${c.online ? 'ok' : ''}`, c.online ? 'online' : 'offline'));
      info.append(nm, el('small', null, `VIN ${c.vin || '—'} · visto há ${ago(c.lastSeen)}`));
      const actions = el('div', 'seg');
      const ren = el('button', 'act', 'Renomear'); ren.type = 'button';
      ren.addEventListener('click', async () => { const n = prompt('Novo nome do carro:', c.name || ''); if (n && n.trim()) { await post(`/api/cars/${encodeURIComponent(c.device)}`, { name: n.trim() }, 'PATCH'); onCarsChanged(); } });
      const del = el('button', 'act danger', 'Desvincular'); del.type = 'button';
      del.addEventListener('click', async () => { if (confirm(`Desvincular "${c.name}"? Ele deixa de aparecer aqui e perde acesso à nuvem (o chassi fica livre para outra conta).`)) { await fetch(`/api/cars/${encodeURIComponent(c.device)}`, { method: 'DELETE', credentials: 'same-origin' }); onCarsChanged(); } });
      actions.append(ren, del); row.append(info, actions); host.append(row);
    }
  }
  function openCars() { renderCars(); $('claimErr').textContent = ''; $('carsDlg').showModal(); }
  $('carsBtn').addEventListener('click', openCars);
  $('carsClose').addEventListener('click', () => $('carsDlg').close());
  $('claimForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); $('claimErr').textContent = '';
    const r = await post('/api/cars/claim', { name: $('claimName').value, vin: $('claimVin').value || undefined, code: $('claimCode').value });
    if (r.ok) { $('claimForm').reset(); $('carsDlg').close(); onCarsChanged(); }
    else $('claimErr').textContent = (await r.json().catch(() => ({}))).error || `Erro ${r.status}`;
  });

  // ---------------- cameras ----------------
  const frame = $('camFrame');
  let lastUrl = '';
  async function openPage(page) {
    const car = getCurrent(); if (!car) return;
    $('camStatus').textContent = 'Abrindo…';
    const r = await post(`/api/cars/${encodeURIComponent(car.device)}/view`, { page });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { $('camStatus').textContent = b.error || `Erro ${r.status}`; frame.hidden = true; return; }
    lastUrl = b.url; frame.hidden = false; frame.src = b.url; $('camStatus').textContent = `${car.name || 'Carro'} — conectado`;
  }
  $('camFull').addEventListener('click', async () => { const car = getCurrent(); if (!car) return; const r = await post(`/api/cars/${encodeURIComponent(car.device)}/view`, { page: '/live-view.html' }); if (r.ok) window.open((await r.json()).url, '_blank', 'noopener'); });
  function renderCams() {
    const car = getCurrent();
    $('camStatus').textContent = !car ? '' : car.tunnel ? `${car.name || 'Carro'} — conectado à nuvem` : `${car.name || 'Carro'} — sem conexão de câmeras. O carro precisa estar ligado, com internet e com o app aberto.`;
    document.querySelectorAll('#camButtons button').forEach((b) => (b.disabled = !car?.tunnel));
    if (!car?.tunnel) { frame.hidden = true; frame.removeAttribute('src'); }
    else if (!$('cams').hidden && !frame.getAttribute('src')) openPage('/live-view.html');      // the Live tab is just the live view
  }
  async function logout() { await post('/api/auth/logout'); location.reload(); }

  // ---------------- QR pairing: /pair?code=XXXXXXXX (the VIN comes from the car, never typed) ----------------
  function maybePair() {
    if (location.pathname !== '/pair') return;
    const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const done = () => { history.replaceState(null, '', '/'); if ($('pairDlg').open) $('pairDlg').close(); };
    if (!code) return done();
    $('pairErr').textContent = ''; $('pairDlg').showModal();
    $('pairCancel').onclick = done;
    $('pairForm').onsubmit = async (ev) => {
      ev.preventDefault(); $('pairErr').textContent = '';
      const r = await post('/api/cars/claim', { name: $('pairName').value, code });
      if (r.ok) { done(); onCarsChanged(); }
      else $('pairErr').textContent = (await r.json().catch(() => ({}))).error || `Erro ${r.status}`;
    };
  }

  /** Full-page navigation to a phone screen served on the camera host (Sentinela, Dashcam…). */
  async function goPage(page) {
    const car = getCurrent(); if (!car) return;
    const r = await post(`/api/cars/${encodeURIComponent(car.device)}/view`, { page });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const t = $('toast'); if (t) { t.textContent = b.error || `Erro ${r.status}`; t.hidden = false; setTimeout(() => { t.hidden = true; }, 3500); } return; }
    location.href = b.url;
  }

  return { showAuth, goPage, maybePair, openCars, renderCams, logout, cfg: () => cfg };
}
