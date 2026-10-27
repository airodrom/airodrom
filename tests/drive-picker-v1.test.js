'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const picker = require('../src/drive-picker');

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

test('picker session is one-shot bootstrap then enroll-complete', () => {
  const id = picker.createSession({ ttlMs: 60000 });
  assert.ok(picker.getLiveSession(id));
  assert.ok(picker.bootstrapSession(id));
  assert.equal(picker.bootstrapSession(id), null); // cannot bootstrap twice
  assert.ok(picker.completeSession(id));
  assert.equal(picker.completeSession(id), null);
  assert.equal(picker.getLiveSession(id), null);
});

test('missing config HTML explains drive.file and picker-setup without broad scopes', () => {
  const html = picker.missingConfigHtml();
  assert.match(html, /drive\.file/);
  assert.match(html, /picker-setup/);
  assert.doesNotMatch(html, /drive\.readonly|googleapis\.com\/auth\/drive(?!\.file)/);
});

test('picker HTML binds session and does not embed access tokens', () => {
  const html = picker.pickerHtml({
    origin: 'http://127.0.0.1:43117',
    sessionId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
    clientId: 'synthetic.apps.googleusercontent.com',
  });
  assert.match(html, /picker\/bootstrap/);
  assert.match(html, /drive\.file/);
  assert.doesNotMatch(html, /ya29\.|access_token\s*=/);
});
