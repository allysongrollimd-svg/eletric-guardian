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
    // --- multi-tenant "accounts" mode (the sellable service) ---
    accounts: env.AUTH_MODE === 'accounts',
    dataDir: env.DATA_DIR || './data',
    sessionSecret: env.SESSION_SECRET || '',
    allowSignup: env.ALLOW_SIGNUP === '1',
    appHost: (env.APP_HOST || '').toLowerCase(),          // e.g. app.example.com  (the dashboard)
    viewHost: (env.VIEW_HOST || '').toLowerCase(),        // e.g. view.example.com (car cameras/recordings; must be a subdomain of APP_HOST's domain)
    publicScheme: env.PUBLIC_SCHEME || (env.NODE_ENV === 'production' ? 'https' : 'http'),
    trustProxy: env.TRUST_PROXY === '1',
    // Strict is right when VIEW_HOST is a subdomain of APP_HOST's domain (same site). 'None' (+Secure) only for demos on unrelated hosts.
    mapTiles: /^pk\.[A-Za-z0-9._-]{20,}$/.test(env.MAPBOX_TOKEN || '')
      ? `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}@2x?access_token=${env.MAPBOX_TOKEN}`
      : /^https:\/\/[^\s]*\{z\}[^\s]*\{x\}[^\s]*\{y\}/.test(env.MAP_TILES || '') ? env.MAP_TILES : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    viewCookieSameSite: ['Strict', 'Lax', 'None'].includes(env.VIEW_COOKIE_SAMESITE) ? env.VIEW_COOKIE_SAMESITE : 'Strict',
    brokerPort: int(env.BROKER_PORT, 0),                  // plain MQTT (dev / private network); 0 = off
    brokerTlsPort: int(env.BROKER_TLS_PORT, 0),           // MQTT over TLS (needs TLS_CERT + TLS_KEY); 0 = off
    tlsCert: env.TLS_CERT || '',
    tlsKey: env.TLS_KEY || '',
    mqttPublic: env.MQTT_PUBLIC_URL ? { url: env.MQTT_PUBLIC_URL } : null,   // what cars are told to connect to
    controlEnabled: env.CONTROL_ENABLED === '1',
    controlPin: env.CONTROL_PIN || '',
    controlUnlockSeconds: int(env.CONTROL_UNLOCK_SECONDS, 600),
  };
}

/** Returns a list of fatal config problems (empty when OK). */
export function validateConfig(cfg) {
  const problems = [];
  if (cfg.accounts) {
    if (cfg.sessionSecret && cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET must have at least 32 characters (or leave it empty to auto-generate one in DATA_DIR).');
    if (cfg.viewHost && cfg.viewHost === cfg.appHost) problems.push('VIEW_HOST must differ from APP_HOST.');
    if (cfg.viewHost && !cfg.appHost) problems.push('APP_HOST is required when VIEW_HOST is set (used for frame-ancestors).');
    if (cfg.brokerTlsPort && (!cfg.tlsCert || !cfg.tlsKey)) problems.push('BROKER_TLS_PORT needs TLS_CERT and TLS_KEY.');
    if (cfg.publicScheme === 'https' && !cfg.trustProxy && !cfg.tlsCert) { /* fine: assume a TLS-terminating proxy */ }
    return problems;                                      // none of the single-owner rules below apply
  }
  if (!cfg.allowInsecure) {
    if (!cfg.dashboardToken) problems.push('DASHBOARD_TOKEN is required (telemetry includes GPS position). Set ALLOW_INSECURE=1 only for local testing.');
    if (!cfg.ingestToken && !cfg.mqttUrl && !cfg.demo) problems.push('Set MQTT_URL and/or INGEST_TOKEN so telemetry can reach the server.');
  }
  if (cfg.controlEnabled) {
    if (!cfg.mqttUrl) problems.push('CONTROL_ENABLED=1 needs MQTT_URL: commands are delivered to the car through the MQTT broker.');
    if (cfg.controlPin.length < 6) problems.push('CONTROL_PIN must have at least 6 characters when CONTROL_ENABLED=1.');
    if (cfg.controlPin && cfg.controlPin === cfg.dashboardToken) problems.push('CONTROL_PIN must differ from DASHBOARD_TOKEN.');
  }
  return problems;
}
