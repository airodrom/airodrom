'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const picker = require('../src/drive-picker');
const { DriveOAuth, FILE_SCOPE } = require('../src/drive-oauth');
const ControlServer = require('../src/control-server');

test('picker config requires api key and numeric app id; never returns api key in status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-picker-'));
  assert.equal(picker.readConfig(dir), null);
  assert.throws(() => picker.writeConfig(dir, { apiKey: 'short', appId: '123' }), /API key/);
  assert.throws(() => picker.writeConfig(dir, { apiKey: 'k'.repeat(24), appId: 'abc' }), /project number/);
  const saved = picker.writeConfig(dir, { apiKey: 'k'.repeat(24), appId: '123456789012' });
  assert.equal(saved.configured, true);
  const cfg = picker.readConfig(dir);
  assert.equal(cfg.appId, '123456789012');
  const st = picker.status(dir);
  assert.equal(st.picker_configured, true);
  assert.equal(JSON.stringify(st).includes('kkkk'), false);
});

test('picker session bootstrap is one-shot; consume only after bootstrapped', () => {
  const id = picker.createSession({ ttlMs: 60000 });
  assert.ok(picker.getLiveSession(id));
  assert.ok(picker.bootstrapSession(id));
  assert.equal(picker.bootstrapSession(id), null); // cannot bootstrap twice
  assert.ok(picker.requireBootstrapped(id));
  assert.ok(picker.consumeSession(id));
  assert.equal(picker.consumeSession(id), null);
  assert.equal(picker.getLiveSession(id), null);
});

test('failed enroll path keeps bootstrapped session until consume', () => {
  const id = picker.createSession({ ttlMs: 60000 });
  picker.bootstrapSession(id);
  assert.ok(picker.requireBootstrapped(id));
  assert.ok(picker.requireBootstrapped(id)); // still live after check
  picker.consumeSession(id);
  assert.equal(picker.requireBootstrapped(id), null);
});

test('missing config HTML explains drive.file and picker-setup without broad scopes', () => {
  const html = picker.missingConfigHtml();
  assert.match(html, /drive\.file/);
  assert.match(html, /picker-setup/);
  assert.doesNotMatch(html, /drive\.readonly|googleapis\.com\/auth\/drive(?!\.file)/);
});

test('picker HTML binds session, bootstraps on click, and does not embed access tokens', () => {
  const html = picker.pickerHtml({
    origin: 'http://127.0.0.1:43117',
    sessionId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
    clientId: 'synthetic.apps.googleusercontent.com',
  });
  assert.match(html, /picker\/bootstrap/);
  assert.match(html, /drive\.file/);
  assert.match(html, /boot\|\|bootstrap/);
  assert.doesNotMatch(html, /ya29\./);
  assert.doesNotMatch(html, /access_token\s*=\s*['"]/);
});

test('PICKER_CSP allows Google Picker origins and keeps frame-ancestors none', () => {
  assert.match(picker.PICKER_CSP, /apis\.google\.com/);
  assert.match(picker.PICKER_CSP, /docs\.google\.com/);
  assert.match(picker.PICKER_CSP, /frame-ancestors 'none'/);
});

test('Drive OAuth rejects supplemental drive.readonly and missing scope', async () => {
  function memoryVault() {
    const values = new Map();
    return {
      put(v) { const reference = require('node:crypto').randomUUID(); values.set(reference, v); return { reference }; },
      resolve(ref) { if (!values.has(ref)) throw Error('missing'); return values.get(ref); },
      forget(ref) { values.delete(ref); },
      replace(ref, v) { values.set(ref, v); return { reference: ref }; },
      _values: values,
    };
  }
  const redirect = 'http://127.0.0.1:9/oauth/drive/callback';
  const clientId = '123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
  const broad = new DriveOAuth({
    clientId,
    vault: memoryVault(),
    request: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        access_token: 'tok', refresh_token: 'r', expires_in: 3600,
        scope: FILE_SCOPE + ' https://www.googleapis.com/auth/drive.readonly',
      }),
    }),
  });
  const st = new URL(broad.start(redirect).authorization_url).searchParams.get('state');
  await assert.rejects(() => broad.complete({ state: st, code: 'x' }), /drive\.file only/i);

  const missing = new DriveOAuth({
    clientId,
    vault: memoryVault(),
    request: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        access_token: 'tok', refresh_token: 'r', expires_in: 3600,
      }),
    }),
  });
  const st2 = new URL(missing.start(redirect).authorization_url).searchParams.get('state');
  await assert.rejects(() => missing.complete({ state: st2, code: 'y' }), /drive\.file only/i);
});

test('bootstrapResponseBody preserves tokens that safeValue would omit', () => {
  const body = picker.bootstrapResponseBody({
    access_token: 'ya29.picker-fixture-token-not-for-production',
    api_key: 'AIzaSyTestKeyForPickerOnlyXX',
    app_id: '123456789012',
    extra: 'drop-me',
  });
  assert.equal(body.access_token, 'ya29.picker-fixture-token-not-for-production');
  assert.equal(body.api_key, 'AIzaSyTestKeyForPickerOnlyXX');
  assert.equal(body.app_id, '123456789012');
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'extra'), false);
  const redacted = require('../src/secret-observation').safeValue(body);
  assert.equal(redacted.access_token, '[omitted]');
  assert.equal(redacted.api_key, '[omitted]');
});

test('picker page HTTP response overrides CSP for Google Picker', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { EventLedger } = require('../src/event-ledger');
  const { ControlPlaneStore } = require('../src/control-plane-store');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-picker-http-'));
  picker.writeConfig(dataDir, { apiKey: 'AIzaSyTestKeyForPickerOnlyXX', appId: '123456789012' });
  const db = new DatabaseSync(':memory:');
  const ledger = new EventLedger(db);
  db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');
  const store = new ControlPlaneStore({ db, ledger });
  const bridge = {
    dataDir,
    controlStore: store,
    ledger,
    closed: false,
    inFlight: new Set(),
    leases: new Map(),
    lifecycle: null,
    policy: { list: () => [] },
  };
  const server = new ControlServer(bridge, { port: 0, token: 'picker-operator-fixture-token', mcpToken: 'mcp-fixture' });
  // Avoid Keychain SecretVault: inject a connected Drive OAuth stub for route wiring.
  server.driveOAuth = {
    resolve: async () => 'ya29.picker-fixture-token-not-for-production',
    configuration: () => ({ clientId: '123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com' }),
    status: () => ({ connected: true }),
  };
  await server.start();
  t.after(async () => { await new Promise((r) => server.server.close(r)); db.close(); });

  const sessionId = picker.createSession({ ttlMs: 60000 });
  const page = await new Promise((resolve, reject) => {
    http.get(`${server.origin}/oauth/drive/picker?s=${sessionId}`, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, csp: res.headers['content-security-policy'], body: b }));
    }).on('error', reject);
  });
  assert.equal(page.status, 200);
  assert.match(String(page.csp || ''), /apis\.google\.com/);
  assert.match(page.body, /Open Google Picker/);

  const boot = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/oauth/drive/picker/bootstrap',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.origin },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ session_id: sessionId }));
    req.end();
  });
  assert.equal(boot.status, 200, boot.body);
  const json = JSON.parse(boot.body);
  assert.equal(json.access_token, 'ya29.picker-fixture-token-not-for-production');
  assert.notEqual(json.access_token, '[omitted]');
  assert.equal(json.api_key, 'AIzaSyTestKeyForPickerOnlyXX');
});
