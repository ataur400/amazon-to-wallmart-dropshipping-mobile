#!/usr/bin/env python3
"""Builds www/ for the Android app from the UNCHANGED desktop app (desktop-app/).

Only a handful of tiny, asserted patches are applied (CSV save, login protocol check,
version label, a few words). Everything else - scanning logic, fees, filters, history,
login, design - is the desktop v1.8.1 code as it is.
"""
import shutil, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "desktop-app"
OUT = ROOT / "www"
EXTRA = ROOT / "mobile-src"

def patch(text, old, new, label):
    if old not in text:
        sys.exit(f"PATCH FAILED ({label}): expected text not found. Desktop source changed?")
    return text.replace(old, new, 1)

if OUT.exists():
    shutil.rmtree(OUT)
shutil.copytree(SRC, OUT)
for f in ("mobile-shim.js", "mobile.js", "mobile.css"):
    shutil.copy2(EXTRA / f, OUT / f)

# ---- app.html
p = OUT / "app.html"; t = p.read_text(encoding="utf-8")
t = patch(t, 'content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"', "viewport")
t = patch(t, '<link rel="stylesheet" href="auth.css" />', '<link rel="stylesheet" href="auth.css" />\n  <link rel="stylesheet" href="mobile.css" />', "css")
t = patch(t, '<script src="auth-config.js"></script>', '<script src="mobile-shim.js"></script>\n  <script src="auth-config.js"></script>', "shim")
t = patch(t, '<script src="app.js"></script>', '<script src="app.js"></script>\n  <script src="mobile.js"></script>', "mobilejs")
t = patch(t, 'id="ver">v1.8.0<', 'id="ver">v1.8.1<', "ver html")
t = patch(t, 'saved on this computer', 'saved on this phone', "history text")
p.write_text(t, encoding="utf-8")
p.rename(OUT / "index.html")   # Capacitor loads index.html

# ---- app.js
p = OUT / "app.js"; t = p.read_text(encoding="utf-8")
t = patch(t, 'const VERSION = "1.8.0";', 'const VERSION = "1.8.1";', "VERSION")
# CSV export: WebView cannot save blob downloads, so hand the text to the native saver.
t = patch(t, 'const blob = new Blob(["\\ufeff" + csv]',
          'if (window.awNative && window.awNative.saveCsv) { window.awNative.saveCsv(prefix, csv); return; }\n  const blob = new Blob(["\\ufeff" + csv]', "csv")
p.write_text(t, encoding="utf-8")

# ---- auth.js
p = OUT / "auth.js"; t = p.read_text(encoding="utf-8")
t = patch(t, 'location.protocol==="awapp:")', 'location.protocol==="awapp:"||window.__AW_MOBILE===true)', "protocol")
t = patch(t, 'return "1.8.0"; }', 'return "1.8.1"; }', "auth version")
p.write_text(t, encoding="utf-8")

print("www/ ready:", sum(1 for _ in OUT.rglob("*") if _.is_file()), "files")
