package xyz.tiresia.dvarim;

import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Fills a widget's list: Today's to-dos, with This Evening as a section of its
 *  own when there's room, or the next days of Upcoming for the wide layout's
 *  second column. onDataSetChanged runs off the main thread, which is the only
 *  reason it is allowed to go to the network. */
public class TodayWidgetService extends RemoteViewsService {
    static final String EXTRA_KIND = "kind";
    static final String EXTRA_SECTIONS = "sections";
    static final String TODAY = "today";
    static final String UPCOMING = "upcoming";
    /** Upcoming's column: this many days ahead with something in them, at most. */
    private static final int DAYS = 7;

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext(),
                UPCOMING.equals(intent.getStringExtra(EXTRA_KIND)),
                intent.getBooleanExtra(EXTRA_SECTIONS, false));
    }

    /** A to-do, or (head != null) a section: This Evening, or a day. */
    private static class Item {
        String id, title, sub = "", head, list;
        boolean evening;
    }

    private static class Factory implements RemoteViewsFactory {
        private final Context context;
        private final boolean upcoming, sections;
        private List<Item> items = new ArrayList<>();

        Factory(Context context, boolean upcoming, boolean sections) {
            this.context = context;
            this.upcoming = upcoming;
            this.sections = sections;
        }

        @Override public void onCreate() {}
        @Override public void onDestroy() { items = new ArrayList<>(); }

        @Override
        public void onDataSetChanged() {
            // Ticks kept while the server was out of reach go first, and any
            // still waiting stay off the list rather than coming back unticked.
            Outbox.drain(context);
            Set<String> waiting = Outbox.waiting(context);
            try {
                items = upcoming ? upcoming(waiting) : today(waiting);
            } catch (Api.NotSignedIn e) {
                items = one(context.getString(R.string.widgetSignIn));
            } catch (Exception e) {
                Log.w("Dvarim", "widget could not load " + (upcoming ? "upcoming" : "today"), e);
                items = one(context.getString(R.string.widgetOffline));
            }
        }

        private List<Item> today(Set<String> waiting) throws Exception {
            JSONArray list = new JSONObject(Api.get(context, "/api/lists/today")).optJSONArray("items");
            List<Item> day = new ArrayList<>(), evening = new ArrayList<>();
            for (int i = 0; list != null && i < list.length(); i++) {
                JSONObject t = list.getJSONObject(i);
                if (!"open".equals(t.optString("status")) || waiting.contains(t.optString("id"))) continue;
                Item item = todo(t);
                (sections && item.evening ? evening : day).add(item);
            }
            if (!evening.isEmpty()) {
                Item head = new Item();
                head.head = context.getString(R.string.widgetEvening);
                head.list = "/today";
                head.evening = true;
                day.add(head);
                day.addAll(evening);
            }
            return day;
        }

        /** The next days with something in them, each under its name. */
        private List<Item> upcoming(Set<String> waiting) throws Exception {
            JSONArray days = new JSONObject(Api.get(context, "/api/lists/upcoming")).optJSONArray("days");
            List<Item> out = new ArrayList<>();
            int shown = 0;
            for (int d = 0; days != null && d < days.length() && shown < DAYS; d++) {
                JSONObject day = days.getJSONObject(d);
                JSONArray list = day.optJSONArray("items");
                List<Item> rows = new ArrayList<>();
                for (int i = 0; list != null && i < list.length(); i++) {
                    JSONObject t = list.getJSONObject(i);
                    if (!"open".equals(t.optString("status")) || waiting.contains(t.optString("id"))) continue;
                    rows.add(todo(t));
                }
                if (rows.isEmpty()) continue;
                Item head = new Item();
                head.head = dayName(day.optString("date"));
                head.list = "/upcoming";
                out.add(head);
                out.addAll(rows);
                shown++;
            }
            return out;
        }

        private static Item todo(JSONObject t) {
            Item item = new Item();
            item.id = t.optString("id");
            item.title = t.optString("title");
            item.evening = t.optBoolean("evening");
            // The project or area a to-do belongs to, which is what the web
            // app shows under the title.
            String where = Api.text(t, "projectName");
            if (where.isEmpty()) where = Api.text(t, "areaName");
            item.sub = where;
            return item;
        }

        /** Tomorrow, a weekday this week, then "Sat 7 Nov". */
        private String dayName(String iso) {
            try {
                SimpleDateFormat parse = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
                Date date = parse.parse(iso);
                Calendar today = Calendar.getInstance();
                today.set(Calendar.HOUR_OF_DAY, 0);
                today.set(Calendar.MINUTE, 0);
                today.set(Calendar.SECOND, 0);
                today.set(Calendar.MILLISECOND, 0);
                long days = Math.round((date.getTime() - today.getTimeInMillis()) / 86400000.0);
                if (days == 1) return context.getString(R.string.widgetTomorrow);
                if (days < 7) return new SimpleDateFormat("EEEE", Locale.getDefault()).format(date);
                return new SimpleDateFormat("EEE d MMM", Locale.getDefault()).format(date);
            } catch (ParseException | NullPointerException e) {
                return iso;
            }
        }

        /** A row that says what went wrong, rather than an empty list pretending
         *  the day is clear. It has no id, so it draws without a checkbox. */
        private static List<Item> one(String message) {
            Item item = new Item();
            item.title = message;
            List<Item> only = new ArrayList<>();
            only.add(item);
            return only;
        }

        @Override public int getCount() { return items.size(); }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
        @Override public int getViewTypeCount() { return 2; }
        @Override public RemoteViews getLoadingView() { return null; }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position >= items.size()) return null;
            Item item = items.get(position);
            if (item.head != null) {
                RemoteViews head = new RemoteViews(context.getPackageName(), R.layout.widget_header_row);
                head.setTextViewText(R.id.head, item.head);
                head.setViewVisibility(R.id.headIcon, item.evening ? View.VISIBLE : View.GONE);
                head.setOnClickFillInIntent(R.id.row, new Intent().putExtra(TodayWidget.EXTRA_LIST, item.list));
                return head;
            }
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_row);
            row.setTextViewText(R.id.title, item.title);
            row.setViewVisibility(R.id.check, item.id == null ? View.INVISIBLE : View.VISIBLE);
            row.setTextViewText(R.id.sub, item.sub);
            row.setViewVisibility(R.id.sub, item.sub.isEmpty() ? View.GONE : View.VISIBLE);
            // under its own heading, This Evening needs no moon on each row
            row.setViewVisibility(R.id.evening, item.evening && !sections ? View.VISIBLE : View.GONE);
            row.setOnClickFillInIntent(R.id.check, new Intent()
                    .putExtra(TodayWidget.EXTRA_ID, item.id)
                    .putExtra(TodayWidget.EXTRA_COMPLETE, true));
            row.setOnClickFillInIntent(R.id.row, new Intent()
                    .putExtra(TodayWidget.EXTRA_ID, item.id));
            return row;
        }
    }
}
