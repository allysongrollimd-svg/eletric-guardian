// Phone screen for car recordings (Sentinela / Dashcam). Runs on the camera host: every fetch is same-origin and goes
// through the tunnel to the car's own API (/api/recordings, /thumb/id/…, /video/id/…). All text goes through textContent.
const cfg = document.querySelector('script[data-type]')?.dataset || {};
const TYPE = cfg.type || 'normal';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const PAGE = 18;
const state = { dates: [], idx: 0, page: 1, pages: 1, filter: 'all', loading: false, items: [] };

async function getJson(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) throw Object.assign(new Error('Sessão expirada. Abra de novo pelo painel.'), { auth: true });
  if (r.status === 503) throw new Error('O carro está offline. Ele precisa estar ligado, com internet e com o app aberto.');
  if (!r.ok) throw new Error(`Erro ${r.status}`);
  return r.json();
}
const dayLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00`); const t = new Date(); t.setHours(12, 0, 0, 0);
  const diff = Math.round((t - d) / 86400000);
  return { main: diff === 0 ? 'Hoje' : diff === 1 ? 'Ontem' : d.toLocaleDateString('pt-BR', { weekday: 'long' }), sub: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) };
};
const fmtDur = (s) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

function setState(msg, sub, retry) {
  const box = $('list'); box.replaceChildren();
  const s = el('div', 'state'); s.append(el('b', null, msg)); if (sub) s.append(sub);
  if (retry) { const b = el('button', 'more', 'Tentar de novo'); b.addEventListener('click', retry); s.append(b); }
  box.append(s); $('more').hidden = true;
}

// Thumbnails come from the car, which answers one request per connection: load a few at a time.
const queue = []; let active = 0;
function loadThumb(img, url) {
  queue.push({ img, url }); pump();
}
// The car answers 202 {"status":"generating"} the first time it is asked for a thumbnail; ask again until it is ready.
async function fetchThumb(url) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 202) { await new Promise((res) => setTimeout(res, 1500)); continue; }
    if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) throw new Error(String(r.status));
    return URL.createObjectURL(await r.blob());
  }
  throw new Error('timeout');
}
function pump() {
  while (active < 4 && queue.length) {
    const { img, url } = queue.shift(); active++;
    fetchThumb(url).then((u) => { img.src = u; }).catch(() => { img.closest('.th')?.classList.add('nothumb'); }).finally(() => { active--; pump(); });
  }
}
const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); loadThumb(e.target, e.target.dataset.src); } }), { rootMargin: '200px' }) : null;

const clock = (rec) => (rec.timestamp ? new Date(rec.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : (rec.timeFormatted || rec.time || ''));
const dayTxt = (rec) => (rec.timestamp ? new Date(rec.timestamp).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) : (rec.dateFormatted || rec.date || ''));
function clipRow(rec) {
  const b = el('button', 'clip'); b.type = 'button';
  const th = el('div', 'th'); const img = el('img'); img.alt = ''; img.decoding = 'async'; img.dataset.src = rec.thumbnailUrl || `/thumb/id/${rec.id}`;
  th.append(img); if (io) io.observe(img); else loadThumb(img, img.dataset.src);
  const m = el('div', 'meta'); m.append(el('b', null, clock(rec)));
  const where = rec.place?.displayName || rec.place?.medium || rec.place?.short;
  m.append(el('small', null, where || rec.sizeFormatted || ''));
  const tags = el('div', 'tags');
  if (rec.peakSeverity && rec.peakSeverity !== 'INFO') tags.append(el('span', `tag ${/CRIT|ALERT/.test(rec.peakSeverity) ? 'bad' : 'warn'}`, rec.peakSeverity === 'CRITICAL' ? 'crítico' : rec.peakSeverity === 'ALERT' ? 'alerta' : String(rec.peakSeverity).toLowerCase()));
  if (rec.personCount) tags.append(el('span', 'tag', `${rec.personCount} pessoa${rec.personCount > 1 ? 's' : ''}`));
  if (rec.vehicleCount) tags.append(el('span', 'tag', `${rec.vehicleCount} veículo${rec.vehicleCount > 1 ? 's' : ''}`));
  if (rec.sizeFormatted && where) tags.append(el('span', 'tag', rec.sizeFormatted));
  if (tags.children.length) m.append(tags);
  b.append(th, m); b.addEventListener('click', () => openPlayer(rec));
  return b;
}

async function loadDates() {
  const d = await getJson('/api/recordings/dates');
  state.dates = (d.dates || []).filter((x) => x.count > 0 && (TYPE !== 'sentry' || x.hasSentry)).map((x) => x.date).sort().reverse();
}
async function loadPage(reset) {
  if (state.loading) return; state.loading = true;
  try {
    if (reset) { state.page = 1; state.items = []; $('list').replaceChildren(); }
    const date = state.dates[state.idx];
    if (!date) { setState('Nada gravado ainda', TYPE === 'sentry' ? 'Quando a sentinela detectar movimento, as gravações aparecem aqui.' : 'As gravações da dashcam aparecem aqui.'); return; }
    const q = new URLSearchParams({ type: TYPE, date, page: String(state.page), pageSize: String(PAGE) });
    if (state.filter !== 'all') q.set('class', state.filter);
    const r = await getJson(`/api/recordings?${q}`);
    if (r.warming) { setState('Organizando as gravações do carro…', `${r.progress?.done ?? 0} de ${r.progress?.total ?? '?'}`); setTimeout(() => loadPage(true), 2500); return; }
    state.pages = r.totalPages || 1;
    if (!r.recordings?.length && state.page === 1) { setState('Nenhuma gravação neste dia'); return; }
    r.recordings.forEach((rec) => { state.items.push(rec); $('list').append(clipRow(rec)); });
    $('more').hidden = state.page >= state.pages;
  } catch (e) { setState(e.auth ? 'Sessão expirada' : 'Não foi possível carregar', e.message, e.auth ? null : () => loadPage(true)); }
  finally { state.loading = false; }
}
function renderDay() {
  const date = state.dates[state.idx];
  const l = date ? dayLabel(date) : { main: '—', sub: '' };
  $('dayMain').textContent = l.main; $('daySub').textContent = l.sub;
  $('prev').disabled = state.idx >= state.dates.length - 1; $('next').disabled = state.idx <= 0;
}
const go = (delta) => { const n = state.idx + delta; if (n < 0 || n >= state.dates.length) return; state.idx = n; renderDay(); loadPage(true); };

// ---- player ----
// The car records one video that tiles its four cameras. The per-clip layout comes from /api/events/id/<id>:
//  standard = 2x2 (front, right / rear, left); dashcam = front on the top 70%, left / rear / right across the bottom 30%.
// These transforms mirror the ones in the car's own player so a tap here crops exactly what the car UI shows.
const ZOOM = {
  standard: { front: ['0% 0%', 'scale(2)'], right: ['100% 0%', 'scale(2)'], rear: ['0% 100%', 'scale(2)'], left: ['100% 100%', 'scale(2)'] },
  dashcam: { front: ['50% 0%', 'scaleY(1.42857)'], left: ['0% 100%', 'scale(3, 3.33333)'], rear: ['50% 100%', 'scale(3, 3.33333)'], right: ['100% 100%', 'scale(3, 3.33333)'] },
};
let curQuad = 'all', curRec = null, curLayout = 'standard', curDurMs = 0;
function applyQuad(q) {
  curQuad = q; document.querySelectorAll('#quads button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  const v = $('video');
  if (q === 'all') { v.style.transform = ''; v.style.transformOrigin = ''; return; }
  const [origin, tf] = ZOOM[curLayout][q];
  v.style.transformOrigin = origin; v.style.transform = tf;
}
// Diagnostic line under the player: what the car answered for this video and what the browser made of it.
const diag = { lines: {} };
const say = (k, v) => { diag.lines[k] = v; $('diag').textContent = Object.entries(diag.lines).map(([a, b]) => `${a}: ${b}`).join('\n'); };
async function probe(rec) {
  const url = rec.videoUrl || `/video/id/${rec.id}`;
  try {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Range: 'bytes=0-1023' } });
    const h = (n) => r.headers.get(n) || '-';
    say('video', `HTTP ${r.status} · ${h('content-type')} · ranges ${h('accept-ranges')} · range ${h('content-range')} · len ${h('content-length')}`);
    try { await r.body?.cancel(); } catch { /* ignore */ }
  } catch (e) { say('video', `falhou: ${e.message}`); }
}
function openPlayer(rec) {
  curRec = rec; const v = $('video');
  $('pTitle').textContent = `${dayTxt(rec)} · ${clock(rec)}`;
  $('pSub').textContent = rec.place?.displayName || rec.place?.short || rec.sizeFormatted || '';
  $('player').hidden = false; document.body.style.overflow = 'hidden';
  curLayout = 'standard'; curDurMs = 0; applyQuad(curQuad); diag.lines = {}; say('clip', `${rec.type} · ${rec.id}`); probe(rec);
  getJson(rec.eventUrl || `/api/events/id/${rec.id}`).then((ev) => { if (curRec !== rec) return; curLayout = ev?.layout === 'dashcam' ? 'dashcam' : 'standard'; curDurMs = ev?.durationMs > 0 ? ev.durationMs : 0; applyQuad(curQuad); say('evento', `layout=${ev?.layout ?? '-'} · durationMs=${ev?.durationMs ?? '-'} · campos: ${Object.keys(ev || {}).join(',').slice(0, 120)}`); }).catch(() => {});
  v.onloadedmetadata = () => { if (v.videoWidth && v.videoHeight) $('vbox').style.setProperty('--ar', `${v.videoWidth}/${v.videoHeight}`); applyQuad(curQuad); };
  v.src = rec.videoUrl || `/video/id/${rec.id}`; v.play().catch(() => {});
}
const ICON_PLAY = 'M8 5v14l11-7z', ICON_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';
const fmtT = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
(() => {
  const v = $('video'), seek = $('seek'); let dragging = false;
  const toggle = () => (v.paused ? v.play().catch(() => {}) : v.pause());
  $('pp').addEventListener('click', toggle); $('vbox').addEventListener('click', toggle);
  v.addEventListener('play', () => $('ppIcon').firstElementChild.setAttribute('d', ICON_PAUSE));
  v.addEventListener('pause', () => $('ppIcon').firstElementChild.setAttribute('d', ICON_PLAY));
  // Clips are still being written or served without a length: fall back to the duration the car reports.
  const dur = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : curDurMs / 1000);
  v.addEventListener('timeupdate', () => { if (!dragging && dur()) seek.value = String(Math.min(1000, Math.round((v.currentTime / dur()) * 1000))); $('time').textContent = `${fmtT(v.currentTime)} / ${fmtT(dur())}`; });
  seek.addEventListener('input', () => { dragging = true; if (dur()) v.currentTime = (seek.value / 1000) * dur(); });
  seek.addEventListener('change', () => { dragging = false; });
  v.addEventListener('error', () => { $('time').textContent = 'vídeo indisponível'; say('erro', `código ${v.error?.code ?? '?'} ${v.error?.message || ''}`); });
  for (const ev of ['loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'abort']) v.addEventListener(ev, () => say('player', `${ev} · ${v.videoWidth}x${v.videoHeight} · dur ${Number.isFinite(v.duration) ? v.duration.toFixed(1) : v.duration}s · ready ${v.readyState} · rede ${v.networkState}`));
})();
function closePlayer() { const v = $('video'); v.pause(); v.removeAttribute('src'); v.load(); $('player').hidden = true; document.body.style.overflow = ''; }

$('prev').addEventListener('click', () => go(1)); $('next').addEventListener('click', () => go(-1));
$('more').addEventListener('click', () => { state.page++; loadPage(false); });
$('pClose').addEventListener('click', closePlayer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('player').hidden) closePlayer(); });
document.querySelectorAll('#quads button').forEach((b) => b.addEventListener('click', () => applyQuad(curQuad === b.dataset.q && b.dataset.q !== 'all' ? 'all' : b.dataset.q)));
document.querySelectorAll('#filters button').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.f; document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b)); loadPage(true); }));
if (TYPE !== 'sentry') $('filters').hidden = true;

(async () => {
  try { await loadDates(); renderDay(); await loadPage(true); }
  catch (e) { setState(e.auth ? 'Sessão expirada' : 'Não foi possível carregar', e.message, e.auth ? null : () => location.reload()); }
})();
