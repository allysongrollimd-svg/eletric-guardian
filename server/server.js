// Servidor na nuvem do Eletric Guardian: o carro envia o estado (POST) e o
// painel abre no navegador de qualquer lugar, com os dados chegando ao vivo.
// Sem dependências: só Node 18+.
//
//   POST /api/car/<id>            corpo JSON do carro, cabeçalho X-Car-Key
//   GET  /api/car/<id>?k=<chave>  último estado
//   GET  /api/car/<id>/stream?k=  estado ao vivo (EventSource)
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

server.listen(PORT, () => console.log(`Eletric Guardian nuvem na porta ${PORT}`));
