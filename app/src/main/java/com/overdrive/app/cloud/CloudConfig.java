package com.overdrive.app.cloud;

import com.overdrive.app.byd.cloud.crypto.CredentialCipher;
import com.overdrive.app.config.UnifiedConfigManager;

import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Settings of the Electric Guardian cloud link, stored in the unified config under "cloud".
 * The device key (a bearer secret shared with the server at pairing time) is stored encrypted.
 */
final class CloudConfig {
    static final String SECTION = "cloud";
    private static final Pattern SERVER_URL = Pattern.compile("^https?://[A-Za-z0-9.-]+(:\\d{1,5})?$");

    boolean enabled;
    String serverUrl = "";
    boolean allowControl;
    String deviceId = "";
    String deviceKey = "";

    static CloudConfig load() {
        CloudConfig c = new CloudConfig();
        try {
            JSONObject root = UnifiedConfigManager.loadConfig();
            JSONObject s = root == null ? null : root.optJSONObject(SECTION);
            if (s != null) {
                c.enabled = s.optBoolean("enabled", false);
                c.serverUrl = s.optString("serverUrl", "").trim();
                c.allowControl = s.optBoolean("allowControl", false);
                c.deviceId = s.optString("deviceId", "");
                c.deviceKey = CredentialCipher.decrypt(s.optString("deviceKey", ""));
            }
        } catch (Throwable ignored) {
            // keep defaults: cloud stays disabled
        }
        return c;
    }

    /** Base URL without a trailing slash, or "" when it is not a plain http(s)://host[:port]. */
    static String normalizeServerUrl(String raw) {
        if (raw == null) return "";
        String u = raw.trim();
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return SERVER_URL.matcher(u).matches() ? u : "";
    }

    String wsUrl(String path) {
        return serverUrl.replaceFirst("^http", "ws") + path;
    }

    boolean save() {
        try {
            JSONObject s = new JSONObject();
            s.put("enabled", enabled);
            s.put("serverUrl", serverUrl);
            s.put("allowControl", allowControl);
            s.put("deviceId", deviceId);
            s.put("deviceKey", CredentialCipher.encrypt(deviceKey));
            return UnifiedConfigManager.updateSection(SECTION, s);
        } catch (Throwable t) {
            return false;
        }
    }

    /** Creates the device identity on first use and persists it (the key never changes afterwards). */
    boolean ensureIdentity() {
        if (!deviceId.isEmpty() && deviceKey.length() >= 32) return true;
        byte[] k = new byte[32];
        new SecureRandom().nextBytes(k);
        deviceId = UUID.randomUUID().toString();
        deviceKey = Base64.getUrlEncoder().withoutPadding().encodeToString(k);
        return save();
    }

    String bearer() {
        return deviceId + "." + deviceKey;
    }
}
