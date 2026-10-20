package xyz.tiresia.dvarim;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.TileService;

/**
 * "New To-Do" in the quick settings shade.
 *
 * The same trip as the launcher's long-press menu — /new, which the web app
 * reads as "open the Inbox with an empty to-do already waiting" — but reachable
 * from anywhere, including the lock screen's shade, without finding the icon
 * first. Add it from the pencil at the bottom of the shade.
 */
public class NewTodoTile extends TileService {
    @Override
    public void onClick() {
        super.onClick();
        Intent open = new Intent(this, LauncherActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .setData(Uri.parse(Server.base(this)).buildUpon().path("/new").build())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= 34) {
            // From API 34 the Intent overload throws; the shade wants to collapse
            // around something it can fire itself.
            startActivityAndCollapse(PendingIntent.getActivity(
                    this, 0, open, PendingIntent.FLAG_IMMUTABLE));
        } else {
            startActivityAndCollapse(open);
        }
    }
}
