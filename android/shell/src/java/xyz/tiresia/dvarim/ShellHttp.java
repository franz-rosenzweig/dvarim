package xyz.tiresia.dvarim;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.InetAddress;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * The bridge's `http` op (docs/BRIDGE.md): one request made by the app for the
 * page's built-in sync, so a WebDAV server that answers no page from another
 * origin (Nextcloud, most) can still be reached. No cookies, no cache, no
 * redirects, 30 seconds. Only https, and plain http only to this phone, the
 * local network or the tailnet.
 *
 * OkHttp rather than HttpURLConnection, which refuses any method it does not
 * know, and WebDAV's PROPFIND and MKCOL are two of those.
 */
final class ShellHttp {
    private ShellHttp() {}

    // OkHttp's retry on a failed connection stays on: a server closes an idle
    // kept-alive connection (Node's after 5 s), and a request that finds its
    // pooled connection gone must be sent again on a new one, not reported as
    // "unexpected end of stream" and a sync lost until the next change.
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .followRedirects(false)          // a sync is never sent where its token was not meant to go
            .followSslRedirects(false)
            .callTimeout(30, TimeUnit.SECONDS)
            .build();                        // and no cookie jar, no cache: OkHttp's defaults

    private static final java.util.Set<String> NEEDS_BODY = new java.util.HashSet<>(
            java.util.Arrays.asList("POST", "PUT", "PATCH", "PROPPATCH", "REPORT"));

    static final class Refused extends Exception {
        final String code;

        Refused(String code, String message) { super(message); this.code = code; }
    }

    /** `{status, headers, body}`. An HTTP error status is an ordinary answer;
     *  only no answer at all is EIO. Blocking. */
    static JSONObject request(JSONObject args) throws Refused, JSONException {
        String url = args.optString("url", "");
        okhttp3.HttpUrl parsed = okhttp3.HttpUrl.parse(url);
        if (parsed == null) throw new Refused("EINVAL", "not a web address: " + url);
        if (!parsed.isHttps() && !isPrivate(parsed.host())) {
            throw new Refused("EINVAL", parsed.host() + " needs an https address: plain http goes only to this phone, the local network or the tailnet");
        }
        String method = args.optString("method", "GET").toUpperCase(Locale.ROOT);
        Object body = args.opt("body");
        Request.Builder r = new Request.Builder().url(parsed);
        JSONObject headers = args.optJSONObject("headers");
        String type = null;
        if (headers != null) {
            for (Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
                String k = keys.next();
                String v = String.valueOf(headers.opt(k));
                if (k.equalsIgnoreCase("Content-Type")) type = v;
                r.header(k, v);
            }
        }
        // OkHttp refuses a body on GET and HEAD, and none on the methods that need one
        RequestBody sent = null;
        boolean none = method.equals("GET") || method.equals("HEAD");
        if (body instanceof String && !none) {
            sent = RequestBody.create((String) body, type == null ? null : MediaType.parse(type));
        } else if (NEEDS_BODY.contains(method)) {
            sent = RequestBody.create(new byte[0], (MediaType) null);
        }
        r.method(method, sent);
        try (Response res = CLIENT.newCall(r.build()).execute()) {
            JSONObject fields = new JSONObject();
            for (String name : res.headers().names()) fields.put(name, res.header(name));
            ResponseBody b = res.body();
            return new JSONObject()
                    .put("status", res.code())
                    .put("headers", fields)
                    .put("body", b == null ? "" : b.string());
        } catch (IOException e) {
            throw new Refused("EIO", "could not reach " + parsed.host() + ": " + e.getMessage());
        }
    }

    /** Whether every address the name has is this phone's, the local network's
     *  or the tailnet's. */
    static boolean isPrivate(String host) {
        if (host.equals("localhost") || host.endsWith(".localhost")) return true;
        try {
            InetAddress[] all = InetAddress.getAllByName(host);
            if (all.length == 0) return false;
            for (InetAddress a : all) if (!isPrivate(a.getAddress())) return false;
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** Loopback, RFC 1918, link-local, and 100.64/10 where Tailscale puts its
     *  devices; for IPv6 loopback, fc00::/7 (the tailnet's fd7a:115c:a1e0::/48
     *  among them) and link-local. */
    static boolean isPrivate(byte[] a) {
        int b0 = a[0] & 0xff, b1 = a.length > 1 ? a[1] & 0xff : 0;
        if (a.length == 4) {
            return b0 == 127 || b0 == 10 || (b0 == 172 && b1 >= 16 && b1 <= 31) || (b0 == 192 && b1 == 168)
                    || (b0 == 169 && b1 == 254) || (b0 == 100 && b1 >= 64 && b1 <= 127);
        }
        if (a.length != 16) return false;
        boolean loopback = true;
        for (int i = 0; i < 15; i++) if (a[i] != 0) { loopback = false; break; }
        if (loopback && a[15] == 1) return true;
        return (b0 & 0xfe) == 0xfc || (b0 == 0xfe && (b1 & 0xc0) == 0x80);
    }
}
