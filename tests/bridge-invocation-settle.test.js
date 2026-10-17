'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mission-fixture.cjs');

function bridgeRuns(bridge, taskId) {
  return bridge.controlStore.db.prepare(
    "SELECT id, state, process_state, generation, result FROM cp_runs WHERE task_id=? AND agent_id='bridge' ORDER BY generation, created_at"
  ).all(taskId).map(row => ({ ...row, result: JSON.parse(row.result || 'null') }));
}

function settleLease(bridge, task, { requestId, outcomeStatus, cancel = false, verified = true, capability = 'git_status' } = {}) {
  const lease = bridge.leases.acquire(task.id, { agentId: 'bridge' });
  if (requestId) {
    task.capabilityInvocations = {
      ...(task.capabilityInvocations || {}),
      [requestId]: {
        fingerprint: 'fixture',
        capability,
        toolCallId: `orchestrator:${require('node:crypto').randomUUID()}`,
        state: outcomeStatus ? 'settled' : 'running',
        runId: lease.runId,
        ...(outcomeStatus ? { outcome: { status: outcomeStatus, allow: outcomeStatus === 'completed', settledAt: Date.now() } } : {})
      }
    };
    task.latestMcpRequestId = requestId;
    bridge.tasks.save(task);
  }
  if (cancel) lease.cancelRequested = true;
  bridge.leases.releaseIfOwner(lease, { verified });
  return lease;
}

test('1. one successful invocation settles its bridge run as invocation_only', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge settle one', { workspace: f.repo }).id);
  const response = await f.bridge.invokeCapability(task.id, {
    name: 'git_status', input: { repo: '.' }, requestId: 'bridge-one-ok'
  });
  assert.equal(response.status, 'completed');
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'completed');
  assert.equal(runs[0].process_state, 'not_started');
  assert.equal(runs[0].result.invocation_only, true);
  assert.equal(runs[0].result.completed, true);
  assert.equal(runs[0].result.request_id, 'bridge-one-ok');
  assert.equal(runs[0].result.correlation, 'run_bound');
  assert.equal(runs[0].result.native_execution_evidence, undefined);
  assert.equal(task.capabilityInvocations['bridge-one-ok'].runId, runs[0].id);
});

test('2. two sequential successful invocations each bind their own run', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge settle two', { workspace: f.repo }).id);
  assert.equal((await f.bridge.invokeCapability(task.id, { name: 'git_status', input: { repo: '.' }, requestId: 'bridge-a' })).status, 'completed');
  assert.equal((await f.bridge.invokeCapability(task.id, { name: 'git_diff', input: { repo: '.' }, requestId: 'bridge-b' })).status, 'completed');
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(r => r.result.request_id), ['bridge-a', 'bridge-b']);
  assert.ok(runs.every(r => r.state === 'completed' && r.result.completed === true && r.result.correlation === 'run_bound'));
  assert.equal(task.capabilityInvocations['bridge-a'].runId, runs[0].id);
  assert.equal(task.capabilityInvocations['bridge-b'].runId, runs[1].id);
});

test('3. failed invocation then successful one do not cross-attribute', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge fail then ok', { workspace: f.repo }).id);
  const execute = f.bridge.capabilityBroker.execute.bind(f.bridge.capabilityBroker);
  let calls = 0;
  f.bridge.capabilityBroker.execute = async (taskId, request, options) => {
    calls++;
    if (calls === 1) return { allow: false, decision: { allow: false, kind: 'policy_denied', reason: 'fixture deny' } };
    return execute(taskId, request, options);
  };
  assert.notEqual((await f.bridge.invokeCapability(task.id, { name: 'git_status', input: { repo: '.' }, requestId: 'bridge-fail' })).status, 'completed');
  assert.equal((await f.bridge.invokeCapability(task.id, { name: 'git_status', input: { repo: '.' }, requestId: 'bridge-ok' })).status, 'completed');
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].result.request_id, 'bridge-fail');
  assert.equal(runs[0].state, 'failed');
  assert.equal(runs[0].result.completed, false);
  assert.equal(runs[1].result.request_id, 'bridge-ok');
  assert.equal(runs[1].state, 'completed');
  assert.equal(runs[1].result.completed, true);
});

test('4. successful invocation then failure keeps the earlier run completed', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge ok then fail', { workspace: f.repo }).id);
  const execute = f.bridge.capabilityBroker.execute.bind(f.bridge.capabilityBroker);
  let calls = 0;
  f.bridge.capabilityBroker.execute = async (taskId, request, options) => {
    calls++;
    if (calls === 2) return { allow: false, executionFailed: true, decision: { allow: false, kind: 'execution_failed', reason: 'fixture boom' } };
    return execute(taskId, request, options);
  };
  assert.equal((await f.bridge.invokeCapability(task.id, { name: 'git_status', input: { repo: '.' }, requestId: 'bridge-first-ok' })).status, 'completed');
  assert.equal((await f.bridge.invokeCapability(task.id, { name: 'git_diff', input: { repo: '.' }, requestId: 'bridge-second-fail' })).status, 'failed');
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs[0].state, 'completed');
  assert.equal(runs[0].result.request_id, 'bridge-first-ok');
  assert.equal(runs[1].state, 'failed');
  assert.equal(runs[1].result.request_id, 'bridge-second-fail');
  assert.equal(runs[1].result.completed, false);
});

test('5. missing invocation evidence fails closed without inventing success', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge missing evidence', { workspace: f.repo }).id);
  // Plant an unrelated successful latest request that must not be used.
  task.capabilityInvocations = {
    unrelated: { fingerprint: 'x', capability: 'git_status', toolCallId: 'orchestrator:' + require('node:crypto').randomUUID(), state: 'settled', runId: 'other-run', outcome: { status: 'completed' } }
  };
  task.latestMcpRequestId = 'unrelated';
  f.bridge.tasks.save(task);
  settleLease(f.bridge, task, {});
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'failed');
  assert.equal(runs[0].result.completed, false);
  assert.equal(runs[0].result.correlation, 'missing');
  assert.equal(runs[0].result.request_id, null);
});

test('6. cancellation settles the bound bridge run as cancelled', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge cancel', { workspace: f.repo }).id);
  settleLease(f.bridge, task, { requestId: 'bridge-cancel', outcomeStatus: 'completed', cancel: true });
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs[0].state, 'cancelled');
  assert.equal(runs[0].result.request_id, 'bridge-cancel');
  assert.equal(runs[0].result.correlation, 'run_bound');
});

test('7. unverified termination does not claim completed invocation evidence', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge unverified', { workspace: f.repo }).id);
  settleLease(f.bridge, task, { requestId: 'bridge-unverified', outcomeStatus: 'completed', verified: false });
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs[0].state, 'termination_unverified');
  assert.equal(runs[0].process_state, 'unknown');
  assert.equal(runs[0].result.request_id, 'bridge-unverified');
  assert.equal(runs[0].result.completed, true);
  assert.equal(runs[0].result.correlation, 'run_bound');
});

test('8. live status refresh binds the new lease run to the same request_id', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge refresh', {
    workspace: f.repo,
    capabilityScopes: ['repo', 'developer_environment', 'mac_local']
  }).id);
  const first = await f.bridge.invokeCapability(task.id, {
    name: 'service_status', input: {}, requestId: 'bridge-refresh'
  });
  assert.equal(first.status, 'completed');
  const second = await f.bridge.invokeCapability(task.id, {
    name: 'service_status', input: {}, requestId: 'bridge-refresh'
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.refreshed, true);
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs.length, 2);
  assert.ok(runs.every(r => r.result.request_id === 'bridge-refresh' && r.result.correlation === 'run_bound'));
  assert.ok(runs.every(r => r.state === 'completed'));
  assert.equal(task.capabilityInvocations['bridge-refresh'].runId, runs[1].id);
});

test('9. research profile uses the same run-bound settlement path', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge research settle', { workspace: f.repo }).id);
  task.mission.capabilityProfile = 'governed-browser-research-v1';
  f.bridge.tasks.save(task);
  settleLease(f.bridge, task, { requestId: 'bridge-research', outcomeStatus: 'completed', capability: 'browser_research' });
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs[0].state, 'completed');
  assert.equal(runs[0].result.invocation_only, true);
  assert.equal(runs[0].result.request_id, 'bridge-research');
  assert.equal(runs[0].result.correlation, 'run_bound');
});

test('10. settlement never fabricates native worker execution evidence', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge no worker evidence', { workspace: f.repo }).id);
  await f.bridge.invokeCapability(task.id, { name: 'git_status', input: { repo: '.' }, requestId: 'bridge-no-nee' });
  settleLease(f.bridge, task, { requestId: 'bridge-no-nee-2', outcomeStatus: 'failed' });
  for (const run of bridgeRuns(f.bridge, task.id)) {
    assert.equal(run.result.invocation_only, true);
    assert.equal(run.result.native_execution_evidence, undefined);
    assert.equal(run.process_state === 'not_started' || run.process_state === 'unknown', true);
  }
});

test('latestMcpRequestId cannot prove a different run completed', async t => {
  const f = await fixture(t);
  const task = f.bridge.tasks.get(f.bridge.createTask('Bridge no latest steal', { workspace: f.repo }).id);
  const lease = f.bridge.leases.acquire(task.id, { agentId: 'bridge' });
  task.capabilityInvocations = {
    older_failed: {
      fingerprint: 'a', capability: 'git_status', toolCallId: 'orchestrator:' + require('node:crypto').randomUUID(),
      state: 'settled', runId: lease.runId, outcome: { status: 'failed' }
    },
    newer_ok: {
      fingerprint: 'b', capability: 'git_status', toolCallId: 'orchestrator:' + require('node:crypto').randomUUID(),
      state: 'settled', runId: 'some-other-run', outcome: { status: 'completed' }
    }
  };
  task.latestMcpRequestId = 'newer_ok';
  f.bridge.tasks.save(task);
  f.bridge.leases.releaseIfOwner(lease, { verified: true });
  const runs = bridgeRuns(f.bridge, task.id);
  assert.equal(runs[0].state, 'failed');
  assert.equal(runs[0].result.request_id, 'older_failed');
  assert.equal(runs[0].result.completed, false);
  assert.equal(runs[0].result.correlation, 'run_bound');
});
