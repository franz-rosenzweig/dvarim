package xyz.tiresia.dvarim;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.Locale;

/**
 * The folder's lists as the page last gave them, kept on the phone for what
 * runs with the app closed: reminders and the Today widget. On a folder there
 * is no server to ask, and only the page can make lists of the folder's
 * Markdown, so FolderActivity keeps its answers here when the page comes up
 * and whenever the vault changes (op `changed`). With the app closed they are
 * what the folder held when it was last open.
 *
 * Today is kept as of its day. Asked on a later day it is made again from
 * what was kept: whatever was left in Today then is still there, its day only
 * further behind, and so is whatever Upcoming had for the days since.
 */
final class Local {
    static final String TODAY = "/api/lists/today";
    static final String UPCOMING = "/api/lists/upcoming";
    static final String[] KEPT = {TODAY, UPCOMING};

    private Local() {}

    /** What Api answers on a folder: a list that was kept, or IOException,
     *  which a tick takes as "keep it for later" (Outbox). */
    static String answer(Context context, String method, String path) throws IOException {
        if (!"GET".equals(method)) throw new IOException("on a folder, " + method + " " + path + " waits for the app to open");
        if (TODAY.equals(path)) return today(context).toString();
        String kept = read(context, path);
        if (kept == null) throw new IOException("nothing kept yet: open Dvarim once");
        return kept;
    }

    static void keep(Context context, String path, String json) throws IOException {
        File to = file(context, path), temp = new File(to.getParentFile(), to.getName() + ".tmp");
        to.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        }
        if (!temp.renameTo(to)) throw new IOException("could not keep " + path);
    }

    /** Today, as of today, however long ago it was kept. */
    static JSONObject today(Context context) throws IOException {
        String kept = read(context, TODAY);
        if (kept == null) throw new IOException("nothing kept yet: open Dvarim once");
        try {
            JSONObject today = new JSONObject(kept);
            String now = day();
            if (now.equals(today.optString("date"))) return today;
            JSONArray items = new JSONArray();
            JSONArray was = today.optJSONArray("items");
            for (int i = 0; was != null && i < was.length(); i++) {
                JSONObject t = was.getJSONObject(i);
                if ("open".equals(t.optString("status"))) items.put(t);
            }
            for (JSONObject d : days(context)) {
                if (d.optString("date").compareTo(now) > 0) break;
                JSONArray more = d.optJSONArray("items");
                for (int i = 0; more != null && i < more.length(); i++) items.put(more.getJSONObject(i));
            }
            return new JSONObject().put("date", now).put("items", items);
        } catch (JSONException e) {
            throw new IOException("what was kept is not a list: " + e.getMessage());
        }
    }

    /** Every to-do from today on: Today's, then Upcoming's after today. For reminders. */
    static JSONArray ahead(Context context) throws IOException {
        JSONArray out = new JSONArray();
        try {
            JSONArray today = today(context).optJSONArray("items");
            for (int i = 0; today != null && i < today.length(); i++) out.put(today.getJSONObject(i));
            String now = day();
            for (JSONObject d : days(context)) {
                if (d.optString("date").compareTo(now) <= 0) continue;
                JSONArray items = d.optJSONArray("items");
                for (int i = 0; items != null && i < items.length(); i++) out.put(items.getJSONObject(i));
            }
        } catch (JSONException e) {
            throw new IOException("what was kept is not a list: " + e.getMessage());
        }
        return out;
    }

    /** Upcoming's days, in order, or none if nothing was kept. */
    private static java.util.List<JSONObject> days(Context context) throws JSONException {
        java.util.List<JSONObject> out = new java.util.ArrayList<>();
        String up = read(context, UPCOMING);
        JSONArray days = up == null ? null : new JSONObject(up).optJSONArray("days");
        for (int i = 0; days != null && i < days.length(); i++) out.add(days.getJSONObject(i));
        return out;
    }

    /** Today where the phone is, as the page writes a day. */
    static String day() {
        Calendar c = Calendar.getInstance();
        return String.format(Locale.ROOT, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    /** Forget everything kept: another folder, or back to the server. */
    static void forget(Context context) {
        for (String path : KEPT) file(context, path).delete();
    }

    private static File file(Context context, String path) {
        return new File(new File(context.getFilesDir(), "local"), path.replace('/', '_') + ".json");
    }

    private static String read(Context context, String path) {
        File f = file(context, path);
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] all = new byte[(int) f.length()];
            int read = 0;
            for (int n; read < all.length && (n = in.read(all, read, all.length - read)) > 0; ) read += n;
            return new String(all, 0, read, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }
}
