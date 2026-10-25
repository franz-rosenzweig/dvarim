package xyz.tiresia.dvarim;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.SizeF;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Today, on the home screen.
 *
 * The one thing a web app cannot reach on Android: a view of the list without
 * opening anything, and a checkbox you can tick from there. Both go through the
 * same session cookie the app holds, so there is no second sign-in.
 *
 * Android only refreshes a widget every half hour at best, so the refresh here
 * is also wired to the button in its corner, to ticking something off, and to
 * launching the app — which covers every moment the list plausibly changed.
 *
 * From Android 12 the launcher picks one of three layouts by the widget's size
 * as it's resized: small, the list as it always was; taller, This Evening as a
 * section of its own; at a tablet's width, Upcoming's next days beside Today.
 */
public class TodayWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "xyz.tiresia.dvarim.REFRESH";
    static final String ACTION_ITEM = "xyz.tiresia.dvarim.ITEM";
    static final String EXTRA_ID = "todoId";
    static final String EXTRA_COMPLETE = "complete";
    static final String EXTRA_LIST = "list";

    @Override
    public void onUpdate(Context context, AppWidgetManager widgets, int[] ids) {
        for (int id : ids) render(context, widgets, id);
        widgets.notifyAppWidgetViewDataChanged(ids, R.id.list);
        widgets.notifyAppWidgetViewDataChanged(ids, R.id.upcoming);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (ACTION_REFRESH.equals(action)) {
            refresh(context);
        } else if (ACTION_ITEM.equals(action)) {
            String id = intent.getStringExtra(EXTRA_ID);
            if (intent.getBooleanExtra(EXTRA_COMPLETE, false) && id != null) {
                complete(context, id);
            } else {
                // the row itself: that to-do, open where it lives; a section, its list
                String list = intent.getStringExtra(EXTRA_LIST);
                open(context, id != null ? "/todo/" + id : list != null ? list : "/today");
            }
        }
    }

    /** Redraw every placed copy and make the list refetch. */
    static void refresh(Context context) {
        AppWidgetManager widgets = AppWidgetManager.getInstance(context);
        int[] ids = widgets.getAppWidgetIds(new ComponentName(context, TodayWidget.class));
        if (ids.length == 0) return;
        for (int id : ids) render(context, widgets, id);
        widgets.notifyAppWidgetViewDataChanged(ids, R.id.list);
        widgets.notifyAppWidgetViewDataChanged(ids, R.id.upcoming);
    }

    /** The smallest size, in dp, each layout is for; the launcher takes the
     *  largest that fits. A 10.9" tablet's home screen cell is about 100dp. */
    private static final SizeF SMALL = new SizeF(140, 70);
    private static final SizeF TALL = new SizeF(180, 280);
    private static final SizeF WIDE = new SizeF(440, 220);

    private static void render(Context context, AppWidgetManager widgets, int widgetId) {
        if (Build.VERSION.SDK_INT >= 31) {
            Map<SizeF, RemoteViews> sizes = new HashMap<>();
            sizes.put(SMALL, layout(context, widgetId, R.layout.widget_today, false, false));
            sizes.put(TALL, layout(context, widgetId, R.layout.widget_today, true, false));
            sizes.put(WIDE, layout(context, widgetId, R.layout.widget_today_wide, true, true));
            widgets.updateAppWidget(widgetId, new RemoteViews(sizes));
        } else {
            widgets.updateAppWidget(widgetId, layout(context, widgetId, R.layout.widget_today, false, false));
        }
    }

    private static RemoteViews layout(Context context, int widgetId, int layout, boolean sections, boolean upcoming) {
        RemoteViews views = new RemoteViews(context.getPackageName(), layout);
        views.setTextViewText(R.id.date,
                new SimpleDateFormat("EEE d MMM", Locale.getDefault()).format(new Date()));

        views.setRemoteAdapter(R.id.list, adapter(context, widgetId, TodayWidgetService.TODAY, sections));
        views.setEmptyView(R.id.list, R.id.empty);
        // One template for the collection; each row says in its fill-in extras
        // whether the tap was the checkbox or the row itself.
        views.setPendingIntentTemplate(R.id.list, itemTemplate(context));
        if (upcoming) {
            views.setRemoteAdapter(R.id.upcoming, adapter(context, widgetId, TodayWidgetService.UPCOMING, true));
            views.setEmptyView(R.id.upcoming, R.id.upcomingEmpty);
            views.setPendingIntentTemplate(R.id.upcoming, itemTemplate(context));
            views.setOnClickPendingIntent(R.id.upcomingHeader, PendingIntent.getActivity(
                    context, 3, launch(context, "/upcoming"),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        views.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(
                context, 1, new Intent(context, TodayWidget.class).setAction(ACTION_REFRESH),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        views.setOnClickPendingIntent(R.id.header, PendingIntent.getActivity(
                context, 2, launch(context, "/today"),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return views;
    }

    /** A list's rows. A distinct data Uri per widget and per kind of list, or
     *  Android reuses one adapter for all of them and only the first updates. */
    private static Intent adapter(Context context, int widgetId, String kind, boolean sections) {
        Intent items = new Intent(context, TodayWidgetService.class)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .putExtra(TodayWidgetService.EXTRA_KIND, kind)
                .putExtra(TodayWidgetService.EXTRA_SECTIONS, sections);
        items.setData(Uri.parse(items.toUri(Intent.URI_INTENT_SCHEME)));
        return items;
    }

    private static PendingIntent itemTemplate(Context context) {
        return PendingIntent.getBroadcast(
                context, 0, new Intent(context, TodayWidget.class).setAction(ACTION_ITEM),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    /** Completed, or kept on the phone until the server can be reached (Outbox). */
    private void complete(Context context, String id) {
        final PendingResult done = goAsync();
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                Outbox.complete(app, id);
            } finally {
                refresh(app);
                done.finish();
            }
        }).start();
    }

    private static void open(Context context, String path) {
        context.startActivity(launch(context, path));
    }

    /** The launcher activity takes its destination from the intent's data, the
     *  same way the home-screen shortcuts do. */
    static Intent launch(Context context, String path) {
        return new Intent(context, LauncherActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .setData(Uri.parse(Server.base(context)).buildUpon().path(path).build())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }
}
