import mqtt from 'mqtt';
import { normalizeTelemetry, normalizeField, parseTopic } from './telemetry.js';

/**
 * Subscribes to the broker the Android app publishes to and feeds the Store.
 * Returns { client, publishCommand, connected } (or null when MQTT_URL is not set).
 *
 * The app has two telemetry modes and both are understood:
 *  - aggregate JSON on <base>                       (Home Assistant mode OFF)
 *  - one retained topic per field <base>/<key>      (Home Assistant mode ON — required for control)
 * Commands go to <base>/<key>[/<sub>]/set (never retained: the app drops retained commands).
 */
export function startMqtt(cfg, store, log = console) {
  if (!cfg.mqttUrl) return null;
  const client = mqtt.connect(cfg.mqttUrl, {
    username: cfg.mqttUsername,
    password: cfg.mqttPassword,
    reconnectPeriod: 3000,
    clientId: `eg-webapp-${Math.random().toString(16).slice(2, 10)}`,
  });
  client.on('connect', () => {
    log.info?.(`[mqtt] connected, subscribing ${cfg.mqttTopic} (+/availability, +/<field>)`);
    client.subscribe([cfg.mqttTopic, `${cfg.mqttTopic}/availability`, `${cfg.mqttTopic}/+`], { qos: 0 });
  });
  client.on('error', (e) => log.error?.('[mqtt] error:', e.message));
  client.on('message', (topic, payload) => {
    const info = parseTopic(topic);
    if (!info || payload.length > 256 * 1024) return;
    if (info.kind === 'availability') return store.setAvailability(info.device, payload.toString().trim() === 'online');
    if (info.kind === 'field') {
      const v = normalizeField(info.key, payload.toString());
      if (v !== undefined) store.update(info.device, { [info.key]: v });
      return;
    }
    let json;
    try { json = JSON.parse(payload.toString()); } catch { return; }
    const fields = normalizeTelemetry(json);
    if (fields) store.update(info.device, fields);
  });

  const commandBase = (device) => (cfg.mqttTopic.includes('+') ? cfg.mqttTopic.replace('+', device) : cfg.mqttTopic);
  return {
    client,
    connected: () => client.connected,
    /** Publishes one command (QoS 1, NOT retained). Resolves once the broker acknowledged it. */
    publishCommand(device, key, sub, payload) {
      const topic = `${commandBase(device)}/${key}${sub ? `/${sub}` : ''}/set`;
      return new Promise((resolve, reject) => {
        if (!client.connected) return reject(new Error('broker offline'));
        client.publish(topic, String(payload), { qos: 1, retain: false }, (err) => (err ? reject(err) : resolve(topic)));
      });
    },
  };
}
