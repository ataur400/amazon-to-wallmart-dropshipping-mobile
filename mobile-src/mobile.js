"use strict";
// Android-only UI glue. Replaces the desktop's Electron menu bar (Tools / Help) and link handling.
(function () {
  if (!window.__AW_MOBILE || !window.awNative) return;
  document.documentElement.classList.add("aw-mobile");

  const N = window.awNative;
  const SHOW_KEY = "aw_show_scan_preview_v1";

  // 1) Links: "Open this page" (bot-check) opens in the SAME browser the scan uses, so solving
  //    the CAPTCHA actually helps the scan. Every other target=_blank link opens in the phone's browser.
  document.addEventListener("click", (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest("a");
    if (!a || !/^https?:\/\//i.test(a.href)) return;
    if (/^open this page$/i.test((a.textContent || "").trim())) {
      ev.preventDefault(); ev.stopPropagation();
      N.openScanBrowser(a.href).catch(() => {});
      return;
    }
    if (a.target === "_blank") {
      ev.preventDefault(); ev.stopPropagation();
      N.openExternal(a.href).catch(() => {});
    }
  }, true);

  // 2) Tools sheet (desktop: menu bar > Tools).
  let showPreview = false;
  try { showPreview = localStorage.getItem(SHOW_KEY) === "1"; } catch (e) {}
  N.setShowWorkers(showPreview).catch(() => {});

  const sheet = document.createElement("div");
  sheet.id = "awToolsOverlay";
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="aw-sheet" role="dialog" aria-modal="true" aria-labelledby="awToolsTitle">
      <div class="aw-sheet-head"><h2 id="awToolsTitle">Tools</h2><button type="button" id="awToolsClose" aria-label="Close">✕</button></div>
      <button type="button" class="aw-item" id="awOpenAmazon"><b>Open Amazon in scan browser</b><small>Solve CAPTCHA / set your US ZIP code</small></button>
      <button type="button" class="aw-item" id="awOpenWalmart"><b>Open Walmart in scan browser</b><small>Solve CAPTCHA</small></button>
      <label class="aw-item aw-check"><span><b>Show scan browser previews while scanning</b><small>Small live thumbnails of the hidden scan browsers at the bottom of the screen</small></span><input type="checkbox" id="awShowPreview"></label>
      <button type="button" class="aw-item danger" id="awClearCookies"><b>Clear Amazon / Walmart cookies</b><small>Your app login and search history are not affected</small></button>
      <button type="button" class="aw-item" id="awAbout"><b>About</b><small>Amazon to Wallmart Product Finder · v${(window.chrome && chrome.runtime.getManifest().version) || ""} · Android edition</small></button>
      <p class="aw-sheet-note">Amazon / Walmart may need a US VPN if they are blocked in your country (same as the desktop app).</p>
    </div>`;
  document.body.appendChild(sheet);
  const $ = (id) => document.getElementById(id);
  const close = () => { sheet.hidden = true; };
  const open = () => { $("awShowPreview").checked = showPreview; sheet.hidden = false; };
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  $("awToolsClose").onclick = close;
  $("awOpenAmazon").onclick = () => { close(); N.openScanBrowser("https://www.amazon.com/"); };
  $("awOpenWalmart").onclick = () => { close(); N.openScanBrowser("https://www.walmart.com/"); };
  $("awShowPreview").onchange = (e) => {
    showPreview = !!e.target.checked;
    try { localStorage.setItem(SHOW_KEY, showPreview ? "1" : "0"); } catch (err) {}
    N.setShowWorkers(showPreview).catch(() => {});
  };
  $("awClearCookies").onclick = async () => {
    if (!confirm("Clear the scan browser's cookies and cache?\n\nYour app login and search history are not affected.")) return;
    try { await N.clearScanCookies(); alert("Scan browser cookies cleared."); } catch (e) { alert("Could not clear cookies: " + (e && e.message || e)); }
  };
  $("awAbout").onclick = () => alert("Amazon to Wallmart Product Finder Dropshipping Tool\nAndroid edition of desktop version " + chrome.runtime.getManifest().version);

  // The Tools button sits in the header next to History (logout/admin buttons are added there by auth.js).
  function addToolsButton() {
    const slot = document.querySelector(".head-top");
    if (!slot || document.getElementById("awToolsBtn")) return false;
    const b = document.createElement("button");
    b.type = "button"; b.id = "awToolsBtn"; b.className = "histbtn aw-toolsbtn";
    b.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></svg><span>Tools</span>';
    b.onclick = open;
    slot.insertBefore(b, slot.querySelector(".ver"));
    return true;
  }
  if (!addToolsButton()) document.addEventListener("DOMContentLoaded", addToolsButton);
})();
