import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

/**
 * Reverse tunnel hub. A car keeps ONE outbound WebSocket to /tunnel; every viewer request becomes a
 * logical stream multiplexed over it, and the car pipes that stream to its own local web server.
 *
 * Wire format (binary WebSocket messages):  [type:u8][streamId:u32 BE][payload]
 *   1 OPEN   server -> car   open a local connection for this stream
 *   2 DATA   both ways       bytes of the stream
 *   3 CLOSE  both ways       stream finished / failed
 *   4 CREDIT server -> car   u32 BE: the car may send that many more bytes on this stream
 * Flow control: the car starts with INITIAL_CREDIT bytes per stream and must wait for CREDIT frames, so a
 * slow viewer (e.g. downloading a recording over a weak link) can never make the server buffer unbounded data.
 */
export const T = { OPEN: 1, DATA: 2, CLOSE: 3, CREDIT: 4 };
export const INITIAL_CREDIT = 256 * 1024;
const MAX_FRAME = 1024 * 1024;
const MAX_STREAMS = 64;
const SEND_SLICE = 64 * 1024;

const frame = (type, id, payload = Buffer.alloc(0)) => {
  const b = Buffer.allocUnsafe(5 + payload.length);
  b[0] = type; b.writeUInt32BE(id, 1); payload.copy(b, 5);
  return b;
};

/** A socket-shaped Duplex backed by one tunnel stream, usable as http.request({createConnection}). */
class TunnelStream extends Duplex {
  constructor(session, id) {
    super({ allowHalfOpen: true, highWaterMark: 64 * 1024 });
    this.session = session; this.id = id; this.unacked = 0; this.closedByPeer = false;
  }
  // net.Socket shims (http client / proxies call these)
  setTimeout() { return this; } setNoDelay() { return this; } setKeepAlive() { return this; } ref() { return this; } unref() { return this; }
  get remoteAddress() { return `tunnel:${this.session.deviceId}`; }
  _read() { this.grant(); }
  grant() { if (this.unacked > 0 && !this.destroyed) { const p = Buffer.alloc(4); p.writeUInt32BE(this.unacked); this.session.send(frame(T.CREDIT, this.id, p)); this.unacked = 0; } }
  onData(buf) { this.unacked += buf.length; this.push(buf); if (this.readableLength <= this.readableHighWaterMark / 2) this.grant(); }
  onClose() { this.closedByPeer = true; this.push(null); if (this.writableEnded || this.destroyed) this.destroy(); else this.end(); }
  _write(chunk, _enc, cb) {
    const parts = [];
    for (let o = 0; o < chunk.length; o += SEND_SLICE) parts.push(chunk.subarray(o, o + SEND_SLICE));
    const next = (i) => { if (i >= parts.length) return cb(); this.session.send(frame(T.DATA, this.id, parts[i]), (e) => (e ? cb(e) : next(i + 1))); };
    if (this.session.closed) return cb(new Error('tunnel closed'));
    next(0);
  }
  _final(cb) { cb(); }
  _destroy(err, cb) {
    if (!this.closedByPeer && !this.session.closed) this.session.send(frame(T.CLOSE, this.id));
    this.session.streams.delete(this.id);
    cb(err);
  }
}

class Session {
  constructor(ws, deviceId) {
    this.ws = ws; this.deviceId = deviceId; this.streams = new Map(); this.nextId = 1; this.closed = false; this.connectedAt = Date.now();
    this.bytesIn = 0; this.bytesOut = 0;
  }
  send(buf, cb) {
    if (this.ws.readyState !== 1) return cb?.(new Error('tunnel closed'));
    this.bytesOut += buf.length; this.ws.send(buf, { binary: true }, cb);
  }
  open() {
    if (this.closed) return null;
    if (this.streams.size >= MAX_STREAMS) throw Object.assign(new Error('too many open streams'), { code: 'EBUSY' });
    const id = this.nextId; this.nextId = this.nextId >= 0xfffffff0 ? 1 : this.nextId + 1;
    const s = new TunnelStream(this, id);
    this.streams.set(id, s);
    this.send(frame(T.OPEN, id));
    return s;
  }
  onMessage(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 5 || raw.length > MAX_FRAME + 5) return;
    this.bytesIn += raw.length;
    const type = raw[0], id = raw.readUInt32BE(1), payload = raw.subarray(5);
    const s = this.streams.get(id);
    if (type === T.DATA) { if (s) s.onData(Buffer.from(payload)); else this.send(frame(T.CLOSE, id)); }
    else if (type === T.CLOSE) { if (s) s.onClose(); }
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const s of [...this.streams.values()]) { s.closedByPeer = true; s.destroy(new Error('tunnel closed')); }
    this.streams.clear();
  }
}

/** Accepts authenticated cars on /tunnel and hands out streams to the view proxy. */
export function createTunnelHub({ accounts, log = console } = {}) {
  const hub = new EventEmitter();
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME + 5 });

  hub.isConnected = (deviceId) => sessions.has(deviceId);
  hub.stats = (deviceId) => { const s = sessions.get(deviceId); return s ? { since: s.connectedAt, streams: s.streams.size, bytesIn: s.bytesIn, bytesOut: s.bytesOut } : null; };
  hub.openStream = (deviceId) => sessions.get(deviceId)?.open() ?? null;

  /** Returns the authenticated claimed device for an upgrade request, or null. */
  function authenticate(req) {
    const m = /^Bearer ([a-f0-9-]{32,40})\.(.{32,200})$/i.exec(req.headers.authorization || '');
    const d = m && accounts.deviceAuth(m[1], m[2]);
    return d && d.owner_id ? d : null;
  }

  hub.handleUpgrade = (req, socket, head) => {
    const d = authenticate(req);
    if (!d) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sessions.get(d.id)?.ws.close(4000, 'replaced');           // one tunnel per car: the newest wins
      const session = new Session(ws, d.id);
      sessions.set(d.id, session);
      accounts.touch(d.id);
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('message', (data, isBinary) => isBinary && session.onMessage(Buffer.isBuffer(data) ? data : Buffer.concat(data)));
      const gone = () => { session.close(); if (sessions.get(d.id) === session) { sessions.delete(d.id); hub.emit('disconnected', d.id); } };
      ws.on('close', gone); ws.on('error', gone);
      hub.emit('connected', d.id);
      log.info?.(`[tunnel] car ${d.id} connected`);
    });
  };

  const beat = setInterval(() => {
    for (const s of sessions.values()) {
      if (!s.ws.alive) { s.ws.terminate(); continue; }
      s.ws.alive = false; s.ws.ping();
      accounts.touch(s.deviceId);
    }
  }, 25_000);
  beat.unref();
  hub.shutdown = () => { clearInterval(beat); for (const s of sessions.values()) s.ws.terminate(); wss.close(); };
  return hub;
}
