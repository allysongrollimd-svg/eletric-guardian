// Electric Guardian live dashboard. All values are written with textContent (never innerHTML).
import { initControls } from '/controls.js';
import { loadConfig, initCloud } from '/cloud.js';
import { initBilling } from '/billing.js';
const $ = (id) => document.getElementById(id);
const nf = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--');
const state = { devices: new Map(), current: null, history: [], fields: {}, es: null, lastMapKey: '' };

async function api(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) throw Object.assign(new Error('unauthorized'), { code: 401 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- rendering ----------
function setText(id, v) { const e = $(id); if (e) e.textContent = v; }

function render(dev) {
  if (!dev) return;
  const d = dev.data;
  setText('soc', nf(d.soc, 0));
  const arc = $('socArc');
  const pct = Math.max(0, Math.min(100, d.soc ?? 0));
  arc.style.strokeDashoffset = String(326.7 * (1 - pct / 100));
  arc.style.stroke = pct <= 15 ? 'var(--bad)' : pct <= 30 ? 'var(--warn)' : 'var(--primary)';
  setText('range', nf(d.ev_range_km, 0));
  setText('speed', nf(d.speed, 0));
  setText('gear', d.gear ?? '--');
  setText('power', nf(d.power, 1));
  const bar = $('powerBar'); const p = Math.max(-60, Math.min(120, d.power ?? 0));
  // centre = 0 kW; right = consumption, left = regeneration
  const zero = (60 / 180) * 100, pos = ((p + 60) / 180) * 100;
  bar.style.left = `${Math.min(zero, pos)}%`; bar.style.width = `${Math.abs(pos - zero)}%`;
  bar.style.background = p < 0 ? 'var(--ok)' : 'var(--primary)';
  setText('hp', d.power == null ? '--' : nf(Math.abs(d.power) * 1.35962, 0)); // kW -> cv (metric hp)
  setText('torque', nf(d.motor_front_torque, 0));
  setText('accel', d.accel_pct == null ? '--' : `${nf(d.accel_pct, 0)}%`);
  setText('rpm', nf(d.motor_rear_rpm ?? d.motor_front_rpm, 0));
  setText('powerHint', p < -0.5 ? 'Regenerando' : p > 0.5 ? 'Consumindo' : ' ');

  const charging = d.is_charging === true;
  setText('chgState', charging ? 'Carregando' : d.is_parked ? 'Estacionado' : 'Em uso');
  setText('chgDetail', charging
    ? [d.charge_power != null ? `${nf(d.charge_power, 1)} kW` : null, d.is_dcfc ? 'DC rápido' : null, d.charging_eta_minutes ? `~${nf(d.charging_eta_minutes)} min` : null].filter(Boolean).join(' · ')
    : ' ');

  setText('tripKm', d.trip_km != null ? `${nf(d.trip_km, 1)} km` : '--');
  setText('tripKwh', d.trip_kwh != null ? `${nf(d.trip_kwh, 1)} kWh` : '--');
  setText('cons', d.consumption_50km != null ? `${nf(d.consumption_50km, 1)} kWh/100 km` : '--');
  setText('tBatt', d.batt_temp != null ? `${nf(d.batt_temp, 1)} °C` : '--');
  setText('tCabin', d.cabin_temp != null ? `${nf(d.cabin_temp, 1)} °C` : '--');
  setText('tExt', d.ext_temp != null ? `${nf(d.ext_temp, 1)} °C` : '--');
  setText('odo', nf(d.odometer, 1));
  renderStatus(dev);
  renderMap(d);
  renderTable(d);
}

function renderStatus(dev) {
  bill?.refreshBanner();
  const el = $('status');
  el.className = `pill ${dev.online ? 'on' : 'off'}`;
  const age = dev.lastSeen ? Math.max(0, Math.round((Date.now() - dev.lastSeen) / 1000)) : null;
  el.textContent = dev.online ? 'Online' : 'Offline';
  setText('lastSeen', age == null ? 'Sem dados ainda' : `Atualizado há ${age < 60 ? age + ' s' : Math.round(age / 60) + ' min'}`);
}

function renderMap(d) {
  if (typeof d.lat !== 'number' || typeof d.lon !== 'number' || (d.lat === 0 && d.lon === 0)) return;
  setText('coords', `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`);
  const key = `${d.lat.toFixed(3)},${d.lon.toFixed(3)}`; // refresh iframe only after ~100 m of movement
  if (key === state.lastMapKey) return;
  state.lastMapKey = key;
  const dl = 0.004;
  $('map').src = `https://www.openstreetmap.org/export/embed.html?bbox=${d.lon - dl},${d.lat - dl},${d.lon + dl},${d.lat + dl}&layer=mapnik&marker=${d.lat},${d.lon}`;
}

function renderTable(d) {
  const q = $('filter').value.trim().toLowerCase();
  const rows = Object.keys(d).sort().filter((k) => !state.fields[k]?.hidden)
    .filter((k) => !q || k.includes(q) || (state.fields[k]?.name || '').toLowerCase().includes(q));
  setText('allCount', String(Object.keys(d).length));
  const tb = $('allRows'); tb.replaceChildren();
  for (const k of rows) {
    const f = state.fields[k]; const v = d[k];
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = f?.name || k;
    const b = document.createElement('td');
    b.textContent = typeof v === 'boolean' ? (v ? 'sim' : 'não') : typeof v === 'number' ? `${nf(v, Number.isInteger(v) ? 0 : 2)}${f?.unit ? ' ' + f.unit : ''}` : String(v);
    tr.append(a, b); tb.append(tr);
  }
}

// ---------- charts ----------
function spark(svgId, key) {
  const svg = $(svgId); svg.replaceChildren();
  const pts = state.history.filter((p) => typeof p[key] === 'number');
  if (pts.length < 2) return;
  const now = Date.now(), t0 = Math.max(now - 30 * 60000, pts[0].t), span = Math.max(now - t0, 30000), W = 300, H = 80;
  let lo = Math.min(...pts.map((p) => p[key])), hi = Math.max(...pts.map((p) => p[key]));
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const xy = pts.map((p) => [Math.max(0, ((p.t - t0) / span) * W), H - 4 - ((p[key] - lo) / (hi - lo)) * (H - 8)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const ns = 'http://www.w3.org/2000/svg';
  const area = document.createElementNS(ns, 'path'); area.setAttribute('class', 'area'); area.setAttribute('d', `${line}L${xy.at(-1)[0]},${H}L${xy[0][0]},${H}Z`);
  const path = document.createElementNS(ns, 'path'); path.setAttribute('d', line);
  svg.append(area, path);
}
const drawCharts = () => { spark('chSoc', 'soc'); spark('chSpeed', 'speed'); spark('chPower', 'power'); };

// ---------- tabs / controls ----------
const ctl = initControls({
  rpc: (op, body) => rpc(op, body),
  getDevice: () => state.current,
  getData: () => state.devices.get(state.current)?.data,
  isOnline: () => !!state.devices.get(state.current)?.online,
});
let cloud = null;        // set in accounts mode
let bill = null;
let ctlTimer = null;
const ctlRerender = () => { if (!$('controls').hidden && !document.querySelector('dialog[open]')) ctl.render(); };
function showTab(name) {
  $('dash').hidden = name !== 'dash' || !state.current; $('controls').hidden = name !== 'controls'; $('cams').hidden = name !== 'cams';
  document.querySelectorAll('.tab[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'controls') { ctl.refreshStatus(); ctl.render(); }
  if (name === 'cams') cloud?.renderCams();
}
document.querySelectorAll('.tab[data-open]').forEach((b) => b.addEventListener('click', () => { setDrawer(false); cloud?.goPage(b.dataset.open); }));
const TITLES = { dash: 'Painel', controls: 'Controles', cams: 'Ao vivo' };
function setDrawer(open) { $('drawer').classList.toggle('open', open); $('drawer').setAttribute('aria-hidden', String(!open)); $('scrim').hidden = !open; $('menuBtn').setAttribute('aria-expanded', String(open)); }
$('menuBtn').addEventListener('click', () => setDrawer(!$('drawer').classList.contains('open')));
$('scrim').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
['carsBtn', 'logout', 'device'].forEach((id) => $(id).addEventListener(id === 'device' ? 'change' : 'click', () => setDrawer(false)));
document.querySelectorAll('.tab[data-tab]').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); $('sectionTitle').textContent = TITLES[b.dataset.tab] || 'Painel'; setDrawer(false); }));
// Re-render at most every 2 s while the controls tab is open so states (on/off, selected option) follow telemetry.
setInterval(ctlRerender, 2000);

// ---------- data flow ----------
function pushHistory(d) {
  const p = { t: Date.now() };
  for (const k of ['soc', 'speed', 'power']) if (typeof d[k] === 'number') p[k] = d[k];
  const last = state.history.at(-1);
  if (!last || p.t - last.t >= 2000) state.history.push(p);
  const cutoff = Date.now() - 30 * 60000;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();
}

function upsertDevice(dev) {
  state.devices.set(dev.device, dev);
  const sel = $('device');
  if (![...sel.options].some((o) => o.value === dev.device)) {
    const o = document.createElement('option'); o.value = dev.device; sel.append(o);
  }
  for (const o of sel.options) if (o.value === dev.device) o.textContent = dev.name || dev.device;
  sel.hidden = state.devices.size < 2;
  if (!state.current) selectDevice(dev.device);
  else if (state.current === dev.device) { render(dev); pushHistory(dev.data); drawCharts(); }
}

async function selectDevice(id) {
  state.current = id; state.lastMapKey = ''; $('device').value = id;
  $('empty').hidden = true; $('tabs').hidden = false; if (!document.querySelector('.tab.on[data-tab=controls]')) $('dash').hidden = false;
  try { state.history = await api(`/api/devices/${encodeURIComponent(id)}/history?minutes=30`); } catch { state.history = []; }
  render(state.devices.get(id)); drawCharts();
}

// ---------- transport: WebSocket first (also carries commands), SSE as fallback ----------
const transport = { ws: null, kind: 'none', pending: new Map(), seq: 0, rtt: null, timer: null };

function handle(event, data) {
  if (event === 'snapshot') { data.forEach(upsertDevice); if (!state.devices.size) { $('dash').hidden = true; $('empty').hidden = false; $('tabs').hidden = state.mode !== 'accounts'; if (state.mode === 'accounts') cloud.openCars(); } }
  else if (event === 'telemetry') upsertDevice(data);
  else if (event === 'status') { state.devices.set(data.device, data); if (data.device === state.current) { renderStatus(data); cloud?.renderCams(); } }
  else if (event === 'pong') { transport.rtt = Math.round(performance.now() - data); renderLatency(); }
  else if (event === 'rpc') { const p = transport.pending.get(data.id); if (p) { transport.pending.delete(data.id); p({ ok: data.ok, status: data.status, body: data.body }); } }
}
function renderLatency() {
  const el = $('latency'); if (!el) return;
  el.hidden = transport.kind === 'none';
  el.textContent = transport.kind === 'ws' ? `WS${transport.rtt != null ? ` · ${transport.rtt} ms` : ''}` : 'SSE';
}

/** One request/response op, over the WebSocket when open, otherwise over plain HTTP. */
async function rpc(op, body = {}) {
  const ws = transport.ws;
  if (ws && ws.readyState === 1) {
    return new Promise((resolve) => {
      const id = ++transport.seq;
      const timer = setTimeout(() => { transport.pending.delete(id); resolve({ ok: false, status: 504, body: { error: 'timeout' } }); }, 8000);
      transport.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      ws.send(JSON.stringify({ type: op, id, ...body }));
    });
  }
  const json = { 'content-type': 'application/json' };
  let r;
  if (op === 'status') r = await fetch('/api/control/status', { credentials: 'same-origin' });
  else if (op === 'unlock') r = await fetch('/api/control/unlock', { method: 'POST', credentials: 'same-origin', headers: json, body: JSON.stringify({ pin: body.pin }) });
  else if (op === 'lock') r = await fetch('/api/control/lock', { method: 'POST', credentials: 'same-origin', headers: json, body: '{}' });
  else if (op === 'cmd') r = await fetch(`/api/devices/${encodeURIComponent(body.device)}/control`, { method: 'POST', credentials: 'same-origin', headers: json, body: JSON.stringify({ key: body.key, sub: body.sub, value: body.value }) });
  else return { ok: false, status: 400, body: { error: 'bad op' } };
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

function connectSse() {
  const es = new EventSource('/api/stream');
  transport.kind = 'sse'; transport.es = es; renderLatency();
  for (const ev of ['snapshot', 'telemetry', 'status']) es.addEventListener(ev, (e) => handle(ev, JSON.parse(e.data)));
  es.onerror = () => { $('status').className = 'pill off'; $('status').textContent = 'Reconectando…'; if (es.readyState === EventSource.CLOSED) setTimeout(boot, 3000); };
}

function connect() {
  transport.es?.close(); transport.ws?.close(); clearInterval(transport.timer);
  if (new URLSearchParams(location.search).has('sse')) { connectSse(); return; }   // ?sse=1 forces the fallback (debug/benchmark)
  let opened = false;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  transport.ws = ws;
  const give = setTimeout(() => { if (!opened) { ws.onclose = null; ws.close(); connectSse(); } }, 4000);   // WS blocked by a proxy? fall back
  ws.onopen = () => {
    opened = true; clearTimeout(give); transport.kind = 'ws'; renderLatency();
    const ping = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
    ping(); transport.timer = setInterval(ping, 5000);
  };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); handle(m.event, m.event === 'pong' ? m.t : m.event === 'rpc' ? m : m.data); };
  ws.onclose = () => {
    clearInterval(transport.timer); clearTimeout(give); transport.kind = 'none'; renderLatency();
    $('status').className = 'pill off'; $('status').textContent = 'Reconectando…';
    if (!opened) { connectSse(); return; }            // never opened: use SSE
    setTimeout(boot, 2000);                             // opened then dropped: re-auth + reconnect
  };
}

async function boot() {
  try {
    state.fields = await (await fetch('/fields.json')).json();
    if (state.mode === undefined) {
      const cfg = await loadConfig();
      state.mode = cfg ? 'accounts' : 'token';
      if (cfg) {
        cloud = initCloud({
          getCars: () => [...state.devices.values()],
          getCurrent: () => state.devices.get(state.current),
          onAuthChanged: () => boot(),
          onCarsChanged: () => { transport.ws?.close(); transport.es?.close(); state.devices.clear(); state.current = null; $('device').replaceChildren(); boot(); },
        });
        bill = initBilling({ getCurrent: () => state.devices.get(state.current) });
        state.cfg = cfg;
        $('pinHint').textContent = 'Digite a senha da sua conta para desbloquear os controles por alguns minutos.';
        $('pin').placeholder = 'Senha da conta'; $('pin').inputMode = 'text'; $('pin').autocomplete = 'current-password';
      }
    }
    await api('/api/devices'); // auth probe
    $('login').hidden = true; $('auth').hidden = true; $('logout').hidden = false;
    if (state.mode === 'accounts') {
      $('carsBtn').hidden = false; $('camsTab').hidden = false; $('billBtn').hidden = false; $('sentryLink').hidden = false; $('dashcamLink').hidden = false;
      api('/api/me').then((m) => { $('adminLink').hidden = m.user?.role !== 'admin'; }).catch(() => {});
      bill.handleReturn();
    }
    connect();
    if (state.mode === 'accounts') cloud.maybePair();
  } catch (e) {
    if (e.code === 401) {
      $('dash').hidden = true; $('logout').hidden = true; $('tabs').hidden = true; $('status').textContent = 'Acesso restrito';
      if (state.mode === 'accounts') cloud.showAuth(state.cfg); else $('login').hidden = false;
    } else { $('status').textContent = 'Sem conexão'; setTimeout(boot, 3000); }
  }
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault(); setText('loginErr', '');
  try { await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: $('token').value }) }); $('token').value = ''; boot(); }
  catch { setText('loginErr', 'Token inválido.'); }
});
$('logout').addEventListener('click', async () => {
  if (state.mode === 'accounts') { await rpc('lock').catch(() => {}); return cloud.logout(); } await rpc('lock'); await fetch('/api/logout', { method: 'POST' }); $('tabs').hidden = true; $('controls').hidden = true; transport.ws?.close(); transport.es?.close(); state.devices.clear(); state.current = null; boot(); });
$('device').addEventListener('change', (e) => selectDevice(e.target.value));
$('filter').addEventListener('input', () => { const d = state.devices.get(state.current); if (d) renderTable(d.data); });
setInterval(() => { const d = state.devices.get(state.current); if (d) renderStatus(d); }, 1000);
boot();
