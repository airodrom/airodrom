'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const ControlServer = require('../src/control-server');
const picker = require('../src/drive-picker');
const { FILE_SCOPE } = require('../src/drive-oauth');

async function bootServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-same-origin-'));
  fs.chmodSync(dataDir, 0o700);
  picker.writeConfig(dataDir, { apiKey: 'AIzaSyTestKeyForPickerOnlyXX', appId: '172228664875' });
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
  const server = new ControlServer(bridge, { port: 0, token: 'picker-same-origin-fixture', mcpToken: 'mcp-fixture' });
  server.driveOAuth = {
    resolve: async () => 'ya29.picker-fixture-token-not-for-production',
    configuration: () => ({ clientId: '123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com' }),
    status: () => ({ connected: true, scope: FILE_SCOPE }),
    complete: async () => ({ connected: true }),
  };
  await server.start();
  t.after(async () => { await new Promise((r) => server.server.close(r)); db.close(); });
  return server;
}

function request(server, { method = 'GET', path: pathname, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.port,
      path: pathname,
      method,
      headers: h,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* plain */ }
        resolve({ status: res.statusCode, body: b, json, csp: res.headers['content-security-policy'] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('Drive OAuth callback accepts Google cross-site top-level navigation (not same-origin false deny)', async (t) => {
  const server = await bootServer(t);
  const res = await request(server, {
    method: 'GET',
    path: '/oauth/drive/callback?state=fixture&code=fixture',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: 'https://accounts.google.com',
      Referer: 'https://accounts.google.com/',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    },
  });
  // Must reach OAuth handler (not origin middleware 403). complete() may still fail on state.
  assert.notEqual(res.status, 403);
  assert.doesNotMatch(res.body, /Local same-origin requests only/);
});

test('Drive Picker page GET accepts cross-site navigation after Google→loopback redirect chain', async (t) => {
  const server = await bootServer(t);
  const sessionId = picker.createSession({ ttlMs: 60000 });
  const res = await request(server, {
    method: 'GET',
    path: `/oauth/drive/picker?s=${sessionId}`,
    headers: {
      Host: `127.0.0.1:${server.port}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      Referer: 'https://accounts.google.com/',
    },
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /Open Google Picker/);
  assert.match(String(res.csp || ''), /apis\.google\.com/);
  assert.doesNotMatch(res.body, /Local same-origin requests only/);
});

test('Drive Picker page GET accepts missing Origin on top-level navigation', async (t) => {
  const server = await bootServer(t);
  const sessionId = picker.createSession({ ttlMs: 60000 });
  const res = await request(server, {
    method: 'GET',
    path: `/oauth/drive/picker?s=${sessionId}`,
    headers: {
      Host: `127.0.0.1:${server.port}`,
      'sec-fetch-site': 'none',
    },
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /drive\.file/);
});

test('Drive Picker bootstrap rejects forged Origin / cross-site', async (t) => {
  const server = await bootServer(t);
  const sessionId = picker.createSession({ ttlMs: 60000 });
  const res = await request(server, {
    method: 'POST',
    path: '/oauth/drive/picker/bootstrap',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    },
    body: { session_id: sessionId },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json?.code, 'drive_picker_cross_origin_rejected');
  assert.match(res.json?.error || '', /same-origin/);
});

test('Drive Picker bootstrap accepts same-origin and returns non-redacted handoff', async (t) => {
  const server = await bootServer(t);
  const sessionId = picker.createSession({ ttlMs: 60000 });
  const res = await request(server, {
    method: 'POST',
    path: '/oauth/drive/picker/bootstrap',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: server.origin,
      'sec-fetch-site': 'same-origin',
    },
    body: { session_id: sessionId },
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.access_token, 'ya29.picker-fixture-token-not-for-production');
  assert.notEqual(res.json.access_token, '[omitted]');
  assert.equal(res.json.api_key, 'AIzaSyTestKeyForPickerOnlyXX');
});

test('invalid Host header is rejected for picker and API', async (t) => {
  const server = await bootServer(t);
  const sessionId = picker.createSession({ ttlMs: 60000 });
  const res = await request(server, {
    method: 'GET',
    path: `/oauth/drive/picker?s=${sessionId}`,
    headers: {
      Host: `localhost:${server.port}`,
      'sec-fetch-site': 'none',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json?.code, 'loopback_host_required');
});

test('forged Origin on authenticated API remains denied', async (t) => {
  const server = await bootServer(t);
  const res = await request(server, {
    method: 'GET',
    path: '/api/assistant/connectors',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: 'https://evil.example',
      Authorization: 'Bearer picker-same-origin-fixture',
      'sec-fetch-site': 'cross-site',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json?.code, 'local_same_origin_only');
});

test('safeValue rewrites picker_url path; wirePickerOffer preserves validated loopback URL', () => {
  const { safeValue } = require('../src/secret-observation');
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const pickerUrl = `http://127.0.0.1:55999/oauth/drive/picker?s=${sessionId}`;
  const scrubbed = safeValue({ picker_url: pickerUrl, picker_configured: true });
  assert.match(String(scrubbed.picker_url || ''), /\[redacted-path\]/);
  const wired = picker.wirePickerOffer({
    state: 'WAIT',
    picker_url: pickerUrl,
    picker_configured: true,
    client_secret: 'must-omit-secret-material',
  }, 'http://127.0.0.1:55999');
  assert.equal(wired.picker_url, pickerUrl);
  assert.equal(wired.picker_configured, true);
  assert.equal(wired.client_secret, '[omitted]');
  assert.throws(
    () => picker.wirePickerOffer({ picker_url: 'https://evil.example/oauth/drive/picker?s=' + sessionId }),
    /loopback|not permitted|invalid/i,
  );
  assert.throws(
    () => picker.wirePickerOffer({ picker_url: `http://127.0.0.1:55999/oauth/drive/picker?s=${sessionId}` }, 'http://127.0.0.1:11111'),
    /origin|invalid/i,
  );
  assert.throws(
    () => picker.assertLoopbackPickerUrl(`http://localhost:55999/oauth/drive/picker?s=${sessionId}`),
    /127\.0\.0\.1|invalid/i,
  );
  assert.throws(
    () => picker.assertLoopbackPickerUrl(`http://127.0.0.1:55999/oauth/drive/picker?s=${sessionId}&extra=1`),
    /only the session|invalid/i,
  );
});

test('/api/assistant/drive/picker returns usable loopback picker_url (not redacted-path)', async (t) => {
  const server = await bootServer(t);
  const res = await request(server, {
    method: 'POST',
    path: '/api/assistant/drive/picker',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: server.origin,
      Authorization: 'Bearer picker-same-origin-fixture',
      'sec-fetch-site': 'same-origin',
    },
    body: { request_id: '00000000-0000-4000-8000-000000000001' },
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json?.picker_configured, true);
  assert.match(String(res.json?.picker_url || ''), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/drive\/picker\?s=[a-f0-9-]{36}$/i);
  assert.doesNotMatch(String(res.json?.picker_url || ''), /redacted/i);

  const page = await request(server, {
    method: 'GET',
    path: new URL(res.json.picker_url).pathname + new URL(res.json.picker_url).search,
    headers: {
      Host: `127.0.0.1:${server.port}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      Referer: 'https://accounts.google.com/',
    },
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /Open Google Picker/);
  assert.doesNotMatch(page.body, /Local same-origin requests only/);
});

test('picker enroll rejects cross-site; expired session fails closed without inventing enrollment', async (t) => {
  const server = await bootServer(t);
  const cross = await request(server, {
    method: 'POST',
    path: '/oauth/drive/picker/enroll',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    },
    body: { session_id: '00000000-0000-4000-8000-000000000099', file_id: 'fileForeign99' },
  });
  assert.equal(cross.status, 403);

  const missing = await request(server, {
    method: 'POST',
    path: '/oauth/drive/picker/enroll',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: server.origin,
      'sec-fetch-site': 'same-origin',
    },
    body: { session_id: '00000000-0000-4000-8000-000000000099', file_id: 'fileForeign99' },
  });
  assert.equal(missing.status, 400);
  assert.match(missing.json?.error || missing.body, /session expired|Re-open/i);
});
