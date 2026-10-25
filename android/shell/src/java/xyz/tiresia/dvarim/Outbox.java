package xyz.tiresia.dvarim;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Ticks the shell makes on its own — a checkbox on the Today widget, a
 * reminder's Complete — kept on the phone while the server cannot be reached,
 * and sent when it can. Without this a tick on a plane was lost without a word:
 * the reminder went from the shade and the to-do stayed open on the server.
 *
 * The same idea as the Mac's (mac/Native/Shell/Outbox.swift), and apart from the web
 * app's own in the window (frontend/src/lib/outbox.js), which covers everything
 * done on the page. Only completions come through here. Completing a done
 * to-do changes nothing, so one whose answer was lost on the way back is simply
 * sent again; each carries the day it was ticked, which is the day the Logbook
 * files it under, not the day the phone found signal again.
 *
 * What is waiting goes out when the app opens, when the reminders re-read the
 * list, when the widget refreshes, and — the one that needs no one to do
 * anything — as soon as the phone has a network again (OutboxJob).
 *
 * On a folder there is no server to send to, and only the page can write the
 * folder's Markdown: a tick waits here until the page is up, and FolderActivity
 * makes it there (drainOutbox), at once if the app is open.
 */
final class Outbox {
    private static final String PREFS = "dvarim.outbox";
    private static final String KEY_OPS = "ops";
    private static final int JOB_ID = "dvarim.outbox".hashCode();

    private Outbox() {}

    /** Blocking. Complete a to-do, or keep the tick for later. */
    static void complete(Context context, String id) {
        String on = today();
        try {
            send(context, id, on);
        } catch (Api.Refused e) {
            // Deleted elsewhere meanwhile, say: nothing to keep it for.
            Log.w("Dvarim", "the server would not complete " + id, e);
        } catch (Exception e) {
            // Unreachable, or signed out: a tick is not to be dropped over either.
            keep(context, id, on);
        }
    }

    /** Blocking. Send what is waiting, each on its own; returns how many went.
     *  On a folder, nothing: FolderActivity sends them through the page. */
    static int drain(Context context) {
        if (Folder.isOn(context)) return 0;
        JSONArray ops = ops(context);
        if (ops.length() == 0) return 0;
        Set<String> handled = new HashSet<>();
        for (int i = 0; i < ops.length(); i++) {
            JSONObject op = ops.optJSONObject(i);
            if (op == null) continue;
            String id = op.optString("id");
            try {
                send(context, id, op.optString("on"));
                handled.add(id);
            } catch (Api.Refused e) {
                Log.w("Dvarim", "the server would not complete " + id + ", kept since " + op.optString("on"), e);
                handled.add(id);
            } catch (Exception e) {
                // still out of reach, or signed out: it waits
            }
        }
        forget(context, handled);
        return handled.size();
    }

    /** The to-dos ticked here and not yet sent, which the widget leaves out. */
    static Set<String> waiting(Context context) {
        Set<String> ids = new HashSet<>();
        JSONArray ops = ops(context);
        for (int i = 0; i < ops.length(); i++) {
            JSONObject op = ops.optJSONObject(i);
            if (op != null) ids.add(op.optString("id"));
        }
        return ids;
    }

    /** What is waiting, as `[{id, on}, …]`, for FolderActivity to make through the page. */
    static JSONArray pending(Context context) {
        return ops(context);
    }

    /** The page made these (FolderBridge.sent). */
    static void forgetSent(Context context, Set<String> ids) {
        forget(context, ids);
    }

    private static void send(Context context, String id, String on) throws Exception {
        Api.post(context, "/api/todos/" + id + "/complete", new JSONObject().put("on", on).toString());
    }

    private static synchronized void keep(Context context, String id, String on) {
        JSONArray ops = ops(context);
        try {
            ops.put(new JSONObject().put("id", id).put("on", on));
        } catch (JSONException e) {
            return;                        // a String and a String: cannot happen
        }
        prefs(context).edit().putString(KEY_OPS, ops.toString()).apply();
        if (Folder.isOn(context)) {
            FolderActivity.tickKept();         // no network to wait for: the page, when it is up
        } else {
            schedule(context);
        }
    }

    /** Only what this drain dealt with: a tick kept while it was sending waits on. */
    private static synchronized void forget(Context context, Set<String> sent) {
        if (sent.isEmpty()) return;
        JSONArray left = new JSONArray();
        JSONArray ops = ops(context);
        for (int i = 0; i < ops.length(); i++) {
            JSONObject op = ops.optJSONObject(i);
            if (op != null && !sent.contains(op.optString("id"))) left.put(op);
        }
        prefs(context).edit().putString(KEY_OPS, left.toString()).apply();
    }

    private static synchronized JSONArray ops(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_OPS, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Run OutboxJob once there is a network, surviving a reboot meanwhile. A
     *  job refused (it takes ACCESS_NETWORK_STATE) must not take the process
     *  with it: the tick is kept already, and the next launch sends it. */
    private static void schedule(Context context) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs == null) return;
        try {
            jobs.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, OutboxJob.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build());
        } catch (RuntimeException e) {
            Log.w("Dvarim", "could not schedule the outbox", e);
        }
    }

    /** Today where the phone is, which is what a tick means. */
    private static String today() {
        Calendar c = Calendar.getInstance();
        return String.format(Locale.ROOT, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
