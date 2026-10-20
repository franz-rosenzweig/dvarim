package xyz.tiresia.dvarim;

import android.app.Activity;
import android.app.Application;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.view.View;

import java.util.Collections;

/**
 * Asks Android not to take the swipe that opens the navigation.
 *
 * With gesture navigation a swipe in from either edge is the system's Back, and
 * it is taken before the page sees it: one pointermove, then a cancel, while the
 * finger carries on. So the drawer could never be pulled out by hand — the
 * gesture this app's own left-edge strip was written for.
 *
 * setSystemGestureExclusionRects (API 29) reserves a strip for the app. The
 * system allows 200dp of it per edge and ignores the rest, so this is a band
 * rather than the whole edge: it sits low, where a thumb already rests, and the
 * edge above and below it — and the whole right edge — still mean Back.
 *
 * What the page then does with the touch is the page's business: a slow drag
 * carries the drawer with the finger, a flick means Back (lib/drawer.svelte.js).
 */
class EdgeGestures implements Application.ActivityLifecycleCallbacks {
    /** All the system will give us, and what the page is told to expect. */
    static final int BAND_DP = 200;
    /** Where the band starts, as a fraction of the window's height. */
    static final float BAND_TOP = 0.52f;
    /** How wide a strip of the edge is ours. Enough for a thumb to start in. */
    static final int WIDTH_DP = 24;

    private void apply(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        final View root = activity.getWindow().getDecorView();
        root.post(() -> {
            float d = root.getResources().getDisplayMetrics().density;
            int h = root.getHeight(), w = Math.round(WIDTH_DP * d), band = Math.round(BAND_DP * d);
            if (h <= 0) return;
            int top = Math.max(0, Math.min(Math.round(h * BAND_TOP), h - band));
            root.setSystemGestureExclusionRects(
                    Collections.singletonList(new Rect(0, top, w, Math.min(top + band, h))));
        });
    }

    @Override public void onActivityResumed(Activity activity) { apply(activity); }
    @Override public void onActivityCreated(Activity activity, Bundle state) {
        activity.getWindow().getDecorView().addOnLayoutChangeListener(
                (v, l, t, r, b, ol, ot, or_, ob) -> { if (b - t != ob - ot) apply(activity); });
    }

    @Override public void onActivityStarted(Activity activity) {}
    @Override public void onActivityPaused(Activity activity) {}
    @Override public void onActivityStopped(Activity activity) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle out) {}
    @Override public void onActivityDestroyed(Activity activity) {}
}
