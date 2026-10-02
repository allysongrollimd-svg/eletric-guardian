import http from 'node:http';

// Headers that would make the car's own server think the request came through a third-party tunnel
// (it then demands its own JWT login) or that leak the viewer's identity/session to the car.
const STRIP_REQ = /^(x-forwarded-.*|forwarded|via|x-real-ip|true-client-ip|cf-.*|x-envoy-.*|x-request-id|proxy-.*|keep-alive|te|trailer|upgrade-insecure-requests)$/i;
const STRIP_COOKIES = /^(eg_session|eg_view|eg_ctl)$/;
// The car's own pages carry their app shell (sidebar, header). When one is shown inside our phone screens (an iframe),
// the shell is hidden so there is a single navigation. Detected from the browser's Sec-Fetch-Dest header.
const EMBED_CSS = '<style id="eg-embed">#app-shell-mount,.sidebar,.sidebar-overlay,.mobile-header,.page-header{display:none!important}' +
  '.app-layout{display:block!important}.main-content{margin:0!important;max-width:100%!important;width:100%!important}body{padding:0!important}</style>';
// Advanced blocks hidden from customers (the admin sees everything). The car's pages tag every block with data-tab.
const CUSTOMER_CSS = {
  '/surveillance.html': '<style id="eg-customer">[data-tab="detection"],[data-tab="oem"],#parking{display:none!important}</style>',
  '/recording.html': '<style id="eg-customer">[data-tab="status"]{display:none!important}</style>',
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
          const css = EMBED_CSS + (isAdmin(who.userId) ? '' : (CUSTOMER_CSS[pathOnly] || ''));
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
