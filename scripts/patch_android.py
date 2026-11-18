#!/usr/bin/env python3
"""Run after `npx cap add android`. Adds the native scan engine and Android settings."""
import pathlib, re, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
AND = ROOT / "android"
APP = AND / "app"
PKG_DIR = APP / "src/main/java/com/amztowallmart/productfinder"

def die(msg): sys.exit("PATCH FAILED: " + msg)

if not AND.exists(): die("android/ folder not found. Run `npx cap add android` first.")

# 1) native code (plugin, service, MainActivity)
PKG_DIR.mkdir(parents=True, exist_ok=True)
for f in (ROOT / "android-overlay/java/com/amztowallmart/productfinder").glob("*.java"):
    shutil.copy2(f, PKG_DIR / f.name)

# 2) manifest
mf = APP / "src/main/AndroidManifest.xml"
t = mf.read_text(encoding="utf-8")
if "ScanService" not in t:
    perm = '<uses-permission android:name="android.permission.INTERNET" />'
    if perm not in t: die("INTERNET permission line not found in AndroidManifest.xml")
    t = t.replace(perm, perm + """
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />""", 1)
    if "</application>" not in t: die("</application> not found in AndroidManifest.xml")
    t = t.replace("</application>", '''    <service android:name=".ScanService" android:exported="false" android:foregroundServiceType="dataSync" />
    </application>''', 1)
t = t.replace('android:allowBackup="true"', 'android:allowBackup="false"')
mf.write_text(t, encoding="utf-8")

# 3) gradle: min SDK 29 (CSV saving to Downloads), version, release signing
vg = AND / "variables.gradle"
v = vg.read_text(encoding="utf-8")
v, n = re.subn(r"minSdkVersion\s*=\s*\d+", "minSdkVersion = 29", v)
if n != 1: die("minSdkVersion not found in variables.gradle")
vg.write_text(v, encoding="utf-8")

bg = APP / "build.gradle"
g = bg.read_text(encoding="utf-8")
g, n1 = re.subn(r"versionCode\s+\d+", "versionCode 81", g, count=1)
g, n2 = re.subn(r'versionName\s+"[^"]*"', 'versionName "1.8.1"', g, count=1)
if n1 != 1 or n2 != 1: die("versionCode / versionName not found in app/build.gradle")
if "AW_KEYSTORE_FILE" not in g:
    signing = '''
    lint { abortOnError false }
    signingConfigs {
        release {
            if (System.getenv("AW_KEYSTORE_FILE")) {
                storeFile file(System.getenv("AW_KEYSTORE_FILE"))
                storePassword System.getenv("AW_KEYSTORE_PASSWORD")
                keyAlias System.getenv("AW_KEY_ALIAS")
                keyPassword System.getenv("AW_KEY_PASSWORD")
            }
        }
    }
'''
    g, n = re.subn(r"(\nandroid\s*\{)", r"\1" + signing.replace("\\", "\\\\"), g, count=1)
    if n != 1: die("android { block not found in app/build.gradle")
    g, n = re.subn(r"(release\s*\{\s*\n)(\s*)minifyEnabled false",
                   r'\1\2minifyEnabled false\n\2signingConfig (System.getenv("AW_KEYSTORE_FILE") ? signingConfigs.release : signingConfigs.debug)', g, count=1)
    if n != 1: die("release buildType not found in app/build.gradle")
bg.write_text(g, encoding="utf-8")

# 4) launcher icon from build/icon.png (same icon as the desktop app)
try:
    from PIL import Image, ImageDraw
    src = Image.open(ROOT / "build/icon.png").convert("RGBA")
    res = APP / "src/main/res"
    for d in res.glob("mipmap-anydpi*"): shutil.rmtree(d)           # drop the default adaptive icon
    for f in res.glob("mipmap-*/ic_launcher_foreground.png"): f.unlink()
    for name, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        folder = res / f"mipmap-{name}"; folder.mkdir(parents=True, exist_ok=True)
        im = src.resize((px, px), Image.LANCZOS)
        im.save(folder / "ic_launcher.png")
        mask = Image.new("L", (px, px), 0); ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
        rnd = Image.new("RGBA", (px, px), (0, 0, 0, 0)); rnd.paste(im, (0, 0), mask)
        rnd.save(folder / "ic_launcher_round.png")
except ImportError:
    print("WARNING: Pillow not installed - default launcher icon kept (pip install pillow).")

print("Android project patched.")
