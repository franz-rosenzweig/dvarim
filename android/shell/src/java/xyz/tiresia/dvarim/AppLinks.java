package xyz.tiresia.dvarim;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The WebViewClient for the windows this app opens itself.
 *
 * The site proper is rendered by android-browser-helper, which hands any
 * navigation off the page's own origin to the system — that is how the link in
 * Settings → Data reaches SettingsActivity. ShareActivity and DevActivity hold
 * WebViews of their own, and a plain WebViewClient tries to load everything
 * where it stands: dvarim://settings is not something a WebView can load, so
 * the link would simply fail underneath the finger.
 *
 * Only that one scheme is handed over. Everything else keeps doing whatever it
 * did before, which in these two windows means staying in the window.
 */
class AppLinks extends WebViewClient {
    static final String SCHEME = "dvarim";

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return hand(view, request.getUrl());
    }

    /** What a WebView below API 24 calls instead of the one above. */
    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return hand(view, Uri.parse(url));
    }

    /** True means the system has it, and the WebView should not. */
    private boolean hand(WebView view, Uri url) {
        if (!SCHEME.equals(url.getScheme())) return false;
        try {
            view.getContext().startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException e) {
            Log.w("Dvarim", "nothing in this app answers " + url, e);
        }
        return true;
    }
}
