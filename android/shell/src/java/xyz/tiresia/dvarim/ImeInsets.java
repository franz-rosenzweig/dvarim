package xyz.tiresia.dvarim;

import android.app.Activity;
import android.app.Application;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;

/**
 * Letting the page know the keyboard is there.
 *
 * An app that draws edge to edge is not resized when the keyboard opens — the
 * keyboard is simply drawn over it, and windowSoftInputMode="adjustResize" no
 * longer applies. So the page kept its full height, visualViewport reported no
 * change, and a card being typed into could sit under the keyboard with nothing
 * able to scroll it clear: the page had no way to know.
 *
 * Taking the keyboard's height as bottom padding on the content view shortens
 * the window for real, so the page gets a smaller viewport and can put the
 * field it is typing into in the room that is left (lib/keyboard.js).
 */
class ImeInsets implements Application.ActivityLifecycleCallbacks {

    @Override
    public void onActivityCreated(Activity activity, Bundle state) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;   // ime() insets are API 30
        final View content = activity.findViewById(android.R.id.content);
        if (content == null) return;
        content.setOnApplyWindowInsetsListener((v, insets) -> {
            int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
            int bars = insets.getInsets(WindowInsets.Type.systemBars()).bottom;
            // Only what the keyboard covers beyond the navigation bar, which the
            // page already allows for with env(safe-area-inset-bottom).
            v.setPadding(v.getPaddingLeft(), v.getPaddingTop(), v.getPaddingRight(), Math.max(0, ime - bars));
            return insets;
        });
    }

    @Override public void onActivityResumed(Activity activity) {}
    @Override public void onActivityStarted(Activity activity) {}
    @Override public void onActivityPaused(Activity activity) {}
    @Override public void onActivityStopped(Activity activity) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle out) {}
    @Override public void onActivityDestroyed(Activity activity) {}
}
