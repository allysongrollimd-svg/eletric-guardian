// All runtime configuration comes from environment variables (see .env.example).
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    dashboardToken: env.DASHBOARD_TOKEN || '',
    ingestToken: env.INGEST_TOKEN || '',
    allowInsecure: env.ALLOW_INSECURE === '1',
    mqttUrl: env.MQTT_URL || '',
    mqttUsername: env.MQTT_USERNAME || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    // The app publishes to <topic> (aggregate JSON) and <topic parent>/availability.
    // Default pattern: electric-guardian/<device>/telemetry
    mqttTopic: env.MQTT_TOPIC || 'electric-guardian/+/telemetry',
    offlineAfterSeconds: int(env.OFFLINE_AFTER_SECONDS, 90),
    historyMax: int(env.HISTORY_MAX_POINTS, 4000),
    historyMinGapMs: int(env.HISTORY_MIN_GAP_MS, 2000),
    demo: env.DEMO === '1',
  };
}

/** Returns a list of fatal config problems (empty when OK). */
export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.allowInsecure) {
    if (!cfg.dashboardToken) problems.push('DASHBOARD_TOKEN is required (telemetry includes GPS position). Set ALLOW_INSECURE=1 only for local testing.');
    if (!cfg.ingestToken && !cfg.mqttUrl && !cfg.demo) problems.push('Set MQTT_URL and/or INGEST_TOKEN so telemetry can reach the server.');
  }
  return problems;
}
