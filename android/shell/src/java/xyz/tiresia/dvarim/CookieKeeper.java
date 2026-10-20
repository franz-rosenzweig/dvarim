package xyz.tiresia.dvarim;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import android.util.Log;
import android.webkit.CookieManager;

/**
 * Keeps the sign-in across restarts.
 *
 * The server's session cookie lasts thirty days, but WebView holds cookies in
 * memory and commits them to disk on a schedule of its own. Android kills
 * background apps freely, and a sign-in that has not been committed yet dies
 * with the process: the password screen comes back for no reason the person can
 * see. flush() is documented as doing precisely this, so the fix is to call it
 * whenever an activity stops — cheap, and the only moment that matters.
 */
class CookieKeeper implements Application.ActivityLifecycleCallbacks {
    @Override
    public void onActivityStopped(Activity activity) {
        try {
            CookieManager.getInstance().flush();
        } catch (RuntimeException e) {
            // No usable WebView: the app has bigger problems than a cookie, but
            // going to the background is not the place to crash over it.
            Log.w("Dvarim", "could not flush cookies", e);
        }
    }

    @Override public void onActivityCreated(Activity activity, Bundle state) {}
    @Override public void onActivityStarted(Activity activity) {}
    @Override public void onActivityResumed(Activity activity) {}
    @Override public void onActivityPaused(Activity activity) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle out) {}
    @Override public void onActivityDestroyed(Activity activity) {}
}
