package xyz.tiresia.dvarim;

import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract.Calendars;
import android.provider.CalendarContract.Instances;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/**
 * The bridge's `calendars` and `events` ops (docs/BRIDGE.md): the phone's own
 * calendars, from CalendarContract, for Today, Upcoming and Settings →
 * Calendar when the to-dos live in a folder and no server reads a calendar for
 * the page. Instances rather than Events: an instance is one occurrence, with
 * repeats already expanded. Needs READ_CALENDAR, which FolderBridge asks for.
 *
 * A test build can stand a file in for the phone's calendars (DevBuild), in
 * tools/bridge_sim.py's shape, so a check needs no calendar permission.
 */
final class DeviceCalendars {
    private DeviceCalendars() {}

    /** `[{name, color}]`: the calendars shown on the phone, one per name. */
    static JSONArray calendars(Context context) throws JSONException, IOException {
        File file = DevBuild.calendarsFile(context);
        if (file != null) return fromFile(file).optJSONArray("calendars");
        JSONArray out = new JSONArray();
        Set<String> seen = new HashSet<>();
        String[] columns = {Calendars.CALENDAR_DISPLAY_NAME, Calendars.CALENDAR_COLOR};
        try (Cursor c = context.getContentResolver().query(Calendars.CONTENT_URI, columns,
                Calendars.VISIBLE + " = 1", null, Calendars.CALENDAR_DISPLAY_NAME + " COLLATE NOCASE")) {
            while (c != null && c.moveToNext()) {
                String name = c.getString(0);
                if (name == null || !seen.add(name)) continue;
                out.put(new JSONObject().put("name", name).put("color", hex(c.isNull(1) ? 0 : c.getInt(1))));
            }
        }
        return out;
    }

    /** Every occurrence touching the days `from`..`to` (both included), in the
     *  calendars named, or all of them for null. */
    static JSONArray events(Context context, String from, String to, JSONArray names) throws JSONException, IOException {
        Set<String> only = null;
        if (names != null) {
            only = new HashSet<>();
            for (int i = 0; i < names.length(); i++) only.add(names.getString(i));
        }
        File file = DevBuild.calendarsFile(context);
        JSONArray out = new JSONArray();
        if (file != null) {
            JSONArray all = fromFile(file).optJSONArray("events");
            for (int i = 0; all != null && i < all.length(); i++) {
                JSONObject e = all.getJSONObject(i);
                String start = e.optString("start").substring(0, 10), end = e.optString("end", start).substring(0, 10);
                if (start.compareTo(to) <= 0 && end.compareTo(from) >= 0 && (only == null || only.contains(e.optString("calendar")))) out.put(e);
            }
            return out;
        }
        long begin = startOf(from, TimeZone.getDefault()), until = startOf(to, TimeZone.getDefault()) + 86_400_000L;
        // an all-day occurrence is kept in UTC; a day either side catches it wherever the phone is
        Uri.Builder range = Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(range, begin - 86_400_000L);
        ContentUris.appendId(range, until + 86_400_000L);
        String[] columns = {Instances.EVENT_ID, Instances.TITLE, Instances.BEGIN, Instances.END, Instances.ALL_DAY,
                Instances.CALENDAR_DISPLAY_NAME, Instances.DISPLAY_COLOR};
        try (Cursor c = context.getContentResolver().query(range.build(), columns, Instances.VISIBLE + " = 1", null, Instances.BEGIN)) {
            while (c != null && c.moveToNext()) {
                String calendar = c.getString(5) == null ? "" : c.getString(5);
                if (only != null && !only.contains(calendar)) continue;
                JSONObject row = row(c.getString(0), c.getString(1), calendar, c.isNull(6) ? 0 : c.getInt(6),
                        c.getInt(4) != 0, c.getLong(2), c.getLong(3), TimeZone.getDefault());
                String start = row.getString("start").substring(0, 10), end = row.getString("end").substring(0, 10);
                if (start.compareTo(to) <= 0 && end.compareTo(from) >= 0) out.put(row);
            }
        }
        return out;
    }

    /**
     * One occurrence as the page wants it (docs/BRIDGE.md): the phone's wall
     * time, and for an all-day event its days, the end being the day after the
     * last, as iCalendar has it and as CalendarContract keeps it. All-day
     * times are midnights in UTC, so they are read as UTC days.
     */
    static JSONObject row(String uid, String title, String calendar, int color, boolean allDay,
                          long begin, long end, TimeZone here) throws JSONException {
        JSONObject row = new JSONObject().put("uid", uid == null ? "" : uid).put("title", title == null ? "" : title)
                .put("calendar", calendar).put("color", hex(color)).put("allDay", allDay);
        if (allDay) {
            TimeZone utc = TimeZone.getTimeZone("UTC");
            String first = stamp(begin, utc, false);
            String after = stamp(Math.max(end, begin + 86_400_000L), utc, false);
            return row.put("start", first).put("end", after);
        }
        return row.put("start", stamp(begin, here, true)).put("end", stamp(Math.max(begin, end), here, true));
    }

    private static String stamp(long ms, TimeZone zone, boolean time) {
        Calendar c = Calendar.getInstance(zone);
        c.setTimeInMillis(ms);
        String day = String.format(Locale.ROOT, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
        return time ? day + String.format(Locale.ROOT, "T%02d:%02d", c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE)) : day;
    }

    private static long startOf(String day, TimeZone zone) {
        String[] p = day.split("-");
        Calendar c = Calendar.getInstance(zone);
        c.clear();
        c.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]));
        return c.getTimeInMillis();
    }

    static String hex(int argb) {
        return String.format(Locale.ROOT, "#%06X", argb & 0xFFFFFF);
    }

    private static JSONObject fromFile(File file) throws IOException, JSONException {
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] all = new byte[(int) file.length()];
            int read = 0;
            for (int n; read < all.length && (n = in.read(all, read, all.length - read)) > 0; ) read += n;
            return new JSONObject(new String(all, 0, read, StandardCharsets.UTF_8));
        }
    }
}
