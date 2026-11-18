"use strict";
// Android edition of preload.js. Gives app.js / auth.js the same chrome.* API they have
// on the desktop, but backed by the native AWNative plugin (hidden WebViews = scan browsers).
// The app code itself (app.js, auth.js) is the unchanged desktop code.
(function () {
  const cap = window.Capacitor;
  if (!cap || typeof cap.registerPlugin !== "function") return; // not inside the Android app
  const AW = cap.registerPlugin("AWNative");
  const VERSION = "1.8.1";
  window.__AW_MOBILE = true;
  window.AWNativePlugin = AW;

  function makeEvent() {
    const listeners = new Set();
    return {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      hasListener: (fn) => listeners.has(fn),
      _fire: (...args) => { [...listeners].forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } }); },
    };
  }
  const onUpdated = makeEvent();
  const onRemoved = makeEvent();
  AW.addListener("tabUpdated", (ev) => onUpdated._fire(ev.id, { status: ev.status, url: ev.url }));
  AW.addListener("tabRemoved", (ev) => onRemoved._fire(ev.id));

  window.chrome = {
    runtime: {
      getManifest: () => ({ name: "Amazon to Wallmart Product Finder Dropshipping Tool", version: VERSION, manifest_version: 3 }),
      getURL: (p) => String(p || "").replace(/^\//, ""),
      id: "aw-mobile",
    },
    storage: {
      local: {
        get: (keys) => AW.storageGet({ keys: keys == null ? null : keys }).then((r) => r.data || {}),
        set: (obj) => AW.storageSet({ data: obj }).then(() => undefined),
        remove: (keys) => AW.storageRemove({ keys: [].concat(keys) }).then(() => undefined),
      },
    },
    tabs: {
      create: async (props) => {
        const r = await AW.tabCreate({ url: (props && props.url) || "about:blank" });
        return { id: r.id, url: (props && props.url) || "about:blank" };
      },
      get: (id) => AW.tabGet({ id }),
      update: (id, props) => AW.tabUpdate({ id, url: props && props.url ? props.url : null }),
      remove: (id) => AW.tabRemove({ id }).then(() => undefined),
      onUpdated, onRemoved,
    },
    scripting: {
      executeScript: ({ target, func }) =>
        AW.exec({ id: target.tabId, source: func.toString() }).then((r) => [{ result: r.result }]),
    },
  };

  window.awSecure = {
    save: (email, password) => AW.secureSave({ email: String(email), password: String(password) }).then((r) => !!r.ok),
    load: () => AW.secureLoad().then((r) => (r && r.email ? { email: r.email, password: r.password } : null)),
    clear: () => AW.secureClear().then(() => true),
  };

  // Things the desktop did with Electron menus / dialogs.
  window.awNative = {
    openExternal: (url) => AW.openExternal({ url }),
    openScanBrowser: (url) => AW.captchaOpen({ url }),
    setShowWorkers: (show) => AW.setShowWorkers({ show: !!show }),
    clearScanCookies: () => AW.clearCookies(),
    saveCsv: (prefix, csv) => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const name = `${prefix}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
      return AW.saveFile({ filename: name, text: "\ufeff" + csv, mime: "text/csv" });
    },
  };

  // The Google Apps Script login backend is called natively, so WebView CORS rules do not apply.
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    if (/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      const r = await AW.netFetch({
        url,
        method: (init && init.method) || "GET",
        headers: (init && init.headers) || {},
        body: init && init.body != null ? String(init.body) : null,
      });
      return new Response(r.body, { status: r.status, headers: { "Content-Type": r.contentType || "application/json" } });
    }
    return origFetch(input, init);
  };
})();
