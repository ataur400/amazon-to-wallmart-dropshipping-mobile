/** Amazon to Wallmart Product Finder Dropshipping Tool authentication backend.
 * Deploy as Web App: Execute as Me; access Anyone. Keep the spreadsheet private.
 * Run setupOwner() manually once from the Apps Script editor before deployment.
 */
const SHEET_ID = 'PASTE_PRIVATE_GOOGLE_SHEET_ID_HERE';
const USERS_TAB = 'USERS';
const SESSIONS_TAB = 'SESSIONS';
const LOG_TAB = 'ACTIVITY_LOG';
const SESSION_HOURS = 24;

function setupDatabase() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ensureSheet_(ss, USERS_TAB, ['User ID','Full Name','Email','Phone Number','Password Salt','Password Hash','Role','Status','Registration Date','Last Login','Updated Date']);
  ensureSheet_(ss, SESSIONS_TAB, ['Token Hash','User ID','Email','Role','Expires At','Created At']);
  ensureSheet_(ss, LOG_TAB, ['Log ID','User Email','Action','Date & Time','Details']);
}

// Run manually once: enter the owner email/password, then remove the temporary values from this function.
function setupOwner() {
  const email = 'CHANGE_TO_OWNER_EMAIL';
  const password = 'CHANGE_TO_A_STRONG_OWNER_PASSWORD';
  if (email.indexOf('CHANGE_') === 0 || password.indexOf('CHANGE_') === 0) throw new Error('Edit setupOwner() with your own credentials first.');
  const salt = Utilities.getUuid() + Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('OWNER_EMAIL', email.toLowerCase().trim());
  props.setProperty('OWNER_SALT', salt);
  props.setProperty('OWNER_HASH', hashPassword_(password, salt));
  setupDatabase();
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const result = route_(body);
    return json_({ok:true, ...result});
  } catch (err) {
    return json_({ok:false, error:String(err && err.message || 'Request failed')});
  }
}
function route_(b) {
  switch (b.action) {
    case 'register': return register_(b);
    case 'login': return login_(b);
    case 'validate': return validate_(b.token);
    case 'logout': revoke_(b.token); return {message:'Logged out'};
    case 'adminList': requireAdmin_(b.token); return {users:listUsers_()};
    case 'adminSetStatus': requireAdmin_(b.token); return setStatus_(b.userId,b.status);
    case 'adminDelete': requireAdmin_(b.token); return deleteUser_(b.userId);
    default: throw new Error('Unknown action');
  }
}
function register_(b) {
  const name=String(b.name||'').trim(), email=String(b.email||'').trim().toLowerCase(), phone=String(b.phone||'').trim(), password=String(b.password||'');
  if(!name||!email||!phone||!password) throw new Error('All registration fields are required.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if(password.length<8) throw new Error('Password must be at least 8 characters.');
  if(!/^\+?[0-9 ()\-.]{7,20}$/.test(phone)) throw new Error('Enter a valid phone number.');
  const sh=sheet_(USERS_TAB), rows=sh.getDataRange().getValues();
  if(rows.slice(1).some(r=>String(r[2]).toLowerCase()===email)) throw new Error('This email is already registered.');
  const salt=Utilities.getUuid()+Utilities.getUuid(), now=new Date(), id=Utilities.getUuid();
  sh.appendRow([id,name,email,phone,salt,hashPassword_(password,salt),'USER','ACTIVE',now,'',now]);
  log_(email,'REGISTER','New account created'); return {message:'Registration successful'};
}
function login_(b) {
  const email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
  const props=PropertiesService.getScriptProperties();
  if(email===props.getProperty('OWNER_EMAIL')) {
    const salt=props.getProperty('OWNER_SALT')||'';
    if(!constantTimeEqual_(hashPassword_(password,salt),props.getProperty('OWNER_HASH')||'')) throw new Error('Invalid email or password.');
    return createSession_('OWNER',email,'ADMIN');
  }
  const sh=sheet_(USERS_TAB), data=sh.getDataRange().getValues();
  for(let i=1;i<data.length;i++) {
    const r=data[i]; if(String(r[2]).toLowerCase()!==email) continue;
    if(r[7]!=='ACTIVE') throw new Error('Your account has been deactivated. Contact the administrator.');
    if(!constantTimeEqual_(hashPassword_(password,String(r[4])),String(r[5]))) throw new Error('Invalid email or password.');
    sh.getRange(i+1,10).setValue(new Date());
    return createSession_(String(r[0]),email,'USER');
  }
  throw new Error('Invalid email or password.');
}
function createSession_(userId,email,role) {
  const token=Utilities.getUuid()+Utilities.getUuid()+Utilities.getUuid(), tokenHash=sha256_(token), now=new Date(), expires=new Date(now.getTime()+SESSION_HOURS*3600000);
  sheet_(SESSIONS_TAB).appendRow([tokenHash,userId,email,role,expires,now]);
  log_(email,'LOGIN','Successful login');
  return {token,email,role,expiresAt:expires.toISOString()};
}
function validate_(token) {
  const s=findSession_(token); if(!s) throw new Error('Session expired. Please log in again.');
  if(s.role==='ADMIN') return {email:s.email,role:'ADMIN'};
  const u=findUserById_(s.userId); if(!u||u.status!=='ACTIVE') {revoke_(token);throw new Error('Your account is inactive.');}
  return {email:s.email,role:'USER'};
}
function requireAdmin_(token) { const s=findSession_(token); if(!s||s.role!=='ADMIN'||s.email!==PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL')) throw new Error('Admin access denied.'); return s; }
function findSession_(token) {
  if(!token) return null; const h=sha256_(String(token)), sh=sheet_(SESSIONS_TAB), d=sh.getDataRange().getValues();
  for(let i=d.length-1;i>=1;i--) if(String(d[i][0])===h) {
    if(new Date(d[i][4]).getTime()<Date.now()) return null;
    return {row:i+1,userId:String(d[i][1]),email:String(d[i][2]),role:String(d[i][3])};
  } return null;
}
function revoke_(token) { if(!token)return; const sh=sheet_(SESSIONS_TAB),d=sh.getDataRange().getValues(),h=sha256_(String(token)); for(let i=d.length-1;i>=1;i--) if(String(d[i][0])===h) sh.deleteRow(i+1); }
function listUsers_() { const d=sheet_(USERS_TAB).getDataRange().getValues(); return d.slice(1).filter(r=>r[0]).map(r=>({id:String(r[0]),name:String(r[1]),email:String(r[2]),phone:String(r[3]),role:String(r[6]),status:String(r[7]),registered:r[8]?new Date(r[8]).toISOString():null,lastLogin:r[9]?new Date(r[9]).toISOString():null})); }
function findUserById_(id) { return listUsers_().find(u=>u.id===String(id)); }
function setStatus_(id,status) {
  if(!['ACTIVE','INACTIVE'].includes(status)) throw new Error('Invalid status.');
  const sh=sheet_(USERS_TAB),d=sh.getDataRange().getValues();
  for(let i=1;i<d.length;i++) if(String(d[i][0])===String(id)) {
    sh.getRange(i+1,8).setValue(status);sh.getRange(i+1,11).setValue(new Date());
    if(status==='INACTIVE') revokeUserSessions_(String(d[i][0]));
    log_(String(d[i][2]),'STATUS_CHANGE',status);return {message:'User status updated'};
  } throw new Error('User not found.');
}
function deleteUser_(id) { const sh=sheet_(USERS_TAB),d=sh.getDataRange().getValues();for(let i=1;i<d.length;i++)if(String(d[i][0])===String(id)){const email=String(d[i][2]);revokeUserSessions_(String(id));sh.deleteRow(i+1);log_(email,'DELETE','User deleted');return {message:'User deleted'};}throw new Error('User not found.'); }
function revokeUserSessions_(id) { const sh=sheet_(SESSIONS_TAB),d=sh.getDataRange().getValues();for(let i=d.length-1;i>=1;i--)if(String(d[i][1])===id)sh.deleteRow(i+1); }
function sheet_(name) { const ss=SpreadsheetApp.openById(SHEET_ID), sh=ss.getSheetByName(name);if(!sh)throw new Error('Database not initialized. Run setupDatabase().');return sh; }
function ensureSheet_(ss,name,headers) { let sh=ss.getSheetByName(name);if(!sh)sh=ss.insertSheet(name);if(sh.getLastRow()===0)sh.appendRow(headers); }
function hashPassword_(password,salt) {
  // Iterated HMAC-SHA-256 password derivation (Apps Script has no native Argon2/PBKDF2 API).
  let value=Utilities.newBlob(String(salt)+'|'+String(password)).getBytes();
  const key=Utilities.newBlob(String(salt)).getBytes();
  for(let i=0;i<12000;i++) value=Utilities.computeHmacSha256Signature(value,key);
  return Utilities.base64Encode(value);
}
function sha256_(s) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s),Utilities.Charset.UTF_8)); }
function constantTimeEqual_(a,b) { if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0; }
function log_(email,action,details) { sheet_(LOG_TAB).appendRow([Utilities.getUuid(),email,action,new Date(),details]); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
