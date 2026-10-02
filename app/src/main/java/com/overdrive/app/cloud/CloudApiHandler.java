package com.overdrive.app.cloud;

import com.overdrive.app.server.HttpResponse;

import org.json.JSONObject;

import java.io.OutputStream;

/**
 * Local API of the cloud page (/api/cloud/*). Authentication is enforced by HttpServer before modular
 * handlers run. Note: these routes are blocked at the cloud view proxy, so they only work on the car.
 */
public final class CloudApiHandler {
    private static final String PREFIX = "/api/cloud/";

    private CloudApiHandler() {}

    public static boolean handle(String method, String path, String body, OutputStream out) {
        try {
            String p = path.indexOf('?') >= 0 ? path.substring(0, path.indexOf('?')) : path;
            CloudClient client = CloudClient.getInstance();
            if ((PREFIX + "status").equals(p) && "GET".equals(method)) {
                HttpResponse.sendJson(out, client.statusJson().toString());
                return true;
            }
            if ((PREFIX + "config").equals(p) && "POST".equals(method)) {
                JSONObject b = new JSONObject(body == null || body.isEmpty() ? "{}" : body);
                Boolean enabled = b.has("enabled") ? b.optBoolean("enabled") : null;
                Boolean allowControl = b.has("allowControl") ? b.optBoolean("allowControl") : null;
                String serverUrl = b.has("serverUrl") ? b.optString("serverUrl") : null;
                String err = client.applyConfig(enabled, serverUrl, allowControl);
                if (err != null) {
                    HttpResponse.sendJson(out, 400, new JSONObject().put("success", false).put("error", err).toString());
                } else {
                    HttpResponse.sendJson(out, new JSONObject().put("success", true).toString());
                }
                return true;
            }
        } catch (Exception e) {
            try {
                HttpResponse.sendJson(out, 500, new JSONObject().put("success", false).put("error", "Erro interno").toString());
            } catch (Exception ignored) {
                // connection already gone
            }
            return true;
        }
        return false;
    }
}
