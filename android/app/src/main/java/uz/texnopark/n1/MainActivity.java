package uz.texnopark.n1;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Texno Park N1 — statik frontendni WebView ichida xizmatlaydi.
 *
 * Statik fayllar https://appassets.local/ origin'i ostida beriladi:
 *  - localStorage/cookie ishonchli ishlaydi (file:// muammosi yo'q);
 *  - barcha so'rovlar birinchi navbatda APK assetlaridan xizmatlanadi (offline);
 *  - topilmagan so'rovlar (tashqi CDN, Google Maps, rasmlar) internetga yuboriladi;
 *  - /api/* so'rovlariga 503 qaytariladi — frontend avtomatik oflayn rejimiga o'tadi.
 */
public class MainActivity extends Activity {

    private static final String LOCAL_ORIGIN = "https://appassets.local";
    private static final String[] MIME_TYPES = {
            "html", "text/html", "css", "text/css", "js", "application/javascript",
            "json", "application/json", "png", "image/png", "jpg", "image/jpeg",
            "jpeg", "image/jpeg", "gif", "image/gif", "svg", "image/svg+xml",
            "webp", "image/webp", "ico", "image/x-icon", "woff", "font/woff",
            "woff2", "font/woff2", "ttf", "font/ttf", "otf", "font/otf",
            "mp4", "video/mp4", "webm", "video/webm", "mp3", "audio/mpeg", "wav", "audio/wav"
    };

    private WebView webView;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        // Status bar: qoramtir burgundy
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#1A0508"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.setNavigationBarColor(Color.parseColor("#1A0508"));
        }

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();

                // Backend API mavjud emas — frontendning oflayn fallback'i ishlaydi
                if (url.startsWith(LOCAL_ORIGIN + "/api/")) {
                    return notFoundResponse();
                }

                // Faqat o'z origin'imizdagi so'rovlarni assetlardan beramiz
                if (url.startsWith(LOCAL_ORIGIN + "/")) {
                    String path = url.substring(LOCAL_ORIGIN.length() + 1);
                    // Query string'ni olib tashlaymiz (?v=...)
                    int q = path.indexOf('?');
                    if (q >= 0) path = path.substring(0, q);
                    if (path.isEmpty()) path = "index.html";
                    // Path traversal himoyasi
                    path = path.replace("..", "").replace("\\", "/");
                    while (path.startsWith("/")) path = path.substring(1);
                    if (path.isEmpty()) path = "index.html";

                    InputStream is = tryOpen(path);
                    if (is != null) {
                        return new WebResourceResponse(guessMime(path), "utf-8", is);
                    }
                }
                // Qolganlar (tashqi URL) — WebView o'zi yuklaydi
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Subframe/iframelarni o'z ichida qoldiramiz, tashqi asosiy navigatsiyani tizim brauzeriga beramiz
                String url = request.getUrl().toString();
                if (url.startsWith(LOCAL_ORIGIN)) return false;
                if (request.isForMainFrame()) {
                    try {
                        startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, request.getUrl()));
                    } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(LOCAL_ORIGIN + "/index.html");
        }
    }

    private InputStream tryOpen(String path) {
        try {
            return getAssets().open(path);
        } catch (IOException e) {
            return null;
        }
    }

    private String guessMime(String path) {
        String lower = path.toLowerCase();
        int dot = lower.lastIndexOf('.');
        String ext = dot >= 0 ? lower.substring(dot + 1) : "";
        for (int i = 0; i < MIME_TYPES.length; i += 2) {
            if (MIME_TYPES[i].equals(ext)) return MIME_TYPES[i + 1];
        }
        return "application/octet-stream";
    }

    private WebResourceResponse notFoundResponse() {
        try {
            return new WebResourceResponse("application/json", "utf-8", 503, "Service Unavailable",
                    new HashMap<String, String>(), getAssets().open("empty.json"));
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
