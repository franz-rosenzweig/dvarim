package xyz.tiresia.dvarim;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

/**
 * Reminders that arrive when the app is closed.
 *
 * A Trusted Web Activity would get these through Web Push, delivered by Chrome.
 * There is no Chrome here — the app renders the site itself — so the shell has
 * to do it: read today's list through the session cookie the WebView already
 * holds, and hand each ⏰ to AlarmManager.
 *
 * Time is the subtle part. A reminder is "15:00" against the to-do's own When
 * date, and the person means three in the afternoon where they are standing,
 * not where the server is: the container runs on America/Phoenix and the phone
 * may be anywhere. So the two are combined in the device's timezone and never
 * in the server's.
 *
 * The server's own Signal reminders, if they are configured, are unaffected;
 * this is a second delivery, not a replacement — which is why it can be
 * turned off, in the app's own Settings, as the Mac's can.
 */
public final class Reminders {
    static final String CHANNEL = "reminders";
    static final String ACTION_REMIND = "xyz.tiresia.dvarim.REMIND";
    static final String ACTION_SYNC = "xyz.tiresia.dvarim.SYNC";
    static final String ACTION_COMPLETE = "xyz.tiresia.dvarim.COMPLETE";
    static final String EXTRA_KEY = "key";
    static final String EXTRA_ID = "todoId";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_SUB = "sub";
    /** Which server the to-do behind this alarm came from; see ReminderReceiver. */
    static final String EXTRA_BASE = "base";

    private static final String PREFS = "dvarim.reminders";
    private static final String KEY_ASKED = "askedForNotifications";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_FIRED = "fired";
    private static final String KEY_FIRED_DAY = "firedDay";
    /** A reminder missed while the phone was off is worth catching up on; one
     *  from this morning, when it is now evening, is just noise. */
    private static final long CATCH_UP_MS = 6 * 60 * 60 * 1000L;
    /** Its own id, so a second test replaces the first rather than stacking. */
    private static final int TEST_ID = "dvarim.test".hashCode();

    private Reminders() {}

    /** Called from LauncherActivity: the one moment we have an Activity, and a
     *  good moment to catch up on everything. */
    public static void onLaunch(Activity activity) {
        askForNotifications(activity);
        scheduleSyncs(activity);
        final Context context = activity.getApplicationContext();
        new Thread(() -> {
            Outbox.drain(context);
            sync(context);
            TodayWidget.refresh(context);
        }).start();
    }

    /** Whether this phone delivers reminders at all. On unless turned off. */
    static boolean enabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, true);
    }

    /** From Settings. Turned on, the alarms are set again at once; turned off,
     *  those already set are dropped as they go off (ReminderReceiver). */
    static void setEnabled(Context context, boolean on) {
        prefs(context).edit().putBoolean(KEY_ENABLED, on).apply();
        if (on) {
            final Context app = context.getApplicationContext();
            new Thread(() -> sync(app)).start();
        }
    }

    private static void askForNotifications(Activity activity) {
        if (Build.VERSION.SDK_INT < 33) return;
        if (activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences prefs = prefs(activity);
        // Android stops showing the dialog after two refusals; asking on every
        // launch after that would only be rude.
        if (prefs.getBoolean(KEY_ASKED, false)) return;
        prefs.edit().putBoolean(KEY_ASKED, true).apply();
        activity.requestPermissions(
                new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 42);
    }

    /** An hourly nudge to re-read the list, plus whatever a launch gives us.
     *  Inexact on purpose: Doze will batch it with everything else that wakes. */
    static void scheduleSyncs(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        alarms.setInexactRepeating(AlarmManager.ELAPSED_REALTIME,
                SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_HALF_HOUR,
                AlarmManager.INTERVAL_HOUR,
                broadcast(context, new Intent(context, ReminderReceiver.class)
                        .setAction(ACTION_SYNC), 0));
    }

    /** Where the to-dos behind an alarm came from: the server's address, or the
     *  folder's. An alarm from somewhere else is dropped when it goes off. */
    static String source(Context context) {
        if (Folder.copy(context) != null) return "copy:" + Server.base(context);
        return Folder.isOn(context) ? "folder:" + Folder.tree(context) : Server.base(context);
    }

    /** Blocking. Reads today's list and puts an alarm on every ⏰ still to come.
     *  On a folder, the lists the page last gave (Local), and every day ahead in
     *  them: with the app closed nothing else sets tomorrow's. */
    static void sync(Context context) {
        if (!enabled(context)) return;
        JSONArray items;
        try {
            items = Folder.isOn(context) ? Local.ahead(context)
                    : new JSONObject(Api.get(context, "/api/lists/today")).optJSONArray("items");
        } catch (Api.NotSignedIn e) {
            return;                       // nothing to do until someone signs in
        } catch (Exception e) {
            Log.w("Dvarim", "could not read today for reminders", e);
            return;
        }
        long now = System.currentTimeMillis();
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject todo = items.optJSONObject(i);
            if (todo == null || !"open".equals(todo.optString("status"))) continue;
            String when = todo.optString("when", "");
            String at = todo.optString("reminder", "");
            if (when.isEmpty() || at.isEmpty() || "null".equals(at)) continue;
            long due = localMillis(when, at);
            if (due == 0) continue;
            String key = todo.optString("id") + "@" + when + "T" + at;
            String sub = Api.text(todo, "projectName");
            if (sub.isEmpty()) sub = Api.text(todo, "areaName");
            Intent remind = new Intent(context, ReminderReceiver.class)
                    .setAction(ACTION_REMIND)
                    .putExtra(EXTRA_KEY, key)
                    .putExtra(EXTRA_ID, todo.optString("id"))
                    .putExtra(EXTRA_TITLE, todo.optString("title"))
                    .putExtra(EXTRA_SUB, sub)
                    .putExtra(EXTRA_BASE, source(context));
            if (due > now) {
                set(context, due, broadcast(context, remind, key.hashCode()));
            } else if (now - due < CATCH_UP_MS && !alreadyFired(context, key)) {
                show(context, key, todo.optString("id"), todo.optString("title"), sub);
            }
        }
    }

    private static void set(Context context, long due, PendingIntent fire) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        if (Build.VERSION.SDK_INT < 23) {
            alarms.setExact(AlarmManager.RTC_WAKEUP, due, fire);
        } else if (Build.VERSION.SDK_INT >= 31 && !alarms.canScheduleExactAlarms()) {
            // From Android 12 an exact alarm is a permission the person grants
            // under "Alarms & reminders". Without it the reminder still arrives,
            // within a few minutes rather than on the dot, which is the right
            // thing to degrade to rather than nagging for the permission.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, fire);
        } else {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, fire);
        }
    }

    /** "2026-09-20" + "15:00" in the phone's timezone, not the server's. */
    static long localMillis(String when, String at) {
        try {
            String[] date = when.split("-");
            String[] time = at.split(":");
            Calendar c = Calendar.getInstance();
            c.clear();
            c.set(Integer.parseInt(date[0]), Integer.parseInt(date[1]) - 1,
                  Integer.parseInt(date[2]), Integer.parseInt(time[0]), Integer.parseInt(time[1]), 0);
            return c.getTimeInMillis();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    static void show(Context context, String key, String id, String title, String sub) {
        NotificationManager notifications =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (notifications == null) return;
        channel(context, notifications);
        // the to-do itself, open where it lives
        Intent open = TodayWidget.launch(context, id != null ? "/todo/" + id : "/today");
        Intent done = new Intent(context, ReminderReceiver.class)
                .setAction(ACTION_COMPLETE)
                .putExtra(EXTRA_KEY, key)
                .putExtra(EXTRA_ID, id);

        android.app.Notification.Builder note =
                (Build.VERSION.SDK_INT >= 26 ? new android.app.Notification.Builder(context, CHANNEL)
                                             : new android.app.Notification.Builder(context))
                .setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle(title)
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(context, key.hashCode(), open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                // The three-argument addAction is deprecated in favour of an
                // Action.Builder that wants an Icon, which is API 23; this one
                // works everywhere and an iconless action is what Android draws
                // in the shade anyway.
                .addAction(0, context.getString(R.string.remindersComplete),
                        broadcast(context, done, ("done" + key).hashCode()));
        if (!sub.isEmpty()) note.setContentText(sub);

        notifications.notify(key.hashCode(), note.build());
        markFired(context, key);
    }

    /**
     * A notification with nothing behind it.
     *
     * Settings offers this because every part of the path from an alarm to the
     * shade is somebody else's to allow — the notification permission, the
     * channel, the battery settings — and the only way to find out that one of
     * them is off is to have expected a reminder that never came.
     */
    static void test(Context context) {
        NotificationManager notifications =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (notifications == null) return;
        channel(context, notifications);
        notifications.notify(TEST_ID,
                (Build.VERSION.SDK_INT >= 26 ? new android.app.Notification.Builder(context, CHANNEL)
                                             : new android.app.Notification.Builder(context))
                        .setSmallIcon(R.drawable.ic_notification_icon)
                        .setContentTitle(context.getString(R.string.settingsTestTitle))
                        .setContentText(context.getString(R.string.settingsTestBody))
                        .setAutoCancel(true)
                        // Opens the app, as a real one does: a notification with
                        // nothing behind it does not go away when it is tapped.
                        .setContentIntent(PendingIntent.getActivity(context, TEST_ID,
                                TodayWidget.launch(context, "/today"),
                                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                        .build());
    }

    /** The channel every reminder goes out on. Creating it again is a no-op, so
     *  this is simply where anything that notifies starts. */
    private static void channel(Context context, NotificationManager notifications) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL,
                context.getString(R.string.remindersChannel), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.remindersChannelWhy));
        notifications.createNotificationChannel(channel);
    }

    static PendingIntent broadcast(Context context, Intent intent, int request) {
        return PendingIntent.getBroadcast(context, request, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ---- "we already showed this one", kept for the day it belongs to -------
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String today() {
        Calendar c = Calendar.getInstance();
        return c.get(Calendar.YEAR) + "-" + c.get(Calendar.DAY_OF_YEAR);
    }

    private static boolean alreadyFired(Context context, String key) {
        SharedPreferences prefs = prefs(context);
        if (!today().equals(prefs.getString(KEY_FIRED_DAY, ""))) return false;
        return prefs.getStringSet(KEY_FIRED, new HashSet<>()).contains(key);
    }

    private static void markFired(Context context, String key) {
        SharedPreferences prefs = prefs(context);
        Set<String> fired = today().equals(prefs.getString(KEY_FIRED_DAY, ""))
                ? new HashSet<>(prefs.getStringSet(KEY_FIRED, new HashSet<>()))
                : new HashSet<>();
        fired.add(key);
        prefs.edit().putString(KEY_FIRED_DAY, today()).putStringSet(KEY_FIRED, fired).apply();
    }
}
