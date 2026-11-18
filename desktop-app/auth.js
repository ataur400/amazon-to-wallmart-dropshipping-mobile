
(() => {
  const cfg = window.AW_AUTH_CONFIG || {};
  const API = cfg.API_URL || "";
  const KEY = "aw_auth_session_v1";
  const EMAIL_KEY = "aw_login_email_v1";
  let session = null, role = "USER", checkTimer = null, hideStyle = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function appVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return "1.8.0"; }
  }
  function ensureUI() {
    if ($("aw-auth-root")) return;
    const root = document.createElement("div"); root.id = "aw-auth-root";
    root.innerHTML = `<section class="aw-auth-card">
      <span class="aw-auth-ver" id="aw-auth-ver" title="Installed version">v${appVersion()}</span>
      <div class="aw-auth-top">
        <div class="aw-auth-brand">
          <div class="aw-auth-logo-wrap"><img class="aw-auth-logo" src="icons/aw-login-logo.png" alt="AW logo"></div>
          <div class="aw-auth-brand-title"><span class="aw-brand-amzto">Amazon</span><span class="aw-brand-to">to</span><span class="aw-brand-wallmart">Wallmart</span></div>
          <div class="aw-auth-brand-sub">PRODUCT FINDER</div><div class="aw-auth-brand-tag">DROPSHIPPING TOOL</div>
          <p class="aw-auth-tagline">Smart Product Research · Better Buying Decisions</p>
        </div>
        <button id="aw-logout" class="aw-auth-hidden">Logout</button>
      </div>
      <div id="aw-login-view">
        <h2>Welcome back</h2><p class="aw-auth-muted">Sign in to access your Amazon to Wallmart Product Finder workspace.</p>
        <label>Email Address</label><input id="aw-login-email" type="email" autocomplete="username" placeholder="name@example.com">
        <label>Password</label><input id="aw-login-password" type="password" autocomplete="current-password" placeholder="Your password">
        <label class="aw-remember-email"><input id="aw-remember-email" type="checkbox" checked> <span>Remember my email and password on this device</span></label>
        <button id="aw-login" class="aw-auth-btn">Login</button>
        <div class="aw-auth-links"><button id="aw-show-register">Create account</button></div>
      </div>
      <div id="aw-register-view" class="aw-auth-hidden">
        <h2>Create account</h2><p class="aw-auth-muted">All fields are required.</p>
        <label>Full Name</label><input id="aw-reg-name" autocomplete="name" placeholder="Full name">
        <label>Email Address</label><input id="aw-reg-email" type="email" autocomplete="email" placeholder="name@example.com">
        <label>Personal Phone Number</label><input id="aw-reg-phone" type="tel" autocomplete="tel" placeholder="+1 000 000 0000">
        <label>Password</label><input id="aw-reg-password" type="password" autocomplete="new-password" placeholder="Create password">
        <label>Confirm Password</label><input id="aw-reg-confirm" type="password" autocomplete="new-password" placeholder="Confirm password">
        <button id="aw-register" class="aw-auth-btn">Register</button>
        <div class="aw-auth-links"><button id="aw-show-login">Back to login</button></div>
      </div>
      <div id="aw-admin-view" class="aw-auth-hidden">
        <h2>Owner Admin</h2><p class="aw-auth-muted">Manage registered users and access status.</p>
        <div id="aw-admin-summary"></div><div class="aw-admin-list" id="aw-admin-list"></div>
        <button id="aw-admin-refresh" class="aw-auth-btn secondary">Refresh users</button>
      </div>
      <div id="aw-auth-message" class="aw-auth-msg" role="status"></div>
      <p class="aw-auth-muted" style="margin:18px 0 0;text-align:center">Secure account access</p>
    </section>`;
    document.body.appendChild(root);
    $("aw-show-register").onclick = () => view("register");
    $("aw-show-login").onclick = () => view("login");
    $("aw-login").onclick = login;
    ["aw-login-email","aw-login-password"].forEach(id=>$(id).addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); login(); } }));
    $("aw-register").onclick = register;
    $("aw-logout").onclick = logout;
    $("aw-admin-refresh").onclick = loadUsers;
  }
  function view(which) {
    ["login","register","admin"].forEach(v => $("aw-"+v+"-view").classList.toggle("aw-auth-hidden",v!==which));
    $("aw-logout").classList.toggle("aw-auth-hidden",!session);
    message("");
  }
  function message(t, bad=true) { const el=$("aw-auth-message"); el.textContent=t||""; el.className="aw-auth-msg "+(t?(bad?"aw-auth-error":"aw-auth-ok"):""); }
  async function api(action, data={}) {
    if (!API || API.includes("PASTE_YOUR_")) throw new Error("Backend is not configured. Deploy the included Google Apps Script and add its Web App URL to auth-config.js.");
    let r,j;
    try {
      r=await fetch(API,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action,...data})});
      j=await r.json();
    } catch(e) { const te=new Error("Connection problem. Please check your internet and try again."); te.transient=true; throw te; }
    if(!r.ok || !j.ok) {
      const err=new Error(j.error||"Request failed");
      // Only an explicit answer from the server means the login is really gone.
      err.auth=/session expired|inactive|access denied|invalid session|please log in/i.test(String(j.error||""));
      throw err;
    }
    return j;
  }
  async function saveSession(s) { session=s; await chrome.storage.local.set({[KEY]:s}); }
  async function login() {
    try {
      message("Signing in...",false);
      const email=$("aw-login-email").value.trim(), password=$("aw-login-password").value;
      if(!email||!password) throw new Error("Enter your email and password.");
      // Remember the email only. Password saving/autofill is handled by Chrome Password Manager.
      const r=await api("login",{email,password});
      if($("aw-remember-email").checked) { await chrome.storage.local.set({[EMAIL_KEY]:email}); try{ if(window.awSecure) await window.awSecure.save(email,password); }catch(e){} }
      else { await chrome.storage.local.remove(EMAIL_KEY); try{ if(window.awSecure) await window.awSecure.clear(); }catch(e){} }
      await saveSession({token:r.token,email:r.email,role:r.role,expiresAt:r.expiresAt}); role=r.role;
      // The login endpoint already verifies credentials and issues this server session.
      // Reuse its trusted response instead of making a second serial validate request.
      await authorizeAndUnlock(r);
    } catch(e){message(e.message);}
  }
  async function register() {
    try {
      const name=$("aw-reg-name").value.trim(),email=$("aw-reg-email").value.trim(),phone=$("aw-reg-phone").value.trim();
      const password=$("aw-reg-password").value,confirm=$("aw-reg-confirm").value;
      if(!name||!email||!phone||!password||!confirm) throw new Error("Please complete all required fields.");
      if(password.length<8) throw new Error("Password must be at least 8 characters.");
      if(password!==confirm) throw new Error("Passwords do not match.");
      await api("register",{name,email,phone,password});
      view("login"); $("aw-login-email").value=email; message("Registration successful. Please log in.",false);
    } catch(e){message(e.message);}
  }
  async function authorizeAndUnlock(prevalidated=null) {
    // Fresh login responses are already validated by the server. Saved sessions
    // still require a server validation when the extension is reopened.
    const r=prevalidated || await api("validate",{token:session.token});
    role=r.role;
    $("aw-auth-root").classList.add("aw-auth-hidden");
    if(hideStyle){hideStyle.remove();hideStyle=null;}
    addLogoutButton();
    if(role==="ADMIN") addAdminButton();
    if(checkTimer) clearInterval(checkTimer);
    checkTimer=setInterval(async()=>{try{await api("validate",{token:session.token});}catch(e){if(e&&e.auth){await clearSession();showLogin(e.message);}}},Math.max(30000,Number(cfg.SESSION_CHECK_INTERVAL_MS)||60000));
  }
  function addLogoutButton(){
    if($("aw-logout-floating")) return;
    const b=document.createElement("button");b.id="aw-logout-floating";b.textContent="Logout";b.onclick=logout;
    const slot=document.querySelector(".head-top");
    if(slot){b.className="aw-hbtn";slot.appendChild(b);}else{b.className="aw-float";b.style.bottom="18px";document.body.appendChild(b);}
  }
  function addAdminButton(){
    if($("aw-admin-open")) return;
    const b=document.createElement("button");b.id="aw-admin-open";b.textContent="Admin";
    b.onclick=async()=>{ $("aw-auth-root").classList.remove("aw-auth-hidden"); view("admin"); await loadUsers();};
    const slot=document.querySelector(".head-top");
    if(slot){b.className="aw-hbtn admin";slot.appendChild(b);}else{b.className="aw-float";b.style.bottom="66px";document.body.appendChild(b);}
  }
  async function loadUsers(){
    try{
      const r=await api("adminList",{token:session.token});
      $("aw-admin-summary").textContent=`Total users: ${r.users.length} · Active: ${r.users.filter(u=>u.status==="ACTIVE").length} · Inactive: ${r.users.filter(u=>u.status!=="ACTIVE").length}`;
      $("aw-admin-list").innerHTML=`<table class="aw-admin-table"><thead><tr><th>Name / Email</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead><tbody>${r.users.map(u=>`<tr><td>${esc(u.name)}<br>${esc(u.email)}</td><td>${esc(u.phone)}</td><td>${esc(u.status)}</td><td><div class="aw-admin-actions"><button data-id="${esc(u.id)}" data-status="${u.status==="ACTIVE"?"INACTIVE":"ACTIVE"}">${u.status==="ACTIVE"?"Deactivate":"Activate"}</button><button data-delete="${esc(u.id)}">Delete</button></div></td></tr>`).join("")}</tbody></table>`;
      $("aw-admin-list").querySelectorAll("[data-id]").forEach(b=>b.onclick=async()=>{try{await api("adminSetStatus",{token:session.token,userId:b.dataset.id,status:b.dataset.status});await loadUsers();}catch(e){message(e.message);}});
      $("aw-admin-list").querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{if(!confirm("Delete this user account?"))return;try{await api("adminDelete",{token:session.token,userId:b.dataset.delete});await loadUsers();}catch(e){message(e.message);}});
      message("User list updated.",false);
    }catch(e){message(e.message);}
  }
  async function logout(){try{if(session)await api("logout",{token:session.token});}catch{} await clearSession();showLogin("You have been logged out.");}
  async function clearSession(){session=null;if(checkTimer)clearInterval(checkTimer);await chrome.storage.local.remove(KEY);}
  function showLogin(msg){$("aw-auth-root").classList.remove("aw-auth-hidden");view("login");message(msg||"Please sign in.");}
  async function start(){
    ensureUI();
    // Keep the original app hidden until the server authorizes the account.
    hideStyle=document.createElement("style");hideStyle.textContent="body > header, body > main, body > footer, body > .hist-overlay {visibility:hidden}";document.head.appendChild(hideStyle);
    $("aw-login").disabled=false;
    const saved=await chrome.storage.local.get([KEY,EMAIL_KEY]);
    session=saved[KEY]||null;
    if(saved[EMAIL_KEY]) $("aw-login-email").value=saved[EMAIL_KEY];
    try{ if(window.awSecure){ const c=await window.awSecure.load(); if(c && (!saved[EMAIL_KEY]||c.email===saved[EMAIL_KEY])){ $("aw-login-email").value=c.email; $("aw-login-password").value=c.password; } } }catch(e){}
    const stillValid = session && session.token && (!session.expiresAt || new Date(session.expiresAt).getTime()>Date.now());
    if(stillValid){
      // Instant open: the 24-hour session is already on this computer. The server re-checks it in the background.
      await authorizeAndUnlock({role:session.role||"USER"});
      api("validate",{token:session.token}).then(r=>{ if(r&&r.role) role=r.role; }).catch(async e=>{ if(e&&e.auth){ await clearSession(); showLogin(e.message||"Session expired. Please log in again."); } });
      return;
    }
    if(session){ await clearSession(); }
    showLogin();
    // Wake the server up while the person types, so pressing Login is faster.
    api("validate",{token:"warmup"}).catch(()=>{});
  }
  if(typeof chrome!=="undefined"&&chrome.storage&&(location.protocol==="chrome-extension:"||location.protocol==="awapp:")){
    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
  }
})();
