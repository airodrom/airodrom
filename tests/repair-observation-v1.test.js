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
const {completeHistoricalNative}=require('./fixtures/historical-native-fixture.cjs');
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

test('Terminal observes the same Mission through separate Cursor correction until Acceptance',async t=>{
 const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:1});f.plan=f.plan.slice(0,1);f.wrongFirst=true;
 const p=await f.ask({review:false});terminal.rememberActive(f.root,p.request_id);const views=[];
 const done=await terminal.poll(f.root,p.request_id,{request:async()=>f.bridge.zeroSetupWork.refreshState(p.request_id),sleep:()=>new Promise(r=>setTimeout(r,100)),onUpdate:v=>views.push(v)});
 assert.equal(done.state,'ACCEPTED');assert.ok(views.some(v=>['RUNNING','VERIFYING','DISPATCHED'].includes(v.state)));assert.ok(views.every(v=>v.mission_id===p.mission_id));
 const m=f.bridge.missions.detail(p.mission_id);assert.equal(m.specialists.assignments[0].attempts.length,2);assert.equal(m.specialists.repair_attempts,1);assert.equal(m.acceptance.length,1);assert.equal(f.calls.length,2);
 assert.equal(f.bridge.controlStore.listMissions().length,1);assert.equal(fs.readFileSync(path.join(m.envelope.workspace,'fixture.txt'),'utf8'),'beta\n');
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
  await completeHistoricalNative(f,m);
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

test('historical repair remains blocked after a writer is released when current implementation policy forbids its route',async t=>{
 const f=await fixture(t),m=failingNative(f),plan=planFor(f,m,{max_repairs:3});await completeHistoricalNative(f,m);await f.settle(m.id,'needs_rework');
 const run=randomUUID();f.bridge.controlStore.startRun({id:run,taskId:m.task_id,missionId:null,agentId:'host'});f.bridge.controlStore.acquireLease({resource:f.repo,runId:run,missionId:null});
 f.bridge.controlStore.db.prepare('INSERT OR IGNORE INTO cp_autonomous_claims VALUES(?,?,?,?,?,?)').run(plan.id,'work',m.id,'seed:'+randomUUID(),'dispatched',Date.now());
 await f.bridge.autonomousExecution.tick();const pending=f.bridge.autonomousExecution.inspect(plan.id);assert.equal(pending.autonomous.repair_blocked.work,'workspace_writer');
 f.bridge.controlStore.updateRun(run,{state:'completed',processState:'not_started',verified:true});await f.bridge.autonomousExecution.tick();
 const blocked=f.bridge.autonomousExecution.inspect(plan.id);assert.match(blocked.autonomous.repair_blocked.work,/CURSOR_IMPLEMENTATION_REQUIRED/);assert.equal(blocked.autonomous.repair_lineage?.work?.repair_mission_id||null,null);
 assert.equal(phases.classifyReason(blocked.autonomous.repair_blocked.work).kind,'permanent');
 assert.equal(blocked.autonomous.repair_pending?.work,undefined);await f.bridge.autonomousExecution.tick();
 assert.equal(f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_pending?.work,undefined);
 assert.equal(f.bridge.controlStore.listMissions().length,1);assert.equal(f.bridge.missions.detail(m.id).acceptance.length,0);
});
