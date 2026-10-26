'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const intent = require('../src/assistant-intent');
const router = require('../src/model-worker-router');

const readyCursor = {
  ready: true, available: true, version: '2026.09.28-64d2043', auth_state: 'credential_file', reason: null,
  tiers: { installed: true, authenticated: true, qualified: true, available: true }
};
const deniedCursor = {
  ready: false, available: false, version: null, auth_state: 'auth_required', reason: 'cursor_credential_file_unavailable',
  tiers: { installed: true, authenticated: false, qualified: false, available: false }
};

async function catalog(readiness) {
  return router.inspect({
    opencodeAdapter: { options: { model: router.MODEL }, readiness: async () => ({ ready: false }) },
    workers: { catalog: () => [{ id: 'cursor', qualified: false, available: false, reason: 'cursor_tool_and_credential_isolation_unqualified', capabilities: [] }] },
    cursorWorker: { readiness: async () => readiness, options: {} }
  }, { conversation: async () => ({ state: 'WAIT' }) });
}

test('cursor catalog uses governed readiness, not the no-tools denial', async () => {
  const qualified = await catalog(readyCursor);
  const cursor = qualified.workers.find(w => w.id === 'cursor');
  assert.equal(cursor.qualification, 'qualified');
  assert.equal(cursor.available, true);
  assert.equal(cursor.reason, null);
  assert.equal(cursor.governed_worker, true);
  const denied = await catalog(deniedCursor);
  const blocked = denied.workers.find(w => w.id === 'cursor');
  assert.equal(blocked.qualification, 'unqualified');
  assert.equal(blocked.available, false);
  assert.equal(blocked.reason, 'cursor_credential_file_unavailable');
});

test('qualified cursor can be selected for public work and unqualified cursor fails closed', async () => {
  const qualified = await catalog(readyCursor);
  const chosen = router.select(qualified, { mission_class: 'WORK', data_class: 'public', privacy: 'approved_external', worker: 'cursor' });
  assert.equal(chosen.state, 'READY');
  assert.equal(chosen.worker, 'cursor');
  const denied = await catalog(deniedCursor);
  assert.equal(router.select(denied, { mission_class: 'WORK', data_class: 'public', privacy: 'approved_external', worker: 'cursor' }).state, 'WAIT');
});

test('operator settings stay off the coding workspace path', () => {
  for (const message of ['Enable Autopilot', 'Read settings', 'Select autonomy mode routine']) {
    const parsed = intent.parse(message);
    assert.equal(parsed.kind, 'operator_control');
    assert.deepEqual(parsed.capability_classes, []);
  }
  // Service/health status is the host-fact rail (not coding WORK, not a free conversation guess).
  assert.equal(intent.parse('Show service status').kind, 'host_fact');
  assert.equal(intent.parse('Fix fixture.txt in the repository').kind, 'work');
});

test('local-only work still prefers the qualified local route when cursor is also qualified', async () => {
  const qualified = await catalog({ ...readyCursor });
  qualified.workers[0] = { ...qualified.workers[0], qualification: 'qualified', available: true };
  qualified.models[0] = { ...qualified.models[0], qualification: 'qualified', available: true, expires_at: Date.now() + 1000 };
  const local = router.select(qualified, { mission_class: 'WORK', data_class: 'personal', privacy: 'local_only' });
  assert.equal(local.worker, 'opencode');
});
