'use strict';
// Owner Google Picker for drive.file. Tokens are one-shot to the picker page only —
// never logged, never sent to models/Missions, never returned on connector status.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sessions = new Map(); // id -> { expires, stage }

/** Picker page CSP: allow Google Picker scripts/frames; keep Control Center CSP strict elsewhere. */
const PICKER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.google.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://www.googleapis.com https://accounts.google.com https://apis.google.com",
  "frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://www.google.com https://content.googleapis.com",
  "img-src 'self' data: https://*.googleusercontent.com https://www.google.com https://ssl.gstatic.com",
  "font-src 'self' https://fonts.gstatic.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

function configPath(dataDir) {
  return path.join(dataDir, 'drive-picker-config.json');
}

function readConfig(dataDir) {
  const file = configPath(dataDir);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const appId = typeof raw.appId === 'string' ? raw.appId.trim() : String(raw.appId || '').trim();
  if (!apiKey || apiKey.length < 20 || apiKey.length > 200) return null;
  if (!/^[0-9]{6,20}$/.test(appId)) return null;
  return { apiKey, appId };
}

/** Numeric prefix of a Google OAuth client id is the owning GCP project number. */
function oauthClientProjectNumber(clientId) {
  const m = /^(\d{6,20})-/.exec(String(clientId || '').trim());
  return m ? m[1] : null;
}

/**
 * Google Picker setAppId must be the project number that owns the OAuth client.
 * Mismatch lets the Picker UI open but drive.file never grants the selected file.
 */
function assertAppIdAlignedWithOAuthClient(appId, clientId) {
  const expected = oauthClientProjectNumber(clientId);
  const actual = String(appId || '').trim();
  if (!expected || !actual) return { aligned: true, expected: expected || null, appId: actual || null };
  if (actual === expected) return { aligned: true, expected, appId: actual };
  const err = Error(
    'Google Picker project number does not match the Drive OAuth client project. '
    + 'Re-run: airodrom drive picker-setup <api-key> <gcp-project-number> using the project number from the same Google Cloud project that owns the desktop OAuth client '
    + '(the numeric prefix of the client id). Selecting a file with a mismatched App ID does not authorize drive.file.',
  );
  err.code = 'picker_appid_oauth_client_project_mismatch';
  err.expected_app_id = expected;
  throw err;
}

function writeConfig(dataDir, { apiKey, appId, clientId = null }) {
  const next = { apiKey: String(apiKey || '').trim(), appId: String(appId || '').trim() };
  if (!next.apiKey || next.apiKey.length < 20 || next.apiKey.length > 200) throw Error('Owner Google Picker API key required');
  if (!/^[0-9]{6,20}$/.test(next.appId)) throw Error('Owner Google Cloud project number (appId) required');
  if (clientId) assertAppIdAlignedWithOAuthClient(next.appId, clientId);
  const file = configPath(dataDir);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return { configured: true, appId: next.appId };
}

function status(dataDir, { clientId = null } = {}) {
  const cfg = readConfig(dataDir);
  const expected = oauthClientProjectNumber(clientId);
  const aligned = !cfg || !expected || cfg.appId === expected;
  return {
    picker_configured: !!cfg,
    app_id_present: !!cfg?.appId,
    app_id_matches_oauth_client: aligned,
    // Never echo apiKey or raw ids
  };
}

function createSession({ ttlMs = 300000 } = {}) {
  const id = crypto.randomUUID();
  sessions.set(id, { expires: Date.now() + ttlMs, stage: 'pending' });
  return id;
}

function getLiveSession(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) return null;
  const row = sessions.get(id);
  if (!row || row.expires < Date.now()) {
    if (row) sessions.delete(id);
    return null;
  }
  return row;
}

/** One-shot token handoff for the picker page. Session remains for enroll. */
function bootstrapSession(id) {
  const row = getLiveSession(id);
  if (!row || row.stage !== 'pending') return null;
  row.stage = 'bootstrapped';
  return row;
}

/** Session must be bootstrapped; does not consume (allows metadata retry). */
function requireBootstrapped(id) {
  const row = getLiveSession(id);
  if (!row || row.stage !== 'bootstrapped') return null;
  return row;
}

/** Consume after successful enrollment. */
function consumeSession(id) {
  const row = getLiveSession(id);
  if (!row || row.stage !== 'bootstrapped') return null;
  sessions.delete(id);
  return row;
}

/** @deprecated use consumeSession after successful enroll */
function completeSession(id) {
  return consumeSession(id);
}

function pickerHtml({ origin, sessionId, clientId }) {
  // Minimal Google Picker host page. Loads Google APIs; exchanges one-shot session for token on click.
  const safeOrigin = String(origin || '').replace(/[^a-zA-Z0-9:./_-]/g, '');
  const safeSession = String(sessionId || '').replace(/[^a-f0-9-]/gi, '');
  const safeClient = String(clientId || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Airodrom · Select Drive file</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:40rem;line-height:1.45;color:#111}
button{font:inherit;padding:.55rem 1rem;cursor:pointer}
.muted{color:#555;font-size:.95rem}
code{font-size:.9em}
</style>
</head><body>
<h1>Select a Google Drive file</h1>
<p class="muted">Airodrom uses <code>drive.file</code> only. Choosing a file here authorizes this app for that file — not your whole Drive.</p>
<p id="status">Loading Google Picker…</p>
<p><button id="pick" type="button" disabled>Open Google Picker</button></p>
<p class="muted">After selection, enroll happens automatically. Close this tab and return to Airodrom Terminal / Control Center.</p>
<script src="https://apis.google.com/js/api.js"></script>
<script>
(function(){
  const origin=${JSON.stringify(safeOrigin)};
  const sessionId=${JSON.stringify(safeSession)};
  const clientId=${JSON.stringify(safeClient)};
  const status=document.getElementById('status');
  const pick=document.getElementById('pick');
  let boot=null;
  let pickerReady=false;
  function fail(msg){ status.textContent=msg; pick.disabled=true; }
  async function bootstrap(){
    const res=await fetch(origin+'/oauth/drive/picker/bootstrap',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session_id:sessionId}),
      credentials:'same-origin'
    });
    const body=await res.json().catch(function(){return {};});
    if(!res.ok) throw Error(body.error||'Picker bootstrap failed');
    if(typeof body.access_token!=='string'||!body.access_token||body.access_token==='[omitted]')
      throw Error('Picker bootstrap did not return an access token');
    if(typeof body.api_key!=='string'||!body.api_key||body.api_key==='[omitted]')
      throw Error('Picker bootstrap did not return an API key');
    boot=body;
    return body;
  }
  function onPicked(doc){
    status.textContent='Recording enrollment for '+doc.id+'…';
    fetch(origin+'/oauth/drive/picker/enroll',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session_id:sessionId, file_id:doc.id, name:doc.name||null, mime_type:doc.mimeType||null}),
      credentials:'same-origin'
    }).then(function(r){return r.json().then(function(b){return {ok:r.ok,b};});})
     .then(function(x){
       if(!x.ok) throw Error(x.b.error||'Enrollment failed');
       status.textContent='Enrolled '+ (x.b.item&&x.b.item.id) +'. You can close this tab and run /drive read <id> in Airodrom.';
       pick.disabled=true;
     }).catch(function(e){ fail(e.message||String(e)); });
  }
  pick.onclick=function(){
    if(!pickerReady) return fail('Google Picker API not loaded');
    status.textContent='Authorizing picker session…';
    pick.disabled=true;
    Promise.resolve(boot||bootstrap()).then(function(){
      if(!boot||!window.google||!google.picker) return fail('Google Picker API not loaded');
      const view=new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
      const builder=new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(boot.access_token)
        .setDeveloperKey(boot.api_key)
        .setAppId(boot.app_id)
        .setCallback(function(data){
          if(data.action===google.picker.Action.PICKED && data.docs && data.docs[0]) onPicked(data.docs[0]);
          else if(data.action===google.picker.Action.CANCEL){ status.textContent='Selection cancelled.'; pick.disabled=false; }
        });
      if(clientId) builder.setOrigin(origin);
      builder.build().setVisible(true);
      status.textContent='Choose a nonsensitive test file.';
    }).catch(function(e){ fail(e.message||String(e)); });
  };
  gapi.load('picker', function(){
    pickerReady=true;
    status.textContent='Ready. Click Open Google Picker to continue (tokens are requested only on click).';
    pick.disabled=false;
  });
})();
</script>
</body></html>`;
}

/** Allowlisted picker bootstrap JSON body (never run through safeValue). */
function bootstrapResponseBody(payload) {
  const access_token = typeof payload?.access_token === 'string' ? payload.access_token : '';
  const api_key = typeof payload?.api_key === 'string' ? payload.api_key : '';
  const app_id = typeof payload?.app_id === 'string' ? payload.app_id : '';
  if (!access_token || !api_key || !app_id) return null;
  return { access_token, api_key, app_id };
}

function missingConfigHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Airodrom · Drive picker setup required</title></head>
<body style="font-family:system-ui;margin:2rem;max-width:40rem;line-height:1.45">
<h1>Drive file selection needs one owner setup step</h1>
<p><code>drive.file</code> only authorizes files this app creates or that you open with Google Picker / Open with.</p>
<p>Airodrom does not have a Google Picker API key configured yet. In the Google Cloud project that owns your desktop OAuth client:</p>
<ol>
<li>Enable <strong>Google Picker API</strong> and <strong>Google Drive API</strong>.</li>
<li>Create a browser API key restricted to Google Picker API.</li>
<li>Note the project <strong>number</strong> (App ID).</li>
</ol>
<p>Then run:</p>
<pre>airodrom drive picker-setup &lt;api-key&gt; &lt;project-number&gt;</pre>
<p>Reconnect with <code>/connect drive fresh</code>, complete consent, and this page will open the picker.</p>
</body></html>`;
}

/**
 * Operator-local Picker handoff URL only (loopback + exact path + session UUID).
 * safeValue/redactUrls rewrite non-allowlisted paths to /[redacted-path], which
 * would open a false same-origin deny instead of the Picker page.
 */
function assertLoopbackPickerUrl(url, expectedOrigin) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch {
    const err = Error('Picker URL is invalid.');
    err.code = 'picker_url_invalid';
    throw err;
  }
  if (parsed.protocol !== 'http:') {
    const err = Error('Picker URL protocol is not permitted.');
    err.code = 'picker_url_invalid';
    throw err;
  }
  if (parsed.hostname !== '127.0.0.1') {
    const err = Error('Picker URL host must be loopback 127.0.0.1.');
    err.code = 'picker_url_invalid';
    throw err;
  }
  if (parsed.pathname !== '/oauth/drive/picker') {
    const err = Error('Picker URL path is not the registered local route.');
    err.code = 'picker_url_invalid';
    throw err;
  }
  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 's') {
    const err = Error('Picker URL query must contain only the session parameter.');
    err.code = 'picker_url_invalid';
    throw err;
  }
  const session = parsed.searchParams.get('s');
  if (!session || !/^[a-f0-9-]{36}$/i.test(session)) {
    const err = Error('Picker URL session is missing or invalid.');
    err.code = 'picker_url_invalid';
    throw err;
  }
  if (expectedOrigin) {
    let expected;
    try { expected = new URL(String(expectedOrigin)); }
    catch {
      const err = Error('Expected Picker origin is invalid.');
      err.code = 'picker_url_invalid';
      throw err;
    }
    if (parsed.origin !== expected.origin) {
      const err = Error('Picker URL origin does not match the local control server.');
      err.code = 'picker_url_invalid';
      throw err;
    }
  }
  return parsed;
}

/**
 * `/api/assistant/drive/picker` wire body. Preserve a validated loopback picker_url
 * after safeValue (same pattern as authorization_url via wireConnectOffer).
 */
function wirePickerOffer(offer, expectedOrigin) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    return require('./secret-observation').safeValue(offer);
  }
  const url = typeof offer.picker_url === 'string' ? offer.picker_url : null;
  if (url) assertLoopbackPickerUrl(url, expectedOrigin);
  const rest = { ...offer };
  delete rest.picker_url;
  const body = require('./secret-observation').safeValue(rest);
  if (url) body.picker_url = url;
  return body;
}

module.exports = {
  PICKER_CSP,
  readConfig,
  writeConfig,
  status,
  oauthClientProjectNumber,
  assertAppIdAlignedWithOAuthClient,
  createSession,
  getLiveSession,
  bootstrapSession,
  requireBootstrapped,
  consumeSession,
  completeSession,
  pickerHtml,
  missingConfigHtml,
  bootstrapResponseBody,
  assertLoopbackPickerUrl,
  wirePickerOffer,
  _sessions: sessions,
};
