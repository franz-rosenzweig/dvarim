package xyz.tiresia.dvarim;

import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Fills the widget's list. onDataSetChanged runs off the main thread, which is
 *  the only reason it is allowed to go to the network. */
public class TodayWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new TodayFactory(getApplicationContext());
    }

    private static class Item {
        String id, title, sub;
        boolean evening;
    }

    private static class TodayFactory implements RemoteViewsFactory {
        private final Context context;
        private List<Item> items = new ArrayList<>();

        TodayFactory(Context context) { this.context = context; }

        @Override public void onCreate() {}
        @Override public void onDestroy() { items = new ArrayList<>(); }

        @Override
        public void onDataSetChanged() {
            List<Item> fresh = new ArrayList<>();
            // Ticks kept while the server was out of reach go first, and any
            // still waiting stay off the list rather than coming back unticked.
            Outbox.drain(context);
            Set<String> waiting = Outbox.waiting(context);
            try {
                JSONArray list = new JSONObject(Api.get(context, "/api/lists/today"))
                        .optJSONArray("items");
                for (int i = 0; list != null && i < list.length(); i++) {
                    JSONObject t = list.getJSONObject(i);
                    if (!"open".equals(t.optString("status")) || waiting.contains(t.optString("id"))) continue;
                    Item item = new Item();
                    item.id = t.optString("id");
                    item.title = t.optString("title");
                    item.evening = t.optBoolean("evening");
                    // The project or area a to-do belongs to, which is what the
                    // web app shows under the title.
                    String where = Api.text(t, "projectName");
                    if (where.isEmpty()) where = Api.text(t, "areaName");
                    item.sub = where;
                    fresh.add(item);
                }
            } catch (Api.NotSignedIn e) {
                fresh = one(context.getString(R.string.widgetSignIn));
            } catch (Exception e) {
                Log.w("Dvarim", "widget could not load today", e);
                fresh = one(context.getString(R.string.widgetOffline));
            }
            items = fresh;
        }

        /** A row that says what went wrong, rather than an empty list pretending
         *  the day is clear. It has no id, so it draws without a checkbox. */
        private static List<Item> one(String message) {
            Item item = new Item();
            item.title = message;
            item.sub = "";
            List<Item> only = new ArrayList<>();
            only.add(item);
            return only;
        }

        @Override public int getCount() { return items.size(); }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public RemoteViews getLoadingView() { return null; }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position >= items.size()) return null;
            Item item = items.get(position);
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_row);
            row.setTextViewText(R.id.title, item.title);
            row.setViewVisibility(R.id.check, item.id == null ? android.view.View.INVISIBLE
                                                              : android.view.View.VISIBLE);
            row.setTextViewText(R.id.sub, item.sub);
            row.setViewVisibility(R.id.sub, item.sub.isEmpty() ? android.view.View.GONE
                                                               : android.view.View.VISIBLE);
            row.setViewVisibility(R.id.evening, item.evening ? android.view.View.VISIBLE
                                                             : android.view.View.GONE);
            row.setOnClickFillInIntent(R.id.check, new Intent()
                    .putExtra(TodayWidget.EXTRA_ID, item.id)
                    .putExtra(TodayWidget.EXTRA_COMPLETE, true));
            row.setOnClickFillInIntent(R.id.row, new Intent()
                    .putExtra(TodayWidget.EXTRA_ID, item.id));
            return row;
        }
    }
}
