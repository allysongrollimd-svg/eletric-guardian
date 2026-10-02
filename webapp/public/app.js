// Electric Guardian live dashboard. All values are written with textContent (never innerHTML).
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
    const o = document.createElement('option'); o.value = dev.device; o.textContent = dev.device; sel.append(o);
  }
  sel.hidden = state.devices.size < 2;
  if (!state.current) selectDevice(dev.device);
  else if (state.current === dev.device) { render(dev); pushHistory(dev.data); drawCharts(); }
}

async function selectDevice(id) {
  state.current = id; state.lastMapKey = ''; $('device').value = id;
  $('empty').hidden = true; $('dash').hidden = false;
  try { state.history = await api(`/api/devices/${encodeURIComponent(id)}/history?minutes=30`); } catch { state.history = []; }
  render(state.devices.get(id)); drawCharts();
}

function connect() {
  state.es?.close();
  const es = new EventSource('/api/stream');
  state.es = es;
  es.addEventListener('snapshot', (e) => { JSON.parse(e.data).forEach(upsertDevice); if (!state.devices.size) { $('dash').hidden = true; $('empty').hidden = false; } });
  es.addEventListener('telemetry', (e) => upsertDevice(JSON.parse(e.data)));
  es.addEventListener('status', (e) => { const s = JSON.parse(e.data); state.devices.set(s.device, s); if (s.device === state.current) renderStatus(s); });
  es.onerror = () => { $('status').className = 'pill off'; $('status').textContent = 'Reconectando…'; if (es.readyState === EventSource.CLOSED) setTimeout(boot, 3000); };
}

async function boot() {
  try {
    state.fields = await (await fetch('/fields.json')).json();
    await api('/api/devices'); // auth probe
    $('login').hidden = true; $('logout').hidden = false;
    connect();
  } catch (e) {
    if (e.code === 401) { $('login').hidden = false; $('dash').hidden = true; $('logout').hidden = true; $('status').textContent = 'Acesso restrito'; }
    else { $('status').textContent = 'Sem conexão'; setTimeout(boot, 3000); }
  }
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault(); setText('loginErr', '');
  try { await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: $('token').value }) }); $('token').value = ''; boot(); }
  catch { setText('loginErr', 'Token inválido.'); }
});
$('logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); state.es?.close(); state.devices.clear(); state.current = null; boot(); });
$('device').addEventListener('change', (e) => selectDevice(e.target.value));
$('filter').addEventListener('input', () => { const d = state.devices.get(state.current); if (d) renderTable(d.data); });
setInterval(() => { const d = state.devices.get(state.current); if (d) renderStatus(d); }, 1000);
boot();
