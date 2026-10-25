package xyz.tiresia.dvarim;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * "New To-Do" on the home screen: a line to tap, and the app opens on /new, an
 * empty to-do in the Inbox with its title waiting for the keyboard or the
 * S Pen. The same trip as the quick settings tile (NewTodoTile), from where a
 * tablet's hand already is.
 */
public class NewTodoWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager widgets, int[] ids) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_new);
        views.setOnClickPendingIntent(R.id.newTodo, PendingIntent.getActivity(
                context, 10, TodayWidget.launch(context, "/new"),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        for (int id : ids) widgets.updateAppWidget(id, views);
    }
}
