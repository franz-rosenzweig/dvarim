package xyz.tiresia.dvarim;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * Share into Dvarim without a browser.
 *
 * A Trusted Web Activity hands the shared title and text to Chrome, which turns
 * them into the web app's share target. With the WebView fallback there is no
 * Chrome to hand them to, and android-browser-helper drops them: the app opens
 * on its start URL and the share is lost.
 *
 * The share target is a plain GET (see the web manifest), so the same thing is a
 * URL this activity can build itself:
 *
 *     https://<host>/share?title=…&text=…&url=…
 *
 * Cookies belong to the app rather than to a WebView, so this is signed in
 * exactly when the main window is.
 */
public class ShareActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // To-dos in a folder: the share is the page's inside the APK, which
        // FolderActivity shows, and which files it without a server.
        if (Folder.isOn(this)) {
            startActivity(new Intent(this, FolderActivity.class)
                    .setData(Uri.parse(shareUrl(getIntent(), FolderActivity.ORIGIN + "/"))));
            finish();
            return;
        }
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // Keep every navigation inside this window; a browser is what we are
        // avoiding. AppLinks makes the one exception: dvarim://settings.
        web.setWebViewClient(new AppLinks());
        setContentView(web);
        web.loadUrl(shareUrl(getIntent(), Server.base(this)));
    }

    private static String shareUrl(Intent intent, String base) {
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String url = null;
        // Android has no separate "shared link" field: a URL arrives inside the
        // text, so lift it out and leave the rest as the note.
        if (text != null) {
            for (String word : text.split("\\s+")) {
                if (word.startsWith("http://") || word.startsWith("https://")) {
                    url = word;
                    if (word.equals(text.trim())) text = null;
                    break;
                }
            }
        }
        Uri.Builder share = Uri.parse(base).buildUpon().path("/share");
        if (subject != null) share.appendQueryParameter("title", subject);
        if (text != null) share.appendQueryParameter("text", text);
        if (url != null) share.appendQueryParameter("url", url);
        return share.build().toString();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent event) {
        if (code == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(code, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
