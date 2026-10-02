package com.overdrive.app.cloud;

import com.overdrive.app.byd.BydDataCollector;
import com.overdrive.app.byd.BydVehicleData;
import com.overdrive.app.daemon.CameraDaemon;
import com.overdrive.app.logging.DaemonLogger;
import com.overdrive.app.mqtt.MqttConnectionConfig;
import com.overdrive.app.mqtt.MqttConnectionManager;
import com.overdrive.app.mqtt.ProxyHelper;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Electric Guardian cloud link: pairs this car with an account (by the code shown on screen and the
 * chassis), then keeps (1) an MQTT connection for telemetry/control and (2) the reverse tunnel for
 * the cameras. Runs inside the camera daemon, next to the web server it exposes, and reaches the
 * internet through the same proxy-aware path as the rest of the app.
 */
public final class CloudClient {
    private static final DaemonLogger LOG = DaemonLogger.getInstance("EgCloud");
    private static final CloudClient INSTANCE = new CloudClient();
    private static final String MQTT_NAME = "Electric Guardian Cloud";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .proxySelector(ProxyHelper.chainProxySelector())
            .build();
    /** WebSocket client: no read timeout (the stream is long-lived) and protocol-level pings keep NATs open. */
    private final OkHttpClient wsHttp = http.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build();

    private final Object wake = new Object();
    private Thread thread;
    private CloudTunnel tunnel;

    private volatile String state = "disabled";          // disabled | registering | pending | claimed | error
    private volatile String code = "";
    private volatile long codeExpiresAt;
    private volatile String claimedName = "";
    private volatile boolean tunnelUp;
    private volatile String lastError = "";
    private volatile boolean registered;
    private long tunnelStartedAt;
    private long reconnectNotBefore;

    private CloudClient() {}

    public static CloudClient getInstance() {
        return INSTANCE;
    }

    public synchronized void start() {
        if (thread != null) return;
        thread = new Thread(this::loop, "EgCloud");
        thread.setDaemon(true);
        thread.start();
        LOG.info("cloud client armed");
    }

    void wakeUp() {
        synchronized (wake) {
            wake.notifyAll();
        }
    }

    private void sleep(long ms) throws InterruptedException {
        synchronized (wake) {
            wake.wait(ms);
        }
    }

    private void loop() {
        long backoff = 3000;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                step();
                backoff = 3000;
            } catch (InterruptedException e) {
                return;
            } catch (Throwable t) {
                lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
                LOG.warn("cloud step failed: " + lastError);
                try {
                    sleep(backoff);
                } catch (InterruptedException e) {
                    return;
                }
                backoff = Math.min(backoff * 2, 60000);
            }
        }
    }

    private void step() throws Exception {
        CloudConfig cfg = CloudConfig.load();
        if (!cfg.enabled || cfg.serverUrl.isEmpty()) {
            state = "disabled";
            stopTunnel();
            sleep(3000);
            return;
        }
        if (!cfg.ensureIdentity()) throw new IllegalStateException("could not persist device identity");

        JSONObject st = registered ? status(cfg) : register(cfg);
        if (st == null) {                       // 401: the server does not know us (yet): register again
            registered = false;
            st = register(cfg);
        }
        registered = true;
        lastError = "";
        state = st.optString("state", "error");

        if ("pending".equals(state)) {
            code = st.optString("code", "");
            codeExpiresAt = st.optLong("expiresAt", 0);
            stopTunnel();
            sleep(4000);
            return;
        }
        if ("claimed".equals(state)) {
            code = "";
            claimedName = st.optString("name", "");
            provisionMqtt(cfg, st.optJSONObject("mqtt"));
            ensureTunnel(cfg);
            sleep(tunnelUp ? 15000 : 3000);
            return;
        }
        throw new IllegalStateException("unexpected pairing state: " + state);
    }

    // ---------------------------------------------------------------- HTTP to the server

    private JSONObject register(CloudConfig cfg) throws Exception {
        JSONObject body = new JSONObject();
        body.put("deviceId", cfg.deviceId);
        body.put("deviceKey", cfg.deviceKey);
        String vin = currentVin();
        if (vin != null) body.put("vin", vin);
        body.put("appVersion", com.overdrive.app.BuildConfig.VERSION_NAME);
        Request req = new Request.Builder().url(cfg.serverUrl + "/api/device/register")
                .post(RequestBody.create(body.toString(), JSON)).build();
        try (Response r = http.newCall(req).execute()) {
            String text = r.body() == null ? "" : r.body().string();
            if (!r.isSuccessful()) throw new IllegalStateException("register HTTP " + r.code() + " " + abbreviate(text));
            return new JSONObject(text);
        }
    }

    /** @return the pairing state, or null when the server answered 401 (unknown device). */
    private JSONObject status(CloudConfig cfg) throws Exception {
        Request req = new Request.Builder().url(cfg.serverUrl + "/api/device/status")
                .header("Authorization", "Bearer " + cfg.bearer()).build();
        try (Response r = http.newCall(req).execute()) {
            String text = r.body() == null ? "" : r.body().string();
            if (r.code() == 401) return null;
            if (!r.isSuccessful()) throw new IllegalStateException("status HTTP " + r.code());
            return new JSONObject(text);
        }
    }

    private static String abbreviate(String s) {
        return s == null ? "" : (s.length() > 120 ? s.substring(0, 120) : s);
    }

    // ---------------------------------------------------------------- vehicle identity

    private static String currentVin() {
        try {
            BydVehicleData d = BydDataCollector.getInstance().getData();
            if (d != null && d.vin != null && d.vin.trim().length() == 17) return d.vin.trim().toUpperCase();
        } catch (Throwable ignored) {
            // VIN not available yet
        }
        return null;
    }

    // ---------------------------------------------------------------- MQTT (telemetry + control)

    /** Creates / keeps up to date the MQTT connection that feeds the cloud dashboard. */
    private void provisionMqtt(CloudConfig cfg, JSONObject mqttHint) {
        try {
            MqttConnectionManager mgr = CameraDaemon.getMqttConnectionManager();
            if (mgr == null) return;                                     // retried on the next step
            String url = mqttHint != null ? mqttHint.optString("url", "") : "";
            if (url.isEmpty()) url = cfg.wsUrl("/mqtt");
            url = withExplicitPort(url);
            String topic = "electric-guardian/" + cfg.deviceId + "/telemetry";

            MqttConnectionConfig existing = null;
            for (MqttConnectionConfig c : mgr.getStore().getAll()) {
                if (MQTT_NAME.equals(c.name)) {
                    existing = c;
                    break;
                }
            }
            JSONObject j = new JSONObject();
            j.put("name", MQTT_NAME);
            j.put("brokerUrl", url);
            j.put("topic", topic);
            j.put("username", cfg.deviceId);
            j.put("password", cfg.deviceKey);
            j.put("qos", 0);
            j.put("enabled", true);
            j.put("homeAssistantDiscovery", true);                       // per-field topics: required by the app for control
            j.put("allowControl", cfg.allowControl);                     // explicit opt-in on the car's screen
            j.put("minIntervalSeconds", 1);
            j.put("maxIntervalSeconds", 300);
            j.put("changeOnly", true);
            j.put("trustAllCerts", false);
            if (existing == null) {
                mgr.addConnection(j);
                LOG.info("cloud MQTT connection created");
            } else if (needsUpdate(existing, url, topic, cfg)) {
                mgr.updateConnection(existing.id, j);
                LOG.info("cloud MQTT connection updated");
            }
        } catch (Throwable t) {
            LOG.warn("MQTT provisioning failed: " + t.getMessage());
        }
    }

    private static boolean needsUpdate(MqttConnectionConfig c, String url, String topic, CloudConfig cfg) {
        return !url.equals(c.brokerUrl) || !topic.equals(c.topic) || !cfg.deviceId.equals(c.username)
                || !cfg.deviceKey.equals(c.password) || c.allowControl != cfg.allowControl
                || !c.enabled || !c.homeAssistantDiscovery;
    }

    /** The app's URL parser wants an explicit port: wss://host/mqtt becomes wss://host:443/mqtt. */
    static String withExplicitPort(String url) {
        if (url.matches("^(tcp|ssl|ws|wss)://[^/]+:\\d+(/.*)?$")) return url;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(tcp|ssl|ws|wss)://([^/]+)(/.*)?$").matcher(url);
        if (!m.matches()) return url;
        String scheme = m.group(1);
        int port = scheme.equals("wss") ? 443 : scheme.equals("ws") ? 80 : scheme.equals("ssl") ? 8883 : 1883;
        return scheme + "://" + m.group(2) + ":" + port + (m.group(3) == null ? "" : m.group(3));
    }

    // ---------------------------------------------------------------- tunnel

    private synchronized void ensureTunnel(CloudConfig cfg) {
        long now = System.currentTimeMillis();
        if (tunnel != null && (tunnelUp || now - tunnelStartedAt < 20000)) return;
        if (now < reconnectNotBefore) return;
        stopTunnel();
        tunnelStartedAt = now;
        tunnel = new CloudTunnel(wsHttp, cfg.wsUrl("/tunnel"), cfg.bearer(), CameraDaemon.HTTP_PORT, new CloudTunnel.Listener() {
            @Override
            public void onConnected() {
                tunnelUp = true;
                lastError = "";
            }

            @Override
            public void onDisconnected(String reason, int httpCode) {
                tunnelUp = false;
                lastError = "tunnel: " + reason;
                LOG.warn("tunnel down: " + reason);
                synchronized (CloudClient.this) {
                    reconnectNotBefore = System.currentTimeMillis() + 3000;
                }
                if (httpCode == 401) registered = false;                 // unlinked or key rejected: re-check pairing
                wakeUp();
            }
        });
        tunnel.connect();
    }

    private synchronized void stopTunnel() {
        tunnelUp = false;
        if (tunnel != null) {
            tunnel.close();
            tunnel = null;
        }
    }

    // ---------------------------------------------------------------- UI facade

    JSONObject statusJson() {
        JSONObject j = new JSONObject();
        try {
            CloudConfig cfg = CloudConfig.load();
            j.put("enabled", cfg.enabled);
            j.put("serverUrl", cfg.serverUrl);
            j.put("allowControl", cfg.allowControl);
            j.put("state", cfg.enabled ? state : "disabled");
            j.put("code", code);
            j.put("codeExpiresAt", codeExpiresAt);
            j.put("name", claimedName);
            j.put("tunnel", tunnelUp);
            j.put("error", lastError);
            String vin = currentVin();
            j.put("vinKnown", vin != null);
            if (vin != null) j.put("vinLast4", vin.substring(13));       // never expose the full VIN through the web UI
        } catch (Exception ignored) {
            // JSONObject.put with plain values cannot fail
        }
        return j;
    }

    /** @return null on success, otherwise an error message for the UI. */
    String applyConfig(Boolean enabled, String serverUrl, Boolean allowControl) {
        CloudConfig cfg = CloudConfig.load();
        if (serverUrl != null) {
            String u = CloudConfig.normalizeServerUrl(serverUrl);
            if (u.isEmpty() && !serverUrl.trim().isEmpty()) return "Endereço inválido. Use algo como https://app.seudominio.com";
            if (!u.equals(cfg.serverUrl)) registered = false;
            cfg.serverUrl = u;
        }
        if (enabled != null) cfg.enabled = enabled;
        if (allowControl != null) cfg.allowControl = allowControl;
        if (cfg.enabled && cfg.serverUrl.isEmpty()) return "Informe o endereço do servidor antes de ativar.";
        if (!cfg.save()) return "Não foi possível salvar a configuração.";
        wakeUp();
        return null;
    }
}
