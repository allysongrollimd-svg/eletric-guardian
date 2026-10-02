import http from 'node:http';

// Headers that would make the car's own server think the request came through a third-party tunnel
// (it then demands its own JWT login) or that leak the viewer's identity/session to the car.
const STRIP_REQ = /^(x-forwarded-.*|forwarded|via|x-real-ip|true-client-ip|cf-.*|x-envoy-.*|x-request-id|proxy-.*|keep-alive|te|trailer|upgrade-insecure-requests)$/i;
const STRIP_COOKIES = /^(eg_session|eg_view|eg_ctl)$/;
// The car's own pages carry their app shell (sidebar, header). When one is shown inside our phone screens (an iframe),
// the shell is hidden so there is a single navigation. Detected from the browser's Sec-Fetch-Dest header.
const EMBED_CSS = '<style id="eg-embed">#app-shell-mount,.sidebar,.sidebar-overlay,.mobile-header,.page-header{display:none!important}' +
  '.app-layout{display:block!important}.main-content{margin:0!important;max-width:100%!important;width:100%!important}body{padding:0!important}' +
  // Dashcam OEM (the factory camera) is removed from the product: no tab, no cards
  '[data-tab="oem"],[data-tab-target="oem"],#oemDashcamCard,#oemDashcamMainCard,#oemNativeDvrCard{display:none!important}' +
  // the car pages' own theme button only changes that one page: hidden until there is a global theme
  '#bydThemePicker{display:none!important}' +
  // Sentinela: "Ativar" comes first, before the operating mode (as in the reference app)
  '.card:has(#survEnabled)>.card-body{display:flex;flex-direction:column}.setting-row:has(#survEnabled){order:-1}</style>';
// The factory (OEM) dashcam is not part of the product: it must stay OFF (no dvr_*.mp4 clips, no extra storage, nothing to explain to
// customers). Enforced from the car's recording-settings page whenever it is opened inside our app.
const OEM_FOLLOW_JS = '<script id="eg-oem-sync">(function(){fetch("/api/oem-dashcam/config").then(function(r){return r.json()}).then(function(c){' +
  'if(c&&c.success&&(c.recordingMode!=="off"||c.surveillanceMode!=="off")){fetch("/api/oem-dashcam/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({recordingMode:"off",surveillanceMode:"off"})})}}).catch(function(){})})();</script>';
// Advanced options hidden from customers (the admin sees everything). The car's pages tag every option with the i18n key of
// its label, so rows are hidden by key (CSS :has) instead of by position: a layout change in the car app cannot hide the wrong thing.
const hideRows = (keys) => keys.map((k) => `.setting-row:has([data-i18n="${k}"])`);
const hideCards = (keys) => keys.map((k) => `.card:has([data-i18n="${k}"])`);
const hideSelf = (keys) => keys.map((k) => `[data-i18n^="${k}"]`);
const SURVEILLANCE_HIDE = [
  // Geral: experimental, power tuning
  ...hideRows(['surveillance.di5_cloud_keepalive', 'surveillance.di5_parked_keepalive', 'surveillance.low_power_mode', 'surveillance.low_soc_cutoff']),
  ...hideSelf(['surveillance.di5_cloud_keepalive_requires_cloud']),
  // Detecção: fine tuning (kept: safe locations, preset, sensitivity, detected objects)
  ...hideRows(['surveillance.det_zone', 'surveillance.loitering_time', 'surveillance.approach_trigger', 'surveillance.shadow_filter', 'surveillance.motion_salience',
    'surveillance.discard_empty_motion', 'surveillance.discard_empty_motion_night', 'surveillance.camera_controls', 'surveillance.camera_front', 'surveillance.camera_right', 'surveillance.camera_left', 'surveillance.camera_rear', 'surveillance.sidecam_boost', 'surveillance.sidecam_sens', 'surveillance.sidecam_zone']),
  ...hideSelf(['surveillance.zone_hint', 'surveillance.shadow_hint', 'surveillance.approach_trigger_hint', 'surveillance.discard_empty_motion_hint', 'surveillance.discard_empty_motion_night_hint', 'surveillance.camera_controls_hint']),
  ...hideCards(['surveillance.developer', 'surveillance.detection_zones_title', 'surveillance.deterrent_title', 'surveillance.screen_deterrent_title', 'parking.settings_title']),
  // Dissuasão na tela: custom message/image/themes; Marcação de local: online resolver and custom URL
  'div:has(> [data-i18n="surveillance.screen_deterrent_content_heading"])',
  ...hideRows(['surveillance.geocoding_online_name', 'surveillance.geocoding_custom_url_name']),
  // Gravação: buffers, codec, fps, clip length, windshield camera, telemetry fields
  ...hideRows(['recording.pre_event_buffer', 'recording.post_event_buffer', 'recording.codec', 'surveillance.camera_fps', 'recording.clip_duration', 'recording.layout_use_windshield_label', 'recording.telemetry_fields_label']),
  '.timeline-visual', '.info-row:has([data-i18n="recording.fps_actual"])',
  // Armazenamento: fine tuning of the BYD dashcam cleanup
  ...hideRows(['recording.cdr_reserved', 'recording.cdr_protect_recent', 'recording.cdr_min_keep']),
  '#parking',
];
const RECORDING_HIDE = [
  '[data-tab="status"]', '[data-tab-target="status"]',
  // Captura: windshield camera, proximity-guard fine tuning, online geocoder
  ...hideRows(['recording.layout_use_windshield_label', 'recording.geocoding_online_name', 'recording.geocoding_custom_url_name']),
  ...hideCards(['recording.proximity_settings_title']),
  // Qualidade: frame rate (codec, clip length, cabin audio, telemetry and fisheye stay)
  ...hideRows(['recording.camera_fps']), '#fpsClampRow',
  // Armazenamento: fine tuning of the BYD dashcam cleanup
  ...hideRows(['recording.cdr_reserved', 'recording.cdr_protect_recent', 'recording.cdr_min_keep']),
];
const CUSTOMER_CSS = {
  '/surveillance.html': `<style id="eg-customer">${SURVEILLANCE_HIDE.join(',')}{display:none!important}</style>`,
  '/recording.html': `<style id="eg-customer">${RECORDING_HIDE.join(',')}{display:none!important}</style>`,
};
const STRIP_RES = /^(connection|keep-alive|transfer-encoding|proxy-.*|x-frame-options|content-security-policy)$/i;

function cleanCookie(header) {
  if (!header) return null;
  const kept = header.split(';').map((s) => s.trim()).filter((c) => c && !STRIP_COOKIES.test(c.split('=')[0]));
  return kept.length ? kept.join('; ') : null;
}

const offlinePage = (name) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Carro offline</title>
<body style="font:16px system-ui;background:#0E1013;color:#E4E8EC;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><h2>${name ? name.replace(/[<>&"]/g, '') + ' está offline' : 'Carro offline'}</h2><p style="color:#97A1AB">O carro precisa estar ligado ou com a central ativa e com internet.<br>Tentando reconectar…</p></div>
<script>setTimeout(()=>location.reload(),5000)</script></body>`;

/**
 * Reverse proxy from a viewer's browser to the car's local web server, through the tunnel.
 *  authorize(req) -> { userId, deviceId, name? } | null      (checked on EVERY request / upgrade)
 *  hub.openStream(deviceId) -> TunnelStream | null
 */
export function createViewProxy({ hub, authorize, frameAncestors = null, isAdmin = () => false }) {
  const forwardHeaders = (req, { upgrade }) => {
    const out = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
      const lk = k.toLowerCase();
      if (STRIP_REQ.test(lk)) continue;
      if (lk === 'cookie') { const c = cleanCookie(v); if (c) out[k] = c; continue; }
      if (!upgrade && (lk === 'connection' || lk === 'upgrade')) continue;
      out[k] = v;
    }
    if (!upgrade) out.Connection = 'close';               // the car serves one request per connection
    return out;
  };

  // Local-only routes of the car: never reachable through the cloud (they re-point or disable the cloud link itself).
  const LOCAL_ONLY = /^\/(api\/cloud(\/|$)|cloud(\.html)?(\?|$))/;
  const blocked = (req) => LOCAL_ONLY.test(req.url);

  function handle(req, res) {
    if (blocked(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Disponível apenas no carro.'); }
    const who = authorize(req);
    if (!who) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Sessão expirada. Abra a câmera novamente pelo painel.'); }
    let stream;
    try { stream = hub.openStream(who.deviceId); } catch { res.writeHead(503, { 'Retry-After': '2' }); return res.end('Muitas conexões abertas com este carro.'); }
    if (!stream) { res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' }); return res.end(offlinePage(who.name)); }

    const pathOnly = req.url.split('?')[0];
    const embed = req.method === 'GET' && String(req.headers['sec-fetch-dest'] || '') === 'iframe';   // any page of the car shown inside our screens
    const fh = forwardHeaders(req, { upgrade: false });
    if (embed) fh['accept-encoding'] = 'identity';                 // we rewrite the HTML, so ask the car for it uncompressed
    const upstream = http.request({ createConnection: () => stream, method: req.method, path: req.url, headers: fh }, (pres) => {
      const headers = {};
      for (const [k, v] of Object.entries(pres.headers)) if (!STRIP_RES.test(k)) headers[k] = v;
      headers['x-content-type-options'] = 'nosniff';
      // our own phone screens (same host) and the dashboard may frame the car's pages
      if (frameAncestors) headers['content-security-policy'] = `frame-ancestors 'self' ${frameAncestors}`;
      const isHtml = /text\/html/i.test(String(pres.headers['content-type'] || '')) && !pres.headers['content-encoding'];
      if (embed && pres.statusCode === 200 && isHtml) {
        const chunks = [];
        pres.on('data', (c) => chunks.push(c));
        pres.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          const css = EMBED_CSS + (isAdmin(who.userId) ? '' : (CUSTOMER_CSS[pathOnly] || '')) + (pathOnly === '/recording.html' ? OEM_FOLLOW_JS : '');
          html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${css}</head>`) : css + html;
          delete headers['content-length']; headers['content-length'] = Buffer.byteLength(html);
          res.writeHead(200, pres.statusMessage, headers); res.end(html);
        });
        pres.on('error', () => res.destroy());
        return;
      }
      res.writeHead(pres.statusCode, pres.statusMessage, headers);
      pres.pipe(res);
      pres.on('error', () => res.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('O carro não respondeu.'); } else res.destroy(); });
    res.on('close', () => { upstream.destroy(); stream.destroy(); });      // viewer left: tear the stream down
    req.pipe(upstream);
  }

  function handleUpgrade(req, socket, head) {
    const who = authorize(req);
    if (blocked(req)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    const fail = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!who) return fail(401, 'Unauthorized');
    let stream;
    try { stream = hub.openStream(who.deviceId); } catch { return fail(503, 'Busy'); }
    if (!stream) return fail(503, 'Car offline');
    const h = forwardHeaders(req, { upgrade: true });
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) raw += `${k}: ${v}\r\n`;
    stream.write(raw + '\r\n');
    if (head?.length) stream.write(head);
    socket.pipe(stream); stream.pipe(socket);
    const end = () => { socket.destroy(); stream.destroy(); };
    socket.on('close', end); socket.on('error', end); stream.on('close', end); stream.on('error', end);
  }

  return { handle, handleUpgrade };
}
