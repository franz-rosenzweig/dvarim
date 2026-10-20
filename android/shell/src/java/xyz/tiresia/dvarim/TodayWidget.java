package xyz.tiresia.dvarim;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

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
 */
public class TodayWidget extends AppWidgetProvider {
    static final String ACTION_REFRESH = "xyz.tiresia.dvarim.REFRESH";
    static final String ACTION_ITEM = "xyz.tiresia.dvarim.ITEM";
    static final String EXTRA_ID = "todoId";
    static final String EXTRA_COMPLETE = "complete";

    @Override
    public void onUpdate(Context context, AppWidgetManager widgets, int[] ids) {
        for (int id : ids) render(context, widgets, id);
        widgets.notifyAppWidgetViewDataChanged(ids, R.id.list);
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
                // the row itself: that to-do, open where it lives
                open(context, id != null ? "/todo/" + id : "/today");
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
    }

    private static void render(Context context, AppWidgetManager widgets, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_today);
        views.setTextViewText(R.id.date,
                new SimpleDateFormat("EEE d MMM", Locale.getDefault()).format(new Date()));

        Intent items = new Intent(context, TodayWidgetService.class)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        // A distinct data Uri per widget, or Android reuses one adapter for all
        // of them and only the first ever updates.
        items.setData(Uri.parse(items.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.list, items);
        views.setEmptyView(R.id.list, R.id.empty);

        // One template for the collection; each row says in its fill-in extras
        // whether the tap was the checkbox or the row itself.
        views.setPendingIntentTemplate(R.id.list, PendingIntent.getBroadcast(
                context, 0, new Intent(context, TodayWidget.class).setAction(ACTION_ITEM),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE));
        views.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(
                context, 1, new Intent(context, TodayWidget.class).setAction(ACTION_REFRESH),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        views.setOnClickPendingIntent(R.id.header, PendingIntent.getActivity(
                context, 2, launch(context, "/today"),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        widgets.updateAppWidget(widgetId, views);
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
