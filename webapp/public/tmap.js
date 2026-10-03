// Small dark tile map (no library): shows where the car is, with zoom buttons and drag. Tiles come from a configurable
// template (MAP_TILES on the server); the default is a dark basemap that matches the app.
const TS = 256;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toPx = (lat, lon, z) => { const s = TS * 2 ** z, x = ((lon + 180) / 360) * s, r = (clamp(lat, -85, 85) * Math.PI) / 180; return [x, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s]; };
const toLL = (x, y, z) => { const s = TS * 2 ** z, n = Math.PI - (2 * Math.PI * y) / s; return [(180 / Math.PI) * Math.atan(Math.sinh(n)), (x / s) * 360 - 180]; };

export function createMap(root, template) {
  root.classList.add('tmap');
  const layer = document.createElement('div'); layer.className = 'tm-tiles';
  const pin = document.createElement('div'); pin.className = 'tm-pin'; pin.innerHTML = '<i></i><b></b>';
  const ctl = document.createElement('div'); ctl.className = 'tm-ctl';
  const mk = (t, label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.setAttribute('aria-label', label); b.addEventListener('click', fn); ctl.append(b); return b; };
  const att = document.createElement('div'); att.className = 'tm-att'; att.textContent = /mapbox\.com/.test(template) ? '© Mapbox · © OpenStreetMap' : '© OpenStreetMap · © CARTO';
  root.append(layer, pin, ctl, att);

  let z = 16, car = null, center = null, drag = null;
  const size = () => ({ w: root.clientWidth || 300, h: root.clientHeight || 240 });
  function draw() {
    if (!center) return;
    const { w, h } = size(), [cx, cy] = toPx(center[0], center[1], z);
    const x0 = cx - w / 2, y0 = cy - h / 2, n = 2 ** z;
    layer.replaceChildren();
    for (let tx = Math.floor(x0 / TS); tx <= Math.floor((x0 + w) / TS); tx++) for (let ty = Math.floor(y0 / TS); ty <= Math.floor((y0 + h) / TS); ty++) {
      if (ty < 0 || ty >= n) continue;
      const img = new Image(); img.alt = ''; img.draggable = false; img.decoding = 'async';
      img.src = template.replace('{s}', 'abcd'[(tx + ty) & 3]).replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
      img.onerror = () => img.remove(); img.style.cssText = `left:${Math.round(tx * TS - x0)}px;top:${Math.round(ty * TS - y0)}px`;
      layer.append(img);
    }
    if (car) { const [px, py] = toPx(car[0], car[1], z); pin.style.left = `${px - x0}px`; pin.style.top = `${py - y0}px`; pin.hidden = false; } else pin.hidden = true;
  }
  const zoom = (d) => { z = clamp(z + d, 3, 19); draw(); };
  mk('+', 'Aproximar', () => zoom(1)); mk('−', 'Afastar', () => zoom(-1));
  mk('◎', 'Centralizar no carro', () => { if (car) { center = car.slice(); draw(); } });
  root.addEventListener('pointerdown', (e) => { if (e.target.closest('.tm-ctl')) return; drag = { x: e.clientX, y: e.clientY, c: toPx(center[0], center[1], z) }; root.setPointerCapture(e.pointerId); });
  root.addEventListener('pointermove', (e) => { if (!drag) return; center = toLL(drag.c[0] - (e.clientX - drag.x), drag.c[1] - (e.clientY - drag.y), z); draw(); });
  const end = () => { drag = null; };
  root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
  if ('ResizeObserver' in window) new ResizeObserver(draw).observe(root);

  return {
    /** Car moved: keep the pin on it; follow it unless the user is looking elsewhere. */
    set(lat, lon) {
      const first = !car, prev = car; car = [lat, lon]; if (first || !center) center = car.slice();
      if (!first) { const a = toPx(prev[0], prev[1], z), b = toPx(lat, lon, z); if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 2) return; }   // parked: nothing to redraw
      draw();
    },
    reset() { car = null; center = null; layer.replaceChildren(); },
    redraw: draw,
  };
}
