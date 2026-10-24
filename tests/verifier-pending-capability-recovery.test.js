'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture, createReadMission } = require('./fixtures/read-mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { capabilityRequestId, capabilityDeadline } = require('../src/mission-verifier');
const repair = require('../src/autonomous-repair');

function wrapPending(bridge, { names = null, settleMs = 80, exitCode = 0, forever = false, deny = false } = {}) {
  const real = bridge.invokeCapability.bind(bridge);
  const started = new Map();
  const matchedRequestIds = [];
  let calls = 0;
  const matched = request => names.has(request.name) || (request.name === 'vscode_run_task' && names.has(request.input?.label));
  bridge.invokeCapability = async (taskId, request) => {
    calls++;
    if (!names || !matched(request)) return real(taskId, request);
    matchedRequestIds.push(request.requestId);
    if (deny) return { status: 'denied', request_id: request.requestId, decision: { reason: 'fixture_denied' } };
    if (!started.has(request.requestId)) {
      let resolve;
      const done = new Promise(r => { resolve = r; }).finally(() => bridge.orchestrator.inflight.delete(request.requestId));
      started.set(request.requestId, { done, resolve, input: request.input, name: request.name });
      if (!forever) {
        bridge.orchestrator.inflight.set(request.requestId, done);
        setTimeout(() => {
          if (request.name === 'vscode_run_task') {
            resolve({ status: 'completed', request_id: request.requestId, result: { exit_code: exitCode, timed_out: false, output: exitCode ? 'fixture fail' : 'ok' } });
          } else {
            real(taskId, request).then(resolve, error => resolve({ status: 'failed', request_id: request.requestId, decision: { reason: String(error.message || error) } }));
          }
        }, settleMs).unref?.();
      }
      return { status: 'pending', request_id: request.requestId, next: 'recover' };
    }
    const entry = started.get(request.requestId);
    assert.deepEqual(request.input, entry.input);
    assert.equal(request.name, entry.name);
    if (forever) return { status: 'pending', request_id: request.requestId, next: 'recover' };
    return entry.done;
  };
  return {
    started,
    matchedRequestIds,
    calls: () => calls,
    executions: () => started.size,
    restore: () => { bridge.invokeCapability = real; }
  };
}

async function verificationFixture(t) {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missions.verifier.recoveryWaitMs = 20;
  f.bridge.missions.verifier.defaultCapabilityBudgetMs = 2_000;
  return f;
}

function repairsOf(f, parentId) {
  return f.bridge.controlStore.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").all(parentId);
}

test('stable request identity and deadline helpers stay deterministic', () => {
  const a = capabilityRequestId('run-1', 'vscode_run_task', { repo: '/tmp/x', label: 'fixture-test', timeoutSeconds: 60 });
  const b = capabilityRequestId('run-1', 'vscode_run_task', { timeoutSeconds: 60, label: 'fixture-test', repo: '/tmp/x' });
  const c = capabilityRequestId('run-1', 'vscode_run_task', { repo: '/tmp/x', label: 'other', timeoutSeconds: 60 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^verify:run-1:vscode_run_task:[0-9a-f]{32}$/);
  const now = 1_000_000;
  assert.equal(capabilityDeadline({ envelope: {} }, { timeoutSeconds: 2 }, { now, defaultBudgetMs: 60_000 }), now + 2_000 + 1_000);
  assert.equal(capabilityDeadline({ envelope: { authority: { expiresAt: now + 500 } } }, { timeoutSeconds: 60 }, { now }), now + 500);
});

test('pending capability that later completes with exit 0 continues host verification', async t => {
  const f = await verificationFixture(t);
  const wrap = wrapPending(f.bridge, { names: new Set(['fixture-test']), settleMs: 60, exitCode: 0 });
  t.after(wrap.restore);
  const m = createReadMission(f);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const done = await f.settle(m.id);
  assert.equal(done.state, 'awaiting_acceptance');
  assert.ok(['passed', 'operator_review'].includes(done.verifications[0].result));
  const taskCheck = done.verifications[0].evidence.find(c => c.id === 'task:fixture-test');
  assert.equal(taskCheck.status, 'passed');
  assert.equal(wrap.executions(), 1);
  assert.ok(wrap.matchedRequestIds.length >= 1);
  assert.equal(new Set(wrap.matchedRequestIds).size, 1);
});

test('pending capability that later completes with nonzero exit records a failed registered check', async t => {
  const f = await verificationFixture(t);
  const wrap = wrapPending(f.bridge, { names: new Set(['fixture-test']), settleMs: 60, exitCode: 1 });
  t.after(wrap.restore);
  const m = createReadMission(f);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const failed = await f.settle(m.id, 'needs_rework');
  assert.equal(failed.verifications[0].result, 'failed');
  const taskCheck = failed.verifications[0].evidence.find(c => c.id === 'task:fixture-test');
  assert.equal(taskCheck.status, 'failed');
  assert.equal(taskCheck.evidence.exit_code, 1);
  assert.equal(wrap.executions(), 1);
  assert.equal(new Set(wrap.matchedRequestIds).size, 1);
});

test('capability that remains pending past the authorized deadline stays unavailable', async t => {
  const f = await verificationFixture(t);
  f.bridge.missions.verifier.defaultCapabilityBudgetMs = 120;
  f.bridge.missions.verifier.recoveryWaitMs = 15;
  const wrap = wrapPending(f.bridge, { names: new Set(['git_status']), forever: true });
  t.after(wrap.restore);
  const m = createReadMission(f);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const failed = await f.settle(m.id, 'needs_rework');
  assert.equal(failed.verifications[0].result, 'unavailable');
  const available = failed.verifications[0].evidence.find(c => c.id === 'verification_available');
  assert.equal(available.status, 'unavailable');
  assert.match(available.evidence.reason, /pending deadline exceeded/);
  assert.match(available.evidence.reason, /verify:/);
  assert.equal(wrap.executions(), 1);
  assert.equal(repairsOf(f, m.id).length, 0);
});

test('repeated pending responses recover one underlying capability execution', async t => {
  const f = await verificationFixture(t);
  const wrap = wrapPending(f.bridge, { names: new Set(['fixture-test']), settleMs: 150, exitCode: 0 });
  t.after(wrap.restore);
  const m = createReadMission(f);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  await f.settle(m.id);
  assert.equal(wrap.executions(), 1);
  assert.equal(new Set(wrap.matchedRequestIds).size, 1);
  assert.ok(wrap.matchedRequestIds.length >= 1);
});

test('denied capability fails closed without inventing a completed check', async t => {
  const f = await verificationFixture(t);
  const wrap = wrapPending(f.bridge, { names: new Set(['git_status']), deny: true });
  t.after(wrap.restore);
  const m = createReadMission(f);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const failed = await f.settle(m.id, 'needs_rework');
  assert.equal(failed.verifications[0].result, 'unavailable');
  const available = failed.verifications[0].evidence.find(c => c.id === 'verification_available');
  assert.match(available.evidence.reason, /denied/);
  assert.equal(failed.verifications[0].evidence.some(c => c.id === 'task:fixture-test'), false);
});

test('cancelled task stops pending recovery without a second execution', async t => {
  const f = await verificationFixture(t);
  f.bridge.missions.verifier.defaultCapabilityBudgetMs = 1_000;
  f.bridge.missions.verifier.recoveryWaitMs = 20;
  const wrap = wrapPending(f.bridge, { names: new Set(['git_status']), forever: true });
  const pendingInvoke = f.bridge.invokeCapability;
  f.bridge.invokeCapability = async (taskId, request) => {
    const response = await pendingInvoke(taskId, request);
    if (request.name === 'git_status' && response.status === 'pending') {
      f.bridge.tasks.get(taskId).cancelRequested = true;
    }
    return response;
  };
  t.after(wrap.restore);
  const m = createReadMission(f);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const failed = await f.settle(m.id, 'needs_rework');
  assert.equal(failed.verifications[0].result, 'unavailable');
  assert.match(failed.verifications[0].evidence.find(c => c.id === 'verification_available').evidence.reason, /cancelled/);
  assert.equal(wrap.executions(), 1);
});

test('controlled registered verification failure dispatches one separate authorized Cursor correction', async t => {
  const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:1,manual:true});
  f.plan=f.plan.slice(0,1);f.wrongFirst=true;
  const p=await f.ask({review:false}),m=await f.settle(p.mission_id),attempts=m.specialists.assignments[0].attempts;
  assert.equal(attempts.length,2);assert.notEqual(attempts[0].run_id,attempts[1].run_id);
  assert.equal(attempts[0].verification.status,'failed');assert.equal(attempts[1].verification.status,'passed');
  assert.equal(m.specialists.repair_attempts,1);assert.equal(f.calls.length,2);assert.equal(m.acceptance.length,0);
  assert.equal(f.bridge.controlStore.listMissions().length,1);
});

test('unavailable verification never authorizes another Cursor implementation', async t => {
  const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:1,manual:true});f.plan=f.plan.slice(0,1);
  f.bridge.missions.verifier.defaultCapabilityBudgetMs=120;f.bridge.missions.verifier.recoveryWaitMs=15;
  const wrap=wrapPending(f.bridge,{names:new Set(['git_status']),deny:true});t.after(wrap.restore);
  const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'needs_rework');
  assert.equal(m.specialists.assignments[0].attempts[0].verification.status,'unavailable');
  assert.equal(m.specialists.repair_attempts,0);assert.equal(f.calls.length,1);assert.equal(m.acceptance.length,0);
  const considered=repair.considerVerifiedRepair(f.bridge,m.id);assert.equal(considered.action,'skipped');
  assert.equal(repairsOf(f,m.id).length,0);
});
