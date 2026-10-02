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
function pump() {
  while (active < 4 && queue.length) {
    const { img, url } = queue.shift(); active++;
    const done = () => { active--; pump(); };
    img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true });
    img.src = url;
  }
}
const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); loadThumb(e.target, e.target.dataset.src); } }), { rootMargin: '200px' }) : null;

function clipRow(rec) {
  const b = el('button', 'clip'); b.type = 'button';
  const th = el('div', 'th'); const img = el('img'); img.alt = ''; img.decoding = 'async'; img.dataset.src = rec.thumbnailUrl || `/thumb/id/${rec.id}`;
  th.append(img); if (io) io.observe(img); else loadThumb(img, img.dataset.src);
  const m = el('div', 'meta'); m.append(el('b', null, rec.timeFormatted || rec.time || ''));
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
// The car records a mosaic of its four cameras in one video; "front/right/rear/left" crop and zoom into one quadrant.
const LAYOUT_2X2 = { front: [0, 0, .5, .5], right: [.5, 0, .5, .5], rear: [0, .5, .5, .5], left: [.5, .5, .5, .5] };
const LAYOUT_DASH = { front: [0, 0, 1, .7], left: [0, .7, 1 / 3, .3], rear: [1 / 3, .7, 1 / 3, .3], right: [2 / 3, .7, 1 / 3, .3] };
let curQuad = 'all', curRec = null;
function applyQuad(q) {
  curQuad = q; document.querySelectorAll('#quads button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  const v = $('video'), box = $('vbox');
  if (q === 'all') { v.style.transform = ''; return; }
  const [x, y, w, h] = (curRec?.type === 'sentry' ? LAYOUT_2X2 : LAYOUT_DASH)[q];
  const S = Math.min(1 / w, 1 / h), W = box.clientWidth, H = box.clientHeight;
  v.style.transform = `translate(${-((x + w / 2) * S - .5) * W}px, ${-((y + h / 2) * S - .5) * H}px) scale(${S})`;
}
function openPlayer(rec) {
  curRec = rec; const v = $('video');
  $('pTitle').textContent = `${rec.dateFormatted || rec.date} · ${rec.timeFormatted || rec.time}`;
  $('pSub').textContent = rec.place?.displayName || rec.place?.short || rec.sizeFormatted || '';
  $('player').hidden = false; document.body.style.overflow = 'hidden';
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
  v.addEventListener('timeupdate', () => { if (!dragging && v.duration) seek.value = String(Math.round((v.currentTime / v.duration) * 1000)); $('time').textContent = `${fmtT(v.currentTime)} / ${fmtT(v.duration)}`; });
  seek.addEventListener('input', () => { dragging = true; if (v.duration) v.currentTime = (seek.value / 1000) * v.duration; });
  seek.addEventListener('change', () => { dragging = false; });
  v.addEventListener('error', () => { $('time').textContent = 'vídeo indisponível'; });
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
