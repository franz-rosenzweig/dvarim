package xyz.tiresia.dvarim;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;

import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The app on a folder (docs/BRIDGE.md): the web app from inside the APK, its
 * to-dos in a folder on the phone — one the person chose, or the copy the app
 * keeps and syncs with the server (AppCopy) — no server needed to open it.
 *
 * Not the TWA and not android-browser-helper's WebView fallback: neither can
 * hand the page a JavaScript interface, and neither can serve it from the APK.
 * So this is a plain WebView, as DevActivity is, that answers
 * https://appassets.androidplatform.net/ from assets/web/ and gives the page
 * FolderBridge as window.DvarimStorage. Only that origin is ever loaded here;
 * every other address goes to the system, so nothing else can reach the bridge.
 */
public class FolderActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int PICK = 41;
    private static final int CALENDAR = 44;

    /** The one on screen, if any: a tick from the widget or a reminder goes
     *  through its page at once rather than waiting for the next open. */
    private static WeakReference<FolderActivity> live = new WeakReference<>(null);

    private WebView web;
    private FolderBridge bridge;
    private FolderBridge.Reply pending;       // a "pick" waiting for the picker to close
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile CountDownLatch calendarAnswer;
    private int load;                          // which page load the engine is awaited for

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Uri tree = Folder.tree(this);
        if (!Folder.isOn(this)) {
            // no folder (or its permission went): back to the server, as the app has always been
            toServer();
            return;
        }
        web = new WebView(this);           // a test build's is open to DevTools already (DevBuild)
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new Client());
        java.io.File copy = Folder.copy(this);
        bridge = copy != null ? new FolderBridge(this, web, copy) : new FolderBridge(this, web, tree);
        web.addJavascriptInterface(bridge, "DvarimStorage");
        setContentView(web);
        live = new WeakReference<>(this);
        web.loadUrl(ORIGIN + startPath(getIntent()));
    }

    /** /today, /new, /share?… — whatever the launcher, a shortcut or a share asked for. */
    private static String startPath(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || data.getPath() == null || data.getPath().isEmpty()) return "/";
        String q = data.getEncodedQuery();
        return data.getPath() + (q == null ? "" : "?" + q);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (web != null && intent != null && intent.getData() != null) web.loadUrl(ORIGIN + startPath(intent));
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Syncthing may have brought changes while the app was away
        if (web != null) web.evaluateJavascript("window.__dvarimFilesChanged && window.__dvarimFilesChanged()", null);
    }

    /**
     * Back is the page's to answer: it keeps its own depth in history — the
     * drawer, a list, whatever is open over it (lib/backstack.svelte.js) — and
     * goes back a step while there is one. Not WebView.canGoBack(): Chromium
     * skips, on Back, an entry a page added before anyone had touched it (the
     * history-manipulation intervention), so straight after opening it said
     * there was nowhere to go and Back closed the app; and later it went back
     * across whole page loads — a share, New To-Do — rather than a step in the
     * page. history.back() from the page itself is not skipped.
     */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(() => { const d = history.state && history.state.depth; if (d > 0) { history.back(); return true; } return false; })()",
                took -> { if (!"true".equals(took)) super.onBackPressed(); });
    }

    @Override
    protected void onDestroy() {
        if (live.get() == this) live.clear();
        main.removeCallbacksAndMessages(null);
        if (bridge != null) bridge.close();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---- the page as the rest of the app's source (phase 6) ----

    /** Once the page's engine is up (frontend/src/lib/backend.js sets
     *  __dvarimLocal when the store is open): ticks kept while the app was
     *  closed go in, and the lists are kept for reminders and the widget. */
    private void whenEngineUp(final int forLoad, final int tries) {
        if (web == null || forLoad != load || tries <= 0) return;
        web.evaluateJavascript("!!(window.__dvarimLocal && window.dvarim)", up -> {
            if ("true".equals(up)) {
                drainOutbox();
                keepLists();
            } else {
                main.postDelayed(() -> whenEngineUp(forLoad, tries - 1), 250);
            }
        });
    }

    /** The page's Today and Upcoming, kept on the phone (Local) for what runs
     *  with the app closed; FolderBridge.keep stores them and tells reminders
     *  and the widget. On the page coming up, and on every op `changed`. */
    void keepLists() {
        if (web == null) return;
        web.evaluateJavascript("Promise.all(" + new JSONArray(java.util.Arrays.asList(Local.KEPT))
                + ".map(p => window.dvarim.request('GET', p).then(r => [p, r.status, JSON.stringify(r.body)])))"
                + ".then(all => DvarimStorage.keep(JSON.stringify(all))).catch(() => {}); true", null);
    }

    /** The ticks Outbox kept (a widget's checkbox, a reminder's Complete),
     *  made through the page, and forgotten once they are in (FolderBridge.sent). */
    void drainOutbox() {
        if (web == null) return;
        JSONArray ops = Outbox.pending(this);
        if (ops.length() == 0) return;
        web.evaluateJavascript("Promise.all(" + ops + ".map(o => window.dvarim.request('POST', '/api/todos/' + o.id + '/complete', {on: o.on})"
                + ".then(r => [o.id, r.status]).catch(() => [o.id, 0])))"
                + ".then(all => DvarimStorage.sent(JSON.stringify(all))); true", null);
    }

    /** From Outbox, on any thread: a tick was kept; if the page is up, in it goes. */
    static void tickKept() {
        FolderActivity a = live.get();
        if (a != null) a.runOnUiThread(a::drainOutbox);
    }

    /**
     * Blocking, off the main thread: whether the page may have the phone's
     * calendars. Android is asked once, the first time the page wants them; a
     * refusal after that is changed in the system's Settings, which the page's
     * message says. A test build with a calendars file needs no permission.
     */
    synchronized boolean calendarAccess() {
        if (DevBuild.calendarsFile(this) != null) return true;
        if (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) return true;
        SharedPreferences prefs = getSharedPreferences("dvarim.calendars", Context.MODE_PRIVATE);
        if (prefs.getBoolean("asked", false)) return false;
        prefs.edit().putBoolean("asked", true).apply();
        CountDownLatch answered = new CountDownLatch(1);
        calendarAnswer = answered;
        runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.READ_CALENDAR}, CALENDAR));
        try {
            answered.await(2, TimeUnit.MINUTES);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == CALENDAR && calendarAnswer != null) calendarAnswer.countDown();
    }

    // ---- what the page asks of the app itself (FolderBridge hands these over) ----

    /** "Choose another folder…": the system's folder picker. */
    void pickFolder(FolderBridge.Reply reply) {
        pending = reply;
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        pick.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(pick, PICK);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK) return;
        boolean changed = result == RESULT_OK && data != null && data.getData() != null;
        if (changed) Folder.use(this, data.getData());
        if (pending != null) {
            pending.ok("{\"changed\":" + changed + "}");
            pending = null;
        }
        if (changed) recreate();                 // the page again, on the new folder
    }

    /** "Use a server instead…". */
    void useServer() {
        Folder.useServer(this);
        toServer();
    }

    /** "Sign out" in the app's copy, once the page has synced what it had:
     *  the token, the sign-in and the copy go (AppCopy), and the app starts
     *  over at the server's sign-in. */
    void signOut() {
        final android.content.Context app = getApplicationContext();
        new Thread(() -> {
            AppCopy.signOut(app);
            runOnUiThread(this::toServer);
        }, "dvarim-sign-out").start();
    }

    /** The app over again, on the server. In a task of its own, as the launcher
     *  starts it: started from here without one, android-browser-helper's
     *  LauncherActivity restarts itself in a new task, which this one's finish
     *  took down with it, and Use a server instead… left the home screen. */
    private void toServer() {
        startActivity(new Intent(this, LauncherActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        finish();
    }

    // ---- serving the web app from assets/web/ ----

    private final class Client extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            // every load is a new page, and a new engine to wait for
            load++;
            whenEngineUp(load, 120);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!"appassets.androidplatform.net".equals(url.getHost())) return null;
            String path = url.getPath() == null ? "/" : url.getPath();
            InputStream in = open(path);
            String served = path;
            if (in == null) {                    // not a file: the app's own route
                in = open("/index.html");
                served = "/index.html";
            }
            if (in == null) return null;
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime(served), "utf-8", 200, "OK", headers, in);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if ("appassets.androidplatform.net".equals(url.getHost())) return false;
            if ("dvarim".equals(url.getScheme()) || "dvarim-debug".equals(url.getScheme())) {
                startActivity(new Intent(FolderActivity.this, SettingsActivity.class));
                return true;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (android.content.ActivityNotFoundException ignored) {
                // nothing on the phone opens it; stay put
            }
            return true;
        }
    }

    private InputStream open(String path) {
        String rel = path.startsWith("/") ? path.substring(1) : path;
        if (rel.isEmpty() || rel.contains("..")) return null;
        try {
            return getAssets().open("web/" + rel);
        } catch (IOException e) {
            return null;
        }
    }

    private static String mime(String path) {
        String p = path.toLowerCase(java.util.Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}
