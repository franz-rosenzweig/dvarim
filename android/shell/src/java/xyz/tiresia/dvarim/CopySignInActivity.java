package xyz.tiresia.dvarim;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The first sign-in for the copy on this phone (AppCopy): the server's own
 * page, in the app's own WebView.
 *
 * Not the Trusted Web Activity: that is Chrome, and the session cookie Chrome
 * holds is out of the app's reach, so the app could never make this phone its
 * token from it. Here the cookie lands in the WebView's jar, which Api reads.
 * Signing in on the page swaps its screen rather than loading another, so
 * until the copy is set up the activity asks every few seconds whether there
 * is a sign-in to set it up from; then it hands over to FolderActivity on the
 * copy, with whatever path it was opened for.
 *
 * The page is told it is inside an app that keeps its own copy
 * (window.__dvarimShell, frontend/src/lib/shell.js), so it keeps none of its
 * own. With no document-start script on a plain WebView that is a JavaScript
 * interface, whose `copy` is a method: the page's test is only whether it is
 * there and truthy.
 */
public class CopySignInActivity extends Activity {
    private static final long EVERY_MS = 3000;

    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean asking, done;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!Folder.wantsCopy(this)) {
            toLauncher();
            return;
        }
        CookieManager.getInstance().setAcceptCookie(true);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " Dvarim/1.1 (Android shell; copy)");
        web.addJavascriptInterface(new ShellFlag(), "__dvarimShell");
        web.addJavascriptInterface(new Shell(), "DvarimShell");
        web.setWebViewClient(new Client());
        setContentView(web);
        Uri data = getIntent() == null ? null : getIntent().getData();
        String path = data == null || data.getPath() == null ? "/" : data.getPath();
        web.loadUrl(Api.url(this, path));
        askSoon(0);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** Whether there is a sign-in to set the copy up from, off the main thread. */
    private void askSoon(long delay) {
        main.postDelayed(() -> {
            if (done || asking || isFinishing()) return;
            asking = true;
            final android.content.Context app = getApplicationContext();
            new Thread(() -> {
                boolean ready = AppCopy.setUpIfSignedIn(app);
                main.post(() -> {
                    asking = false;
                    if (ready) toCopy();
                    else askSoon(EVERY_MS);
                });
            }, "dvarim-copy-setup").start();
        }, delay);
    }

    /** The copy is there: the app from inside the APK, on it. */
    private void toCopy() {
        if (done) return;
        done = true;
        CookieManager.getInstance().flush();
        startActivity(new Intent(this, FolderActivity.class).setData(getIntent() == null ? null : getIntent().getData()));
        finish();
    }

    /** No longer copy mode (Settings changed it): the launcher decides again. */
    private void toLauncher() {
        startActivity(new Intent(this, LauncherActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        finish();
    }

    /** window.__dvarimShell: "this app keeps the copy". */
    private static final class ShellFlag {
        @JavascriptInterface
        public boolean copy() { return true; }

        @JavascriptInterface
        public String mode() { return "copy"; }
    }

    /** window.DvarimShell.postMessage(json), the page asking the app (lib/shell.js askShell). */
    private final class Shell {
        @JavascriptInterface
        public void postMessage(String json) {
            String type;
            try {
                type = new JSONObject(json).optString("type");
            } catch (JSONException e) {
                return;
            }
            if ("useCopy".equals(type)) main.post(() -> {
                Folder.useCopy(CopySignInActivity.this);
                askSoon(0);
            });
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            askSoon(0);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (FolderBridge.sameOrigin(url.toString(), Api.base(CopySignInActivity.this))) return false;
            if ("dvarim".equals(url.getScheme()) || "dvarim-debug".equals(url.getScheme())) {
                startActivity(new Intent(CopySignInActivity.this, SettingsActivity.class));
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
}
