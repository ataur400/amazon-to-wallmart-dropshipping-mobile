package com.amztowallmart.productfinder;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Android replacement for the desktop's main.js.
 *  - storage            : chrome.storage.local        (JSON file in app-private storage)
 *  - secure*            : saved login                 (encrypted with the Android Keystore)
 *  - netFetch           : login backend calls         (native HTTP, no CORS limits)
 *  - tab*, exec         : chrome.tabs / scripting     (hidden WebViews that open Amazon / Walmart)
 *  - captchaOpen        : visible scan browser        (shares cookies with the hidden ones)
 *  - saveFile           : CSV export to Downloads
 */
@CapacitorPlugin(name = "AWNative")
public class AWNativePlugin extends Plugin {

    private static final Pattern BACKEND_RE = Pattern.compile("^https://script\\.google(usercontent)?\\.com/.*");
    private static final Pattern SITE_RE = Pattern.compile("^https://([a-z0-9-]+\\.)*(amazon|walmart)\\.com/.*", Pattern.CASE_INSENSITIVE);
    private static final String CRED_KEY = "aw_cred_enc_v1";
    private static final String KS_ALIAS = "aw_cred_key_v1";
    private static final int WORKER_W_DP = 1280;
    private static final int WORKER_H_DP = 900;

    private final Handler ui = new Handler(Looper.getMainLooper());

    // ------------------------------------------------------------ storage
    private final Object storeLock = new Object();
    private JSONObject store = new JSONObject();
    private boolean storeLoaded = false;
    private final java.util.concurrent.ExecutorService io = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final Runnable saveTask = () -> io.execute(this::flushStore);

    private File storeFile() { return new File(getContext().getFilesDir(), "storage.json"); }

    private void loadStore() {
        synchronized (storeLock) {
            if (storeLoaded) return;
            storeLoaded = true;
            File f = storeFile();
            if (!f.exists()) return;
            try (FileInputStream in = new FileInputStream(f)) {
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[16384]; int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                store = new JSONObject(bo.toString("UTF-8"));
            } catch (Exception e) { store = new JSONObject(); }
        }
    }

    private void flushStore() {
        synchronized (storeLock) {
            try {
                File tmp = new File(getContext().getFilesDir(), "storage.json.tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(store.toString().getBytes(StandardCharsets.UTF_8));
                    out.getFD().sync();
                }
                File dst = storeFile();
                if (!tmp.renameTo(dst)) { //noinspection ResultOfMethodCallIgnored
                    dst.delete(); tmp.renameTo(dst);
                }
            } catch (Exception ignored) { }
        }
    }

    private void scheduleSave() { ui.removeCallbacks(saveTask); ui.postDelayed(saveTask, 500); }

    @PluginMethod
    public void storageGet(PluginCall call) {
        loadStore();
        JSObject out = new JSObject();
        JSONObject data = new JSONObject();
        try {
            synchronized (storeLock) {
                Object keys = call.getData().opt("keys");
                if (keys == null || keys == JSONObject.NULL) {
                    data = new JSONObject(store.toString());
                } else if (keys instanceof String) {
                    if (store.has((String) keys)) data.put((String) keys, store.get((String) keys));
                } else if (keys instanceof JSONArray) {
                    JSONArray a = (JSONArray) keys;
                    for (int i = 0; i < a.length(); i++) {
                        String k = a.optString(i);
                        if (store.has(k)) data.put(k, store.get(k));
                    }
                } else if (keys instanceof JSONObject) { // defaults object
                    JSONObject d = (JSONObject) keys;
                    Iterator<String> it = d.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        data.put(k, store.has(k) ? store.get(k) : d.get(k));
                    }
                }
            }
            out.put("data", data);
            call.resolve(out);
        } catch (Exception e) { call.reject("storage read failed: " + e.getMessage()); }
    }

    @PluginMethod
    public void storageSet(PluginCall call) {
        loadStore();
        try {
            JSONObject data = call.getData().optJSONObject("data");
            if (data != null) {
                synchronized (storeLock) {
                    Iterator<String> it = data.keys();
                    while (it.hasNext()) { String k = it.next(); store.put(k, data.get(k)); }
                }
                scheduleSave();
            }
            call.resolve();
        } catch (Exception e) { call.reject("storage write failed: " + e.getMessage()); }
    }

    @PluginMethod
    public void storageRemove(PluginCall call) {
        loadStore();
        JSONArray keys = call.getData().optJSONArray("keys");
        synchronized (storeLock) {
            if (keys != null) for (int i = 0; i < keys.length(); i++) store.remove(keys.optString(i));
        }
        scheduleSave();
        call.resolve();
    }

    // ------------------------------------------------------------ saved login (Android Keystore, AES-GCM)
    private SecretKey credKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KS_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KS_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build());
            return kg.generateKey();
        }
        return (SecretKey) ks.getKey(KS_ALIAS, null);
    }

    @PluginMethod
    public void secureSave(PluginCall call) {
        loadStore();
        JSObject out = new JSObject();
        try {
            String email = call.getString("email", "");
            String pw = call.getString("password", "");
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, credKey());
            byte[] ct = c.doFinal(pw.getBytes(StandardCharsets.UTF_8));
            JSONObject o = new JSONObject();
            o.put("email", email);
            o.put("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP));
            o.put("pw", Base64.encodeToString(ct, Base64.NO_WRAP));
            synchronized (storeLock) { store.put(CRED_KEY, o); }
            scheduleSave();
            out.put("ok", true);
        } catch (Exception e) { out.put("ok", false); }
        call.resolve(out);
    }

    @PluginMethod
    public void secureLoad(PluginCall call) {
        loadStore();
        JSObject out = new JSObject();
        try {
            JSONObject o;
            synchronized (storeLock) { o = store.optJSONObject(CRED_KEY); }
            if (o != null) {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, credKey(), new GCMParameterSpec(128, Base64.decode(o.getString("iv"), Base64.NO_WRAP)));
                byte[] pt = c.doFinal(Base64.decode(o.getString("pw"), Base64.NO_WRAP));
                out.put("email", o.getString("email"));
                out.put("password", new String(pt, StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) { out = new JSObject(); }
        call.resolve(out);
    }

    @PluginMethod
    public void secureClear(PluginCall call) {
        loadStore();
        synchronized (storeLock) { store.remove(CRED_KEY); }
        scheduleSave();
        call.resolve();
    }

    // ------------------------------------------------------------ network (login backend)
    @PluginMethod
    public void netFetch(final PluginCall call) {
        final String url = call.getString("url", "");
        if (!BACKEND_RE.matcher(url).matches()) { call.reject("Blocked request"); return; }
        final String method = call.getString("method", "GET");
        final JSONObject headers = call.getData().optJSONObject("headers");
        final String body = call.getData().isNull("body") ? null : call.getData().optString("body", null);
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(60000);
                conn.setRequestMethod(method == null ? "GET" : method.toUpperCase());
                if (headers != null) {
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) { String k = it.next(); conn.setRequestProperty(k, headers.optString(k)); }
                }
                if (body != null && !"GET".equalsIgnoreCase(conn.getRequestMethod())) {
                    conn.setDoOutput(true);
                    try (OutputStream os = conn.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
                }
                int status = conn.getResponseCode();
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                if (in != null) { byte[] buf = new byte[16384]; int n; while ((n = in.read(buf)) > 0) bo.write(buf, 0, n); in.close(); }
                String ct = conn.getContentType();
                JSObject out = new JSObject();
                out.put("status", status);
                out.put("contentType", ct == null ? "application/json" : ct);
                out.put("body", bo.toString("UTF-8"));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Network error: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "aw-netfetch").start();
    }

    // ------------------------------------------------------------ worker "tabs" (hidden WebViews)
    private static class Tab {
        int id;
        WebView wv;
        volatile boolean failed, pending, started, ready;
        volatile int navCounter;
        String bridgeName;
    }

    private final Map<Integer, Tab> tabs = new ConcurrentHashMap<>();
    private final Map<String, PluginCall> execCalls = new ConcurrentHashMap<>();
    private final Map<String, Integer> execTab = new ConcurrentHashMap<>();
    private int nextTabId = 1000;
    private boolean showWorkers = false;
    private String cachedUA = null;
    private OnBackPressedCallback backCallback;

    private String desktopUA() {
        if (cachedUA != null) return cachedUA;
        String chromeVer = "120.0.0.0";
        try {
            String def = WebSettings.getDefaultUserAgent(getContext());
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("Chrome/([0-9.]+)").matcher(def);
            if (m.find()) chromeVer = m.group(1);
        } catch (Exception ignored) { }
        cachedUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVer + " Safari/537.36";
        return cachedUA;
    }

    @Override
    public void load() {
        // Same safety net as the desktop: closing the app while a scan runs asks first.
        backCallback = new OnBackPressedCallback(false) {
            @Override public void handleOnBackPressed() {
                new AlertDialog.Builder(getActivity())
                        .setTitle("A scan is still running.")
                        .setMessage("Closing the app will stop it. Results found so far stay in History.")
                        .setNegativeButton("Keep scanning", null)
                        .setPositiveButton("Close and stop", (d, w) -> { destroyAllTabs(); getActivity().finishAndRemoveTask(); })
                        .show();
            }
        };
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), backCallback);
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (getActivity().checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    getActivity().requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 4711);
                }
            } catch (Exception ignored) { }
        }
    }

    @Override
    protected void handleOnDestroy() { destroyAllTabs(); flushStore(); }

    @Override
    protected void handleOnPause() { io.execute(this::flushStore); }

    private void destroyAllTabs() {
        for (final Integer id : tabs.keySet()) removeTabNow(id, false);
        updateAwake();
    }

    private void updateAwake() {
        final boolean active = !tabs.isEmpty();
        ui.post(() -> {
            if (backCallback != null) backCallback.setEnabled(active);
            try {
                Window w = getActivity().getWindow();
                if (active) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (Exception ignored) { }
            try {
                Intent i = new Intent(getContext(), ScanService.class);
                if (active) {
                    if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i); else getContext().startService(i);
                } else {
                    getContext().stopService(i);
                }
            } catch (Exception ignored) { }
        });
    }

    private FrameLayout contentRoot() { return getActivity().findViewById(android.R.id.content); }

    private float density() { return getContext().getResources().getDisplayMetrics().density; }

    private void placeWorker(Tab t) {
        FrameLayout root = contentRoot();
        if (root == null || t.wv == null) return;
        float d = density();
        if (showWorkers) {
            float s = 0.28f;
            int idx = 0;
            for (Tab o : tabs.values()) { if (o == t) break; idx++; }
            t.wv.setPivotX(0); t.wv.setPivotY(0);
            t.wv.setScaleX(s); t.wv.setScaleY(s);
            t.wv.setTranslationX(idx * (WORKER_W_DP * s + 4) * d + 4 * d);
            t.wv.setTranslationY(Math.max(0, root.getHeight() - (WORKER_H_DP * s + 8) * d));
            t.wv.setOnTouchListener((v, e) -> true);
            t.wv.bringToFront();
            t.wv.setElevation(24 * d);
        } else {
            t.wv.setScaleX(1f); t.wv.setScaleY(1f);
            t.wv.setTranslationX(0); t.wv.setTranslationY(0);
            t.wv.setElevation(0);
            t.wv.setOnTouchListener(null);
            // Behind the app's own page: it is loaded and rendered, just not visible.
            ViewGroup parent = (ViewGroup) t.wv.getParent();
            if (parent != null && parent.indexOfChild(t.wv) != 0) { parent.removeView(t.wv); parent.addView(t.wv, 0); }
        }
    }

    @PluginMethod
    public void setShowWorkers(PluginCall call) {
        showWorkers = call.getBoolean("show", false);
        ui.post(() -> { for (Tab t : tabs.values()) placeWorker(t); });
        call.resolve();
    }

    private JSObject tabInfo(Tab t) {
        JSObject o = new JSObject();
        o.put("id", t.id);
        String u = t.wv.getUrl();
        o.put("url", t.failed ? "chrome-error://chromewebdata/" : (u == null ? "about:blank" : u));
        o.put("status", t.wv.getProgress() < 100 ? "loading" : "complete");
        return o;
    }

    private void fireUpdated(Tab t) {
        JSObject o = tabInfo(t);
        o.put("status", "complete");
        notifyListeners("tabUpdated", o);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView newWorkerWebView(final Tab tab) {
        WebView wv = new WebView(getContext());
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(desktopUA());           // desktop pages, like the desktop app's scan browsers
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(wv, true);

        // Results of page scripts come back through a private, per-tab, random-named bridge.
        tab.bridgeName = "__aw" + UUID.randomUUID().toString().replace("-", "");
        wv.addJavascriptInterface(new Object() {
            @JavascriptInterface public void done(String token, String json) { finishExec(token, json, null); }
            @JavascriptInterface public void fail(String token, String msg) { finishExec(token, null, msg); }
        }, tab.bridgeName);

        wv.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap fav) {
                if (url != null && url.startsWith("data:")) return; // WebView's own error page
                tab.navCounter++;
                tab.failed = false;
                if (tab.pending) tab.started = true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                if (!tab.ready) return;                    // initial about:blank: not reported
                if (tab.pending && !tab.started) return;   // stale event from the previous page
                final int mark = tab.navCounter;
                // Redirect chains fire several finish events: report only once the page has settled.
                ui.postDelayed(() -> {
                    if (!tabs.containsKey(tab.id) || tab.wv == null) return;
                    if (mark != tab.navCounter) return;    // a newer navigation began
                    if (tab.wv.getProgress() < 100) return;
                    tab.pending = false; tab.started = false;
                    fireUpdated(tab);
                }, 450);
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                String d = String.valueOf(err.getDescription());
                if (d.contains("ERR_ABORTED")) return;     // replaced by a newer navigation
                tab.failed = true;
                if (tab.pending) tab.started = true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String u = req.getUrl().toString();
                return !(u.startsWith("http://") || u.startsWith("https://") || u.startsWith("about:")); // block app-links (amzn://, intent://)
            }
        });
        wv.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsAlert(WebView v, String u, String m, JsResult r) { r.cancel(); return true; }
            @Override public boolean onJsConfirm(WebView v, String u, String m, JsResult r) { r.cancel(); return true; }
            @Override public boolean onJsBeforeUnload(WebView v, String u, String m, JsResult r) { r.confirm(); return true; }
            @Override public boolean onConsoleMessage(ConsoleMessage cm) { return true; }
            @Override public boolean onCreateWindow(WebView v, boolean d, boolean g, android.os.Message m) { return false; }
        });
        return wv;
    }

    @PluginMethod
    public void tabCreate(final PluginCall call) {
        final String url = call.getString("url", "about:blank");
        ui.post(() -> {
            try {
                final Tab t = new Tab();
                t.id = nextTabId++;
                t.wv = newWorkerWebView(t);
                float d = density();
                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams((int) (WORKER_W_DP * d), (int) (WORKER_H_DP * d));
                lp.gravity = Gravity.TOP | Gravity.START;
                contentRoot().addView(t.wv, 0, lp);
                tabs.put(t.id, t);
                updateAwake();
                t.wv.loadUrl(url == null || url.isEmpty() ? "about:blank" : url);
                // Let the initial load settle first, so its finish event can never be mistaken for a later page.
                ui.postDelayed(() -> {
                    t.ready = true;
                    placeWorker(t);
                    JSObject out = new JSObject(); out.put("id", t.id);
                    call.resolve(out);
                }, 350);
            } catch (Exception e) { call.reject("Could not create scan browser: " + e.getMessage()); }
        });
    }

    private Tab tabOrReject(PluginCall call) {
        Tab t = tabs.get(call.getInt("id", -1));
        if (t == null || t.wv == null) { call.reject("No tab with id: " + call.getInt("id", -1)); return null; }
        return t;
    }

    @PluginMethod
    public void tabGet(final PluginCall call) {
        ui.post(() -> { Tab t = tabOrReject(call); if (t != null) call.resolve(tabInfo(t)); });
    }

    @PluginMethod
    public void tabUpdate(final PluginCall call) {
        final String url = call.getData().isNull("url") ? null : call.getData().optString("url", null);
        ui.post(() -> {
            Tab t = tabOrReject(call);
            if (t == null) return;
            if (url != null && !url.isEmpty()) {
                t.failed = false; t.pending = true; t.started = false;
                t.wv.loadUrl(url);
            }
            call.resolve(tabInfo(t));
        });
    }

    private void removeTabNow(int id, boolean notify) {
        final Tab t = tabs.remove(id);
        if (t == null) return;
        // Fail any script still running in this tab.
        for (Map.Entry<String, Integer> e : execTab.entrySet()) {
            if (e.getValue() == id) finishExec(e.getKey(), null, "The background tab was closed.");
        }
        Runnable r = () -> {
            try {
                t.wv.stopLoading();
                ViewGroup p = (ViewGroup) t.wv.getParent();
                if (p != null) p.removeView(t.wv);
                t.wv.removeJavascriptInterface(t.bridgeName);
                t.wv.destroy();
            } catch (Exception ignored) { }
            t.wv = null;
        };
        if (Looper.myLooper() == Looper.getMainLooper()) r.run(); else ui.post(r);
        if (notify) { JSObject o = new JSObject(); o.put("id", id); notifyListeners("tabRemoved", o); }
    }

    @PluginMethod
    public void tabRemove(final PluginCall call) {
        final int id = call.getInt("id", -1);
        ui.post(() -> { removeTabNow(id, true); updateAwake(); call.resolve(); });
    }

    // chrome.scripting.executeScript({ target:{tabId}, func }) : run `source` (a function) inside the page,
    // wait for its (possibly async) result.
    @PluginMethod
    public void exec(final PluginCall call) {
        final String source = call.getString("source", "");
        ui.post(() -> {
            final Tab t = tabOrReject(call);
            if (t == null) return;
            final String token = UUID.randomUUID().toString().replace("-", "");
            execCalls.put(token, call);
            execTab.put(token, t.id);
            String js = "(function(){var T='" + token + "',B=window['" + t.bridgeName + "'];"
                    + "try{var f=(" + source + ");"
                    + "Promise.resolve().then(function(){return f();})"
                    + ".then(function(r){B.done(T,JSON.stringify(r===undefined?null:r));},"
                    + "function(e){B.fail(T,String(e&&e.message||e));});"
                    + "}catch(e){B.fail(T,String(e&&e.message||e));}})();";
            t.wv.evaluateJavascript(js, null);
            // Safety net: a page that navigates away mid-script never answers.
            ui.postDelayed(() -> finishExec(token, null, "The page script did not finish in time."), 180000);
        });
    }

    private void finishExec(String token, String json, String error) {
        PluginCall call = execCalls.remove(token);
        execTab.remove(token);
        if (call == null) return;
        if (error != null) { call.reject(error); return; }
        try {
            Object value = new JSONTokener(json == null ? "null" : json).nextValue();
            JSObject out = new JSObject();
            out.put("result", value == null ? JSONObject.NULL : value);
            call.resolve(out);
        } catch (JSONException e) { call.reject("Bad page result: " + e.getMessage()); }
    }

    // ------------------------------------------------------------ CAPTCHA / ZIP code: visible scan browser
    @PluginMethod
    @SuppressLint({"SetJavaScriptEnabled"})
    public void captchaOpen(final PluginCall call) {
        final String url = call.getString("url", "");
        if (!SITE_RE.matcher(url).matches()) { call.resolve(); return; }
        ui.post(() -> {
            final Dialog dlg = new Dialog(getActivity(), android.R.style.Theme_Material_Light_NoActionBar);
            LinearLayout col = new LinearLayout(getContext());
            col.setOrientation(LinearLayout.VERTICAL);
            col.setFitsSystemWindows(true);
            LinearLayout bar = new LinearLayout(getContext());
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            bar.setBackgroundColor(0xFF12305F);
            int pad = (int) (10 * density());
            bar.setPadding(pad, pad, pad, pad);
            TextView title = new TextView(getContext());
            title.setText("Scan browser: solve CAPTCHA / set ZIP code, then press Done");
            title.setTextColor(0xFFFFFFFF);
            title.setTextSize(13);
            bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            Button done = new Button(getContext());
            done.setText("Done");
            bar.addView(done, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            col.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            final WebView wv = new WebView(getContext());
            WebSettings s = wv.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setUserAgentString(desktopUA());
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(true);
            s.setSupportZoom(true);
            s.setBuiltInZoomControls(true);
            s.setDisplayZoomControls(false);
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setAcceptThirdPartyCookies(wv, true);
            wv.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                    String u = req.getUrl().toString();
                    return !(u.startsWith("http://") || u.startsWith("https://"));
                }
            });
            col.addView(wv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            dlg.setContentView(col);
            final Runnable closeIt = () -> {
                try { CookieManager.getInstance().flush(); wv.stopLoading(); wv.destroy(); } catch (Exception ignored) { }
                dlg.dismiss();
            };
            done.setOnClickListener(v -> closeIt.run());
            dlg.setOnKeyListener((d, keyCode, ev) -> {
                if (keyCode == KeyEvent.KEYCODE_BACK && ev.getAction() == KeyEvent.ACTION_UP) {
                    if (wv.canGoBack()) wv.goBack(); else closeIt.run();
                    return true;
                }
                return false;
            });
            dlg.show();
            wv.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void clearCookies(final PluginCall call) {
        ui.post(() -> {
            CookieManager cm = CookieManager.getInstance();
            cm.removeAllCookies(ok -> cm.flush());
            for (Tab t : tabs.values()) { try { t.wv.clearCache(true); } catch (Exception ignored) { } }
            call.resolve();
        });
    }

    // ------------------------------------------------------------ links and files
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void saveFile(final PluginCall call) {
        final String name = call.getString("filename", "export.csv").replaceAll("[\\\\/:*?\"<>|]", "_");
        final String text = call.getString("text", "");
        final String mime = call.getString("mime", "text/csv");
        new Thread(() -> {
            try {
                ContentResolver cr = getContext().getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                final Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("could not create the file");
                try (OutputStream os = cr.openOutputStream(uri)) { os.write(text.getBytes(StandardCharsets.UTF_8)); }
                ui.post(() -> {
                    Toast.makeText(getContext(), "Saved in Downloads: " + name, Toast.LENGTH_LONG).show();
                    try {
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType(mime);
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        Intent chooser = Intent.createChooser(send, "Open / share " + name);
                        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(chooser);
                    } catch (Exception ignored) { }
                });
                call.resolve();
            } catch (Exception e) {
                ui.post(() -> Toast.makeText(getContext(), "Could not save the file: " + e.getMessage(), Toast.LENGTH_LONG).show());
                call.reject("Save failed: " + e.getMessage());
            }
        }, "aw-savefile").start();
    }
}
