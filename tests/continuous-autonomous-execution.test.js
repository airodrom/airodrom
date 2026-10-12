'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');
const { flightRecorder } = require('../src/mission-flight-recorder');
const TestBridge = require('./fixtures/test-bridge.cjs');
const { SYNTHETIC_FIXTURE_DISPOSE } = TestBridge;

function native(f, extra = {}) {
  return f.create({
    objective: 'Synthetic CAE step ' + randomUUID(),
    task_type: 'local_files',
    manifest: manifest(f.repo),
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'beta\n' }]
    },
    ...extra
  });
}
function stage(m, id = 'one', deps = []) {
  return { id, depends_on: deps, mission_id: m?.id, objective: 'Synthetic bounded step', acceptance_criteria: ['Registered file criterion passes'], verification_requirements: ['Independent registered tests'], human_checkpoint: false };
}
function plan(f, stages) {
  const m = f.bridge.controlStore.listMissions()[0];
  return f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(), goal_id: m.goal_id, stages, max_runtime_hours: 1, max_attempts: 3
  });
}
function authorize(f, id, extra = {}) {
  return f.bridge.autonomousExecution.authorize(id, {
    request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 20, max_repairs: 3, confirmed: true, ...extra
  });
}
async function accept(f, missionId, tag) {
  const done = await f.settle(missionId);
  return f.bridge.missions.accept(missionId, {
    request_id: tag + '-accept', verification_id: done.verifications[0].id,
    decision: 'accept', rationale: 'Synthetic host verification reviewed'
  });
}

test('01 single authorized goal completes via durable scheduler', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  assert.equal(g.execution_enabled, false);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'one');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).autonomous.lifecycle, 'completed');
});

test('02 multi-stage dependency graph completes in order', async t => {
  const f = await fixture(t), a = native(f);
  const bs = stage(null, 'b', ['a']); delete bs.mission_id;
  const g = plan(f, [stage(a, 'a'), bs]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  await accept(f, a.id, 'a');
  const b = native(f, {
    objective: 'Second synthetic file', allowed_files: ['second.txt'],
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'second.txt', content: 'beta\n' }],
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      native_actions: [{ name: 'file_write', path: 'second.txt', content: 'beta\n' }]
    },
    manifest: (() => { const mf = manifest(f.repo); mf.mission.scope.include = ['second.txt']; return mf; })()
  });
  f.bridge.missions.goalPlanner.bind(g.id, 'b', b.id, 'bind-b');
  await f.bridge.autonomousExecution.tick();
  await accept(f, b.id, 'b');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('03 unverified dependency blocks autonomous dispatch', async t => {
  const f = await fixture(t), a = native(f), b = native(f), g = plan(f, [stage(a, 'a'), stage(b, 'b', ['a'])]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(b.id).n, 0);
  assert.throws(() => f.bridge.missions.dispatch(b.id, { request_id: 'early' }), /Goal dependency/);
});

test('04 human checkpoint blocks continuation until operator confirms', async t => {
  const f = await fixture(t), m = native(f), s = stage(m); s.human_checkpoint = true;
  const g = plan(f, [s]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 0);
  f.bridge.missions.goalPlanner.checkpoint(g.id, 'one', 'cp');
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'cp');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('05 ChatGPT disconnect does not stop an authorized goal', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  // Simulate client gone: clear conversation engine if present; scheduler still owns work.
  f.bridge.controlServer = { conversationEngine: { active: new Map() } };
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'client');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('06 Cursor exit / reopen continues durable authorized work', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  await f.reopen();
  f.ensureAdmission();
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).execution_enabled, true);
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'reopen');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('07 closed admission gate prevents autonomous dispatch', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  f.bridge.lifecycle.drain();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 0);
});

test('08 uncertain effects block retry and worker switch', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id, { workers: ['host', 'opencode'] });
  f.bridge.controlStore.db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'unknown',NULL,NULL,NULL,?,?)")
    .run(randomUUID(), m.id, m.task_id, Date.now(), Date.now());
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_autonomous_claims WHERE plan_id=?").get(g.id).n, 0);
  assert.throws(() => f.bridge.autonomousExecution.switchWorker(g.id, {
    request_id: randomUUID(), from_worker: 'host', to_worker: 'opencode', confirmed: true
  }), /Uncertain|dispatch|lease/i);
});

test('09 restart does not duplicate dispatched Missions', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  const first = f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n;
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, first);
  await f.reopen(); f.ensureAdmission();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, first);
});

test('10 two scheduler ticks cannot double-claim the same Mission', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  await Promise.all([f.bridge.autonomousExecution.tick(), f.bridge.autonomousExecution.tick()]);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 1);
});

test('11 expired authorization / plan budget stops scheduling', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  f.bridge.controlStore.db.prepare('UPDATE cp_mission_programs SET expires_at=0 WHERE id=?').run(g.id);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 0);
});

test('12 invalid worker switch is rejected; authorized switch preserves scope', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id, { workers: ['host'] });
  assert.throws(() => f.bridge.autonomousExecution.switchWorker(g.id, {
    request_id: randomUUID(), from_worker: 'host', to_worker: 'codex', confirmed: true
  }), /not authorized/);
  const switched = f.bridge.autonomousExecution.authorize(g.id, {
    request_id: randomUUID(), workers: ['host', 'opencode'], max_concurrent_missions: 1,
    max_dispatches: 20, max_repairs: 3, confirmed: true
  });
  assert.deepEqual(switched.autonomous.workers.sort(), ['host', 'opencode']);
  const ok = f.bridge.autonomousExecution.switchWorker(g.id, {
    request_id: randomUUID(), from_worker: 'host', to_worker: 'opencode', confirmed: true
  });
  assert.equal(ok.autonomous.worker_history.at(-1).to, 'opencode');
  assert.equal(ok.goal_id, g.goal_id);
});

test('13 pause and stop future scheduling; resume continues', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  f.bridge.autonomousExecution.pause(g.id, randomUUID());
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 0);
  f.bridge.autonomousExecution.resume(g.id, randomUUID());
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'resume');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('14 cancellation preserves writer ownership safety path', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  f.bridge.missions.goalPlanner.cancel(g.id, 'cancel-plan');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'cancelled');
  f.bridge.autonomousExecution.stop(g.id, randomUUID());
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).execution_enabled, false);
});

test('15 synthetic fixture disposal never counts as real termination', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  const receipt = f.bridge.disposeFixtureOwnership();
  assert.equal(receipt.real_termination_verified, false);
  assert.equal(receipt.resolution, SYNTHETIC_FIXTURE_DISPOSE);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n, 0);
});

test('16 goal completion requires authoritative evidence not forged terminal state', async t => {
  const f = await fixture(t), a = native(f), b = native(f), g = plan(f, [stage(a, 'a'), stage(b, 'b', ['a'])]);
  authorize(f, g.id);
  f.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='completed' WHERE id=?").run(a.id);
  assert.equal(f.bridge.missions.goalPlanner.verified(a.id), false);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(b.id).n, 0);
});

test('17 Flight Recorder records autonomous events without secrets', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'trace');
  f.bridge.controlStore.event('goal.autonomous.dispatched', m.id, { plan_id: g.id, prompt: 'PRIVATE_CANARY', credential: 'syn' });
  const trace = flightRecorder(f.bridge, { missionId: m.id });
  assert.ok(trace.events.some(e => e.event_type === 'goal.autonomous.authorized' || e.event_type === 'goal.autonomous.dispatched' || e.event_type === 'mission.settled'));
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_CANARY|credential/);
});

test('18 MCP client unavailability does not stop durable execution', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  // No MCP session attached; durable tick still dispatches.
  assert.equal(f.bridge.controlServer?.conversationEngine?.active?.size || 0, 0);
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'mcp');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('19 Mission Program dispatch authority cannot be bypassed', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  // Without authorize, scheduler must not dispatch.
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 0);
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).execution_enabled, false);
});

test('20 authorize requires explicit confirmation and rejects production mutation fields', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  assert.throws(() => f.bridge.autonomousExecution.authorize(g.id, {
    request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 10, max_repairs: 2, confirmed: false
  }), /confirmation/);
  assert.throws(() => f.bridge.autonomousExecution.authorize(g.id, {
    request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 10, max_repairs: 2, confirmed: true, production_mutation: true
  }), /Unexpected/);
});

test('21 pre-schema goal plans migrate safely (missing autonomous block)', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  const row = f.bridge.controlStore.db.prepare('SELECT goal_plan FROM cp_mission_programs WHERE id=?').get(g.id);
  const stored = JSON.parse(row.goal_plan);
  delete stored.autonomous;
  f.bridge.controlStore.db.prepare('UPDATE cp_mission_programs SET goal_plan=? WHERE id=?').run(JSON.stringify(stored), g.id);
  const view = f.bridge.autonomousExecution.inspect(g.id);
  assert.equal(view.autonomous.version, 1);
  assert.equal(view.execution_enabled, false);
});

test('22 control-plane autonomous actions are wired', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  const { controlPlaneWrite, controlPlaneRead } = require('../src/control-plane-api');
  const url = new URL('http://localhost/api/control-v2/autonomous-goals');
  assert.equal(controlPlaneRead(f.bridge, url).items.length >= 1, true);
  controlPlaneWrite(f.bridge, 'authorize-autonomous-goal', {
    id: g.id, request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 10, max_repairs: 2, confirmed: true
  });
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).execution_enabled, true);
});

test('23 clean production shutdown still refuses unverified work', async t => {
  const f = await fixture(t);
  f.bridge.lifecycle.resume(f.bridge.lifecycle.epoch);
  f.bridge.controlStore.startRun({ id: 'cae-alive', taskId: 't', agentId: 'host' });
  f.bridge.controlStore.updateRun('cae-alive', { state: 'running', processState: 'alive', verified: false });
  await assert.rejects(() => f.bridge.productionShutdown(), /unverified|writer lock retained/i);
  f.bridge.shutdownPromise = null;
  f.bridge.closed = false;
});

test('24 scheduler fairness: one blocked plan does not prevent another', async t => {
  const f = await fixture(t);
  const a = native(f), blocked = plan(f, [stage(a, 'a')]);
  authorize(f, blocked.id);
  f.bridge.controlStore.db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'unknown',NULL,NULL,NULL,?,?)")
    .run(randomUUID(), a.id, a.task_id, Date.now(), Date.now());
  const b = native(f, { objective: 'Independent synthetic goal mission ' + randomUUID() });
  // Second plan on same goal — bind fresh mission
  const g2 = plan(f, [stage(b, 'solo')]);
  authorize(f, g2.id);
  await f.bridge.autonomousExecution.tick();
  assert.ok(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(b.id).n >= 1);
});

test('25 repair budget exhaustion reaches blocked lifecycle without infinite retry', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id, { max_repairs: 1, max_dispatches: 5 });
  await f.bridge.autonomousExecution.tick();
  f.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='needs_rework' WHERE id=?").run(m.id);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).autonomous.repair_counts.one, 1);
  f.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='ready' WHERE id=?").run(m.id);
  f.bridge.controlStore.db.prepare("UPDATE cp_dispatches SET state='cancelled' WHERE mission_id=?").run(m.id);
  f.bridge.controlStore.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=?").run(g.id);
  // Repair budget already consumed while mission still looks recoverable — eligibleStage blocks.
  const view = f.bridge.autonomousExecution.inspect(g.id);
  assert.equal(view.autonomous.repair_counts.one >= 1, true);
  await f.bridge.autonomousExecution.tick();
  // Only the first dispatch should exist; no further autonomous claim after repair budget.
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_autonomous_claims WHERE plan_id=? AND state='dispatched'").get(g.id).n, 0);
});

test('26 memory revocation invalidates future goal context retrieval', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  f.bridge.personalMemory.remember({
    domain: 'project', projectId: m.project_id, type: 'fact', subject: 'cae-context',
    content: 'Synthetic authorized context for continuity', source: 'user_explicit', sensitivity: 'normal'
  });
  const task = f.bridge.tasks.get(m.task_id);
  task.mission.authorityRevoked = true;
  f.bridge.tasks.save(task);
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).stages[0].reason, 'authority_unavailable');
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 0);
  const cont = f.bridge.missions.goalPlanner.continue(g.id, randomUUID());
  assert.equal(cont.contexts.length, 0);
});

test('27 reboot recovery preserves goal and Mission identity', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  const before = { plan: g.id, mission: m.id, goal: g.goal_id };
  await f.reopen();
  f.ensureAdmission();
  const after = f.bridge.autonomousExecution.inspect(before.plan);
  assert.equal(after.id, before.plan);
  assert.equal(after.goal_id, before.goal);
  assert.equal(after.stages[0].mission_id, before.mission);
  assert.equal(after.execution_enabled, true);
  // recover() runs first; monitor may immediately dispatch eligible work.
  assert.ok(['recovered', 'dispatched'].includes(after.autonomous.last_action), after.autonomous.last_action);
});

test('28 dispatch budget exhaustion stops scheduling', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id, { max_dispatches: 1 });
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).autonomous.dispatch_count, 1);
  // Force another ready mission path after settling claim without completing verification.
  f.bridge.controlStore.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=?").run(g.id);
  f.bridge.controlStore.db.prepare("UPDATE cp_dispatches SET state='cancelled' WHERE mission_id=?").run(m.id);
  f.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='ready' WHERE id=?").run(m.id);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(m.id).n, 1);
});
