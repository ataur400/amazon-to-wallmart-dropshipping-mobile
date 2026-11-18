// ============================================================
// Amazon to Wallmart Product Finder Dropshipping Tool
// Flow: open an Amazon category search (SOLD BY AMAZON only) in a background tab ->
// read products -> keep small/cheap ones -> for each, open a Walmart search
// in the same tab -> match titles -> work out NET profit (Walmart price minus
// Walmart referral fee, WFS fulfillment fee, inbound cost and the Amazon cost)
// -> open the Walmart product page and check the fixed criteria below.
// ============================================================

// ---- FIXED CRITERIA (not shown as options on purpose) ----
const VERSION = "1.8.0";
const MIN_SELLERS_DEFAULT = 3;   // the Walmart listing must have at least this many sellers
const MAX_SELLERS_DEFAULT = 10;  // ...and at most this many (both editable in the form)
const MAX_VARIANTS = Infinity;  // variations are allowed; count is displayed for review
const WALMART_SELLER_RE = /^walmart(\.com)?(\s+inc\.?)?$/i; // Walmart itself must NOT be a seller
const LOW_PRICE_LIMIT = 10;      // optional WFS surcharge when the retail price is under $10
const AMAZON_SELLER_ID = "ATVPDKIKX0DER"; // Amazon.com as the seller (Amazon's "Sold by Amazon" filter)

// ---- HISTORY settings (v1.5.0) ----
const HISTORY_KEY = "aw_history_v1";   // chrome.storage.local key
const HISTORY_DAYS = 3;                // history older than this many days is deleted automatically
const HISTORY_MAX_SESSIONS = 60;       // safety cap on saved runs
const HISTORY_LOG_MAX = 400;           // max checked-product rows saved per run

// WFS fulfillment fee by shipping weight (lb). Upper bound is inclusive.
const WFS_TIERS = [
  { max: 0.6, fee: 3.45, label: "0 - 0.6 lb" },
  { max: 2,   fee: 4.95, label: "0.6 - 2 lb" },
  { max: 3,   fee: 5.45, label: "2 - 3 lb" },
  { max: 4,   fee: 5.75, label: "3 - 4 lb" },
];
function tierForWeight(lb) {
  for (let i = 0; i < WFS_TIERS.length; i++) if (lb <= WFS_TIERS[i].max) return i;
  return -1; // heavier than 4 lb: no tier defined
}

// Amazon USA mother categories A-Z. "i" = Amazon search department alias.
// physical:false = digital / no-shipping categories (skipped in "All categories (auto)").
const CATEGORIES = [
  { name: "Appliances", i: "appliances" },
  { name: "Arts, Crafts & Sewing", i: "arts-crafts" },
  { name: "Automotive", i: "automotive" },
  { name: "Baby", i: "baby-products" },
  { name: "Beauty & Personal Care", i: "beauty" },
  { name: "Books", i: "stripbooks" },
  { name: "CDs & Vinyl", i: "popular" },
  { name: "Cell Phones & Accessories", i: "mobile" },
  { name: "Clothing, Shoes & Jewelry", i: "fashion" },
  { name: "Collectibles & Fine Art", i: "collectibles" },
  { name: "Computers", i: "computers" },
  { name: "Digital Music", i: "digital-music", physical: false },
  { name: "Electronics", i: "electronics" },
  { name: "Gift Cards", i: "gift-cards", physical: false },
  { name: "Grocery & Gourmet Food", i: "grocery" },
  { name: "Handmade", i: "handmade" },
  { name: "Health & Household", i: "hpc" },
  { name: "Home & Kitchen", i: "garden" },
  { name: "Industrial & Scientific", i: "industrial" },
  { name: "Kindle Store", i: "digital-text", physical: false },
  { name: "Luggage & Travel Gear", i: "luggage" },
  { name: "Movies & TV", i: "movies-tv" },
  { name: "Musical Instruments", i: "mi" },
  { name: "Office Products", i: "office-products" },
  { name: "Patio, Lawn & Garden", i: "lawngarden" },
  { name: "Pet Supplies", i: "pets" },
  { name: "Software", i: "software" },
  { name: "Sports & Outdoors", i: "sporting" },
  { name: "Tools & Home Improvement", i: "tools" },
  { name: "Toys & Games", i: "toys-and-games" },
  { name: "Video Games", i: "videogames" },
];
const ALL_CATEGORIES = "__ALL__";
const catByName = (n) => CATEGORIES.find((c) => c.name === n);

// Amazon category search URL: price filter + "Sold by Amazon" seller filter (prices in cents).
function searchUrl(categoryName, minPrice, maxPrice, keyword, page) {
  const lo = Math.max(0, Math.round(minPrice * 100));
  const hi = Math.round(Math.min(maxPrice, 10000) * 100);
  const p = new URLSearchParams();
  if (keyword) p.set("k", keyword);
  p.set("i", catByName(categoryName).i);
  // "amazon" = Sold by Amazon only. "others" = no seller filter, so third-party (marketplace) sellers are included.
  p.set("rh", (sellerMode === "amazon" ? "p_6:" + AMAZON_SELLER_ID + "," : "") + "p_36:" + lo + "-" + hi);
  if (page > 1) p.set("page", String(page));
  return "https://www.amazon.com/s?" + p.toString();
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const $ = (id) => document.getElementById(id);

let running = false;
let stopFlag = false;
let userStopRequested = false;
const stopWaiters = new Set();
let results = [];
let sellerMode = "amazon"; // "amazon" | "others"
const sellerLabel = () => (sellerMode === "amazon" ? "Sold by Amazon" : "All other sellers");
let amazonFeed = [], walmartFeed = [];
let counters = { amazon: 0, walmart: 0, matched: 0, profitable: 0, dropped: 0 };
let workerTabs = {}; // slot -> tab id (one background tab per parallel worker)
// history state
let historyData = [];        // saved runs, newest first
let currentSession = null;   // the run that is in progress (also inside historyData)
let sessionEntries = [];     // raw feed entries of the current run
let persistTimer = null;
let historyOpen = false;
let histFilter = "all", histQuery = "", histOpenId = null, histTab = "found", histLogFilter = "all";

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

function setStatus(html, cls = "") {
  const el = $("status");
  el.className = "status " + cls;
  el.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

class BlockedError extends Error {
  constructor(site, url) {
    super(site + " showed a bot check");
    this.site = site;
    this.url = url;
  }
}
class LoadError extends Error {}

// ---------- background worker tab ----------
// ---------- self-healing (v1.5.1) ----------
// Chrome sometimes refuses tab changes for a moment (for example while you drag a tab).
// These errors are temporary, so the app waits and tries again instead of stopping the scan.
const TRANSIENT_TAB_RE = /cannot be edited|dragging|Tabs cannot be queried|No tab with id|tab was closed|was removed|Frame with ID/i;

// Records what the app noticed and fixed. Shown in History > "Auto-fix log" of the run.
function logEvent(type, msg) {
  if (!currentSession) return;
  if (!currentSession.events) currentSession.events = [];
  currentSession.events.push({ at: Date.now(), type, msg: String(msg).slice(0, 300) });
  if (currentSession.events.length > 200) currentSession.events.shift();
  schedulePersist();
}

// Runs a Chrome tab call and retries it (up to `tries` times) when the error is temporary.
async function tabCall(label, fn, tries = 8) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (userStopRequested) throw e;
      if (!TRANSIENT_TAB_RE.test(String((e && e.message) || e))) throw e;
      logEvent("retry", label + ": " + e.message + " (try " + i + "/" + tries + ")");
      await sleep(Math.min(400 * i, 3000));
    }
  }
  throw lastErr;
}

async function ensureWorkerTab(slot = 0) {
  const id = workerTabs[slot];
  if (id != null) {
    try { await tabCall("tabs.get", () => chrome.tabs.get(id)); return id; } catch { delete workerTabs[slot]; }
  }
  const tab = await tabCall("tabs.create", () => chrome.tabs.create({ url: "about:blank", active: false }));
  workerTabs[slot] = tab.id;
  return tab.id;
}

async function closeWorkerTab() {
  const ids = Object.values(workerTabs);
  workerTabs = {};
  // Remove worker tabs directly: a pending navigation or page script is terminated
  // by Chrome when its tab is closed. Do not run retry/backoff logic here.
  await Promise.all(ids.map(async (id) => {
    try { await chrome.tabs.remove(id); } catch {}
  }));
}
function waitOrStop(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    stopWaiters.add(finish);
    if (userStopRequested) finish();
  });
}

function waitForLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      err ? reject(err) : resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const onRemoved = (id) => { if (id === tabId) finish(new LoadError("The background tab was closed.")); };
    const timer = setTimeout(() => finish(new LoadError("The page took too long to load.")), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// Load a URL in the worker tab, run `func` inside the page and return its result.
async function runInTab(url, func, site, slot = 0) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (userStopRequested) throw new LoadError("Scan stopped by user.");
    try { return await runInTabOnce(url, func, site, slot); }
    catch (e) {
      lastErr = e;
      if (userStopRequested) throw e;
      // Bot checks and "site blocked" are not temporary: stop retrying.
      if (!(e instanceof LoadError) || /^Chrome could not open/.test(e.message) || attempt === 3) throw e;
      logEvent("recover", site + ": " + e.message + " - opening a fresh tab and trying again (" + attempt + "/2)");
      delete workerTabs[slot];
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

async function runInTabOnce(url, func, site, slot = 0) {
  if (userStopRequested) throw new LoadError("Scan stopped by user.");
  const tabId = await ensureWorkerTab(slot);
  if (userStopRequested) throw new LoadError("Scan stopped by user.");
  const loaded = waitForLoad(tabId);
  loaded.catch(() => {});
  try {
    await tabCall("tabs.update", () => chrome.tabs.update(tabId, { url }));
  } catch (e) {
    delete workerTabs[slot];
    throw new LoadError("Could not open " + site + ": " + e.message);
  }
  await loaded;
  if (userStopRequested) throw new LoadError("Scan stopped by user.");

  const tab = await tabCall("tabs.get", () => chrome.tabs.get(tabId));
  if (!tab.url || tab.url.startsWith("chrome-error:")) {
    throw new LoadError(
      "Chrome could not open " + site + ". Make sure the site opens normally in your browser. " +
      "If you are outside the US, " + site + " may be blocked and you may need a US VPN."
    );
  }

  let res;
  try {
    if (userStopRequested) throw new LoadError("Scan stopped by user.");
    res = await chrome.scripting.executeScript({ target: { tabId }, func });
  } catch (e) {
    throw new LoadError("Could not read the " + site + " page: " + e.message);
  }
  const out = res && res[0] && res[0].result;
  if (!out) throw new LoadError("The " + site + " page returned no data.");
  if (out.blocked) throw new BlockedError(site, url);
  return out;
}

// ---------- functions that run INSIDE the pages (must be self-contained) ----------
// Reads one Amazon search-results page (already filtered to 'Sold by Amazon' in the URL).
async function amazonSearchExtract() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bodyText = () => (document.body ? document.body.innerText : "");
  const blockedRe = /Enter the characters you see below|Robot Check|not a robot|Type the characters you see/i;
  if (blockedRe.test(bodyText()) || /captcha/i.test(location.href)) return { blocked: true };

  // let lazy content and images settle
  for (let i = 0; i < 4; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(450);
  }
  window.scrollTo(0, 0);

  const parsePrice = (text) => {
    if (text == null) return null;
    const m = String(text).match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };

  const imageHash = async (src) => {
    if (!src) return null;
    return await new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => done(null), 3500);
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas"); c.width = 8; c.height = 8;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 8, 8);
          const d = ctx.getImageData(0, 0, 8, 8).data;
          const lum = [];
          for (let i = 0; i < d.length; i += 4) lum.push(0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]);
          const avg = lum.reduce((a,b)=>a+b,0) / lum.length;
          let bits = ""; for (let i=0;i<lum.length;i+=4) {
            let nib=0; for(let j=0;j<4;j++) if(lum[i+j] >= avg) nib |= (1 << (3-j));
            bits += nib.toString(16);
          }
          clearTimeout(timer); done(bits);
        } catch (e) { clearTimeout(timer); done(null); }
      };
      img.onerror = () => { clearTimeout(timer); done(null); };
      img.src = src;
    });
  };
  const cards = document.querySelectorAll('div[data-component-type="s-search-result"]');
  const seen = new Set();
  const items = [];
  cards.forEach((card) => {
    const asin = card.getAttribute("data-asin");
    if (!asin || seen.has(asin)) return;
    const img = card.querySelector("img.s-image");
    const titleEl = card.querySelector("h2 span") || card.querySelector("h2");
    let title = titleEl ? titleEl.textContent.trim() : "";
    if (!title && img) title = img.getAttribute("alt") || "";
    const priceEl =
      card.querySelector(".a-price:not(.a-text-price) .a-offscreen") ||
      card.querySelector(".a-price .a-offscreen");
    const price = priceEl ? parsePrice(priceEl.textContent) : null;
    if (!title || price == null) return;
    seen.add(asin);
    const sm = (card.innerText || card.textContent || "").match(/([\d.,]+\s*[KkMm]?\+?)\s*bought in past month/i);
    items.push({
      asin,
      title: title.replace(/\s+/g, " ").trim(),
      price,
      image: img ? (img.currentSrc || img.src || "") : "",
      imageHash: img ? imageHash(img.currentSrc || img.src || "") : null,
      url: "https://www.amazon.com/dp/" + asin,
      sales: sm ? sm[1].replace(/\s+/g, "") + " / month" : "",
    });
  });
  await Promise.all(items.map(async (item) => { item.imageHash = await item.imageHash; }));
  const next = document.querySelector("a.s-pagination-next");
  const hasNext = !!next && !next.classList.contains("s-pagination-disabled") && next.getAttribute("aria-disabled") !== "true";
  return { items, hasNext, pageTitle: document.title };
}

// Reads visible Amazon offer cards. Counts are only reported when the page exposes
// seller/fulfillment evidence; hidden or inaccessible offers remain unverified.
async function amazonSellerExtract() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = document.body ? document.body.innerText : "";
  if (/Robot Check|Enter the characters you see below|not a robot/i.test(text.slice(0, 2500))) return { blocked: true };
  for (let i = 0; i < 5; i++) { window.scrollTo(0, document.body.scrollHeight); await sleep(250); }
  window.scrollTo(0, 0);
  const cards = Array.from(document.querySelectorAll('#aod-offer, [id^="aod-offer"], .olpOffer, .aod-pinned-offer'));
  const sellers = new Map();
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  for (const card of cards) {
    const t = clean(card.innerText || card.textContent);
    const sm = t.match(/(?:Sold by|Seller)\s*:?\s*([^\n]+)/i);
    const name = clean(sm && sm[1]).replace(/\s*(?:Ships from|Fulfilled by).*$/i, '').slice(0, 100);
    if (!name) continue;
    const low = t.toLowerCase();
    const type = /ships from\s*amazon|fulfilled by amazon|amazon fulfillment/i.test(low) ? 'fba' :
      /ships from\s*(?!amazon)|fulfilled by\s*(?!amazon)/i.test(low) ? 'fbm' : 'unknown';
    const key = name.toLowerCase();
    if (!sellers.has(key)) sellers.set(key, { name, type });
    else if (sellers.get(key).type === 'unknown' && type !== 'unknown') sellers.get(key).type = type;
  }
  const list = Array.from(sellers.values());
  const body = document.body ? document.body.innerText : '';
  const totalMatch = body.match(/(?:Other sellers on Amazon|New \(\d+\) from|See All Buying Options)[^\n]{0,60}/i);
  const totalNum = totalMatch && totalMatch[0].match(/\((\d+)\)/);
  const fba = list.filter(x => x.type === 'fba').length;
  const fbm = list.filter(x => x.type === 'fbm').length;
  const unknown = list.filter(x => x.type === 'unknown').length;
  // Read variation option counts from Amazon's visible variation selectors.
  let amazonVariationCount = 0;
  const variationGroups = [];
  for (const group of Array.from(document.querySelectorAll('[id^="variation_"], #twister .a-row, .variation-dropdown-container'))) {
    const label = clean(group.querySelector("label, .a-form-label")?.innerText || group.getAttribute("id") || "");
    const options = group.querySelectorAll('li, option, [data-defaultasin]');
    const count = options.length;
    if (count > amazonVariationCount) amazonVariationCount = count;
    if (count > 0) variationGroups.push({ label, count });
  }
  return { sellers: list, fba, fbm, unknown, observed: list.length, source: list.length ? 'visible-offers' : 'not-exposed', offerHint: totalNum ? Number(totalNum[1]) : null, variationCount: amazonVariationCount, variationGroups };
}

async function walmartExtract() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isBlocked = () => {
    const t = (document.title || "") + " " + (document.body ? document.body.innerText.slice(0, 2000) : "");
    return /Robot or human|Press\s*&\s*Hold|verify your identity|confirm that you.re a human/i.test(t) ||
      !!document.querySelector("#px-captcha");
  };

  let data = null;
  for (let i = 0; i < 14; i++) {
    if (isBlocked()) return { blocked: true };
    const el = document.getElementById("__NEXT_DATA__");
    if (el) {
      try { data = JSON.parse(el.textContent); break; } catch (e) {}
    }
    await sleep(500);
  }
  if (!data) return { items: [], noData: true };

  const raw = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 14) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (node.usItemId && node.name) raw.push(node);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(data, 0);

  const parsePrice = (text) => {
    if (text == null) return null;
    if (typeof text === "number") return text;
    const m = String(text).match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };

  const imageHash = async (src) => {
    if (!src) return null;
    return await new Promise((resolve) => {
      const img = new Image(); let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => done(null), 3500);
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas"); c.width = 8; c.height = 8;
          const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img,0,0,8,8);
          const d = ctx.getImageData(0,0,8,8).data, lum=[];
          for(let i=0;i<d.length;i+=4) lum.push(.299*d[i]+.587*d[i+1]+.114*d[i+2]);
          const avg=lum.reduce((a,b)=>a+b,0)/lum.length; let bits="";
          for(let i=0;i<lum.length;i+=4){let n=0;for(let j=0;j<4;j++)if(lum[i+j]>=avg)n|=1<<(3-j);bits+=n.toString(16);}
          clearTimeout(timer); done(bits);
        } catch(e) { clearTimeout(timer); done(null); }
      };
      img.onerror=()=>{clearTimeout(timer);done(null);}; img.src=src;
    });
  };
  const seen = new Set();
  const items = [];
  for (const o of raw) {
    const id = String(o.usItemId);
    if (seen.has(id) || o.isSponsoredFlag) continue;
    const pi = o.priceInfo || {};
    let price = pi.currentPrice && pi.currentPrice.price;
    if (price == null) price = parsePrice(pi.linePrice);
    if (price == null) price = parsePrice(o.price);
    if (price == null || !isFinite(price)) continue;
    seen.add(id);
    const seller = o.sellerName || o.sellerDisplayName || o.seller || "";
    // Rough hint only: the real variation check happens on the product page.
    let variantHint = 0;
    if (Array.isArray(o.variantCriteria)) {
      o.variantCriteria.forEach((c) => {
        const n = c && Array.isArray(c.variantList) ? c.variantList.length : 0;
        if (n > variantHint) variantHint = n;
      });
    }
    items.push({
      id,
      title: String(o.name).replace(/\s+/g, " ").trim(),
      price: Number(price),
      seller: typeof seller === "string" ? seller : "",
      variantHint,
      image: (o.imageInfo && (o.imageInfo.thumbnailUrl || (o.imageInfo.allImages && o.imageInfo.allImages[0] && o.imageInfo.allImages[0].url))) || (typeof o.image === "string" ? o.image : ""),
      imageHash: await imageHash((o.imageInfo && (o.imageInfo.thumbnailUrl || (o.imageInfo.allImages && o.imageInfo.allImages[0] && o.imageInfo.allImages[0].url))) || (typeof o.image === "string" ? o.image : "")),
      brand: String(o.brand || o.brandName || ""),
      url: "https://www.walmart.com" + (o.canonicalUrl || "/ip/" + id),
    });
    if (items.length >= 8) break;
  }
  return { items };
}

// Reads ONE Walmart product page: who sells it, how many sellers, how many variations.
async function walmartItemExtract() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isBlocked = () => {
    const t = (document.title || "") + " " + (document.body ? document.body.innerText.slice(0, 2000) : "");
    return /Robot or human|Press\s*&\s*Hold|verify your identity|confirm that you.re a human/i.test(t) ||
      !!document.querySelector("#px-captcha");
  };

  let data = null;
  for (let i = 0; i < 14; i++) {
    if (isBlocked()) return { blocked: true };
    const el = document.getElementById("__NEXT_DATA__");
    if (el) {
      try { data = JSON.parse(el.textContent); break; } catch (e) {}
    }
    await sleep(500);
  }
  if (!data) return { noData: true };

  const root = data && data.props && data.props.pageProps && data.props.pageProps.initialData &&
    data.props.pageProps.initialData.data;
  const product = root && root.product;
  if (!product) return { noData: true };

  // Give the page a moment to draw the seller section ("Compare all N sellers").
  for (let i = 0; i < 10; i++) {
    const txt = document.body ? document.body.innerText : "";
    if (/add to cart|sold (and shipped )?by|out of stock|compare all/i.test(txt)) break;
    await sleep(500);
  }
  if (isBlocked()) return { blocked: true };

  // ----- sellers -----
  const names = new Set();
  const sellerDetails = new Map();
  const addName = (n, node = null) => {
    if (typeof n !== "string" || !n.trim()) return;
    const name = n.trim(); names.add(name);
    const blob = node && typeof node === "object" ? JSON.stringify(node).toLowerCase() : "";
    const kind = /(fulfilled by walmart|walmart fulfillment services|fulfillmenttype.{0,20}wfs|fulfillmentmethod.{0,20}wfs|iswfs.{0,8}true)/i.test(blob) ? "wfs" :
      /\b(sellerfulfilled|fulfilledbyseller|marketplace seller|ship from seller)\b/i.test(blob) ? "other" : "unknown";
    const key = name.toLowerCase();
    if (!sellerDetails.has(key) || (sellerDetails.get(key).type === "unknown" && kind !== "unknown")) sellerDetails.set(key, { name, type: kind });
  };
  addName(product.sellerName || product.sellerDisplayName, product);

  let extraSellers = null;
  const countKeys = /^(additionalOfferCount|otherOffersCount|otherOfferCount|otherSellerCount|additionalSellerCount|numberOfOtherSellers)$/;
  const walk = (node, parentKey, depth) => {
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, parentKey, depth + 1)); return; }
    if (/offer|seller/i.test(parentKey || "")) { addName(node.sellerName || node.sellerDisplayName, node); }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (countKeys.test(k) && typeof v === "number") extraSellers = Math.max(extraSellers || 0, v);
      if (v && typeof v === "object") walk(v, k, depth + 1);
    }
  };
  walk(product, "", 0);

  const text = document.body ? document.body.innerText : "";
  let pageTotal = null;
  const m1 = text.match(/(?:compare|see|view)\s+all\s+(\d+)\s+sellers?/i);
  const m2 = text.match(/(\d+)\s+other\s+sellers?/i);
  if (m1) pageTotal = parseInt(m1[1], 10);
  else if (m2) pageTotal = parseInt(m2[1], 10) + 1;

  let sellerCount, sellerSource;
  if (pageTotal != null) { sellerCount = pageTotal; sellerSource = "page"; }
  else if (extraSellers != null) { sellerCount = extraSellers + 1; sellerSource = "json"; }
  else { sellerCount = Math.max(1, names.size); sellerSource = "inferred"; } // no seller list shown = single seller

  // ----- variations -----
  let variantCount = 0;
  const vm = product.variantsMap;
  if (vm && typeof vm === "object") variantCount = Object.keys(vm).length;
  const crit = Array.isArray(product.variantCriteria) ? product.variantCriteria : [];
  crit.forEach((c) => {
    const n = c && Array.isArray(c.variantList) ? c.variantList.length : 0;
    if (n > variantCount) variantCount = n;
  });

  // Walmart does not publish monthly sales. Read the nearest thing the page shows
  // (e.g. "500+ bought since yesterday"), or nothing.
  const sm = text.match(/([\d.,]+\s*[KkMm]?\+?)\s*(?:bought|sold)\s+(since yesterday|in (?:the )?past (?:month|\d+ days?|week)|this month)/i);
  const sales = sm ? sm[1].replace(/\s+/g, "") + " " + sm[2].toLowerCase() : "";

  // ----- Walmart listing/package weight (normalized to pounds) -----
  // Priority: shipping/package weight > item/product weight > generic weight.
  // Capacity, dimensions, and marketing claims are deliberately ignored.
  const parseNum = (v) => {
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
    let x = String(v ?? "").trim().replace(/\s/g, "");
    if (!x) return null;
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(x)) x = x.replace(/,/g, "");
    else if (/^\d+,\d+$/.test(x)) x = x.replace(",", ".");
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const asLb = (value, unit) => {
    const n = parseNum(value);
    if (n == null) return null;
    const u = String(unit || "").toLowerCase().replace(/[.\s]/g, "");
    if (/^(oz|ounce|ounces)$/.test(u)) return n / 16;
    if (/^(kg|kilogram|kilograms)$/.test(u)) return n * 2.2046226218;
    if (/^(g|gram|grams)$/.test(u)) return n / 453.59237;
    if (/^(mg|milligram|milligrams)$/.test(u)) return n / 453592.37;
    if (/^(lb|lbs|pound|pounds)$/.test(u)) return n;
    return null;
  };
  const weightFromText = (raw) => {
    const x = String(raw ?? "").replace(/\u00a0/g, " ").trim();
    const combo = x.match(/(\d+(?:[,.]\d+)?)\s*(?:lb|lbs|pounds?)\s*(?:[,;and]+\s*)?(\d+(?:[,.]\d+)?)\s*(?:oz|ounces?)\b/i);
    if (combo) {
      const a = asLb(combo[1], "lb"), b = asLb(combo[2], "oz");
      return a != null && b != null ? a + b : null;
    }
    const m = x.match(/(?:^|[^\w.])(\d[\d,]*(?:\.\d+)?)\s*(lb|lbs|pounds?|oz|ounces?|kg|kilograms?|grams?|g|mg)\b/i);
    return m ? asLb(m[1], m[2]) : null;
  };
  const rankWeightLabel = (label) => {
    const k = String(label || "").toLowerCase().replace(/[_-]+/g, " ");
    if (!/weight/.test(k)) return 99;
    if (/capacity|dimension|length|width|height|diameter|volume|limit|maximum|max weight|recommended|load/.test(k)) return 99;
    if (/shipping|package|packaged|ship weight/.test(k)) return 0;
    if (/item|product|assembled/.test(k)) return 1;
    return 2;
  };
  let weightLb = null, weightSource = null, weightRank = 99;
  const acceptWeight = (label, raw, unit = "") => {
    const rank = rankWeightLabel(label);
    if (rank === 99) return;
    let lb = weightFromText(raw);
    if (lb == null && unit) lb = asLb(raw, unit);
    if (lb == null || lb <= 0 || lb > 5000) return;
    if (rank < weightRank) {
      weightRank = rank;
      weightLb = lb;
      weightSource = String(label || "Walmart listing details").trim();
    }
  };
  const walkWeights = (node, parentKey = "", depth = 0) => {
    if (!node || typeof node !== "object" || depth > 22) return;
    if (Array.isArray(node)) {
      node.forEach(v => walkWeights(v, parentKey, depth + 1));
      return;
    }
    const label = typeof node.name === "string" ? node.name : parentKey;
    const unit = node.unitOfMeasure || node.unitCode || node.unit || node.uom || "";
    if (node.value != null && typeof node.value !== "object") acceptWeight(label, node.value, unit);
    if (node.measure != null && typeof node.measure !== "object") acceptWeight(label, node.measure, unit);
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" || typeof value === "number") {
        acceptWeight(key, value);
        // Some Walmart attributes use { name: "Item Weight", value: "..." }.
        if (/weight/i.test(key)) acceptWeight(key, value, unit);
      } else if (value && typeof value === "object") {
        walkWeights(value, key, depth + 1);
      }
    }
  };
  // Read the full product payload first, then the product-specific subtree.
  walkWeights(data);
  walkWeights(product, "product");
  // JSON-LD sometimes carries Product/Offer shipping details absent from pageProps.
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try { walkWeights(JSON.parse(script.textContent || "")); } catch {}
  }
  // Read visible specification rows (label and adjacent value), not arbitrary page numbers.
  if (weightLb == null && document.body) {
    const selectors = [
      '[data-testid*="specification"] tr',
      '[data-testid*="product-spec"] tr',
      '[data-testid*="specification"] li',
      'tr',
      'li'
    ];
    const seenRows = new Set();
    for (const selector of selectors) {
      for (const row of Array.from(document.querySelectorAll(selector))) {
        if (seenRows.has(row)) continue;
        seenRows.add(row);
        const cells = Array.from(row.querySelectorAll("th,td,[class*='label'],[class*='value']"))
          .map(el => (el.innerText || "").trim()).filter(Boolean);
        const rowText = (row.innerText || "").trim();
        const label = cells.length >= 2 ? cells[0] : (rowText.split(/\n/)[0] || "");
        const value = cells.length >= 2 ? cells.slice(1).join(" ") : rowText.slice(label.length).trim();
        if (/weight/i.test(label) && value) acceptWeight(label, value);
      }
    }
    if (weightLb == null) {
      const bodyText = document.body.innerText.replace(/\r/g, "");
      const labelRe = /(shipping\s+weight|package(?:d)?\s+weight|item\s+weight|product\s+weight|assembled\s+product\s+weight)\s*[:\n]\s*([^\n]{1,100})/ig;
      let m;
      while ((m = labelRe.exec(bodyText))) acceptWeight(m[1], m[2]);
    }
  }

  // Page labels are stronger than JSON hints. Unknown fulfillment is never silently
  // counted as WFS or seller-fulfilled.
  const detailList = Array.from(sellerDetails.values());
  const wfsSellerCount = detailList.filter(x => x.type === "wfs").length;
  const otherSellerCount = detailList.filter(x => x.type === "other").length;
  const unknownSellerCount = detailList.filter(x => x.type === "unknown").length;
  return { sellers: Array.from(names), sellerDetails: detailList, sellerCount, sellerSource, wfsSellerCount, otherSellerCount, unknownSellerCount, variantCount, sales, weightLb, weightSource };
}

// ---------- cache ----------
async function cacheGet(key) {
  try {
    const obj = await chrome.storage.local.get(key);
    const hit = obj[key];
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;
  } catch {}
  return undefined;
}
async function cacheSet(key, data) {
  try { await chrome.storage.local.set({ [key]: { t: Date.now(), data } }); } catch {}
}

// ---------- Amazon ----------
// Collects up to maxItems products (Sold by Amazon only) whose price is inside [minPrice, maxPrice].
// req = { cat, keyword }.
async function getAmazonItems(req, maxItems, minPrice, maxPrice, seenAsins, label) {
  const all = [];
  const maxPages = 20;
  let keyword = req.keyword;
  let usedFallbackKeyword = false;

  for (let pg = 1; pg <= maxPages && all.length < maxItems; pg++) {
    if (stopFlag) break;

    const url = searchUrl(req.cat, minPrice, maxPrice, keyword, pg);
    const out = await runInTab(url, amazonSearchExtract, "Amazon");
    const got = out.items || [];

    // Some departments return nothing without a keyword; retry once with the category name.
    if (pg === 1 && !got.length && !keyword && !usedFallbackKeyword) {
      usedFallbackKeyword = true;
      keyword = req.cat.replace(/&/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();
      pg = 0; // restart at page 1 with the keyword
      continue;
    }

    for (const it of got) {
      if (seenAsins.has(it.asin)) continue;
      seenAsins.add(it.asin);
      if (it.price < minPrice || it.price > maxPrice) continue;
      all.push(it);
      counters.amazon++;
      pushFeed(amazonFeed, { n: counters.amazon, item: it, status: "Scanned on Amazon (" + sellerLabel() + ")", cls: "ok" });
    }
    setStatus(`${escapeHtml(label)}: page ${pg}, ${all.length} ${sellerLabel()} products in your price range so far...`);

    if (!got.length) break;
    if (out.hasNext === false) break;
    if (pg < maxPages && all.length < maxItems) await sleep(jitter(800, 1500));
  }
  return all.slice(0, maxItems);
}

// ---------- Walmart ----------
function buildQuery(title) {
  const cleaned = String(title || "")
    .replace(/[\(\[].*?[\)\]]/g, " ")
    .replace(/[^\w\s\-\.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const comma = cleaned.indexOf(",");
  let terms = cleaned.split(" ");
  if (comma > 0 && comma < 55) {
    const prefix = cleaned.slice(0, comma).trim().split(" ");
    const suffix = cleaned.slice(comma + 1).trim().split(" ");
    // Keep the product-type tail from the prefix, but de-emphasize the brand.
    terms = prefix.slice(-2).concat(suffix);
  } else if (terms.length > 5) {
    // If there is no comma, omit only the first leading brand token.
    terms = terms.slice(1);
  }
  return terms.filter(Boolean).slice(0, 10).join(" ");
}

// ---------- matching ----------
const STOP = new Set(["the", "and", "for", "with", "of", "a", "an", "in", "to", "by", "new", "pack", "set"]);

function tokens(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s\-\.]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[\-\.]+|[\-\.]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// "2 pack", "pack of 6", "12 count", "24 ct" ... -> number, or null if not stated
function packCount(title) {
  const t = title.toLowerCase();
  const m =
    t.match(/(\d+)\s*[- ]?\s*(?:pack|pk|ct|count|pcs|pieces|pairs)\b/) ||
    t.match(/pack of\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function productSpecs(title) {
  const t = String(title || "").toLowerCase().replace(/[×✕]/g, "x");
  const out = { pack: null, dimensions: [], colors: [], fluidOz: null };
  const pack = t.match(/(?:pack\s+of\s*(\d+)|(\d+)\s*[- ]?\s*(?:pack|pk|ct|count|pcs|pieces|pair|pairs))\b/i);
  if (pack) out.pack = Number(pack[1] || pack[2]);
  const dimRe = /(\d+(?:\.\d+)?)\s*(inches|inch|in|cm|mm|feet|foot|ft)\b/g;
  let m;
  while ((m = dimRe.exec(t))) {
    const n = Number(m[1]), u = m[2].startsWith("in") ? "in" : m[2].startsWith("cm") ? "cm" : m[2].startsWith("mm") ? "mm" : "ft";
    const inches = u === "in" ? n : u === "cm" ? n / 2.54 : u === "mm" ? n / 25.4 : n * 12;
    out.dimensions.push(inches);
  }
  const fl = t.match(/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*oz|fluid\s+ounces?)\b/i);
  if (fl) out.fluidOz = Number(fl[1]);
  const colorWords = ["black","white","blue","red","green","pink","purple","yellow","gray","grey","silver","gold","clear","brown","beige","navy","orange"];
  out.colors = colorWords.filter(c => new RegExp("\\b" + c + "\\b", "i").test(t));
  return out;
}
function compareSpecs(aTitle, wTitle) {
  const a = productSpecs(aTitle), w = productSpecs(wTitle);
  const issues = [];
  const packStatus = a.pack == null || w.pack == null ? "unknown" : (a.pack === w.pack ? "match" : "different");
  const sizeStatus = !a.dimensions.length || !w.dimensions.length ? "unknown" :
    (a.dimensions.some(x => w.dimensions.some(y => Math.abs(x-y) <= Math.max(.15, x*.03))) ? "match" : "different");
  const colorStatus = !a.colors.length || !w.colors.length ? "unknown" :
    (a.colors.some(c => w.colors.includes(c)) ? "match" : "different");
  const fluidStatus = a.fluidOz == null || w.fluidOz == null ? "unknown" :
    (Math.abs(a.fluidOz-w.fluidOz) <= Math.max(.1, a.fluidOz*.03) ? "match" : "different");
  if (packStatus === "different") issues.push("Pack/count differs");
  if (sizeStatus === "different") issues.push("Product size differs");
  if (colorStatus === "different") issues.push("Color differs");
  if (fluidStatus === "different") issues.push("Fluid volume differs");
  return { a, w, packStatus, sizeStatus, colorStatus, fluidStatus, issues, pass: true };
}
function imageDistance(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let bits = 0;
  for (let i=0;i<a.length;i++) {
    const x=parseInt(a[i],16), y=parseInt(b[i],16), z=x^y;
    bits += (z&1)+((z>>1)&1)+((z>>2)&1)+((z>>3)&1);
  }
  return bits;
}
function similarity(amazonTitle, walmartTitle) {
  const brandPrefix = (title) => {
    const t = String(title || "");
    const comma = t.indexOf(",");
    // Ignore a distinct leading brand/brand+descriptor segment when both
    // listings have a comma-separated title. Brand identity is not a gate.
    return comma > 0 && comma < 48 ? t.slice(comma + 1) : t;
  };
  const a = tokens(brandPrefix(amazonTitle)), b = tokens(brandPrefix(walmartTitle));
  const allA = tokens(amazonTitle), allB = tokens(walmartTitle);
  const aa = a.length >= 3 ? a : allA;
  const bb = b.length >= 3 ? b : allB;
  if (!aa.length || !bb.length) return 0;
  const A = new Set(aa), B = new Set(bb);
  let inter=0; A.forEach(t=>{if(B.has(t))inter++;});
  const dice=(2*inter)/(A.size+B.size);
  const numbers=aa.filter(t=>/\d/.test(t));
  const numberScore=numbers.length ? numbers.filter(t=>B.has(t)).length/numbers.length : dice;
  return Math.max(0,Math.min(1,dice*.78+numberScore*.22));
}
// Picks the best-matching Walmart search result. The product is dropped (not
// swapped for a worse match) if that best match is sold by Walmart itself or
// looks like it has variations.
// Returns { match, reason } where reason is null, "nomatch", "walmart" or "variants".
async function findWalmartMatch(amazonItem, opts, slot = 0) {
  const cacheKey = "w4:" + amazonItem.asin;
  let candidates = await cacheGet(cacheKey);
  if (candidates === undefined) {
    const url = "https://www.walmart.com/search?q=" + encodeURIComponent(buildQuery(amazonItem.title));
    const out = await runInTab(url, walmartExtract, "Walmart", slot);
    candidates = out.items || [];
    if (!out.noData) await cacheSet(cacheKey, candidates);
    await sleep(jitter(1000, 2000)); // go slowly so we are not blocked
  }

  let best = null;
  for (const c of candidates) {
    const ratio = c.price / amazonItem.price;
    if (ratio < 0.4 || ratio > 3.5) continue; // huge difference = probably a different product
    const titleScore = similarity(amazonItem.title, c.title);
    const specs = compareSpecs(amazonItem.title, c.title);
    const imgDistance = imageDistance(amazonItem.imageHash, c.imageHash);
    const imageStatus = imgDistance == null ? "unverified" : (imgDistance <= 18 ? "similar" : imgDistance >= 30 ? "mismatch" : "uncertain");
    // Soft scoring: brand is ignored; image/spec differences reduce confidence
    // rather than eliminating potentially valid cross-brand equivalents.
    const imageScore = imgDistance == null ? null : Math.max(0, 1 - imgDistance/64);
    let score = imageScore == null ? titleScore * 0.88 : titleScore * 0.66 + imageScore * 0.34;
    if (specs.packStatus === "different") score -= 0.16;
    if (specs.sizeStatus === "different") score -= 0.12;
    if (specs.fluidStatus === "different") score -= 0.12;
    if (specs.colorStatus === "different") score -= 0.035;
    if (imageStatus === "mismatch") score -= 0.12;
    if (imageStatus === "uncertain") score -= 0.035;
    score = Math.max(0, Math.min(1, score));
    const candidate = { ...c, score, titleScore, imgDistance, imageStatus, specAudit: specs, specConflicts: specs.issues };
    if (!best || score > best.score) best = candidate;
  }
  if (!best || best.score < Math.max(opts.minMatch, 0.48)) return { match: null, reason: "nomatch", best };
  if (best.titleScore < 0.42) return { match: null, reason: "nomatch", best };
  const soldByWalmart = !!best.seller && WALMART_SELLER_RE.test(best.seller.trim());
  if (opts.onlyWalmartSold) {
    if (best.seller && !soldByWalmart) return { match: null, reason: "notwalmart", best };
  } else if (soldByWalmart) {
    return { match: null, reason: "walmart", best };
  }
  return { match: best, reason: null };
}

// ---------- profit ----------
// Net profit per unit if you buy on Amazon and sell on Walmart through WFS:
//   Walmart price - referral fee - WFS fulfillment fee - inbound cost - Amazon price
function calcProfit(amazonPrice, walmartPrice, fees, wfsBase) {
  const referral = walmartPrice * (fees.referralPct / 100);
  const lowPrice = fees.applyLowPrice && walmartPrice < LOW_PRICE_LIMIT ? fees.lowPriceFee : 0;
  const wfs = wfsBase + lowPrice;
  const inbound = fees.inbound;
  const totalCost = referral + wfs + inbound; // everything Walmart/WFS takes before the Amazon cost
  const net = walmartPrice - totalCost - amazonPrice;
  return { referral, wfs, inbound, totalCost, net, netPct: (net / amazonPrice) * 100 };
}

// Decide the WFS tier. Returns { fee, label, weightLb, known } or null if heavier than 4 lb.
function pickTier(weightLb, fees) {
  if (fees.tierMode !== "auto") {
    const t = WFS_TIERS[fees.tierMode];
    return { fee: t.fee, label: "Manual: " + t.label, weightLb: weightLb != null && isFinite(weightLb) ? weightLb : null, known: weightLb != null && isFinite(weightLb) };
  }
  if (weightLb != null && isFinite(weightLb)) {
    const idx = tierForWeight(weightLb);
    if (idx < 0) return null;
    return { fee: WFS_TIERS[idx].fee, label: WFS_TIERS[idx].label, weightLb, known: true };
  }
  const t = WFS_TIERS[fees.fallbackTier];
  return { fee: t.fee, label: t.label + " (weight not found)", weightLb: null, known: false };
}

// Opens the Walmart product page and checks the fixed criteria.
// Returns { ok, reason, sellerCount, sellerSource, variantCount }.
// reason: null, "walmart", "notwalmart", "variants", "fewsellers", "sellers" or "unverified".
async function verifyAmazonSellers(item, slot = 0) {
  const cacheKey = "as2:" + item.asin;
  const cached = await cacheGet(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const out = await runInTab(item.url, amazonSellerExtract, "Amazon", slot);
    const data = { sellers: out.sellers || [], fba: out.fba ?? null, fbm: out.fbm ?? null,
      unknown: out.unknown ?? null, observed: out.observed ?? 0, source: out.source || "not-exposed", offerHint: out.offerHint ?? null,
      variationCount: out.variationCount ?? null, variationGroups: out.variationGroups || [] };
    await cacheSet(cacheKey, data);
    await sleep(jitter(500, 900));
    return data;
  } catch (e) {
    if (e instanceof BlockedError) return { sellers: [], fba: null, fbm: null, unknown: null, observed: 0, source: "blocked", offerHint: null, variationCount: null, variationGroups: [] };
    return { sellers: [], fba: null, fbm: null, unknown: null, observed: 0, source: "unavailable", offerHint: null, variationCount: null, variationGroups: [] };
  }
}

async function verifyWalmartListing(match, opts, slot = 0) {
  const cacheKey = "wi5:" + match.id;
  let info = await cacheGet(cacheKey);
  if (info === undefined) {
    const out = await runInTab(match.url, walmartItemExtract, "Walmart", slot);
    if (out.noData) return { ok: false, reason: "unverified" };
    info = {
      sellers: out.sellers || [],
      sellerDetails: out.sellerDetails || [],
      wfsSellerCount: out.wfsSellerCount ?? null,
      otherSellerCount: out.otherSellerCount ?? null,
      unknownSellerCount: out.unknownSellerCount ?? null,
      sellerCount: out.sellerCount,
      sellerSource: out.sellerSource,
      variantCount: out.variantCount,
      sales: out.sales || "",
      weightLb: out.weightLb == null ? null : out.weightLb,
      weightSource: out.weightSource || null,
    };
    await cacheSet(cacheKey, info);
    await sleep(jitter(1000, 2000));
  }
  const base = { sellerDetails: info.sellerDetails || [], wfsSellerCount: info.wfsSellerCount ?? null, otherSellerCount: info.otherSellerCount ?? null, unknownSellerCount: info.unknownSellerCount ?? null, sellerCount: info.sellerCount, sellerSource: info.sellerSource, variantCount: info.variantCount, walmartSales: info.sales || "", weightLb: info.weightLb == null ? null : info.weightLb, weightSource: info.weightSource || null };
  const hasWalmart = (info.sellers || []).some((n) => WALMART_SELLER_RE.test(String(n).trim()));
  if (opts.onlyWalmartSold) {
    if (!(info.sellers || []).length) return { ...base, ok: false, reason: "unverified" };
    if (!hasWalmart) return { ...base, ok: false, reason: "notwalmart" };
  } else if (hasWalmart) {
    return { ...base, ok: false, reason: "walmart" };
  }
  // Variation count is informational; do not reject a product only because it has variants.
  if (info.sellerCount < opts.minSellers) return { ...base, ok: false, reason: "fewsellers" };
  if (info.sellerCount > opts.maxSellers) return { ...base, ok: false, reason: "sellers" };
  return { ...base, ok: true, reason: null };
}

// ---------- live scan feed ----------
const FEED_MAX = 40;
let feedQueued = false;
function pushFeed(list, entry) {
  list.unshift(entry);
  if (list.length > FEED_MAX) list.length = FEED_MAX;
  scheduleFeed();
}
function setEntry(entry, status, cls) { entry.status = status; entry.cls = cls; scheduleFeed(); if (currentSession) schedulePersist(); }
let feedDirty = false;
function scheduleFeed() {
  if (feedQueued) return;
  feedQueued = true;
  setTimeout(() => {
    feedQueued = false;
    // Do not redraw while this tab is in the background; it is redrawn when you come back.
    if (document.hidden) { feedDirty = true; return; }
    renderFeed();
  }, 160);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { tickClock(); if (feedDirty) { feedDirty = false; renderFeed(); } }
});
function thumb(src) {
  return src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />` : `<div class="noimg">no image</div>`;
}
// Keyed list patching: only new or changed cards are rebuilt (no full innerHTML rewrite, no image flicker).
const feedCache = { feedAmazon: new Map(), feedWalmart: new Map() };
function patchFeed(boxId, entries, htmlFn, emptyHtml) {
  const box = $(boxId), cache = feedCache[boxId];
  if (!entries.length) {
    if (box.dataset.empty !== "1") { box.innerHTML = emptyHtml; box.dataset.empty = "1"; cache.clear(); }
    return;
  }
  if (box.dataset.empty === "1") { box.innerHTML = ""; box.dataset.empty = "0"; cache.clear(); }
  const tpl = document.createElement("template");
  const next = new Map(), order = [];
  for (const e of entries) {
    const html = htmlFn(e);
    let rec = cache.get(e.n);
    if (!rec || rec.html !== html) {
      tpl.innerHTML = html.trim();
      const el = tpl.content.firstElementChild;
      if (!rec) el.classList.add("fresh");
      rec = { html, el };
    }
    next.set(e.n, rec);
    order.push(rec.el);
  }
  cache.forEach((rec, n) => { if (!next.has(n) || next.get(n).el !== rec.el) rec.el.remove(); });
  order.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null); });
  while (box.children.length > order.length) box.lastElementChild.remove();
  cache.clear(); next.forEach((rec, n) => cache.set(n, rec));
}
function setCount(id, v) {
  const el = $(id), t = String(v);
  if (el.textContent === t) return;
  el.textContent = t;
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
}
function renderFeed() {
  setCount("cAmazon", counters.amazon);
  setCount("cWalmart", counters.walmart);
  setCount("cMatched", counters.matched);
  setCount("cProfit", counters.profitable);
  setCount("cDropped", counters.dropped);
  patchFeed("feedAmazon", amazonFeed, (e) => `
    <div class="fcard ${e.cls || ""}">
      <span class="fnum">#${e.n}</span>${thumb(e.item.image)}
      <div class="ftxt"><div class="ftitle">${escapeHtml(e.item.title)}</div>
      <div class="fmeta"><b>${money(e.item.price)}</b> · ${escapeHtml(e.status)}</div></div>
    </div>`, '<div class="fempty">Nothing scanned yet.</div>');
  patchFeed("feedWalmart", walmartFeed, (e) => {
    const w = e.best;
    return `
    <div class="fcard ${e.cls || ""}">
      <span class="fnum">#${e.n}</span>${thumb(w ? w.image : e.item.image)}
      <div class="ftxt"><div class="ftitle">${w ? escapeHtml(w.title) : "Searching: " + escapeHtml(e.item.title)}</div>
      <div class="fmeta">${w ? "<b>" + money(w.price) + "</b> on Walmart · " : ""}Amazon ${money(e.item.price)} · ${escapeHtml(e.status)}</div></div>
    </div>`;
  }, '<div class="fempty">Nothing checked yet.</div>');
}
function resetFeed() {
  amazonFeed = []; walmartFeed = [];
  counters = { amazon: 0, walmart: 0, matched: 0, profitable: 0, dropped: 0 };
  $("live").hidden = false;
  renderFeed();
}

// ---------- UI ----------
function money(n) { return "$" + n.toFixed(2); }

function nowText() {
  return new Date().toLocaleString(undefined, {
    weekday: "short", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function render() {
  const sorted = [...results].sort((x, y) => y.netPct - x.netPct);
  $("table").hidden = sorted.length === 0;
  $("export").disabled = sorted.length === 0;
  $("rows").innerHTML = sorted
    .map((r) => {
      const strong = r.score >= 0.7;
      const aUrl = escapeHtml(r.amazonUrl);
      const wUrl = escapeHtml(r.walmartUrl);
      const est = r.sellerSource === "inferred" ? " (est.)" : "";
      const wt = r.weightLb != null ? r.weightLb.toFixed(2) + " LB" : "N/A";
      return `<tr>
        <td><div class="prod">
          <a href="${aUrl}" target="_blank" rel="noopener" title="Open on Amazon"><img src="${escapeHtml(r.image || "")}" alt="" loading="lazy" decoding="async" /></a>
          <div class="info">
            <a class="ttl" href="${aUrl}" target="_blank" rel="noopener" title="Open on Amazon">${escapeHtml(r.title)}</a>
            <small class="wt">Walmart: ${escapeHtml(r.walmartTitle)}</small>
            <div class="match-audit">
              <span class="audit-chip ${r.imageStatus === "similar" ? "pass" : "warn"}">Image: ${r.imageStatus === "similar" ? "Similar" : r.imageStatus === "mismatch" ? "Different – review" : "Not verified"}</span>
              <span class="audit-chip ${r.titleScore >= .58 ? "pass" : "warn"}">Product similarity: ${Math.round((r.titleScore || 0)*100)}%</span>
              <span class="audit-chip ${(r.specAudit && r.specAudit.packStatus === "different") ? "warn" : "pass"}">Count: ${r.specAudit ? (r.specAudit.packStatus === "match" ? "Match" : r.specAudit.packStatus === "different" ? "Different" : "Not listed") : "N/V"}</span>
              <span class="audit-chip ${(r.specAudit && r.specAudit.sizeStatus === "different") ? "warn" : "pass"}">Size: ${r.specAudit ? (r.specAudit.sizeStatus === "match" ? "Match" : r.specAudit.sizeStatus === "different" ? "Different" : "Not listed") : "N/V"}</span>
              <span class="audit-chip ${(r.specAudit && r.specAudit.colorStatus === "different") ? "warn" : ""}">Color: ${r.specAudit ? (r.specAudit.colorStatus === "match" ? "Match" : r.specAudit.colorStatus === "different" ? "Different" : "Not listed") : "N/V"}</span>
              <span class="audit-chip">Amazon variations: ${r.amazonVariationCount == null ? "N/V" : r.amazonVariationCount}</span>
              <span class="audit-chip">Walmart variations: ${r.variantCount == null ? "N/V" : r.variantCount}</span>
              <span class="audit-chip">Volume: ${r.specAudit ? (r.specAudit.a.fluidOz != null ? r.specAudit.a.fluidOz + " / " : "N/A / ") + (r.specAudit.w.fluidOz != null ? r.specAudit.w.fluidOz + " fl oz" : "N/A") : "N/A"}</span>
            </div>
            <div class="links">
              <a class="btn" href="${aUrl}" target="_blank" rel="noopener">Amazon ↗</a>
              <a class="btn alt" href="${wUrl}" target="_blank" rel="noopener">Walmart ↗</a>
            </div>
          </div>
        </div></td>
        <td class="price">${money(r.amazonPrice)}<small>${escapeHtml(r.sellerLabel || sellerLabel())}</small></td>
        <td class="price">${money(r.walmartPrice)}</td>
        <td class="fees">
          <div class="feetotal"><small>WFS total cost</small>−${money(r.totalCost)}</div>
          <dl class="feelist">
            <div><dt>Referral</dt><dd>${money(r.referral)}</dd></div>
            <div><dt>WFS fee</dt><dd>${money(r.wfs)}</dd></div>
            <div><dt>Inbound</dt><dd>${money(r.inbound)}</dd></div>
            <div class="weight-row" title="${escapeHtml(r.weightSource || (r.weightLb == null ? "Weight not found in Walmart listing details" : "Source: " + r.weightSource))}"><dt>Weight/LB</dt><dd class="${r.weightLb == null ? "weight-na" : "weight-ok"}">${wt}</dd></div>
          </dl>
          <span class="tier" title="WFS fee tier used for the calculation">${escapeHtml(r.tierLabel)}</span>
        </td>
        <td class="gap">+${money(r.net)}<small>+${r.netPct.toFixed(0)}% over Amazon price</small></td>
        <td class="sales">
          <div><small>Amazon</small>${r.amazonSales ? escapeHtml(r.amazonSales) : "<span class=\"na\">Not shown</span>"}</div>
          <div><small>Walmart</small>${r.walmartSales ? escapeHtml(r.walmartSales) : "<span class=\"na\">Not shown</span>"}</div>
        </td>
        <td class="listing"><b>${r.sellerCount}${est}</b> Walmart sellers<small>${r.variantCount <= 1 ? "single listing" : r.variantCount + " variations"}</small>
          <div class="seller-breakdown">
            <div><strong>Amazon</strong><span>FBA: ${r.amazonFbaSellers == null ? "N/V" : r.amazonFbaSellers} · FBM: ${r.amazonFbmSellers == null ? "N/V" : r.amazonFbmSellers}</span><small>${r.amazonSellerSource === "visible-offers" ? "Visible offers" : "Not fully exposed"}${r.amazonUnknownSellers ? " · Unknown: " + r.amazonUnknownSellers : ""}</small></div>
            <div><strong>Walmart</strong><span>WFS: ${r.walmartWfsSellers == null ? "N/V" : r.walmartWfsSellers} · Other: ${r.walmartOtherSellers == null ? "N/V" : r.walmartOtherSellers}</span><small>${r.sellerSource === "inferred" ? "Estimated total" : "Total: " + r.sellerSource}${r.walmartUnknownSellers ? " · Unknown: " + r.walmartUnknownSellers : ""}</small></div>
          </div>
          <span class="badge ${strong && r.imageStatus !== "mismatch" ? "hi" : ""}">${strong && r.imageStatus !== "mismatch" ? "Strong candidate" : "Review candidate"} ${Math.round(r.score * 100)}%</span></td>
      </tr>`;
    })
    .join("");
}

function setRunning(on) {
  running = on;
  document.body.classList.toggle("is-running", on);
  $("start").disabled = on;
  $("startNew").disabled = on;
  $("stop").disabled = !on;
  $("category").disabled = on;
  $("modeAmazon").disabled = on;
  $("modeOthers").disabled = on;
}

async function run() {
  if (running) return;
  stopFlag = false;
  userStopRequested = false;
  stopWaiters.clear();
  results = [];
  render();
  $("barFill").style.width = "0%";
  setRunning(true);
  saveSettings();
  resetFeed();

  const startedAt = nowText();
  const catChoice = $("category").value;
  const cats = catChoice === ALL_CATEGORIES
    ? CATEGORIES.filter((c) => c.physical !== false).map((c) => c.name)
    : [catChoice];
  const speed = Math.max(1, Math.min(4, parseInt($("speed").value, 10) || 2));
  const keyword = ($("keyword").value || "").trim();
  const target = Math.max(1, Math.min(50, parseInt($("target").value, 10) || 20));
  const maxItems = Math.max(10, Math.min(500, parseInt($("maxItems").value, 10) || 100));
  const minProfit = parseFloat($("minProfit").value);
  const minPrice = parseFloat($("minPrice").value) || 0;
  const maxPrice = parseFloat($("maxPrice").value) || 1e9;
  const num = (id, dflt) => { const v = parseFloat($(id).value); return isFinite(v) && v >= 0 ? v : dflt; };
  const minSellers = Math.max(1, Math.round(num("minSellers", MIN_SELLERS_DEFAULT)));
  const maxSellers = Math.max(minSellers, Math.round(num("maxSellers", MAX_SELLERS_DEFAULT)));
  const opts = { minMatch: parseFloat($("minMatch").value), onlyWalmartSold: $("onlyWalmartSold").checked, minSellers, maxSellers };
  const tierSel = $("tierMode").value;
  const fees = {
    referralPct: num("referralPct", 15),
    inbound: num("inbound", 0.5),
    applyLowPrice: $("lowPrice").checked,
    lowPriceFee: 1.0,
    tierMode: tierSel === "auto" ? "auto" : parseInt(tierSel, 10),
    fallbackTier: parseInt($("fallbackTier").value, 10) || 0,
  };
  // Cheapest possible WFS fee: used for the quick pre-check before the Walmart page is opened.
  const minWfs = fees.tierMode === "auto" ? WFS_TIERS[0].fee : WFS_TIERS[fees.tierMode].fee;
  const minProfitPct = isFinite(minProfit) ? minProfit : 20;
  const rejected = { walmart: 0, notwalmart: 0, variants: 0, fewsellers: 0, sellers: 0, unverified: 0, overweight: 0, lowprofit: 0 };
  startSession(readSettings(), rejected);
  let endStatus = "completed";

  const seenAsins = new Set();
  let checked = 0;
  let consecutiveFails = 0;

  try {
    for (let ci = 0; ci < cats.length; ci++) {
      if (stopFlag || results.length >= target) break;
      const cat = cats[ci];
      const label = `${cat} (${ci + 1}/${cats.length})`;
      setStatus("Loading " + escapeHtml(label) + "...");

      let items;
      try {
        items = await getAmazonItems({ cat, keyword }, maxItems, minPrice, maxPrice, seenAsins, label);
      } catch (err) {
        if (err instanceof BlockedError || cats.length === 1) throw err;
        console.warn("Skipping category", cat, err);
        continue;
      }
      if (!items.length) {
        if (cats.length === 1) {
          endStatus = "empty";
          setStatus(
            `No ${sellerLabel()} products between ${money(minPrice)} and ${money(maxPrice)} were found for this setup. Widen the price range, clear the keyword, pick another category, or Amazon may have changed its page layout.`,
            "warn"
          );
          return;
        }
        continue;
      }

      // Parallel workers: each one owns a background tab and takes the next product from the queue.
      let next = 0, done = 0, firstError = null;
      const processItem = async (item, slot) => {
        const i = ++done;
        checked++;
        const entry = { n: ++counters.walmart, item, best: null, status: "Searching on Walmart...", cls: "work" };
        pushFeed(walmartFeed, entry);
        entry.at = Date.now(); sessionEntries.push(entry); schedulePersist();
        const drop = (msg) => { counters.dropped++; setEntry(entry, msg, "bad"); };
        const REASON = { nomatch: "No reliable match (image/spec/title check)", walmart: "Walmart is a seller - skipped", notwalmart: "Not sold by Walmart - skipped", variants: "Has variations - skipped", fewsellers: "Too few sellers - skipped", sellers: "Too many sellers - skipped", unverified: "Could not verify listing", overweight: "Over 4 lb - skipped", lowprofit: "Profit too low after real WFS fee" };
        $("barFill").style.width = Math.round(((ci + i / items.length) / cats.length) * 100) + "%";
        setStatus(
          `${escapeHtml(label)} · ${speed} tab${speed > 1 ? "s" : ""} working · product ${i}/${items.length} · results ${results.length}/${target}<br><small>${escapeHtml(item.title.slice(0, 90))}</small>`
        );

        let found = null;
        try {
          found = await findWalmartMatch(item, opts, slot);
          consecutiveFails = 0;
        } catch (err) {
          if (err instanceof BlockedError) throw err;
          if (err instanceof LoadError && ++consecutiveFails < 3 * speed) { console.warn("Skipped one item:", err.message); logEvent("skip", "Skipped a product: " + err.message); drop("Page failed to load - skipped"); return; }
          throw err;
        }
        entry.best = found.match || found.best || null;
        if (found.reason && found.reason !== "nomatch") rejected[found.reason] = (rejected[found.reason] || 0) + 1;
        const match = found.match;
        if (!match) { drop(REASON[found.reason] || "No match"); return; }
        counters.matched++;
        setEntry(entry, "Matched " + Math.round(match.score * 100) + "% - checking profit", "work");

        // Quick optimistic profit check (cheapest WFS tier). Only open the Walmart page for items that pass.
        const pre = calcProfit(item.price, match.price, fees, minWfs);
        if (pre.net <= 0 || pre.netPct < minProfitPct) { drop("Profit " + pre.netPct.toFixed(0) + "% (below " + minProfitPct + "%)"); return; }
        if (stopFlag || results.length >= target) return;
        setEntry(entry, "Profitable on paper - checking Walmart listing", "work");

        const amazonSellerInfo = await verifyAmazonSellers(item, slot);
        let check;
        try {
          check = await verifyWalmartListing(match, opts, slot);
          consecutiveFails = 0;
        } catch (err) {
          if (err instanceof BlockedError) throw err;
          if (err instanceof LoadError && ++consecutiveFails < 3 * speed) { console.warn("Skipped one item:", err.message); logEvent("skip", "Skipped a product: " + err.message); drop("Page failed to load - skipped"); return; }
          throw err;
        }
        if (!check.ok) { rejected[check.reason]++; drop(REASON[check.reason] || "Rejected"); return; }

        // Real WFS tier from the shipping weight, then the real profit.
        const tier = pickTier(check.weightLb, fees);
        if (!tier) { rejected.overweight++; drop(REASON.overweight); return; }
        const pr = calcProfit(item.price, match.price, fees, tier.fee);
        if (pr.net <= 0 || pr.netPct < minProfitPct) { rejected.lowprofit++; drop(REASON.lowprofit); return; }
        if (results.length >= target) return;
        counters.profitable++;
        setEntry(entry, "PROFITABLE +" + money(pr.net) + " (" + pr.netPct.toFixed(0) + "%)", "win");

        results.push({
          asin: item.asin,
          title: item.title,
          image: item.image,
          amazonPrice: item.price,
          amazonUrl: item.url,
          walmartPrice: match.price,
          walmartUrl: match.url,
          walmartTitle: match.title,
          referral: pr.referral,
          wfs: pr.wfs,
          inbound: pr.inbound,
          totalCost: pr.totalCost,
          tierLabel: tier.label,
          weightLb: tier.weightLb,
          weightSource: check.weightSource || null,
          net: pr.net,
          netPct: pr.netPct,
          sellerCount: check.sellerCount,
          sellerSource: check.sellerSource,
          amazonFbaSellers: amazonSellerInfo.fba,
          amazonFbmSellers: amazonSellerInfo.fbm,
          amazonUnknownSellers: amazonSellerInfo.unknown,
          amazonObservedSellers: amazonSellerInfo.observed,
          amazonSellerSource: amazonSellerInfo.source,
          walmartWfsSellers: check.wfsSellerCount,
          walmartOtherSellers: check.otherSellerCount,
          walmartUnknownSellers: check.unknownSellerCount,
          walmartSellerDetails: check.sellerDetails || [],
          variantCount: check.variantCount,
          amazonSales: item.sales || "",
          walmartSales: check.walmartSales || "",
          score: match.score,
          titleScore: match.titleScore,
          imageStatus: match.imageStatus,
          imageDistance: match.imgDistance,
          specAudit: match.specAudit || null,
          amazonVariationCount: amazonSellerInfo.variationCount,
          amazonVariationGroups: amazonSellerInfo.variationGroups || [],
          foundAt: nowText(),
          sellerLabel: sellerLabel(),
        });
        render();
        schedulePersist();
      };
      const worker = async (slot) => {
        // small stagger so the tabs do not all hit Walmart in the same instant;
        // the wait is interruptible so Stop does not wait for the stagger timer.
        if (slot > 0) await waitOrStop(slot * 700);
        while (!stopFlag && !userStopRequested && !firstError && results.length < target && next < items.length) {
          const item = items[next++];
          try { await processItem(item, slot); }
          catch (err) { firstError = firstError || err; stopFlag = true; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(speed, items.length) }, (_, k) => worker(k)));
      if (firstError) throw firstError;
    }

    endStatus = userStopRequested ? "stopped" : "completed";
    const stopped = userStopRequested ? " (stopped by you)" : "";
    const rej =
      `<br><small>Dropped by the criteria: ` +
      (opts.onlyWalmartSold ? `not sold by Walmart ${rejected.notwalmart}, ` : `Walmart is a seller ${rejected.walmart}, `) +
      `variations ${rejected.variants}, fewer than ${minSellers} sellers ${rejected.fewsellers}, more than ${maxSellers} sellers ${rejected.sellers}, ` +
      `over 4 lb ${rejected.overweight}, profit too low after real WFS fee ${rejected.lowprofit}, could not verify ${rejected.unverified}.</small>` +
      `<br><small>Started: ${escapeHtml(startedAt)} · Finished: ${escapeHtml(nowText())}</small>`;
    if (results.length === 0) {
      setStatus(
        `Checked ${checked} products and none had at least ${minProfitPct}% net profit${stopped}. Try "All categories (auto)", a different keyword, a wider price range, or a lower profit target.` + rej,
        "warn"
      );
    } else {
      setStatus(`Done. Checked ${checked} products and found ${results.length} with at least ${minProfitPct}% net profit${stopped}. Open both links on each result to confirm it is the same product.` + rej);
    }
  } catch (err) {
    if (userStopRequested) {
      endStatus = "stopped";
      setStatus("Scan stopped. Results found so far have been preserved.");
    } else if (err instanceof BlockedError) {
      endStatus = "blocked";
      logEvent("error", err.site + " showed a bot check / CAPTCHA");
      setStatus(
        `${err.site} showed a bot check / CAPTCHA, so the scan stopped. <a href="${escapeHtml(err.url)}" target="_blank" rel="noopener">Open this page</a>, solve the check yourself (or wait a while), then start the scan again. Anything found so far is shown below.`,
        "error"
      );
    } else {
      endStatus = "error";
      if (currentSession) { currentSession.error = String(err.message || err); logEvent("error", err.message || err); }
      setStatus("Error: " + escapeHtml(err.message || String(err)), "error");
      console.error(err);
    }
  } finally {
    finalizeSession(endStatus);
    await closeWorkerTab();
    setRunning(false);
  }
}

function downloadCsv(header, rows, prefix) {
  const csv = [header, ...rows]
    .map((row) => row.map((c) => '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"').join(","))
    .join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  a.download = `${prefix}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCsv(list = results) {
  const lbl = (list[0] && list[0].sellerLabel) || sellerLabel();
  const header = ["Found At", "Title", "Amazon Price (" + lbl + ")", "Walmart Price", "Referral Fee", "WFS Fee", "Inbound Cost", "WFS Total Cost", "Weight Tier", "Weight (lb)", "Weight Source", "Net Profit $", "Net Profit % (over Amazon price)", "Amazon Monthly Sales", "Walmart Sales", "Walmart Sellers", "Amazon FBA Sellers", "Amazon FBM Sellers", "Amazon Unknown Sellers", "Walmart WFS Sellers", "Walmart Other Sellers", "Walmart Unknown Sellers", "Walmart Variations", "Match %", "Amazon URL", "Walmart URL"];
  const rows = [...list]
    .sort((a, b) => b.netPct - a.netPct)
    .map((r) => [r.foundAt, r.title, r.amazonPrice, r.walmartPrice, r.referral.toFixed(2), r.wfs.toFixed(2), r.inbound.toFixed(2), r.totalCost.toFixed(2), r.tierLabel, r.weightLb != null ? r.weightLb.toFixed(2) : "N/A", r.weightSource || "N/A", r.net.toFixed(2), r.netPct.toFixed(1), r.amazonSales, r.walmartSales, r.sellerCount, r.amazonFbaSellers, r.amazonFbmSellers, r.amazonUnknownSellers, r.walmartWfsSellers, r.walmartOtherSellers, r.walmartUnknownSellers, r.variantCount, Math.round(r.score * 100), r.amazonUrl, r.walmartUrl]);
  const selectedCategory = $("category").value;
  const categoryIndex = CATEGORIES.findIndex((c) => c.name === selectedCategory);
  const categoryPrefix = selectedCategory === ALL_CATEGORIES
    ? "All_Categories"
    : String(categoryIndex + 1).padStart(2, "0") + ". " + selectedCategory;
  // Match the supplied workbook naming pattern: category + tool label + timestamp.
  downloadCsv(header, rows, categoryPrefix + "_AmztoWallmart_Product");
}

// ---------- remember the form settings ----------
const SETTING_IDS = ["category", "keyword", "target", "minProfit", "minPrice", "maxPrice", "maxItems", "minMatch",
  "speed", "referralPct", "inbound", "tierMode", "fallbackTier", "minSellers", "maxSellers", "lowPrice", "onlyWalmartSold"];
function readSettings() {
  const o = {};
  SETTING_IDS.forEach((id) => { const el = $(id); o[id] = el.type === "checkbox" ? el.checked : el.value; });
  o.sellerMode = sellerMode;
  return o;
}
function applySettings(o) {
  if (!o) return;
  if (o.sellerMode === "amazon" || o.sellerMode === "others") sellerMode = o.sellerMode;
  SETTING_IDS.forEach((id) => {
    if (!(id in o)) return;
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!o[id]; else el.value = o[id];
  });
}
function saveSettings() {
  try { localStorage.setItem("pgf_settings_v2", JSON.stringify(readSettings())); } catch {}
}
function loadSettings() {
  try { applySettings(JSON.parse(localStorage.getItem("pgf_settings_v2") || "null")); } catch {}
}

// ============================================================
// HISTORY (v1.5.0)
// Every scan is saved as a "run": the settings used, every Amazon product
// checked on Walmart (with the result and the reason it was kept or dropped),
// the profitable results, and the final summary. Runs older than
// HISTORY_DAYS days are deleted automatically.
// ============================================================
const STATUS_INFO = {
  running: { label: "Running", cls: "run" },
  completed: { label: "Completed", cls: "ok" },
  stopped: { label: "Stopped by you", cls: "warn" },
  blocked: { label: "Stopped: bot check", cls: "bad" },
  error: { label: "Error", cls: "bad" },
  empty: { label: "No products found", cls: "mute" },
  interrupted: { label: "Interrupted", cls: "warn" },
};
const hasStorage = () => typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local;
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? escapeHtml(u) : "#");

function packEntry(e) {
  const w = e.best;
  return {
    n: e.n, title: e.item.title, image: e.item.image || "", price: e.item.price, url: e.item.url, asin: e.item.asin,
    wTitle: w ? w.title : "", wPrice: w ? w.price : null, wUrl: w ? w.url : "", wImage: w ? w.image || "" : "",
    status: e.status, cls: e.cls || "", at: e.at || 0,
  };
}

function startSession(settings, rejected) {
  const t = Date.now();
  sessionEntries = [];
  currentSession = {
    id: "s" + t.toString(36) + Math.random().toString(36).slice(2, 6),
    startedAt: t, finishedAt: null, status: "running",
    settings, rejected, counters: { ...counters },
    results: [], log: [], logTotal: 0, note: "", error: "",
  };
  historyData.unshift(currentSession);
  persistHistory();
}

function syncCurrent() {
  const s = currentSession;
  if (!s) return;
  s.counters = { ...counters };
  s.results = results.slice();
  s.logTotal = sessionEntries.length;
  s.log = sessionEntries.slice(-HISTORY_LOG_MAX).map(packEntry);
}

function finalizeSession(status) {
  if (!currentSession) return;
  currentSession.status = status;
  currentSession.finishedAt = Date.now();
  currentSession.note = ($("status").textContent || "").replace(/\s+/g, " ").trim().slice(0, 900);
  syncCurrent();
  currentSession = null;
  clearTimeout(persistTimer); persistTimer = null;
  persistHistory();
}

function pruneHistory(list) {
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return list.filter((s) => s && s.startedAt >= cutoff).slice(0, HISTORY_MAX_SESSIONS);
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistHistory(); }, 2500);
}

async function persistHistory() {
  if (currentSession) syncCurrent();
  historyData = pruneHistory(historyData);
  updateHistoryBadge();
  if (historyOpen) {
    const a = document.activeElement;
    if (!(a && a.tagName === "SELECT" && $("histBody").contains(a))) renderHistory();
  }
  if (!hasStorage()) return;
  try { await chrome.storage.local.set({ [HISTORY_KEY]: historyData }); }
  catch (e) { console.warn("Could not save history:", e); }
}

async function loadHistory() {
  if (!hasStorage()) return;
  try {
    const o = await chrome.storage.local.get(HISTORY_KEY);
    const stored = pruneHistory(Array.isArray(o[HISTORY_KEY]) ? o[HISTORY_KEY] : []);
    const existing = historyData;
    stored.forEach((s) => { if (s.status === "running" && !(currentSession && currentSession.id === s.id)) s.status = "interrupted"; });
    historyData = [...existing, ...stored.filter((s) => !existing.some((e) => e.id === s.id))]
      .sort((a, b) => b.startedAt - a.startedAt);
    await chrome.storage.local.set({ [HISTORY_KEY]: historyData });
  } catch (e) { console.warn("Could not load history:", e); }
  updateHistoryBadge();
}

function updateHistoryBadge() {
  $("histCount").textContent = historyData.length;
  $("historyBtn").classList.toggle("live", !!currentSession);
}

// ---------- history formatting ----------
function fmtTime(ms) {
  return new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtClock(ms) {
  return ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}
function fmtDur(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}
function fmtAgo(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + " min ago";
  if (sec < 86400) return Math.floor(sec / 3600) + " h ago";
  return Math.floor(sec / 86400) + " d ago";
}
function dayLabel(ms) {
  const d = new Date(ms), t = new Date();
  const key = (x) => x.getFullYear() * 400 + x.getMonth() * 32 + x.getDate();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (key(d) === key(t)) return "Today";
  if (key(d) === key(y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "short" });
}
const catName = (s) => ((s.settings && s.settings.category) === ALL_CATEGORIES ? "All categories (auto)" : (s.settings && s.settings.category) || "Unknown category");

function settingRows(s) {
  const st = s.settings || {};
  const tier = (v) => {
    if (v === "auto") return "Auto (from Walmart weight)";
    const t = WFS_TIERS[parseInt(v, 10)];
    return t ? t.label + " = " + money(t.fee) : "-";
  };
  const strict = { "0.6": "Strict", "0.5": "Medium", "0.4": "Loose" }[st.minMatch] || st.minMatch;
  return [
    ["Category", catName(s)],
    ["Keyword", st.keyword || "none"],
    ["Amazon seller type", st.sellerMode === "others" ? "All other sellers" : "Sold by Amazon"],
    ["Search speed", (st.speed || "2") + " tab" + (String(st.speed) === "1" ? "" : "s")],
    ["Results wanted", st.target],
    ["Min net profit", st.minProfit + "%"],
    ["Amazon price range", "$" + st.minPrice + " to $" + st.maxPrice],
    ["Match strictness", strict],
    ["Walmart sellers", st.minSellers + " to " + st.maxSellers],
    ["Max Amazon products / category", st.maxItems],
    ["Referral fee", st.referralPct + "%"],
    ["Inbound cost", "$" + st.inbound],
    ["WFS fee", tier(st.tierMode)],
    ["If weight not found", tier(st.fallbackTier)],
    ["Low-price surcharge", st.lowPrice ? "On" : "Off"],
    ["Only sold by Walmart", st.onlyWalmartSold ? "On" : "Off"],
  ];
}

// ---------- history rendering ----------
function sessionText(s) {
  return [catName(s), (s.settings && s.settings.keyword) || "",
    ...(s.results || []).map((r) => r.title + " " + r.walmartTitle),
    ...(s.log || []).map((e) => e.title + " " + e.wTitle)].join(" ").toLowerCase();
}

function visibleSessions() {
  return historyData.filter((s) => {
    const found = (s.results || []).length;
    if (histFilter === "found" && !found) return false;
    if (histFilter === "none" && found) return false;
    if (histFilter === "issues" && !["blocked", "error", "interrupted", "empty"].includes(s.status)) return false;
    if (histQuery && !sessionText(s).includes(histQuery)) return false;
    return true;
  });
}

function foundRowsHtml(s) {
  const list = [...(s.results || [])].sort((a, b) => b.netPct - a.netPct);
  if (!list.length) return '<div class="hempty">No profitable product was found in this run.</div>';
  return list.map((r) => `
    <div class="hrow">
      ${r.image ? `<img src="${safeUrl(r.image)}" alt="" loading="lazy" />` : '<div class="noimg">no image</div>'}
      <div class="hr-main">
        <a class="hr-ttl" href="${safeUrl(r.amazonUrl)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>
        <small>Walmart: ${escapeHtml(r.walmartTitle || "")}</small>
        <div class="links">
          <a class="btn" href="${safeUrl(r.amazonUrl)}" target="_blank" rel="noopener">Amazon ↗</a>
          <a class="btn alt" href="${safeUrl(r.walmartUrl)}" target="_blank" rel="noopener">Walmart ↗</a>
        </div>
      </div>
      <div class="hr-num"><small>Amazon</small><b>${money(r.amazonPrice)}</b></div>
      <div class="hr-num"><small>Walmart</small><b>${money(r.walmartPrice)}</b></div>
      <div class="hr-num"><small>WFS cost</small><b class="neg">−${money(r.totalCost)}</b></div>
      <div class="hr-profit">+${money(r.net)}<small>+${r.netPct.toFixed(0)}%</small></div>
    </div>`).join("");
}

function logRowsHtml(s) {
  let list = s.log || [];
  if (histLogFilter === "win") list = list.filter((e) => e.cls === "win");
  if (histLogFilter === "bad") list = list.filter((e) => e.cls === "bad");
  const total = s.logTotal || list.length;
  const head = `<div class="hlog-head">
      <span>Showing <b>${list.length}</b> of ${total} checked products${total > (s.log || []).length ? ` (last ${(s.log || []).length} saved)` : ""}</span>
      <select data-logfilter aria-label="Filter checked products">
        <option value="all"${histLogFilter === "all" ? " selected" : ""}>All checked</option>
        <option value="win"${histLogFilter === "win" ? " selected" : ""}>Profitable only</option>
        <option value="bad"${histLogFilter === "bad" ? " selected" : ""}>Dropped only</option>
      </select></div>`;
  if (!list.length) return head + '<div class="hempty">Nothing to show here.</div>';
  return head + list.map((e) => `
    <div class="lrow ${escapeHtml(e.cls)}">
      <span class="ln">#${e.n}</span>
      ${e.image ? `<img src="${safeUrl(e.image)}" alt="" loading="lazy" />` : '<div class="noimg">no image</div>'}
      <div class="lmain">
        <a class="hr-ttl" href="${safeUrl(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>
        <small><b>Amazon ${money(e.price)}</b>${e.wTitle ? ` → Walmart ${e.wPrice != null ? "<b>" + money(e.wPrice) + "</b>" : ""}: <a href="${safeUrl(e.wUrl)}" target="_blank" rel="noopener">${escapeHtml(e.wTitle)}</a>` : " → no Walmart match"}</small>
      </div>
      <div class="lstat"><span>${escapeHtml(e.status)}</span><time>${fmtClock(e.at)}</time></div>
    </div>`).join("");
}

const EVENT_LABEL = { retry: "Retried", recover: "Recovered", skip: "Skipped item", error: "Error" };
function eventsHtml(s) {
  const ev = s.events || [];
  if (!ev.length) return '<div class="hempty">No problems were detected in this run. Nothing needed fixing.</div>';
  return '<div class="hev-help">Temporary problems the app noticed and handled on its own. "Retried" and "Recovered" were fixed automatically.</div>' +
    ev.map((e) => `<div class="hev ${escapeHtml(e.type)}"><time>${fmtClock(e.at)}</time><span class="hevt">${escapeHtml(EVENT_LABEL[e.type] || e.type)}</span><span class="hevm">${escapeHtml(e.msg)}</span></div>`).join("");
}

function errorReport(s) {
  const lines = [
    "Amazon to Wallmart Product Finder Dropshipping Tool v" + VERSION + " - error report",
    "Browser: " + navigator.userAgent,
    "Run started: " + new Date(s.startedAt).toLocaleString() + " | status: " + s.status,
    "Category: " + catName(s) + " | keyword: " + ((s.settings && s.settings.keyword) || "none"),
    "Error: " + (s.error || "none"),
    "Counters: " + JSON.stringify(s.counters || {}),
    "Final message: " + (s.note || ""),
    "Settings: " + JSON.stringify(s.settings || {}),
    "Auto-fix log (last 40):",
    ...(s.events || []).slice(-40).map((e) => "  " + new Date(e.at).toLocaleTimeString() + " [" + e.type + "] " + e.msg),
  ];
  return lines.join("\n");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    ta.remove(); return ok;
  }
}

function settingsHtml(s) {
  return '<dl class="hset">' + settingRows(s).map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join("") + "</dl>";
}

function sessionCard(s) {
  const info = STATUS_INFO[s.status] || { label: s.status, cls: "mute" };
  const c = s.counters || {};
  const found = (s.results || []).length;
  const open = histOpenId === s.id;
  const end = s.finishedAt || (s.status === "running" ? Date.now() : s.startedAt);
  const st = s.settings || {};
  const tab = histTab;
  let detail = "";
  if (open) {
    const note = s.note ? `<div class="hnote">${escapeHtml(s.note)}</div>` : "";
    const body = tab === "log" ? logRowsHtml(s) : tab === "settings" ? settingsHtml(s) : tab === "events" ? eventsHtml(s) : foundRowsHtml(s);
    detail = `<div class="hdetail">
      <div class="hactions">
        <button class="hbtn pri" data-act="reuse" data-id="${s.id}">↺ Reuse these settings</button>
        <button class="hbtn" data-act="showres" data-id="${s.id}"${found && !currentSession ? "" : " disabled"}>Show results in table</button>
        <button class="hbtn" data-act="expcsv" data-id="${s.id}"${found ? "" : " disabled"}>Export results CSV</button>
        <button class="hbtn" data-act="report" data-id="${s.id}">Copy error report</button>
        <button class="hbtn danger" data-act="del" data-id="${s.id}"${s === currentSession ? " disabled" : ""}>Delete</button>
      </div>
      ${note}
      <div class="htabs">
        <button data-act="tab" data-tab="found" data-id="${s.id}" class="${tab === "found" ? "on" : ""}">Profitable found <b>${found}</b></button>
        <button data-act="tab" data-tab="log" data-id="${s.id}" class="${tab === "log" ? "on" : ""}">All checked products <b>${s.logTotal || (s.log || []).length}</b></button>
        <button data-act="tab" data-tab="settings" data-id="${s.id}" class="${tab === "settings" ? "on" : ""}">Settings used</button>
        <button data-act="tab" data-tab="events" data-id="${s.id}" class="${tab === "events" ? "on" : ""}">Auto-fix log <b>${(s.events || []).length}</b></button>
      </div>
      <div class="htabbody">${body}</div>
    </div>`;
  }
  return `<article class="hcard ${info.cls}${open ? " open" : ""}">
    <div class="hcard-head" data-act="toggle" data-id="${s.id}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="hc-main">
        <div class="hc-title">
          <span class="spill ${info.cls}">${escapeHtml(info.label)}</span>
          <b>${escapeHtml(catName(s))}</b>
          ${st.keyword ? `<span class="hchip kw">“${escapeHtml(st.keyword)}”</span>` : ""}
          <span class="hchip">${st.sellerMode === "others" ? "All other sellers" : "Sold by Amazon"}</span>
          ${(s.events || []).length ? `<span class="hchip fix">⚙ ${(s.events || []).length} auto-fix${(s.events || []).length === 1 ? "" : "es"}</span>` : ""}
          <span class="hchip">≥ ${escapeHtml(String(st.minProfit))}% profit</span>
          <span class="hchip">$${escapeHtml(String(st.minPrice))} – $${escapeHtml(String(st.maxPrice))}</span>
        </div>
        <div class="hc-sub">${fmtTime(s.startedAt)} · ${fmtDur(end - s.startedAt)} · ${fmtAgo(s.startedAt)}${s.error ? ` · <span class="err">${escapeHtml(s.error)}</span>` : ""}</div>
      </div>
      <div class="hc-nums">
        <div><b>${c.amazon || 0}</b><span>Amazon</span></div>
        <div><b>${c.walmart || 0}</b><span>Walmart</span></div>
        <div><b>${c.matched || 0}</b><span>Matched</span></div>
        <div class="win"><b>${found}</b><span>Profitable</span></div>
      </div>
      <span class="chev" aria-hidden="true">▾</span>
    </div>
    ${detail}
  </article>`;
}

function renderHistory() {
  const body = $("histBody");
  const sc = body.scrollTop;
  const all = historyData;
  const checked = all.reduce((n, s) => n + ((s.counters && s.counters.walmart) || 0), 0);
  const profit = all.reduce((n, s) => n + (s.results || []).length, 0);
  $("histStats").innerHTML = `
    <div class="cbox"><b>${all.length}</b><span>Searches</span></div>
    <div class="cbox wal"><b>${checked}</b><span>Products checked</span></div>
    <div class="cbox win"><b>${profit}</b><span>Profitable found</span></div>
    <div class="cbox amz"><b>${all.length ? fmtAgo(all[0].startedAt) : "-"}</b><span>Last search</span></div>`;
  document.querySelectorAll("#histChips button").forEach((b) => b.classList.toggle("on", b.dataset.f === histFilter));
  $("histExport").disabled = !all.some((s) => (s.log || []).length);
  $("histClear").disabled = !all.some((s) => s !== currentSession);

  const list = visibleSessions();
  if (!all.length) {
    body.innerHTML = `<div class="hempty big"><b>No searches saved yet</b>Start a scan and it will appear here automatically. History is kept for the last ${HISTORY_DAYS} days.</div>`;
  } else if (!list.length) {
    body.innerHTML = '<div class="hempty big"><b>Nothing matches</b>Try a different search word or filter.</div>';
  } else {
    let lastDay = "", html = "";
    list.forEach((s) => {
      const d = dayLabel(s.startedAt);
      if (d !== lastDay) { lastDay = d; html += `<h3 class="hday">${escapeHtml(d)}</h3>`; }
      html += sessionCard(s);
    });
    body.innerHTML = html;
  }
  body.scrollTop = sc;
}

function openHistory() {
  historyOpen = true;
  $("histOverlay").hidden = false;
  document.body.classList.add("noscroll");
  renderHistory();
  $("histClose").focus();
}
function closeHistory() {
  historyOpen = false;
  $("histOverlay").hidden = true;
  document.body.classList.remove("noscroll");
  $("historyBtn").focus();
}

function historyAction(act, id, el) {
  const s = historyData.find((x) => x.id === id);
  if (act === "toggle") {
    histOpenId = histOpenId === id ? null : id;
    if (histOpenId) { histTab = s && (s.results || []).length ? "found" : "log"; histLogFilter = "all"; }
    renderHistory();
    return;
  }
  if (!s) return;
  if (act === "tab") { histTab = el.dataset.tab; renderHistory(); return; }
  if (act === "reuse") {
    if (running) { setStatus("Stop the current scan first, then reuse these settings.", "warn"); closeHistory(); return; }
    applySettings(s.settings);
    updateSellerButtons(); updateFixedNote(); saveSettings();
    closeHistory();
    setStatus("Settings restored from the search of " + escapeHtml(fmtTime(s.startedAt)) + " (" + escapeHtml(catName(s)) + "). Click <b>Start scan</b> to run it again.");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (act === "showres") {
    if (running) return;
    results = (s.results || []).slice();
    render();
    closeHistory();
    setStatus("Showing " + results.length + " saved result" + (results.length === 1 ? "" : "s") + " from " + escapeHtml(fmtTime(s.startedAt)) + " (" + escapeHtml(catName(s)) + ").");
    $("table").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (act === "report") {
    copyText(errorReport(s)).then((ok) => {
      el.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(() => { el.textContent = "Copy error report"; }, 1800);
    });
    return;
  }
  if (act === "expcsv") { exportCsv(s.results || []); return; }
  if (act === "del") {
    if (s === currentSession) return;
    if (!confirm("Delete this search from history?")) return;
    historyData = historyData.filter((x) => x.id !== id);
    if (histOpenId === id) histOpenId = null;
    persistHistory();
  }
}

function exportHistoryCsv() {
  const header = ["Search Started", "Status", "Category", "Keyword", "Amazon Seller Type", "Product (Amazon)", "Amazon Price", "Walmart Match", "Walmart Price", "Result", "Checked At", "Amazon URL", "Walmart URL"];
  const rows = [];
  visibleSessions().forEach((s) => {
    const st = s.settings || {};
    (s.log || []).forEach((e) => rows.push([
      new Date(s.startedAt).toLocaleString(), (STATUS_INFO[s.status] || {}).label || s.status, catName(s), st.keyword || "",
      st.sellerMode === "others" ? "All other sellers" : "Sold by Amazon",
      e.title, e.price, e.wTitle, e.wPrice == null ? "" : e.wPrice, e.status, e.at ? new Date(e.at).toLocaleString() : "", e.url, e.wUrl,
    ]));
  });
  if (!rows.length) return;
  downloadCsv(header, rows, "AmztoWallmart-History");
}

function initHistory() {
  window.addEventListener("unhandledrejection", (e) => logEvent("error", "Unexpected: " + ((e.reason && e.reason.message) || e.reason)));
  window.addEventListener("error", (e) => logEvent("error", "Unexpected: " + e.message));
  $("historyBtn").addEventListener("click", openHistory);
  $("histClose").addEventListener("click", closeHistory);
  $("histOverlay").addEventListener("mousedown", (e) => { if (e.target === $("histOverlay")) closeHistory(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && historyOpen) closeHistory(); });
  $("histSearch").addEventListener("input", (e) => { histQuery = e.target.value.trim().toLowerCase(); renderHistory(); });
  $("histChips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (b) { histFilter = b.dataset.f; renderHistory(); }
  });
  $("histBody").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (el && !el.disabled) historyAction(el.dataset.act, el.dataset.id, el);
  });
  $("histBody").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest('[data-act="toggle"]');
    if (el && e.target === el) { e.preventDefault(); historyAction("toggle", el.dataset.id, el); }
  });
  $("histBody").addEventListener("change", (e) => {
    if (e.target.matches("[data-logfilter]")) { histLogFilter = e.target.value; renderHistory(); }
  });
  $("histExport").addEventListener("click", exportHistoryCsv);
  $("histClear").addEventListener("click", () => {
    if (!confirm("Delete ALL saved search history? This cannot be undone.")) return;
    historyData = historyData.filter((s) => s === currentSession);
    histOpenId = null;
    persistHistory();
  });
  loadHistory();
}

// ---------- init ----------
$("ver").textContent = "v" + VERSION;
{
  const allOpt = document.createElement("option");
  allOpt.value = ALL_CATEGORIES;
  allOpt.textContent = "All categories (auto)";
  $("category").appendChild(allOpt);
}
CATEGORIES.forEach((c, idx) => {
  const o = document.createElement("option");
  o.value = c.name;
  o.textContent = String(idx + 1).padStart(2, "0") + ". " + c.name;
  $("category").appendChild(o);
});
WFS_TIERS.forEach((t, idx) => {
  const label = `${t.label} = ${money(t.fee)}`;
  const o1 = document.createElement("option"); o1.value = String(idx); o1.textContent = label; $("tierMode").appendChild(o1);
  const o2 = document.createElement("option"); o2.value = String(idx); o2.textContent = label; $("fallbackTier").appendChild(o2);
});
$("fallbackTier").value = "1";
loadSettings();

// live date + time (today's date and the current clock)
function tickClock() { if (!document.hidden) $("clock").textContent = nowText(); }
tickClock();
setInterval(tickClock, 1000);

// This page only works when Chrome runs it as an extension page. If someone
// double-clicks app.html (file://) the chrome.* APIs do not exist.
function extensionApisMissing() {
  return typeof chrome === "undefined" || !chrome.tabs || !chrome.scripting || !chrome.storage;
}

function showNotAnExtensionMessage() {
  setStatus(
    "<b>This page is not running as a Chrome extension</b> (current address: <code>" + escapeHtml(location.href) + "</code>).<br>" +
    "Do not open <code>app.html</code> directly from the folder. Instead:<br>" +
    "1. Open <code>chrome://extensions</code> and turn on <b>Developer mode</b> (top right).<br>" +
    "2. Click <b>Load unpacked</b> and select the unzipped <code>AmztoWallmart-Product-finder</code> folder.<br>" +
    "3. Click the extension's icon in the Chrome toolbar (pin it from the puzzle-piece menu). " +
    "The app then opens in a new tab and its address starts with <code>chrome-extension://</code>.",
    "error"
  );
  $("start").disabled = true;
}

if (extensionApisMissing()) {
  showNotAnExtensionMessage();
}

$("start").addEventListener("click", () => {
  if (extensionApisMissing()) { showNotAnExtensionMessage(); return; }
  run();
});
$("startNew").addEventListener("click", () => {
  if (running) return;
  // Keep the search keyword; clear only the current scan and its visible output.
  results = [];
  amazonFeed = [];
  walmartFeed = [];
  counters = { amazon: 0, walmart: 0, matched: 0, profitable: 0, dropped: 0 };
  sessionEntries = [];
  currentSession = null;
  clearTimeout(persistTimer);
  persistTimer = null;
  stopFlag = false;
  $("barFill").style.width = "0%";
  $("live").hidden = true;
  $("table").hidden = true;
  $("rows").innerHTML = "";
  $("export").disabled = true;
  renderFeed();
  setStatus("Ready for a new scan. Search keyword kept.");
  persistHistory();
});
$("stop").addEventListener("click", () => {
  if (!running || userStopRequested) return;
  userStopRequested = true;
  stopFlag = true;
  $("stop").disabled = true;
  setStatus("Stopping now… cancelling active Amazon/Walmart page tasks.");
  for (const wake of [...stopWaiters]) wake();
  // Closing the worker tabs aborts in-flight page loads and injected page scripts.
  void closeWorkerTab();
});
$("export").addEventListener("click", () => exportCsv());
function updateSellerButtons() {
  $("modeAmazon").classList.toggle("on", sellerMode === "amazon");
  $("modeOthers").classList.toggle("on", sellerMode === "others");
  $("modeAmazon").setAttribute("aria-pressed", sellerMode === "amazon");
  $("modeOthers").setAttribute("aria-pressed", sellerMode === "others");
  $("fixedAmazon").textContent = sellerMode === "amazon" ? "Sold by Amazon only" : "all other sellers (third-party included)";
}
function setSellerMode(m) { if (running) return; sellerMode = m; updateSellerButtons(); saveSettings(); }
$("modeAmazon").addEventListener("click", () => setSellerMode("amazon"));
$("modeOthers").addEventListener("click", () => setSellerMode("others"));
function updateFixedNote() {
  $("fixedWalmart").textContent = $("onlyWalmartSold").checked ? "sold by Walmart itself" : "Walmart itself is not a seller";
  $("fixedSellers").textContent = (parseInt($("minSellers").value, 10) || MIN_SELLERS_DEFAULT) + " to " + (parseInt($("maxSellers").value, 10) || MAX_SELLERS_DEFAULT) + " sellers";
  $("fallbackWrap").style.opacity = $("tierMode").value === "auto" ? "1" : ".45";
}
["onlyWalmartSold", "minSellers", "maxSellers", "tierMode"].forEach((id) => $(id).addEventListener("change", updateFixedNote));
$("minSellers").addEventListener("input", updateFixedNote);
$("maxSellers").addEventListener("input", updateFixedNote);
updateFixedNote();
updateSellerButtons();

initHistory();

// back-to-top button (UI only)
{
  const t = $("toTop");
  window.addEventListener("scroll", () => t.classList.toggle("show", window.scrollY > 600), { passive: true });
  t.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}
