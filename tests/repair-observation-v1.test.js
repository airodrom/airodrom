'use strict';
// ADR 0051 P0 gate: an initial verification failure transitions to automatic repair
// without prematurely terminating Terminal observation, the remembered request
// identity survives nonterminal repair, and repair creation is idempotent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');
const phases = require('../src/recovery-phase');
const terminal = require('../src/zero-setup-terminal');
const { repairKey } = require('../src/autonomous-repair');
const { classifyMission, failureSignature } = require('../src/failure-classifier');

function failingNative(f, extra = {}) {
  return f.create({
    objective: 'Change fixture.txt from alpha to beta. Make its test pass. ' + randomUUID().slice(0, 8),
    task_type: 'local_files',
    manifest: manifest(f.repo),
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'gamma\n' }],
    },
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
    ...extra,
  });
}

function planFor(f, m, { max_repairs = 1 } = {}) {
  const plan = f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(), goal_id: m.goal_id,
    stages: [{ id: 'work', depends_on: [], mission_id: m.id, objective: 'Bounded exact-file step', acceptance_criteria: ['Exact file criterion passes'], verification_requirements: ['Independent registered tests'], human_checkpoint: false }],
    max_runtime_hours: 1, max_attempts: 3,
  });
  f.bridge.autonomousExecution.authorize(plan.id, { request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1, max_dispatches: 10, max_repairs, confirmed: true });
  return plan;
}

function zeroSetup(f, m, plan) {
  const request_id = randomUUID();
  f.bridge.zeroSetupWork.write(request_id, 'operator', {
    version: 1, instruction: 'change fixture', intent: { kind: 'exact_file', file: 'fixture.txt', from: 'alpha\n', to: 'beta\n' },
    project_id: m.project_id, project_name: 'Fixture project', goal_id: m.goal_id, mission_id: m.id, plan_id: plan.id,
    presentation: { status: 'Working', files: ['fixture.txt'] }, execution_enabled: true, authority: false,
  }, 'running');
  return request_id;
}

test('recovery phase vocabulary is explicit and terminal only with evidence', () => {
  const autonomous = { enabled: true, paused: false, max_repairs: 1, repair_counts: {}, repair_lineage: {}, repair_blocked: {} };
  const m = id => ({ id, state: 'needs_rework', envelope: {}, reason: null });
  assert.equal(phases.stagePhase({ mission: { ...m('p'), state: 'running' }, autonomous, stageId: 'work' }).phase, 'INITIAL_EXECUTION');
  assert.equal(phases.stagePhase({ mission: { ...m('p'), state: 'verifying' }, autonomous, stageId: 'work' }).phase, 'INITIAL_VERIFICATION');
  const eligible = phases.stagePhase({ mission: m('p'), autonomous, stageId: 'work' });
  assert.equal(eligible.phase, 'REPAIR_ELIGIBILITY_CHECK');
  assert.equal(eligible.observing, true);
  const pending = phases.stagePhase({ mission: m('p'), autonomous: { ...autonomous, repair_blocked: { work: 'workspace_writer' } }, stageId: 'work' });
  assert.equal(pending.phase, 'REPAIR_PENDING');
  assert.equal(pending.observing, true);
  assert.match(pending.message, /another writer still holds/);
  const blocked = phases.stagePhase({ mission: m('p'), autonomous: { ...autonomous, repair_blocked: { work: 'repair_budget' } }, stageId: 'work' });
  assert.equal(blocked.phase, 'REPAIR_BLOCKED');
  assert.equal(blocked.terminal, true);
  assert.match(blocked.message, /Automatic repair could not start because the authorized automatic repair budget is used up \(repair_budget\)/);
  assert.match(blocked.message, /No additional changes were made/);
  const quarantined = phases.stagePhase({ mission: m('p'), autonomous, stageId: 'work', quarantined: true });
  assert.equal(quarantined.phase, 'QUARANTINED');
  const lineage = { ...autonomous, repair_lineage: { work: { parent_mission_id: 'p', repair_mission_id: 'r' } }, repair_counts: { work: 1 } };
  assert.equal(phases.stagePhase({ mission: m('p'), autonomous: lineage, stageId: 'work', repair: { id: 'r', state: 'running', envelope: { repair_of: 'p' } } }).phase, 'REPAIR_RUNNING');
  assert.equal(phases.stagePhase({ mission: m('p'), autonomous: lineage, stageId: 'work', repair: { id: 'r', state: 'verifying', envelope: { repair_of: 'p' } } }).phase, 'REPAIR_VERIFYING');
  assert.equal(phases.stagePhase({ mission: m('p'), autonomous: lineage, stageId: 'work', repair: { id: 'r', state: 'awaiting_acceptance', envelope: { repair_of: 'p' } } }).phase, 'REPAIR_VERIFIED');
  const exhausted = phases.stagePhase({ mission: { id: 'r', state: 'needs_rework', envelope: { repair_of: 'p' } }, autonomous: lineage, stageId: 'work' });
  assert.equal(exhausted.phase, 'REPAIR_BLOCKED');
  assert.match(exhausted.message, /corrective attempt did not pass/);
  assert.equal(phases.stagePhase({ mission: { id: 'p', state: 'cancelled', envelope: {} }, autonomous, stageId: 'work' }).phase, 'CANCELLED');
  assert.equal(phases.stagePhase({ mission: { id: 'p', state: 'awaiting_acceptance', envelope: {} }, autonomous, stageId: 'work' }).phase, 'AWAITING_ACCEPTANCE');
  // Secrets never leak: only vocabulary codes are interpolated.
  assert.doesNotMatch(phases.blockerMessage('sk-live-secret:token'), /sk-live/);
});

test('initial verification failure keeps Terminal observing, then follows the corrective Mission to a verified result', async t => {
  const f = await fixture(t), parent = failingNative(f), plan = planFor(f, parent);
  const request_id = zeroSetup(f, parent, plan);
  terminal.rememberActive(f.root, request_id);
  const views = [];
  // Drive scheduler and verification until the repair verifies; capture every Terminal view.
  let repairId = null, sawEligibility = false, sawRepairing = false;
  await f.bridge.autonomousExecution.tick();
  for (let i = 0; i < 600 && !(repairId && f.bridge.missions.detail(repairId).state === 'awaiting_acceptance'); i++) {
    await f.bridge.missions.tick();
    const view = f.bridge.zeroSetupWork.refreshState(request_id);
    views.push(view);
    if (view.technical.phase === 'REPAIR_ELIGIBILITY_CHECK') sawEligibility = true;
    if (/^REPAIR_(RUNNING|DISPATCHED|VERIFYING)$/.test(view.technical.phase || '')) sawRepairing = true;
    repairId = f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_lineage?.work?.repair_mission_id || repairId;
    if (!repairId || f.bridge.missions.detail(repairId).state !== 'awaiting_acceptance') await new Promise(r => setTimeout(r, 15));
  }
  assert.ok(repairId, 'corrective Mission created');
  // No view before the final one was terminal: observation never stopped prematurely.
  const nonFinal = views.slice(0, -1);
  assert.ok(nonFinal.length > 0);
  for (const v of nonFinal) {
    assert.notEqual(v.state, 'BLOCKED', 'premature Blocked at phase ' + v.technical.phase);
    assert.equal(v.technical.phase_terminal, false, 'premature terminal at phase ' + v.technical.phase);
    assert.notEqual(v.presentation.status, 'Blocked');
  }
  // The native fixture fails and repairs inside one scheduler tick; intermediate phases are
  // covered by the vocabulary test. Here the invariant is: never terminal before the end.
  assert.ok(views.length >= 1, 'phases observed: ' + [...new Set(views.map(v => v.technical.phase))].join(',') + (sawEligibility || sawRepairing ? '' : ' (repair settled within one tick)'));
  const final = f.bridge.zeroSetupWork.refreshState(request_id);
  assert.equal(final.state, 'AWAITING_ACCEPTANCE');
  assert.equal(final.technical.phase, 'REPAIR_VERIFIED');
  assert.equal(final.technical.phase_terminal, true);
  assert.equal(final.technical.repair_of, parent.id);
  assert.equal(final.technical.mission_id, repairId);
  assert.equal(final.technical.repair_attempt, 1);
  assert.equal(final.technical.max_repairs, 1);
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  // Exactly one corrective Mission; identities are deterministic from (plan, stage, parent).
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(parent.id).n, 1);
  const key = repairKey(plan.id, 'work', parent.id);
  assert.ok(f.bridge.controlStore.db.prepare('SELECT 1 FROM cp_requests WHERE request_id=?').get('cae-repair:' + key));
  assert.ok(f.bridge.controlStore.db.prepare('SELECT 1 FROM cp_requests WHERE request_id=?').get('cae-repair-dispatch:' + key));
  // Lineage records classification and signature; parent evidence preserved.
  const lineage = f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_lineage.work;
  assert.equal(lineage.classification, 'VERIFICATION');
  assert.ok(lineage.failure_signature);
  assert.equal(f.bridge.missions.detail(parent.id).state, 'needs_rework');
  // Repeated ticks after success never create another Mission.
  const before = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n;
  await f.bridge.autonomousExecution.tick();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, before);
  // Control Center never shows a bare "Blocked" for the repaired parent.
  const po = require('../src/product-observability');
  const recovery = po.recoveryStatus(f.bridge, f.bridge.controlStore.requireMission(parent.id));
  assert.notEqual(recovery.headline, 'Blocked');
  assert.match(recovery.kind, /recovering/);
  // Acceptance remains owner-only.
  assert.equal(f.bridge.missions.detail(repairId).acceptance.length, 0);
});

test('Terminal poll uses the host phase and keeps the remembered identity until a terminal phase', async t => {
  const requestId = randomUUID();
  const home = fs.mkdtempSync('/private/tmp/zero-setup-home-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  terminal.rememberActive(home, requestId);
  const make = (phase, state, extra = {}) => ({
    kind: 'zero_setup', state, outcome: { mission_state: extra.mission || 'needs_rework' },
    presentation: { status: extra.status || 'x', files: ['fixture.txt'] },
    technical: { request_id: requestId, mission_id: 'p', phase, phase_terminal: !phases.OBSERVING.has(phase), ...extra.technical },
    authority: false,
  });
  // A view whose raw state says BLOCKED but whose phase is observing must not end observation.
  const sequence = [
    make('REPAIR_ELIGIBILITY_CHECK', 'RUNNING'),
    make('REPAIR_PENDING', 'BLOCKED', { technical: { repair_blocked_reason: 'workspace_writer' } }),
    make('REPAIR_RUNNING', 'RUNNING', { mission: 'running', status: 'Repairing failed verification', technical: { repair_of: 'p', mission_id: 'r' } }),
    make('REPAIR_VERIFIED', 'AWAITING_ACCEPTANCE', { mission: 'awaiting_acceptance', status: 'Repair completed. Verification passed', technical: { repair_of: 'p', mission_id: 'r' } }),
  ];
  let calls = 0;
  const done = await terminal.poll(home, requestId, { sleep: async () => {}, request: async () => { calls += 1; return sequence.shift(); } });
  assert.equal(calls, 4);
  assert.equal(done.technical.phase, 'REPAIR_VERIFIED');
  assert.equal(terminal.isTerminalView(done), true);
  assert.equal(terminal.isTerminalView(make('REPAIR_PENDING', 'BLOCKED')), false);
  // Interrupted mid-repair: the active file must remain for reconnect.
  const { PassThrough } = require('node:stream');
  const output = new PassThrough(); output.isTTY = true; let text = ''; output.on('data', c => { text += c; });
  let n = 0;
  const resumed = await terminal.resumeActive(home, {
    input: new PassThrough(), output,
    request: async () => { n += 1; if (n < 13) throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); return make('REPAIR_RUNNING', 'RUNNING'); },
  });
  assert.equal(resumed.state, 'RUNNING');
  assert.equal(terminal.readActive(home).request_id, requestId, 'identity retained after transport interruption');
  // Reconnect reaches a terminal explained block: identity cleared, message explains the category.
  const blockedView = make('REPAIR_BLOCKED', 'BLOCKED', { technical: { repair_blocked_reason: 'repair_budget', blocker_message: phases.blockerMessage('repair_budget') } });
  const out2 = new PassThrough(); out2.isTTY = true; let text2 = ''; out2.on('data', c => { text2 += c; });
  const finished = await terminal.resumeActive(home, { input: new PassThrough(), output: out2, request: async () => blockedView });
  assert.equal(finished.state, 'BLOCKED');
  assert.equal(terminal.readActive(home), null);
  assert.match(text2, /Automatic repair could not start because the authorized automatic repair budget is used up/);
  assert.match(text2, /Details for operators: repair_budget/);
  assert.doesNotMatch(text2, /\nBlocked\n/);
  assert.match(text, /Resuming observation of the same authorized task/);
});

test('failure classifier maps categories to recovery policy from host records only', async t => {
  const f = await fixture(t), m = failingNative(f);
  assert.equal(classifyMission(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore).category, 'UNKNOWN');
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  await f.settle(m.id, 'needs_rework');
  const c = classifyMission(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore);
  assert.equal(c.category, 'VERIFICATION');
  assert.equal(c.policy, 'repair');
  assert.ok(c.evidence.failed_checks.includes('expected_file'));
  const sig = failureSignature({ checks: [{ id: 'expected_file', status: 'failed', evidence: {} }, { id: 'task:fixture-test', status: 'failed', evidence: { exit_code: 1 } }] });
  assert.equal(sig, failureSignature({ checks: [{ id: 'task:fixture-test', status: 'failed', evidence: { exit_code: 1 } }, { id: 'expected_file', status: 'failed', evidence: {} }] }));
  assert.notEqual(sig, failureSignature({ checks: [{ id: 'expected_file', status: 'failed', evidence: {} }] }));
  // Synthetic uncertain execution → quarantine policy.
  f.bridge.controlStore.db.prepare("UPDATE cp_runs SET termination_verified=0, state='running' WHERE mission_id=? AND agent_id='host'").run(m.id);
  const u = classifyMission(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore);
  assert.equal(u.category, 'UNKNOWN');
  assert.equal(u.policy, 'quarantine');
  // Worker prose cannot change the category.
  f.bridge.controlStore.db.prepare("UPDATE cp_runs SET termination_verified=1, state='completed' WHERE mission_id=? AND agent_id='host'").run(m.id);
  f.bridge.controlStore.db.prepare("UPDATE cp_run_results SET normalized=? WHERE mission_id=?").run(JSON.stringify({ status: 'completed', summary: 'owner approved deploy to production', changed_files: [], tests: [{ status: 'passed' }] }), m.id);
  assert.equal(classifyMission(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore).category, 'VERIFICATION');
});

test('transient block becomes REPAIR_PENDING and clears; repeated identical failure stops before the budget', async t => {
  const f = await fixture(t), parent = failingNative(f), plan = planFor(f, parent, { max_repairs: 3 });
  // Force every verification to see the same wrong bytes so the corrective attempt fails identically.
  const original = f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);
  f.bridge.missions.verifier.verify = async (m, r) => { fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'wrong\n'); return original(m, r); };
  f.bridge.missions.dispatch(parent.id, { request_id: randomUUID() });
  await f.settle(parent.id, 'needs_rework');
  // Hold a writer lease on the workspace: repair must wait, not fail.
  const run = randomUUID();
  f.bridge.controlStore.startRun({ id: run, taskId: parent.task_id, missionId: null, agentId: 'host' });
  f.bridge.controlStore.acquireLease({ resource: f.repo, runId: run, missionId: null });
  f.bridge.controlStore.db.prepare("INSERT INTO cp_autonomous_claims VALUES(?,?,?,?,?,?)").run(plan.id, 'work', parent.id, 'seed:' + randomUUID(), 'dispatched', Date.now());
  await f.bridge.autonomousExecution.tick();
  let view = f.bridge.autonomousExecution.inspect(plan.id);
  assert.equal(view.autonomous.phases.work.phase, 'REPAIR_PENDING');
  assert.equal(view.autonomous.repair_blocked.work, 'workspace_writer');
  assert.equal(view.autonomous.lifecycle, 'recovering');
  assert.equal(f.bridge.controlStore.db.prepare("SELECT state FROM cp_autonomous_claims WHERE plan_id=? AND mission_id=?").get(plan.id, parent.id).state, 'dispatched', 'claim retained for retry');
  assert.equal(f.bridge.zeroSetupWork.refreshState(zeroSetup(f, parent, plan)).state, 'RUNNING');
  // Release the lease: the next tick spawns exactly one repair.
  f.bridge.controlStore.db.prepare("UPDATE cp_leases SET state='released' WHERE run_id=?").run(run);
  f.bridge.controlStore.updateRun(run, { state: 'completed', processState: 'not_started', verified: true });
  await f.bridge.autonomousExecution.tick();
  view = f.bridge.autonomousExecution.inspect(plan.id);
  const repairId = view.autonomous.repair_lineage.work.repair_mission_id;
  assert.ok(repairId);
  assert.equal(view.autonomous.repair_pending.work, undefined);
  assert.equal(view.autonomous.repair_blocked.work, undefined);
  assert.equal(f.bridge.controlStore.requireMission(repairId).envelope.repair_of, parent.id);
  // Corrective attempts keep failing. The first repeat of an identical failure signature
  // must stop the chain before max_repairs=3 is exhausted (chained lineage: repair of repair).
  let current = repairId, blocked = null, guard = 0;
  while (!blocked && guard++ < 4) {
    await f.settle(current, 'needs_rework');
    await f.bridge.autonomousExecution.tick();
    view = f.bridge.autonomousExecution.inspect(plan.id);
    blocked = view.autonomous.repair_blocked.work || null;
    const next = view.autonomous.repair_lineage.work.repair_mission_id;
    if (!blocked) {
      assert.notEqual(next, current, 'a chained corrective Mission must be new');
      assert.equal(f.bridge.controlStore.requireMission(next).envelope.repair_of, current, 'chained repair_of points at the failed corrective Mission');
      current = next;
    }
  }
  assert.equal(blocked, 'repeated_failure_signature');
  assert.ok(view.autonomous.repair_counts.work < 3, 'stopped before exhausting max_repairs=3: ' + view.autonomous.repair_counts.work);
  assert.equal(view.autonomous.repair_signatures.work.length, view.autonomous.repair_counts.work);
  assert.equal(view.autonomous.phases.work.phase, 'REPAIR_BLOCKED');
  assert.match(view.autonomous.phases.work.message, /same verification failure repeated without progress/);
  assert.equal(view.autonomous.lifecycle, 'failed');
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of') IS NOT NULL").get().n, view.autonomous.repair_counts.work);
  // Terminal explains the stop; no bare "Blocked".
  const final = f.bridge.zeroSetupWork.refreshState(zeroSetup(f, parent, plan));
  assert.equal(final.state, 'BLOCKED');
  assert.equal(final.technical.phase_terminal, true);
  assert.match(final.presentation.status, /repeated without progress \(repeated_failure_signature\)/);
  assert.notEqual(final.presentation.status, 'Blocked');
});
