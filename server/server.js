// Servidor na nuvem do Eletric Guardian: o carro envia o estado (POST) e o
// painel abre no navegador de qualquer lugar, com os dados chegando ao vivo.
// Sem dependências: só Node 18+.
//
//   POST /api/car/<id>            corpo JSON do carro, cabeçalho X-Car-Key
//   GET  /api/car/<id>?k=<chave>  último estado
//   GET  /api/car/<id>/ws?k=      estado ao vivo (WebSocket)
//   GET  /api/car/<id>/stream?k=  estado ao vivo (EventSource, reserva)
//   GET  /car/<id>?k=<chave>      painel (mesmo dashboard.html do app)
//
// A chave é criada pelo próprio carro; o primeiro envio de um id grava a chave
// e daí em diante só quem tem ela envia ou vê os dados.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DASHBOARD = process.env.DASHBOARD_HTML ||
  path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'dashboard.html');
const MAX_BODY = 64 * 1024;
const MAX_CARS = 1000;
const ID_RE = /^[0-9a-f-]{36}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });
const keysFile = path.join(DATA_DIR, 'keys.json');
const lastFile = path.join(DATA_DIR, 'last.json');

const keys = readJson(keysFile); // id -> sha256(chave)
const last = readJson(lastFile); // id -> último JSON recebido (texto)
const listeners = new Map();     // id -> Set de respostas EventSource
const sockets = new Map();       // id -> Set de sockets WebSocket

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(keysFile, JSON.stringify(keys), () => {});
    fs.writeFile(lastFile, JSON.stringify(last), () => {});
  }, 5000);
}

const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

function keyOk(id, key) {
  if (!key || !keys[id]) return false;
  const a = Buffer.from(keys[id], 'hex');
  const b = Buffer.from(hash(key), 'hex');
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

function receive(id, req, res) {
  const key = req.headers['x-car-key'];
  if (!key || String(key).length < 32) return send(res, 401, 'text/plain', 'chave ausente');
  if (!keys[id]) {
    if (Object.keys(keys).length >= MAX_CARS) return send(res, 507, 'text/plain', 'limite de carros');
    keys[id] = hash(key);
  } else if (!keyOk(id, key)) {
    return send(res, 403, 'text/plain', 'chave errada');
  }
  readBody(req, (text) => {
    try { JSON.parse(text); } catch { return send(res, 400, 'text/plain', 'JSON inválido'); }
    last[id] = text;
    saveSoon();
    for (const l of listeners.get(id) || []) l.write(`data: ${text}\n\n`);
    for (const sock of sockets.get(id) || []) wsSend(sock, text);
    send(res, 204, 'text/plain', '');
  });
}

function stream(id, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (last[id]) res.write(`data: ${last[id]}\n\n`);
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    listeners.get(id).delete(res);
  });
}

// WebSocket sem dependências (RFC 6455): o servidor só envia texto; do
// navegador aceita ping e close.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function wsSend(sock, text) {
  if (!sock.destroyed) sock.write(wsFrame(0x1, Buffer.from(text, 'utf8')));
}

function wsUpgrade(req, sock) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2];
  const key = req.headers['sec-websocket-key'];
  if (parts[0] !== 'api' || parts[1] !== 'car' || !ID_RE.test(id || '') || parts[3] !== 'ws' ||
      !key || !keyOk(id, url.searchParams.get('k'))) {
    sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  if (!sockets.has(id)) sockets.set(id, new Set());
  sockets.get(id).add(sock);
  if (last[id]) wsSend(sock, last[id]);

  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_BODY) { sock.destroy(); return; }
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), total);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      buf = buf.subarray(total);
      if (opcode === 0x8) { sock.end(wsFrame(0x8, Buffer.alloc(0))); return; }
      if (opcode === 0x9) sock.write(wsFrame(0xA, payload));
    }
  });
  const ping = setInterval(() => { if (!sock.destroyed) sock.write(wsFrame(0x9, Buffer.alloc(0))); }, 25000);
  const drop = () => { clearInterval(ping); sockets.get(id)?.delete(sock); };
  sock.on('close', drop);
  sock.on('error', drop);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const k = url.searchParams.get('k');

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, 'text/plain; charset=utf-8', 'Eletric Guardian: abra o link do painel que aparece na tela do app no carro.');
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'text/plain', 'ok');

  if (parts[0] === 'api' && parts[1] === 'car' && ID_RE.test(parts[2] || '')) {
    if (req.method === 'POST' && parts.length === 3) return receive(parts[2], req, res);
    if (req.method === 'GET') {
      if (!keyOk(parts[2], k)) return send(res, 403, 'text/plain', 'link inválido');
      if (parts[3] === 'stream') return stream(parts[2], req, res);
      return send(res, 200, 'application/json; charset=utf-8', last[parts[2]] || '{}');
    }
  }
  if (req.method === 'GET' && parts[0] === 'car' && ID_RE.test(parts[1] || '')) {
    if (!keyOk(parts[1], k)) return send(res, 403, 'text/plain; charset=utf-8', 'link inválido');
    return fs.readFile(DASHBOARD, (err, html) =>
      err ? send(res, 500, 'text/plain', 'painel ausente') : send(res, 200, 'text/html; charset=utf-8', html));
  }
  send(res, 404, 'text/plain', 'não encontrado');
});

server.on('upgrade', wsUpgrade);

server.listen(PORT, () => console.log(`Eletric Guardian nuvem na porta ${PORT}`));
