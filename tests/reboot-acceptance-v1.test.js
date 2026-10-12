'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reboot = require('../src/reboot-acceptance');

function tempHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-reboot-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('acceptance paths stay under private home', () => {
  const home = '/Users/fixture/.airodrom';
  assert.equal(reboot.pendingPath(home), path.join(home, 'reboot-acceptance', 'pending.json'));
  assert.equal(reboot.receiptPath(home), path.join(home, 'reboot-acceptance', 'post-reboot-receipt.json'));
  assert.match(reboot.PHRASE, /Airodrom-Orbit-2026/);
});

test('status reports absence without throwing', t => {
  const home = tempHome(t);
  const s = reboot.status(home);
  assert.equal(s.pending, false);
  assert.equal(s.receipt, false);
  assert.equal(s.authority, false);
});

test('verify without pending is idle success for RunAtLoad', async t => {
  const home = tempHome(t);
  const receipt = await reboot.verify(home, {
    status: async () => ({ healthy: true, pid: 1, opencode: { ready: true } }),
    request: async () => ({ items: [] })
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.skipped, true);
  assert.equal(receipt.acceptance_ok, null);
  assert.equal(receipt.reason, 'no_pending_reboot_acceptance_state');
  assert.equal(receipt.authority, false);
  assert.equal(reboot.status(home).idle_verify_expected, true);
});

test('verify settles pending when checks pass', async t => {
  const home = tempHome(t);
  const memoryId = '11111111-2222-4333-8444-555555555555';
  fs.mkdirSync(reboot.acceptanceDir(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reboot.pendingPath(home), JSON.stringify({
    version: 1,
    stamp: 'fixture',
    memory_id: memoryId,
    subject_hint: reboot.SUBJECT_HINT,
    expected_install_name: null,
    phrase: reboot.PHRASE
  }), { mode: 0o600 });
  const original = reboot.supervisorRows;
  const ollama = reboot.ollamaReady;
  reboot.supervisorRows = () => ['1234 1 node scripts/local-service.cjs'];
  reboot.ollamaReady = () => true;
  t.after(() => { reboot.supervisorRows = original; reboot.ollamaReady = ollama; });
  const receipt = await reboot.verify(home, {
    status: async () => ({
      healthy: true,
      pid: 1234,
      admission: 'open',
      opencode: { ready: true },
      product: { status: 'Ready', memory: 'Ready', provider: 'Ready' }
    }),
    request: async (h, route) => {
      if (route === '/api/control-v2/health') return { bridge: { mcp_ready: true } };
      if (route === '/api/interactive/lifecycle') {
        return { state: 'open', reconciled: true, idle: true, prior_state: 'stopping', closed_startup: false, hold_reason: null };
      }
      return { items: [{ memoryId, content: reboot.PHRASE }] };
    }
  }, { timeoutMs: 2000 });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.checks.admission_open, true);
  assert.equal(fs.existsSync(reboot.pendingPath(home)), false);
  assert.equal(fs.existsSync(reboot.receiptPath(home)), true);
  assert.ok(receipt.receipt_path && fs.existsSync(receipt.receipt_path));
  assert.match(path.basename(receipt.receipt_path), /^post-reboot-receipt-\d{8}T\d{6}Z\.json$/);
});

test('verify fails closed when admission stays booting and preserves prior receipt', async t => {
  const home = tempHome(t);
  const memoryId = '11111111-2222-4333-8444-555555555555';
  fs.mkdirSync(reboot.acceptanceDir(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reboot.pendingPath(home), JSON.stringify({
    version: 1, stamp: 'fixture', memory_id: memoryId, subject_hint: reboot.SUBJECT_HINT, expected_install_name: null
  }), { mode: 0o600 });
  const prior = { ok: false, preserved: true };
  fs.writeFileSync(reboot.receiptPath(home), JSON.stringify(prior), { mode: 0o600 });
  const original = reboot.supervisorRows;
  const ollama = reboot.ollamaReady;
  reboot.supervisorRows = () => ['1234 1 node scripts/local-service.cjs'];
  reboot.ollamaReady = () => true;
  t.after(() => { reboot.supervisorRows = original; reboot.ollamaReady = ollama; });
  const receipt = await reboot.verify(home, {
    status: async () => ({
      healthy: true, pid: 1234, admission: 'booting',
      opencode: { ready: true }, product: null
    }),
    request: async (_h, route) => {
      if (route === '/api/control-v2/health') return { bridge: { mcp_ready: true } };
      if (route === '/api/interactive/lifecycle') {
        return { state: 'booting', reconciled: true, idle: true, prior_state: 'stopping', closed_startup: false, hold_reason: 'awaiting_owned_start_resume' };
      }
      throw Error('Service admission is closed for maintenance');
    }
  }, { timeoutMs: 2000 });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.checks.admission_open, false);
  assert.equal(receipt.memory_error_class, 'admission_closed');
  assert.equal(receipt.canonical_receipt_preserved, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(reboot.receiptPath(home), 'utf8')), prior);
  assert.equal(fs.existsSync(reboot.pendingPath(home)), true);
});
