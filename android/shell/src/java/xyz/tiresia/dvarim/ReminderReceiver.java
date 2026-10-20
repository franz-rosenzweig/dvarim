package xyz.tiresia.dvarim;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Where our own alarms and notification buttons land.
 *
 * Not exported, and with no intent filter: everything that reaches it is a
 * PendingIntent this app made, which the system fires under our identity.
 * BootReceiver is the one the system talks to.
 */
public class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        final Context app = context.getApplicationContext();

        if (Reminders.ACTION_REMIND.equals(action)) {
            // An alarm set before the server (or the folder) was changed is
            // about a to-do on the old one. AlarmManager keeps no list we could
            // go back and cancel, so the alarm says where it came from and we
            // drop it here.
            String from = intent.getStringExtra(Reminders.EXTRA_BASE);
            if (from != null && !from.equals(Reminders.source(app))) return;
            // Turned off since it was set, likewise: the alarm cannot be found
            // again to cancel, so it is dropped when it goes off.
            if (!Reminders.enabled(app)) return;
            Reminders.show(app,
                    intent.getStringExtra(Reminders.EXTRA_KEY),
                    intent.getStringExtra(Reminders.EXTRA_ID),
                    intent.getStringExtra(Reminders.EXTRA_TITLE),
                    intent.getStringExtra(Reminders.EXTRA_SUB) == null
                            ? "" : intent.getStringExtra(Reminders.EXTRA_SUB));
            return;
        }

        if (Reminders.ACTION_COMPLETE.equals(action)) {
            String id = intent.getStringExtra(Reminders.EXTRA_ID);
            String key = intent.getStringExtra(Reminders.EXTRA_KEY);
            NotificationManager notifications = app.getSystemService(NotificationManager.class);
            if (notifications != null && key != null) notifications.cancel(key.hashCode());
            background(app, () -> {
                Outbox.complete(app, id);      // or kept, until the server is back
                TodayWidget.refresh(app);
            });
            return;
        }

        if (Reminders.ACTION_SYNC.equals(action)) {
            resync(app);
        }
    }

    /** Re-read the list and put the alarms back. Shared with BootReceiver. */
    void resync(final Context app) {
        background(app, () -> {
            Outbox.drain(app);
            Reminders.sync(app);
            TodayWidget.refresh(app);
        });
    }

    /** Keeps the process alive for the network call; a receiver is otherwise
     *  dead the moment onReceive returns. */
    private void background(Context context, Runnable work) {
        final PendingResult done = goAsync();
        new Thread(() -> {
            try {
                work.run();
            } finally {
                done.finish();
            }
        }).start();
    }
}
