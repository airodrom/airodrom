'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compactTaskStatus } = require('../src/mcp-tools');

function makeTask(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    connected: false,
    latestMcpRequestId: 'request-123',
    mission: {},
    ...overrides
  };
}

function makeState(overrides = {}) {
  return {
    status: 'running',
    failureKind: null,
    busy: true,
    heartbeatHealthy: false,
    stalled: false,
    lastActivityAt: 100,
    lastHeartbeatAt: null,
    lastResult: null,
    lastRunBlocked: false,
    safetyStop: null,
    error: null,
    approvals: [],
    activeChat: null,
    mission: { huge: 'x'.repeat(50000) },
    transitions: Array.from({ length: 500 }, (_, i) => ({ i })),
    events: Array.from({ length: 500 }, (_, i) => ({ i })),
    context: { huge: 'y'.repeat(50000) },
    ...overrides
  };
}

test('compact status omits heavy mission and history payloads', () => {
  const value = compactTaskStatus(makeState(), makeTask(), { workspace: 'bridge', origin: 'http://127.0.0.1:43117' });
  for (const key of ['mission', 'mission_authorization', 'recovery', 'transitions', 'context', 'events', 'description', 'source']) {
    assert.equal(Object.hasOwn(value, key), false, key);
  }
  assert.ok(JSON.stringify(value).length < 5000);
  assert.equal(value.workspace, 'bridge');
});

test('worker state distinguishes healthy stale and disconnected', () => {
  assert.equal(compactTaskStatus(makeState({ heartbeatHealthy: true }), makeTask({ connected: true })).worker_state, 'healthy');
  assert.equal(compactTaskStatus(makeState({ heartbeatHealthy: false }), makeTask({ connected: true })).worker_state, 'stale');
  assert.equal(compactTaskStatus(makeState({ heartbeatHealthy: false }), makeTask({ connected: false })).worker_state, 'disconnected');
});

test('completed result is durable, bounded, and marked ready', () => {
  const long = 'r'.repeat(30000);
  const value = compactTaskStatus(makeState({ status: 'completed', busy: false, lastResult: long }), makeTask());
  assert.equal(value.result_ready, true);
  assert.equal(value.result.length, 24000);
  assert.equal(value.result_truncated, true);
  assert.equal(value.result_untrusted, true);
});

test('busy and cancelled tasks do not expose stale result', () => {
  assert.equal(compactTaskStatus(makeState({ status: 'running', busy: true, lastResult: 'old' }), makeTask()).result_ready, false);
  assert.equal(compactTaskStatus(makeState({ status: 'cancelled', busy: false, lastResult: 'old' }), makeTask()).result_ready, false);
});

test('approval payload is compact', () => {
  const value = compactTaskStatus(makeState({
    approvals: [{
      id: 'a1',
      toolName: 'write',
      status: 'pending',
      expiresAt: 123,
      input: { huge: 'x'.repeat(10000) },
      fingerprint: 'secret',
      workspace: '/private/path',
      sessionId: 's1'
    }]
  }), makeTask());
  assert.deepEqual(value.approvals, [{ id: 'a1', tool: 'write', status: 'pending', expires_at: 123 }]);
});
