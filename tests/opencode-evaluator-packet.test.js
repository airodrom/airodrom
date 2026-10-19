'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { containsSecret } = require('../src/personal-memory');
const { sourceContextSensitive, specialistReturnSafetyView, classifyProcessFailure } = require('../src/opencode-adapter');
const { parseEvaluation, evaluationAllowanceMs, preStartEvaluationRetryable } = require('../src/opencode-gateway');
const { canonicalHash } = require('../src/authority-hash');

function luhnDigest() {
  for (let i = 0; i < 100000; i++) {
    const digest = createHash('sha256').update('milestone-b2-evidence-' + i).digest('hex');
    if (containsSecret(digest)) return digest;
  }
  throw new Error('fixture digest was not card-shaped');
}

function packet(digest) {
  const mission = randomUUID();
  const run = randomUUID();
  const dispatch = randomUUID();
  const workspace = randomUUID();
  return {
    version: 1,
    mission_id: mission,
    assignment_id: 'edit-bytes',
    worker_id: 'cursor',
    cursor_run_id: run,
    dispatch_id: dispatch,
    authorized_scope_hash: digest,
    workspace_identity: { workspace_id: workspace, repository_id: mission + ':' + workspace },
    changed_files: ['alpha.txt', 'beta.txt'],
    before_hashes: { 'alpha.txt': digest, 'beta.txt': digest },
    after_hashes: { 'alpha.txt': digest, 'beta.txt': digest },
    diff_summary: { changed: 2, paths: ['alpha.txt', 'beta.txt'] },
    test_results: [],
    execution_status: 'completed',
    termination_status: { verified: true, process_state: 'exited' },
    verification_results: {
      status: 'passed',
      workspace_hash: digest,
      checks: [
        { id: 'task:exact-bytes', status: 'passed', evidence_hash: digest },
        { id: 'repository_v2', status: 'passed', evidence_hash: digest }
      ]
    },
    errors: [],
    remaining_repair_budget: 0,
    assignment: {
      version: 1,
      parent_mission_id: mission,
      sealed_contract_hash: digest,
      id: 'edit-bytes',
      worker: 'cursor',
      role: 'specialist',
      operation: 'edit',
      paths: ['alpha.txt', 'beta.txt'],
      description: 'Replace fixture bytes',
      depends_on: [],
      verification: ['task:exact-bytes'],
      workspace_id: workspace,
      repository_id: mission + ':' + workspace,
      runtime_ms: 120000,
      max_invocations: 1,
      repair_ceiling: 0,
      idempotency_key: 'assignment:' + mission + ':edit-bytes'
    },
    attempt: 1,
    run_id: run,
    state: 'completed',
    termination_verified: true,
    host_changes: [
      { path: 'alpha.txt', preimage_sha256: digest, sha256: digest, size: 6 },
      { path: 'beta.txt', preimage_sha256: digest, sha256: digest, size: 5 }
    ],
    host_verification: {
      status: 'passed',
      workspace_hash: digest,
      checks: [{ id: 'task:exact-bytes', status: 'passed', evidence_hash: digest }]
    },
    worker_claims: { tests: [], limitations: [], untrusted: true },
    accounting: { class: 'UNKNOWN_SUBSCRIPTION', observed_cost: null, invocations: 1 },
    references: ['mission:' + mission, 'run:' + run, 'dispatch:' + dispatch],
    prior_results: [],
    authority: false
  };
}

test('host evidence digests pass the evaluator scan and secrets still fail', () => {
  const digest = luhnDigest();
  assert.equal(containsSecret(digest), true);
  const raw = packet(digest);
  const before = JSON.stringify(raw);
  assert.equal(sourceContextSensitive(JSON.stringify(raw.verification_results)), true);
  const view = specialistReturnSafetyView(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(sourceContextSensitive(JSON.stringify(view)), false);
  assert.equal(view.host_verification.status, 'passed');
  assert.deepEqual(view.host_verification.checks.map(c => c.id), ['task:exact-bytes']);
  assert.deepEqual(view.assignment.paths, ['alpha.txt', 'beta.txt']);
  assert.equal(view.assignment.id, 'edit-bytes');
  assert.equal(view.remaining_repair_budget, 0);
  assert.equal(view.worker_claims.untrusted, true);
  assert.equal(view.authority, false);
  assert.equal(JSON.stringify(view).includes('/Users'), false);
  assert.equal(JSON.stringify(view).includes(digest), false);
  const secret = packet(digest);
  secret.worker_claims.limitations = ['Bearer syntheticContextSecret'];
  assert.equal(sourceContextSensitive(JSON.stringify(specialistReturnSafetyView(secret))), true);
  const path = packet(digest);
  path.changed_files = ['/Users/example/alpha.txt'];
  path.host_changes[0].path = '/Users/example/alpha.txt';
  assert.equal(sourceContextSensitive(JSON.stringify(specialistReturnSafetyView(path))), true);
});

test('structured evaluation binds to the host hash and fails closed otherwise', () => {
  const binding = { version: 1, mission_id: randomUUID(), worker_run_id: randomUUID() };
  const binding_hash = canonicalHash(binding);
  const ready = parseEvaluation(JSON.stringify({ version: 1, binding_hash, recommendation: 'ready', summary: 'Exact bytes matched the host checks.' }), binding);
  assert.equal(ready.recommendation, 'ready');
  assert.equal(ready.binding_hash, binding_hash);
  assert.throws(() => parseEvaluation('not-json', binding), /gateway_json_required/);
  assert.throws(() => parseEvaluation(JSON.stringify({ version: 1, binding_hash, recommendation: 'ship', summary: 'no' }), binding), /gateway_recommendation_invalid/);
  assert.throws(() => parseEvaluation(JSON.stringify({ version: 1, binding_hash: 'ab'.repeat(32), recommendation: 'ready', summary: 'mismatch' }), binding), /gateway_result_binding_mismatch/);
  assert.equal(classifyProcessFailure({ timedOut: true }), 'opencode_timeout');
  assert.equal(classifyProcessFailure({ cancelled: true }), 'opencode_cancelled');
});

test('a local evaluator that never started can be retried once', () => {
  const mission = { state: 'blocked', reason: 'EVALUATION_UNAVAILABLE: opencode_unavailable_or_unsupported' };
  const run = { agent_id: 'opencode', state: 'failed', termination_verified: 1, pid: null, resolution: 'gateway_evaluation_unavailable' };
  const attempt = { verification: { status: 'passed' } };
  assert.equal(preStartEvaluationRetryable(mission, [run], attempt), true);
  assert.equal(preStartEvaluationRetryable(mission, [run, run], attempt), false);
  assert.equal(preStartEvaluationRetryable(mission, [{ ...run, pid: 10 }], attempt), false);
  assert.equal(preStartEvaluationRetryable({ ...mission, reason: 'EVALUATION_UNAVAILABLE: opencode_sensitive_context' }, [run], attempt), false);
  assert.equal(preStartEvaluationRetryable(mission, [run], { ...attempt, evaluation_run_id: 'already' }), false);
  assert.equal(preStartEvaluationRetryable(mission, [run], { verification: { status: 'failed' } }), false);
});

test('OpenCode evaluation keeps its own allowance after the Cursor window', () => {
  const mission = {
    created_at: 0,
    envelope: {
      cognitive: { envelope: { expires_at: 1e15, limits: { planning_ms: 120000, execution_ms: 120000 } } },
      contract: { identity: { expires_at: 1e15, created_at: 0 }, budget: { max_wall_clock_ms: 360000 } }
    }
  };
  assert.equal(evaluationAllowanceMs(mission, 240000), 120000);
  assert.equal(evaluationAllowanceMs(mission, 0), 120000);
  assert.throws(() => evaluationAllowanceMs(mission, 359995), /gateway_evaluation_deadline/);
});
