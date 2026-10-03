import net from 'node:net';
import tls from 'node:tls';
import { Aedes } from 'aedes';
import { createWebSocketStream } from 'ws';
import { createLimiter } from './auth.js';
import { normalizeTelemetry, normalizeField, parseTopic } from './telemetry.js';

const PREFIX = 'electric-guardian';

/**
 * Embedded MQTT broker for the cars. A car authenticates with its pairing credentials
 * (username = deviceId, password = deviceKey) and is confined to `electric-guardian/<deviceId>/…`:
 *   publish   <base>, <base>/availability, <base>/<field>          (telemetry; nothing else)
 *   subscribe <base>/+/set, <base>/+/+/set, <base>/automation/+     (commands the app understands)
 * where <base> = electric-guardian/<deviceId>/telemetry. Telemetry is fed straight into the Store.
 * Nothing is retained by the broker (memory stays flat); the Store keeps the latest state.
 */
export async function createBroker({ accounts, store, log = console } = {}) {
  const aedes = await Aedes.createBroker({ maxClientsIdLength: 128, drainTimeout: 30_000, maxTopicLevels: 12, connectTimeout: 15_000 });
  const online = new Map();                       // deviceId -> number of live MQTT connections
  const authFail = createLimiter(20, 60_000);     // failed logins per remote address per minute
  const stats = new Map();                        // deviceId -> { connects, msgs, rejected, lastRejected, lastTopic, lastAt }
  const st = (id) => { let s = stats.get(id); if (!s) stats.set(id, s = { connects: 0, msgs: 0, rejected: 0, lastRejected: null, lastTopic: null, lastAt: null }); return s; };
  const ipOf = (c) => c?.conn?.remoteAddress ?? c?.req?.socket?.remoteAddress ?? '?';

  aedes.authenticate = (client, username, password, cb) => {
    const ip = ipOf(client);
    const d = accounts.deviceAuth(String(username ?? ''), password?.toString());
    if (!d || !d.owner_id) {
      if (!authFail(ip)) log.warn?.(`[broker] auth flood from ${ip}`);
      log.info?.(`[broker] login refused for ${String(username ?? '').slice(0, 8)}… (unknown car, wrong key or not linked yet)`);
      const e = new Error('not authorized'); e.returnCode = 4; return cb(e, false);
    }
    client.deviceId = d.id;
    cb(null, true);
  };

  aedes.authorizePublish = (client, packet, cb) => {
    if (!client) return cb(null);                                   // broker-originated (LWT)
    const id = client.deviceId, t = packet.topic;
    packet.retain = false;                                          // never store anything in the broker
    if (t === 'homeassistant' || t.startsWith('homeassistant/')) return cb(null);   // HA discovery: accepted and ignored (no one can subscribe)
    const base = `${PREFIX}/${id}/telemetry`;
    if ((t === base || t.startsWith(`${base}/`)) && !t.endsWith('/set')) return cb(null);
    const s = st(id); s.rejected++; s.lastRejected = String(t).slice(0, 120);
    if (s.rejected <= 3) log.warn?.(`[broker] ${id.slice(0, 8)}… tried to publish a forbidden topic: ${s.lastRejected}`);
    cb(new Error('forbidden topic'));
  };

  aedes.authorizeSubscribe = (client, sub, cb) => {
    const base = `${PREFIX}/${client.deviceId}/telemetry`, t = sub.topic;
    const ok = t === `${base}/+/set` || t === `${base}/+/+/set` || t === `${base}/automation/+` || t === 'homeassistant/status';
    cb(null, ok ? sub : null);                                      // null = denied for this topic only (SUBACK failure), connection stays up
  };

  aedes.on('clientReady', (c) => { if (c.deviceId) { st(c.deviceId).connects++; log.info?.(`[broker] car ${c.deviceId.slice(0, 8)}… connected`); online.set(c.deviceId, (online.get(c.deviceId) || 0) + 1); accounts.touch(c.deviceId); } });
  aedes.on('clientDisconnect', (c) => {
    if (!c.deviceId) return;
    const n = (online.get(c.deviceId) || 1) - 1;
    if (n <= 0) { online.delete(c.deviceId); store.setAvailability(c.deviceId, false); } else online.set(c.deviceId, n);
  });

  aedes.on('publish', (packet, client) => {
    if (!client?.deviceId) return;
    const info = parseTopic(packet.topic);
    if (!info || info.device !== client.deviceId) return;
    const s = st(info.device); s.msgs++; s.lastTopic = String(packet.topic).slice(0, 120); s.lastAt = Date.now();
    const text = packet.payload.toString();
    if (info.kind === 'availability') return store.setAvailability(info.device, text.trim() === 'online');
    if (info.kind === 'field') {
      const v = normalizeField(info.key, text);
      if (v === undefined) return;
      if (info.key === 'vin' && typeof v === 'string') accounts.touch(info.device, { vin: v });
      return store.update(info.device, { [info.key]: v });
    }
    let json; try { json = JSON.parse(text); } catch { return; }
    const fields = normalizeTelemetry(json);
    if (!fields) return;
    if (typeof fields.vin === 'string') accounts.touch(info.device, { vin: fields.vin });
    store.update(info.device, fields);
  });

  const servers = [];
  return {
    aedes,
    connected: (deviceId) => online.has(deviceId),
    stats: (deviceId) => ({ ...(stats.get(deviceId) || { connects: 0, msgs: 0, rejected: 0, lastRejected: null, lastTopic: null, lastAt: null }) }),
    /** Hands a plain TCP/TLS socket (or any duplex) to the broker. */
    handle: (stream) => aedes.handle(stream),
    /** MQTT over WebSocket, mounted by the HTTP server on /mqtt (lets the car use wss://host/mqtt through the TLS proxy). */
    handleWs: (ws) => { const s = createWebSocketStream(ws); s.remoteAddress = ws._socket?.remoteAddress; aedes.handle(s, { socket: ws._socket }); },
    listen({ port, host = '0.0.0.0', tlsOptions }) {
      const srv = tlsOptions ? tls.createServer(tlsOptions, aedes.handle) : net.createServer(aedes.handle);
      servers.push(srv);
      return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, host, () => resolve(srv.address().port)); });
    },
    /** Delivers a vehicle command to the car (QoS 1, never retained). */
    publishCommand(deviceId, key, sub, payload) {
      return new Promise((resolve, reject) => {
        if (!online.has(deviceId)) return reject(new Error('car not connected to the broker'));
        const topic = `${PREFIX}/${deviceId}/telemetry/${key}${sub ? `/${sub}` : ''}/set`;
        aedes.publish({ cmd: 'publish', topic, payload: Buffer.from(String(payload)), qos: 1, retain: false, dup: false }, (err) => (err ? reject(err) : resolve(topic)));
      });
    },
    close() {
      servers.forEach((s) => s.close());
      return new Promise((r) => aedes.close(r));
    },
  };
}
