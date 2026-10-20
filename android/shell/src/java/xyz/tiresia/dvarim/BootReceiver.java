package xyz.tiresia.dvarim;

import android.content.Context;
import android.content.Intent;

/**
 * A reboot, or an update to the app, throws away every alarm the system was
 * holding for us. This is the only receiver the system itself talks to, so it
 * is the only one that has to be exported, and all it does is put them back.
 */
public class BootReceiver extends ReminderReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        Context app = context.getApplicationContext();
        Reminders.scheduleSyncs(app);
        resync(app);
    }
}
