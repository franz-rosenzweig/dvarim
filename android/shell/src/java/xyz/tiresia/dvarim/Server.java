package xyz.tiresia.dvarim;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.util.Locale;

/**
 * Which Dvarim this app talks to.
 *
 * The web app addresses its own API relatively — /api/… against whatever served
 * the page — so it cannot move itself. The one screen that could change the
 * address would be a screen the old server has to be reachable to serve, and if
 * it were reachable there would be nothing to change. So the address lives out
 * here in the shell, where SettingsActivity can set it with nothing loaded at
 * all.
 *
 * The built-in answer is R.string.launchUrl, the address the app was generated
 * around. Anything typed since is kept here and wins — for the WebView, for the
 * widget, for the quick settings tile and for the reminders alike.
 */
final class Server {
    private static final String PREFS = "dvarim.server";
    private static final String KEY_ORIGIN = "origin";

    private Server() {}

    /** The site root, trailing slash and all: what callers here want. */
    static String base(Context context) {
        return origin(context) + "/";
    }

    /** "https://dvarim.tiresia.xyz" — no trailing slash, the shape a person types. */
    static String origin(Context context) {
        String stored = prefs(context).getString(KEY_ORIGIN, null);
        // Read back through parse() as well as written through it. An address
        // stored by some older version of this app is not this version's to
        // trust, and the window that renders the site does not decline an
        // address it dislikes — it throws, on launch, where there is no
        // settings screen left to fix it from.
        String origin = stored == null ? null : parse(stored);
        return origin != null ? origin : builtIn(context);
    }

    /** The address the app was built around, whatever has been typed since. */
    static String builtIn(Context context) {
        String origin = parse(context.getString(R.string.launchUrl));
        // The build wrote that string from twa-manifest.json; it has no business
        // being unparseable, and an empty answer is a louder way to say so than
        // a crash on a settings screen.
        return origin != null ? origin : "";
    }

    /** Asked through origin(), not through the stored string, so that a stored
     *  string this version will not have agrees with what it is actually using. */
    static boolean isBuiltIn(Context context) {
        return builtIn(context).equals(origin(context));
    }

    /**
     * Remember an address someone typed. Returns the origin now in use, or null
     * if what they typed was not an address, in which case nothing changed.
     */
    static String set(Context context, String typed) {
        String origin = parse(typed);
        if (origin == null) return null;
        SharedPreferences.Editor edit = prefs(context).edit();
        // Typing the built-in address back in is how you undo this, so it had
        // better leave no trace: a stored copy would go stale the day the app
        // is rebuilt somewhere else.
        if (origin.equals(builtIn(context))) edit.remove(KEY_ORIGIN);
        else edit.putString(KEY_ORIGIN, origin);
        edit.apply();
        return origin;
    }

    /**
     * What someone typed, as an origin, or null if it is not one.
     *
     * https only, and not out of principle: android-browser-helper's
     * WebViewFallbackActivity, the window that renders the site, throws
     * "launchUrl scheme must be 'https'" out of its own onCreate. An http
     * address would therefore save cleanly and then crash the app every time it
     * opened, with the settings shortcut the only way back. A server indoors
     * needs a certificate — a local CA, or a tunnel that brings one — before
     * this app can be pointed at it.
     *
     * A bare "dvarim.example.com" is read as https for that reason too. The
     * path goes: this is an origin, and the web app owns its own routes.
     */
    static String parse(String typed) {
        if (typed == null) return null;
        String text = typed.trim();
        if (text.isEmpty()) return null;
        if (!text.contains("://")) text = "https://" + text;
        Uri uri = Uri.parse(text);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        String host = uri.getHost();
        if (!scheme.equals("https")) return null;
        if (host == null || host.isEmpty()) return null;
        // ":443" spelled out is the same address, but not the same string, and
        // the window that renders the site compares ports: every link on the
        // page would count as leaving it and be handed to a browser.
        int port = uri.getPort();
        return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
    }

    /** An address, but a cleartext one — worth telling apart from a typo, since
     *  the answer to it is a different sentence. */
    static boolean looksCleartext(String typed) {
        return typed != null && typed.trim().toLowerCase(Locale.US).startsWith("http://");
    }

    /**
     * A URL meant for the built-in address, pointed at the chosen one instead.
     *
     * Everything that opens the app hands it a URL. The launcher's shortcuts and
     * the app links in the manifest name the built-in host outright, because
     * both were written into the build; the widget and the tile build theirs
     * from base() above. The path is the part that carries the meaning —
     * /today, /new, /share?… — so keep it and swap the address underneath. This
     * app shows one Dvarim, and this is which one.
     */
    static Uri rebase(Context context, Uri uri) {
        if (uri == null || uri.getScheme() == null || uri.getHost() == null) return uri;
        Uri server = Uri.parse(base(context));
        return uri.buildUpon()
                .scheme(server.getScheme())
                .encodedAuthority(server.getEncodedAuthority())
                .build();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
