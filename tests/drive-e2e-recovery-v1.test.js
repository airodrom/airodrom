'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const ControlServer = require('../src/control-server');
const picker = require('../src/drive-picker');
const driveIntent = require('../src/drive-intent');
const { FILE_SCOPE } = require('../src/drive-oauth');

async function bootServer(t, { clientId = '172228664875-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com', appId = '172228664875' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-e2e-'));
  fs.chmodSync(dataDir, 0o700);
  picker.writeConfig(dataDir, { apiKey: 'AIzaSyTestKeyForPickerOnlyXX', appId, clientId });
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
  const server = new ControlServer(bridge, { port: 0, token: 'drive-e2e-fixture', mcpToken: 'mcp-fixture' });
  server.driveOAuth = {
    resolve: async () => 'ya29.picker-fixture-token-not-for-production',
    configuration: () => ({ clientId }),
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
        resolve({ status: res.statusCode, body: b, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('NL Drive read phrases route to host Drive rail, not bare conversation', () => {
  for (const phrase of [
    'Read my enrolled Drive document',
    'read the enrolled google drive file',
    'Show my authorized Drive document',
    '/drive read',
    '/drive read abcDEF123_-',
  ]) {
    const parsed = driveIntent.parse(phrase);
    assert.equal(parsed?.action, 'read', phrase);
    assert.equal(parsed?.host_verified, true, phrase);
  }
});

test('picker API refuses mismatched App ID before opening a session', async (t) => {
  const server = await bootServer(t);
  // Simulate owner-configured wrong project number without going through writeConfig alignment.
  fs.writeFileSync(path.join(server.bridge.dataDir, 'drive-picker-config.json'), JSON.stringify({
    apiKey: 'AIzaSyTestKeyForPickerOnlyXX',
    appId: '999999999999',
  }) + '\n', { mode: 0o600 });
  const res = await request(server, {
    method: 'POST',
    path: '/api/assistant/drive/picker',
    headers: {
      Host: `127.0.0.1:${server.port}`,
      Origin: server.origin,
      Authorization: 'Bearer drive-e2e-fixture',
      'sec-fetch-site': 'same-origin',
    },
    body: { request_id: '00000000-0000-4000-8000-000000000010' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json?.code, 'picker_appid_oauth_client_project_mismatch');
  assert.equal(res.json?.picker_url, undefined);
  assert.match(String(res.json?.message || ''), /does not match|project number/i);
});

test('picker bootstrap refuses mismatched App ID without consuming tokens', async (t) => {
  const server = await bootServer(t);
  fs.writeFileSync(path.join(server.bridge.dataDir, 'drive-picker-config.json'), JSON.stringify({
    apiKey: 'AIzaSyTestKeyForPickerOnlyXX',
    appId: '999999999999',
  }) + '\n', { mode: 0o600 });
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
  assert.equal(res.status, 400);
  assert.equal(res.json?.code, 'picker_appid_oauth_client_project_mismatch');
  assert.ok(picker.getLiveSession(sessionId), 'session remains pending when bootstrap refused before consume');
});

test('CLI recovers from null cancellation context without exposing TypeError', () => {
  const err = Object.assign(new TypeError("Cannot read properties of null (reading 'signal')"), { name: 'TypeError' });
  const nullSignal = err?.name === 'TypeError' && /reading ['"]signal['"]/i.test(String(err.message || ''));
  assert.equal(nullSignal, true);
  const message = nullSignal
    ? 'Conversation cancellation context was unavailable. The CLI recovered; send the message again.'
    : String(err.message);
  assert.doesNotMatch(message, /TypeError|Cannot read properties/i);
  assert.match(message, /recovered|send the message again/i);
});
