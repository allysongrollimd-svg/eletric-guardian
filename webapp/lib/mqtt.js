import mqtt from 'mqtt';
import { normalizeTelemetry, parseTopic } from './telemetry.js';

/** Subscribes to the broker the Android app publishes to and feeds the Store. */
export function startMqtt(cfg, store, log = console) {
  if (!cfg.mqttUrl) return null;
  const client = mqtt.connect(cfg.mqttUrl, {
    username: cfg.mqttUsername,
    password: cfg.mqttPassword,
    reconnectPeriod: 3000,
    clientId: `eg-webapp-${Math.random().toString(16).slice(2, 10)}`,
  });
  const availTopic = `${cfg.mqttTopic}/availability`;
  client.on('connect', () => {
    log.info?.(`[mqtt] connected, subscribing ${cfg.mqttTopic}`);
    client.subscribe([cfg.mqttTopic, availTopic], { qos: 0 });
  });
  client.on('error', (e) => log.error?.('[mqtt] error:', e.message));
  client.on('message', (topic, payload) => {
    const info = parseTopic(topic);
    if (!info) return;
    if (info.kind === 'availability') return store.setAvailability(info.device, payload.toString().trim() === 'online');
    if (payload.length > 256 * 1024) return;
    let json;
    try { json = JSON.parse(payload.toString()); } catch { return; }
    const fields = normalizeTelemetry(json);
    if (fields) store.update(info.device, fields);
  });
  return client;
}
