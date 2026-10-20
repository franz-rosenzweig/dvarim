package xyz.tiresia.dvarim;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;

/**
 * The to-dos kept on this phone and synced with the server: the default since
 * the app went offline-first. The page is the one inside the APK
 * (FolderActivity), its vault a folder of the app's own (PlainFiles), and the
 * page's built-in sync keeps that folder in step with the server's /dav with a
 * device token (frontend/src/lib/davsync.js). So the app opens with no network
 * at all, and the widget, the tile and reminders read the copy (Local).
 *
 * The one step that needs the server is the first: the person signs in on the
 * server's page in the app's own WebView (CopySignInActivity), not Chrome's,
 * whose cookies the app cannot read. The app then borrows that session to make
 * this phone its own token (POST /api/tokens, which takes a session and never
 * a token), keeps it in the app's private storage, and hands it to the page in
 * storage.info()'s `sync`.
 */
final class AppCopy {
    private static final String PREFS = "dvarim.copy";
    private static final String KEY_SERVER = "server", KEY_WHO = "who", KEY_DEVICE = "device", KEY_TOKEN = "token";

    private AppCopy() {}

    /** Set up for the server in use, with its token: {server, who, device}, else null. */
    static JSONObject current(Context context) {
        SharedPreferences p = prefs(context);
        String server = p.getString(KEY_SERVER, null), token = p.getString(KEY_TOKEN, null);
        if (server == null || token == null || !server.equals(Api.base(context))) return null;
        try {
            return new JSONObject().put("server", server).put("who", p.getString(KEY_WHO, "owner"))
                    .put("device", p.getString(KEY_DEVICE, ""));
        } catch (JSONException e) {
            return null;
        }
    }

    /** Its folder, files/copies/<host>/<who>/, made if missing; null with no copy. */
    static File folder(Context context) {
        JSONObject c = current(context);
        return c == null ? null : folder(context, c.optString("server"), c.optString("who"));
    }

    private static File folder(Context context, String server, String who) {
        Uri u = Uri.parse(server);
        String host = (u.getHost() == null ? "server" : u.getHost()) + (u.getPort() == -1 ? "" : "-" + u.getPort());
        File dir = new File(new File(new File(context.getFilesDir(), "copies"), safe(host)), safe(who));
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    /** What the page's sync is told (BRIDGE.md, info's `sync`); `app` says the app owns it. */
    static JSONObject syncInfo(Context context) {
        JSONObject c = current(context);
        if (c == null) return null;
        try {
            return new JSONObject().put("kind", "dvarim").put("address", c.optString("server"))
                    .put("token", prefs(context).getString(KEY_TOKEN, "")).put("app", true);
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * With a sign-in in the WebView and no copy yet: make this phone a token and
     * keep it. True once there is a copy. Blocking: never on the main thread.
     */
    static boolean setUpIfSignedIn(Context context) {
        if (current(context) != null) return true;
        try {
            JSONObject auth = new JSONObject(Api.server(context, "GET", "/api/auth", null));
            if (!auth.optBoolean("authenticated")) return false;
            JSONObject person = auth.optJSONObject("person");
            String who = personKey(person);
            String base = deviceName(context);
            for (int n = 1; n <= 9; n++) {
                String name = n == 1 ? base : base + " " + n;
                try {
                    String made = Api.server(context, "POST", "/api/tokens", new JSONObject().put("name", name).toString());
                    String token = new JSONObject(made).getString("token");
                    prefs(context).edit().putString(KEY_SERVER, Api.base(context)).putString(KEY_WHO, who)
                            .putString(KEY_DEVICE, name).putString(KEY_TOKEN, token).commit();
                    folder(context);
                    Local.forget(context);
                    Log.i("Dvarim", "keeping a copy on this phone for " + who + ", synced as " + name);
                    return true;
                } catch (Api.Refused e) {
                    if (e.status != 409) throw e;          // a name already taken: the next number
                }
            }
        } catch (IOException | JSONException e) {
            Log.w("Dvarim", "could not set up the copy yet", e);
        }
        return false;
    }

    /**
     * The page has synced what it had and signs out: the token goes from the
     * server, the WebView's sign-in with it, and the copy from the phone.
     * Blocking: never on the main thread.
     */
    static void signOut(Context context) {
        JSONObject c = current(context);
        if (c == null) return;
        try {
            // Api.url escapes the path itself: a name escaped here would be escaped twice
            Api.server(context, "DELETE", "/api/tokens/" + c.optString("device"), null);
        } catch (IOException e) {
            Log.w("Dvarim", "could not revoke this phone's token", e);
        }
        try {
            Api.server(context, "POST", "/api/logout", "{}");
        } catch (IOException e) {
            Log.w("Dvarim", "could not sign out on the server", e);
        }
        File dir = folder(context, c.optString("server"), c.optString("who"));
        prefs(context).edit().clear().commit();
        PlainFiles.delete(dir);
        Local.forget(context);
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
        });
    }

    /** Whose copy, as the page keys them (backend.js personKey): "owner" for the
     *  server's owner (the page's ''), otherwise the account's id, lowercased. */
    static String personKey(JSONObject person) {
        if (person == null || person.optBoolean("owner", true)) return "owner";
        String key = person.optString("uid", person.optString("name", "")).trim().toLowerCase(java.util.Locale.ROOT);
        return key.isEmpty() ? "owner" : key;
    }

    /** The phone's name, in the characters the server allows a device. */
    static String deviceName(Context context) {
        String raw = null;
        try {
            raw = Settings.Global.getString(context.getContentResolver(), "device_name");
        } catch (RuntimeException ignored) {
            // no such setting on this phone
        }
        if (raw == null || raw.trim().isEmpty()) raw = Build.MODEL;
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < raw.length(); ) {
            int cp = raw.codePointAt(i);
            boolean ok = Character.isLetterOrDigit(cp) || " ._'’()-".indexOf(cp) >= 0;
            b.appendCodePoint(ok ? cp : ' ');
            i += Character.charCount(cp);
        }
        String name = b.toString().trim().replaceAll(" +", " ");
        if (name.length() > 36) name = name.substring(0, 36).trim();
        return name.isEmpty() ? "Phone" : name;
    }

    private static String safe(String s) {
        String out = s.replace('/', '-').replace(':', '-');
        return out.isEmpty() ? "_" : out.startsWith(".") ? "_" + out.substring(1) : out;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
