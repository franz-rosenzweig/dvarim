package xyz.tiresia.dvarim;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.RadioGroup;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Collections;

/**
 * The shell's own settings: what the page cannot answer for itself.
 *
 * Which server (Server.java — the page is served by it, so it is the wrong
 * place to change which one), whether this phone reminds at all and whether
 * Android is letting those reminders through (that is a permission, and the
 * app asks for it once, ever), and which build this is — which matters more
 * than it sounds on a phone carrying a release, a test build and an Island
 * clone under the same icon.
 *
 * Reachable two ways, deliberately. "Settings" in the launcher's long-press
 * menu works with no server at all, which is the case this screen exists for.
 * A link in the web app's own Settings → Data is where someone would look
 * first; it is a dvarim://settings URL, and android-browser-helper's WebView
 * hands any navigation off its own origin to an ACTION_VIEW intent, which is
 * the one this activity answers.
 */
public class SettingsActivity extends Activity {
    private static final int PICK_FOLDER = 43;

    private RadioGroup where;
    private TextView folderName, folderNote;
    private View folderRow;
    /** While the radio buttons are being set from what is saved, not by a finger. */
    private boolean showingWhere;
    private EditText server;
    private TextView serverState, notifyState, alarmState;
    private Button builtIn, alarms;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.settings);

        server = findViewById(R.id.server);
        serverState = findViewById(R.id.serverState);
        notifyState = findViewById(R.id.notifyState);
        alarmState = findViewById(R.id.alarmState);
        builtIn = findViewById(R.id.builtIn);
        alarms = findViewById(R.id.alarms);

        where = findViewById(R.id.where);
        folderRow = findViewById(R.id.folderRow);
        folderName = findViewById(R.id.folderName);
        folderNote = findViewById(R.id.folderNote);
        where.setOnCheckedChangeListener((group, id) -> { if (!showingWhere) chooseWhere(id); });
        findViewById(R.id.chooseFolder).setOnClickListener(v -> pickFolder());
        showWhere();

        server.setText(Server.origin(this));
        findViewById(R.id.test).setOnClickListener(v -> test());
        findViewById(R.id.save).setOnClickListener(v -> save());
        builtIn.setOnClickListener(v -> {
            server.setText(Server.builtIn(this));
            server.setSelection(server.getText().length());
        });
        // What is under the field is about what is in it, so it follows every
        // keystroke: why an address will not do, the way back to the built-in
        // one, and the answer to a Test that is now about a different address.
        server.addTextChangedListener(new TextWatcher() {
            @Override public void afterTextChanged(Editable text) { showServer(); }
            @Override public void beforeTextChanged(CharSequence t, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence t, int a, int b, int c) {}
        });

        Switch remind = findViewById(R.id.remind);
        remind.setChecked(Reminders.enabled(this));
        remind.setOnCheckedChangeListener((v, on) -> Reminders.setEnabled(this, on));
        findViewById(R.id.notify).setOnClickListener(v -> openNotificationSettings());
        alarms.setOnClickListener(v -> openAlarmSettings());
        findViewById(R.id.testReminder).setOnClickListener(v -> {
            Reminders.test(this);
            toast(getString(R.string.settingsTestSent));
        });
        findViewById(R.id.clearCache).setOnClickListener(v -> clearCache());

        showAbout();
        showServer();
    }

    /** Both permissions can be changed from outside the app, and coming back
     *  from Android's own screens is exactly when they will have been. */
    @Override
    protected void onResume() {
        super.onResume();
        showNotifications();
    }

    // ------------------------------------------------------------ server

    private void showServer() {
        String typed = server.getText().toString();
        String origin = Server.parse(typed);
        boolean isBuiltIn = origin != null && origin.equals(Server.builtIn(this));
        builtIn.setVisibility(isBuiltIn ? View.GONE : View.VISIBLE);
        if (origin == null) {
            serverState.setText(Server.looksCleartext(typed)
                    ? R.string.settingsServerNeedsHttps : R.string.settingsNotAnAddress);
        } else if (isBuiltIn) {
            serverState.setText(R.string.settingsServerBuiltIn);
        } else {
            serverState.setText("");
        }
    }

    /** Is anything answering there? Asks before saving, so a typo is a sentence
     *  on this screen rather than an app that opens on an error page. */
    private void test() {
        final String origin = Server.parse(server.getText().toString());
        if (origin == null) {
            showServer();                 // it says why
            return;
        }
        serverState.setText(R.string.settingsTesting);
        new Thread(() -> {
            String why = null;
            try {
                Api.probe(origin);
            } catch (Exception e) {
                why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            }
            final String failed = why;
            runOnUiThread(() -> {
                // Typing while it was knocking means the answer is about an
                // address that is no longer in the box.
                if (!origin.equals(Server.parse(server.getText().toString()))) return;
                serverState.setText(failed == null
                        ? getString(R.string.settingsReachable, origin)
                        : getString(R.string.settingsUnreachable, origin, failed));
            });
        }).start();
    }

    private void save() {
        String was = Server.origin(this);
        String origin = Server.set(this, server.getText().toString());
        if (origin == null) {
            showServer();                 // it says why
            return;
        }
        if (origin.equals(was)) {
            finish();                     // already there; nothing to restart for
            return;
        }
        // The alarms already set belong to the old server's to-dos, and so do
        // any notifications on screen. ReminderReceiver drops the alarms when
        // they fire; the shade is ours to clear now.
        NotificationManager notifications =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (notifications != null) notifications.cancelAll();
        toast(getString(R.string.settingsSaved, origin));
        restart();
    }

    /** The window behind this one is still showing the old server, or the old
     *  folder. Start the app over rather than leaving it there looking like it worked. */
    private void restart() {
        startActivity(new Intent(this, LauncherActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        finish();
    }

    // ------------------------------------------------------ where they live

    private void showWhere() {
        String mode = Folder.mode(this);
        boolean folder = "folder".equals(mode), copy = "copy".equals(mode);
        Uri chosen = Folder.chosen(this);
        showingWhere = true;
        where.check(folder ? R.id.inFolder : copy ? R.id.onPhone : R.id.onServer);
        showingWhere = false;
        folderRow.setVisibility(folder ? View.VISIBLE : View.GONE);
        folderName.setText(chosen == null ? getString(R.string.settingsNoFolder) : Folder.detail(this, chosen));
        org.json.JSONObject current = AppCopy.current(this);
        if (!Folder.hasWebBundle(this)) folderNote.setText(R.string.settingsNoWebBundle);
        else if (copy && current != null) folderNote.setText(getString(R.string.settingsCopyNote, current.optString("device")));
        else if (copy) folderNote.setText(R.string.settingsCopySignIn);
        else if (folder && chosen != null && !Folder.granted(this, chosen)) folderNote.setText(R.string.settingsFolderLost);
        else folderNote.setText(R.string.settingsFolderNote);
    }

    /** A finger on one of the three. A folder with none chosen, or one whose
     *  grant has gone, asks for one; cancelling the picker leaves things as they were. */
    private void chooseWhere(int id) {
        if (id == R.id.onPhone) {
            Folder.useCopy(this);
            restart();
            return;
        }
        if (id == R.id.onServer) {
            Folder.useServer(this);
            restart();
            return;
        }
        Uri chosen = Folder.chosen(this);
        if (chosen != null && Folder.granted(this, chosen)) {
            Folder.useChosen(this);
            restart();
        } else {
            pickFolder();
        }
    }

    private void pickFolder() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            startActivityForResult(pick, PICK_FOLDER);
        } catch (ActivityNotFoundException e) {
            toast(getString(R.string.settingsNoPicker));
            showWhere();
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FOLDER) return;
        if (result == RESULT_OK && data != null && data.getData() != null) {
            Folder.use(this, data.getData());
            restart();
        } else {
            showWhere();                  // cancelled: as it was
        }
    }

    // ----------------------------------------------------- notifications

    private void showNotifications() {
        NotificationManager notifications =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        boolean allowed = Build.VERSION.SDK_INT < 24
                || (notifications != null && notifications.areNotificationsEnabled());
        notifyState.setText(allowed ? R.string.settingsNotifyOn : R.string.settingsNotifyOff);

        // Whether a reminder lands on its minute is a second permission, and
        // only from Android 12; before that every alarm was exact.
        AlarmManager schedule = (AlarmManager) getSystemService(ALARM_SERVICE);
        boolean exact = Build.VERSION.SDK_INT < 31
                || (schedule != null && schedule.canScheduleExactAlarms());
        alarmState.setText(exact ? R.string.settingsAlarmExact : R.string.settingsAlarmInexact);
        alarms.setVisibility(Build.VERSION.SDK_INT >= 31 && !exact ? View.VISIBLE : View.GONE);
    }

    private void openNotificationSettings() {
        Intent settings = Build.VERSION.SDK_INT >= 26
                ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                : appDetails();
        open(settings);
    }

    private void openAlarmSettings() {
        if (Build.VERSION.SDK_INT < 31) return;
        open(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                Uri.fromParts("package", getPackageName(), null)));
    }

    private Intent appDetails() {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null));
    }

    private void open(Intent settings) {
        try {
            startActivity(settings);
        } catch (ActivityNotFoundException e) {
            toast(getString(R.string.settingsNoScreen));
        }
    }

    // ------------------------------------------------------------- about

    private void showAbout() {
        String version = "?";
        long build = 0;
        try {
            PackageInfo about = getPackageManager().getPackageInfo(getPackageName(), 0);
            version = about.versionName;
            build = Build.VERSION.SDK_INT >= 28 ? about.getLongVersionCode() : about.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            Log.w("Dvarim", "no package info for ourselves", e);   // cannot happen
        }
        ((TextView) findViewById(R.id.version)).setText(
                getString(R.string.settingsVersion, version, build));
        // Which of the icons on the home screen this one is: the release, the
        // test build, or a clone some app-cloning profile made of either.
        ((TextView) findViewById(R.id.appId)).setText(getPackageName());
        ((TextView) findViewById(R.id.serving)).setText(Server.origin(this));
    }

    /**
     * Throw away the pages the WebView is holding.
     *
     * Only the HTTP cache: cookies are a CookieManager away and stay, so this
     * does not sign anyone out, and neither does it touch localStorage, where
     * the theme and the text size live. A WebView is needed to ask, and one
     * made here is as good as any — the cache belongs to the app, not to it.
     */
    private void clearCache() {
        try {
            WebView web = new WebView(this);
            web.clearCache(true);
            web.destroy();
            toast(getString(R.string.settingsCacheCleared));
        } catch (RuntimeException e) {
            Log.w("Dvarim", "could not clear the WebView cache", e);
        }
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    // -------------------------------------------------------- the way in

    /**
     * "Settings" in the launcher's long-press menu.
     *
     * The way in that does not need the server: point the app at an address it
     * cannot reach and the page never loads, so the link inside it never
     * appears. Registered from code rather than declared in shortcuts.xml
     * because that file is generated from twa-manifest.json on every build and
     * its entries are all URLs for the web app.
     */
    static void offerShortcut(Context context) {
        // Icon.createWithResource over a vector is API 26; below that the
        // long-press menu simply keeps the three the build wrote.
        if (Build.VERSION.SDK_INT < 26) return;
        ShortcutManager shortcuts = context.getSystemService(ShortcutManager.class);
        if (shortcuts == null) return;
        try {
            shortcuts.setDynamicShortcuts(Collections.singletonList(
                    new ShortcutInfo.Builder(context, "settings")
                            .setShortLabel(context.getString(R.string.settingsTitle))
                            .setLongLabel(context.getString(R.string.settingsShortcutLong))
                            .setIcon(Icon.createWithResource(context, R.drawable.ic_shortcut_settings))
                            .setIntent(new Intent(context, SettingsActivity.class)
                                    .setAction(Intent.ACTION_VIEW))
                            .build()));
        } catch (RuntimeException e) {
            // Rate-limited, or too many already: not worth a crash on launch.
            Log.w("Dvarim", "could not offer the Settings shortcut", e);
        }
    }
}
