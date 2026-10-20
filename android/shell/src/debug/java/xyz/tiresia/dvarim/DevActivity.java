package xyz.tiresia.dvarim;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * The web app from a development server, in the same engine the real app uses.
 *
 * The real app renders in android-browser-helper's WebViewFallbackActivity, and
 * that refuses any URL that is not https, so it cannot show localhost. This is
 * the same System WebView with the same settings that matter, which makes it the
 * place to try a gesture under a real finger against sample data:
 *
 *     ./shell/dev.sh http://localhost:8421
 *
 * It exists in test builds only (src/debug/).
 */
public class DevActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        web.setWebViewClient(new AppLinks());
        setContentView(web);
        String url = getIntent().getStringExtra("url");
        if (url == null) url = "http://localhost:8421/";
        // The widget, the reminders and the outbox follow the page (DevBuild).
        DevBuild.rememberServer(this, url);
        web.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
