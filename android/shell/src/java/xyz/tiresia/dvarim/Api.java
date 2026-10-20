package xyz.tiresia.dvarim;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The site's API, from native code, signed in as whoever signed in to the app.
 *
 * There is no second credential to manage: the WebView already holds the
 * session cookie the server set, so borrow it. That is the same trick the macOS
 * shell uses, and it means a widget or a reminder is signed in exactly when the
 * app is, and signs out with it.
 *
 * Every call blocks, so callers are responsible for not being on the main
 * thread. RemoteViewsFactory and BroadcastReceiver.goAsync() both give us one.
 */
final class Api {
    private static final int TIMEOUT_MS = 12000;

    private Api() {}

    static String url(Context context, String path) {
        return Uri.parse(base(context)).buildUpon().path(path).build().toString();
    }

    /** The server's root: Server's, except in a test build showing a
     *  development server, whose native pieces follow the page (DevBuild). */
    static String base(Context context) {
        String dev = DevBuild.server(context);
        return dev != null ? dev : Server.base(context);
    }

    static String get(Context context, String path) throws IOException {
        return send(context, path, "GET", null);
    }

    static String post(Context context, String path) throws IOException {
        return send(context, path, "POST", null);
    }

    /** A POST with a JSON body. */
    static String post(Context context, String path, String json) throws IOException {
        return send(context, path, "POST", json);
    }

    /**
     * Is a Dvarim answering at this address?
     *
     * For Settings, which asks about an address nobody has committed to yet, so
     * it takes the origin rather than reading the stored one. /api/health is
     * public, so no cookie is needed and a wrong answer here means the address
     * is wrong rather than the sign-in. Blocking, like everything else here.
     */
    static void probe(String origin) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
        try {
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setRequestProperty("Accept", "application/json");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("answered " + code);
            if (!read(c.getInputStream()).contains("\"ok\"")) {
                throw new IOException("something answered, but not a Dvarim");
            }
        } finally {
            c.disconnect();
        }
    }

    private static String send(Context context, String path, String method, String json) throws IOException {
        // On a folder there is no server: the lists the page last gave, and a
        // tick waits for the page (Local, Outbox)
        if (Folder.isOn(context)) return Local.answer(context, method, path);
        return server(context, method, path, json);
    }

    /**
     * The server itself, even with the to-dos on the phone: for what only it
     * can do, such as making or revoking the copy's own token (AppCopy).
     */
    static String server(Context context, String method, String path, String json) throws IOException {
        HttpURLConnection c =(HttpURLConnection) new URL(url(context, path)).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setRequestProperty("Accept", "application/json");
            // No Origin header, so the server's same-origin check waves us
            // through: this is not a browser acting on someone else's behalf.
            String cookie = cookie(context);
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            if (json != null) {
                byte[] body = json.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = c.getOutputStream()) { out.write(body); }
            }
            int code = c.getResponseCode();
            if (code == 401 || code == 403) throw new NotSignedIn();
            // 502-504 are the tunnel in front of a server that is restarting:
            // out of reach for now, like no network at all, not a refusal.
            if (code == 502 || code == 503 || code == 504) throw new IOException(method + " " + path + ": " + code);
            if (code < 200 || code >= 300) throw new Refused(method + " " + path + ": " + code, code);
            return read(c.getInputStream());
        } finally {
            c.disconnect();
        }
    }

    /**
     * The session cookie, read on the main thread.
     *
     * CookieManager is documented as thread-safe, but it is a WebView object and
     * WebView is emphatic about which thread it wants; a reminder scheduled
     * after a reboot runs with no activity ever having existed, so this is the
     * one place that could learn the hard way. Hopping costs nothing.
     */
    static String cookie(final Context context) {
        if (Looper.myLooper() == Looper.getMainLooper()) return cookieNow(context);
        final String[] held = new String[1];
        final CountDownLatch read = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            held[0] = cookieNow(context);
            read.countDown();
        });
        try {
            read.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return held[0];
    }

    private static String cookieNow(Context context) {
        try {
            return CookieManager.getInstance().getCookie(base(context));
        } catch (RuntimeException e) {
            return null;                  // no usable WebView: the 401 will say so
        }
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    /**
     * A string field of the API's JSON, or "" when it is missing or null.
     * optString answers a JSON null with the word "null", which is how a to-do
     * in the Inbox — no project, no area — came to have "null" under its title.
     */
    static String text(JSONObject o, String key) {
        return o.isNull(key) ? "" : o.optString(key, "");
    }

    /** Worth telling apart: it means "open the app and sign in", not "retry". */
    static class NotSignedIn extends IOException {
        NotSignedIn() { super("not signed in"); }
    }

    /** The server answered, and the answer was no: sending it again will not help. */
    static class Refused extends IOException {
        final int status;

        Refused(String what) { this(what, 0); }

        Refused(String what, int status) { super(what); this.status = status; }
    }
}
