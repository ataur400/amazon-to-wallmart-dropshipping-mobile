# Amazon to Wallmart Product Finder - Android (v1.8.1)

ডেস্কটপ v1.8.1-এর **একই অ্যাপ**, Android-এর জন্য। স্ক্যান লজিক, ফিল্টার, ফি ক্যালকুলেশন, History, লগইন (একই Google Sheet ব্যাকএন্ড, একই অ্যাকাউন্ট) সব ডেস্কটপের কোড থেকেই নেওয়া (`desktop-app/` ফোল্ডার, অপরিবর্তিত)। শুধু যেগুলো কম্পিউটার-নির্ভর ছিল (Electron উইন্ডো, মেনু, ফাইল সেভ) সেগুলো Android-এর নেটিভ কোড দিয়ে বদলানো হয়েছে।

## APK বানানো (একবারই সেটআপ, ডেস্কটপের মতোই GitHub Actions)
1. এই ফোল্ডারটা একটা নতুন GitHub repo-তে আপলোড করুন।
2. repo -> **Actions -> "Build Android app (APK)" -> Run workflow**।
3. ~10 মিনিট পরে রান শেষ হলে নিচে **Artifacts** থেকে `AmztoWallmart-Product-Finder-android` ডাউনলোড করুন, ভেতরে APK।
4. APK ফোনে পাঠান -> খুলুন -> "Install unknown apps" অনুমতি দিন -> Install।

### আপডেটের সময় ডেটা রাখতে (গুরুত্বপূর্ণ)
কী ছাড়া বিল্ড করলে প্রতিবার আলাদা অস্থায়ী কী দিয়ে সাইন হয়, তখন নতুন APK পুরোনোটার ওপর ইনস্টল হয় না (আনইনস্টল লাগে, History মুছে যায়)। এটা এড়াতে **একবার** নিজের কী বানান:
```
keytool -genkeypair -v -keystore aw-release.jks -alias aw -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 aw-release.jks
```
repo -> Settings -> Secrets and variables -> Actions-এ চারটা secret যোগ করুন: `AW_KEYSTORE_BASE64` (উপরের base64 আউটপুট), `AW_KEYSTORE_PASSWORD`, `AW_KEY_ALIAS` (aw), `AW_KEY_PASSWORD`। **aw-release.jks ফাইলটা সুরক্ষিত রাখুন**, হারালে আর পুরোনো ইনস্টলের ওপর আপডেট দেওয়া যাবে না।

## ব্যবহার (ডেস্কটপের সাথে পার্থক্য)
- **Tools** বাটন (হেডারে, History-র পাশে) = ডেস্কটপের Tools মেনু: Amazon/Walmart স্ক্যান ব্রাউজারে খোলা (CAPTCHA সলভ / US ZIP code সেট), স্ক্যান ব্রাউজারের লাইভ প্রিভিউ দেখানো, cookie মুছা।
- Bot-check মেসেজের **"Open this page"** লিংকে চাপলে অ্যাপের ভেতরেই স্ক্যান-ব্রাউজার খুলবে। CAPTCHA সলভ করে **Done** চাপুন, তারপর আবার Start scan।
- ফলাফলের টেবিল ফোনে প্রতিটা প্রোডাক্ট আলাদা কার্ড হিসেবে দেখায় (তথ্য একই)।
- **Export CSV** ফাইল ফোনের **Downloads** ফোল্ডারে সেভ হয় এবং শেয়ার/ওপেন মেন্যু আসে।
- স্ক্যান চলার সময় স্ক্রিন জেগে থাকে এবং একটা "scanning" নোটিফিকেশন দেখায় (অ্যাপ ব্যাকগ্রাউন্ডে গেলেও চলতে সাহায্য করে)। দীর্ঘ স্ক্যানে ফোন চার্জে রাখুন এবং Settings -> Apps -> এই অ্যাপ -> Battery -> **Unrestricted** করে দিন।
- স্ক্যান চলাকালীন Back চাপলে ডেস্কটপের মতোই জিজ্ঞেস করবে "Keep scanning / Close and stop"।
- Walmart/Amazon ব্লক থাকলে আগের মতোই US VPN লাগতে পারে।
- সর্বনিম্ন Android 10 (API 29)।

## ফোল্ডার
- `desktop-app/` - ডেস্কটপ v1.8.1-এর অ্যাপ কোড (অপরিবর্তিত)
- `mobile-src/` - মোবাইল শিম (`chrome.*` -> নেটিভ), Tools মেনু, মোবাইল CSS
- `android-overlay/` - নেটিভ Java কোড (লুকানো WebView স্ক্যান ব্রাউজার, স্টোরেজ, এনক্রিপ্টেড লগইন, CSV সেভ, ফোরগ্রাউন্ড সার্ভিস)
- `scripts/` - বিল্ডের সময় চলা স্ক্রিপ্ট; `backend/` - আগের Google Apps Script (বদলায়নি)
