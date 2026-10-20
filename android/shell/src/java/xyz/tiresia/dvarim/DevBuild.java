package xyz.tiresia.dvarim;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.webkit.WebView;

/**
 * What only a test build does.
 *
 * A debuggable build opens its WebView to chrome://inspect, which is the one way
 * to see what the page makes of a real finger: synthesized pointer events in a
 * desktop browser skip the engine's own scroll-versus-gesture arbitration, and
 * that arbitration is where touch gestures live or die. The release build is
 * not debuggable, so this is inert there.
 */
final class DevBuild {
    private DevBuild() {}

    private static final String PREFS = "dvarim.dev";
    private static final String KEY_SERVER = "server";

    static void onCreate(Context context) {
        if (debuggable(context)) WebView.setWebContentsDebuggingEnabled(true);
    }

    /**
     * The development server DevActivity last showed, which the test build's
     * widget, reminders and outbox then talk to as well (Api). Otherwise they
     * would talk to the real server while the window showed sample data, and a
     * tick on a test build's widget would complete a real to-do. Null in a
     * release build, and until DevActivity has opened something.
     */
    static String server(Context context) {
        if (!debuggable(context)) return null;
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SERVER, null);
    }

    /** DevActivity's page, as a root the API can be addressed against. */
    static void rememberServer(Context context, String page) {
        Uri u = Uri.parse(page);
        if (u.getScheme() == null || u.getAuthority() == null) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_SERVER, u.getScheme() + "://" + u.getAuthority() + "/").apply();
    }

    /**
     * files/calendars.json, when a test build has one: the phone's calendars
     * as tools/bridge_sim.py's file has them, standing in for CalendarContract
     * (DeviceCalendars), so tools/phone/local_check.py needs no calendar
     * permission. Null in a release build, and when there is no such file.
     */
    static java.io.File calendarsFile(Context context) {
        if (!debuggable(context)) return null;
        java.io.File file = new java.io.File(context.getFilesDir(), "calendars.json");
        return file.exists() ? file : null;
    }

    private static boolean debuggable(Context context) {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
