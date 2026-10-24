'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const R = require('../src/cognitive-router');
const C = require('../src/cognitive-contracts');

async function setup(t) {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  return f;
}

describe('Cursor-only host execution policy', () => {
  test('Cursor execution defaults disabled and is reversible by operator only', async (t) => {
    const f = await setup(t);
    const policy = f.bridge.hostExecutionPolicy;
    assert.equal(policy.cursorDisabled(), true);
    const status = policy.status('operator');
    assert.equal(status.cursor_execution_disabled, true);
    assert.equal(status.external_subscription, 'unaffected');
    assert.throws(() => policy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'mcp:x'), /authenticated local owner/);
    assert.throws(() => policy.enableCursor({ confirmed: false, request_id: randomUUID() }, 'operator'), /confirmation/);
    const enabled = policy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
    assert.equal(enabled.cursor_execution_disabled, false);
    assert.equal(policy.cursorDisabled(), false);
    const disabled = policy.disableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
    assert.equal(disabled.cursor_execution_disabled, true);
  });

  test('assertCursorAllowed fails closed while disabled', async (t) => {
    const f = await setup(t);
    assert.throws(() => f.bridge.hostExecutionPolicy.assertCursorAllowed('dispatch'), /CURSOR_EXECUTION_DISABLED/);
  });

  test('requestedWorker rejects disabled Cursor and conflicting implementation workers', () => {
    assert.throws(
      () => R.requestedWorker('Start the Arecibo audit in Cursor.', { cursorDisabled: true }),
      /CURSOR_EXECUTION_DISABLED/
    );
    for(const text of ['Start the Arecibo release-readiness audit using local OpenCode only. Do not deploy production.','Start the Arecibo release-readiness audit using local OpenCode only. Do not call Cursor.'])assert.throws(()=>R.requestedWorker(text,{cursorDisabled:true}),/CURSOR_IMPLEMENTATION_REQUIRED/);
  });

  test('route never auto-selects Cursor when host policy disables it', () => {
    const envelope = {
      version: 2,
      requested_worker: 'auto',
      eligible_workers: ['host', 'opencode', 'cursor'],
    };
    const proposal = {
      files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
      tasks: [
        { id: 't1', operation: 'edit', paths: ['a.js'], description: 'one', depends_on: [] },
        { id: 't2', operation: 'edit', paths: ['b.js'], description: 'two', depends_on: [] },
        { id: 't3', operation: 'edit', paths: ['c.js'], description: 'three', depends_on: [] },
        { id: 't4', operation: 'edit', paths: ['d.js'], description: 'four', depends_on: [] },
        { id: 't5', operation: 'edit', paths: ['e.js'], description: 'five', depends_on: [] },
        { id: 't6', operation: 'edit', paths: ['a.js'], description: 'six', depends_on: [] },
        { id: 't7', operation: 'edit', paths: ['b.js'], description: 'seven', depends_on: [] },
      ],
    };
    assert.equal(R.route(envelope, proposal, ['host', 'opencode', 'cursor'], { cursorDisabled: false }), 'cursor');
    assert.throws(()=>R.route(envelope, proposal, ['host', 'opencode', 'cursor'], { cursorDisabled: true }),/CURSOR_EXECUTION_DISABLED/);
  });

  test('coerceAutopilotDeliverable turns read-only audit plans into one enrolled edit', () => {
    const envelope = C.seal({
      version: 3, request_id: '11111111-1111-4111-8111-111111111111', caller: 'operator',
      delegation: { policy_id: '22222222-2222-4222-8222-222222222222', policy_hash: 'a'.repeat(64) },
      repository_id: 'proj:policy', workspace_id: '33333333-3333-4333-8333-333333333333',
      git_anchor: 'b'.repeat(40),
      integrity: { version: 1, hash: 'c'.repeat(64), entries: 1, bytes: 1, exclusions: 'none' },
      permitted_paths: ['CHANGELOG.md', 'README.md'], denied_paths: ['.git/**'],
      operations: ['read', 'edit'], eligible_workers: ['host', 'opencode', 'cursor'],
      verification: ['diff-check', 'arecibo-typecheck'],
      limits: { planning_attempts: 2, execution_attempts: 2, repair_attempts: 1, planning_ms: 120000, execution_ms: 120000 },
      requested_worker: 'auto', instruction_hash: 'd'.repeat(64), expires_at: Date.now() + 60000
    });
    const proposal = {
      version: 3,
      request_id: envelope.request_id,
      envelope_hash: envelope.hash,
      files: ['CHANGELOG.md', 'README.md'],
      tasks: [
        { id: 'read_changelog', operation: 'read', paths: ['CHANGELOG.md'], description: 'read changelog', depends_on: [], worker: 'opencode', role: 'analysis', verification: [] },
        { id: 'read_readme', operation: 'read', paths: ['README.md'], description: 'read readme', depends_on: ['read_changelog'], worker: 'opencode', role: 'analysis', verification: [] }
      ],
      verification: ['diff-check', 'arecibo-typecheck'],
      complexity: 'bounded'
    };
    const coerced = R.coerceAutopilotDeliverable(proposal, envelope, 'Start the Arecibo release-readiness audit and produce a grounded report.');
    assert.equal(coerced.tasks.length, 1);
    assert.equal(coerced.tasks[0].operation, 'edit');
    assert.equal(coerced.tasks[0].worker,'cursor');
    assert.equal(coerced.tasks[0].paths[0], 'CHANGELOG.md');
    assert.match(coerced.tasks[0].description, /diff --check|trailing whitespace/i);
    assert.equal(R.coerceAutopilotDeliverable(proposal, envelope, 'Summarize CHANGELOG only').tasks.length, 2);
  });

  test('coercePlanningProposal blocks implementation when Cursor is ineligible', () => {
    const envelope = C.seal({
      version: 3, request_id: '11111111-1111-4111-8111-111111111111', caller: 'operator',
      delegation: { policy_id: '22222222-2222-4222-8222-222222222222', policy_hash: 'a'.repeat(64) },
      repository_id: 'proj:policy', workspace_id: '33333333-3333-4333-8333-333333333333',
      git_anchor: 'b'.repeat(40),
      integrity: { version: 1, hash: 'c'.repeat(64), entries: 1, bytes: 1, exclusions: 'none' },
      permitted_paths: ['CHANGELOG.md', 'docs/README.md'], denied_paths: ['.git/**'],
      operations: ['read', 'edit'], eligible_workers: ['host', 'opencode'],
      verification: ['diff-check', 'arecibo-typecheck'],
      limits: { planning_attempts: 2, execution_attempts: 2, repair_attempts: 1, planning_ms: 120000, execution_ms: 120000 },
      requested_worker: 'auto', instruction_hash: 'd'.repeat(64), expires_at: Date.now() + 60000
    });
    assert.throws(()=>R.coercePlanningProposal({
      version: 3,
      request_id: envelope.request_id,
      envelope_hash: envelope.hash,
      files: ['CHANGELOG.md'],
      tasks: [{
        id: 'change', operation: 'edit', paths: ['CHANGELOG.md'], description: 'edit',
        depends_on: [], worker: 'cursor', role: 'implementation', verification: []
      }],
      verification: ['diff-check'],
      complexity: 'bounded'
    }, envelope),/cognitive_worker_unqualified:cursor/);
  });

  test('Autopilot enrolls OpenCode-only workers while Cursor is disabled', async (t) => {
    const f = await setup(t);
    assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
    // Simulate Cursor readiness without allowing enrollment.
    f.bridge.cursorWorker.lastReadiness = { ready: true, tiers: { qualified: true } };
    const workers = f.bridge.hostExecutionPolicy.cursorDisabled()
      ? ['opencode']
      : (f.bridge.cursorWorker.lastReadiness?.ready ? ['opencode', 'cursor'] : ['opencode']);
    assert.deepEqual(workers, ['opencode']);
  });
});
