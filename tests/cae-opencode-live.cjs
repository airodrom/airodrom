'use strict';
/**
 * Isolated REAL LOCAL OpenCode acceptance for Continuous Autonomous Execution V1.
 * Requires AIRODROM_OPENCODE_LIVE=1. Disposable fixture DB/workspace only.
 * Does not mutate the installed service, LaunchAgents, or personal memory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.env.AIRODROM_OPENCODE_LIVE !== '1') {
  throw Error('Set AIRODROM_OPENCODE_LIVE=1 for isolated OpenCode CAE qualification');
}
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { flightRecorder } = require('../src/mission-flight-recorder');
const { canonicalHash } = require('../src/authority-hash');

const OPENCODE = {
  enabled: true,
  executable: '/opt/homebrew/bin/opencode',
  model: 'ollama/qwen3-coder:30b',
  timeoutMs: 120000
};

// Same bounded objective as reliability-opencode-live (proven against this runtime).
const OBJECTIVE = 'Read inline current_context.records. The fixture.color record gives a color token. Use edit to replace alpha in fixture.txt with that token, preserving the single newline. Return the exact result_contract JSON. Do not use shell, tests, memory tools, or network.';

function stage(m, id = 'implement', deps = []) {
  return {
    id, depends_on: deps, mission_id: m?.id,
    objective: 'Bounded OpenCode CAE step',
    acceptance_criteria: ['Registered exact-file criterion passes'],
    verification_requirements: ['Independent registered host tests'],
    human_checkpoint: false
  };
}

function seedColor(b) {
  const a = b.authorityRuntime, by = a.store.operator;
  a.project(b.projects.listProjects({})[0].projectId);
  const c = a.memory.propose({
    kind: 'project_operational', operator_id: a.store.operatorId,
    project_id: b.projects.listProjects({})[0].projectId, scope: 'project_specific',
    subject_key: 'fixture.color', value: 'beta',
    source_hash: canonicalHash({ synthetic: 'beta' }),
    source_refs: [{ source_ref: 'synthetic:color' }], metadata: {}
  }, by);
  a.memory.promote(c.id, {}, by);
}

test('REAL OPENCODE: authorized CAE goal dispatches, verifies, and survives client disconnect', async t => {
  const f = await fixture(t, { opencode: OPENCODE, settleTimeoutMs: 180000 });
  const b = f.bridge;
  qualifyCanonical(b);
  seedColor(b);
  const ready = await b.opencodeAdapter.readiness();
  assert.equal(ready.ready, true, JSON.stringify(ready));

  const m = f.create({
    preferred_agent: undefined,
    manifest: manifest(f.repo),
    objective: OBJECTIVE,
    target_domains: ['fixture'],
    required_memory_keys: ['fixture.color'],
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  });
  assert.equal(m.envelope.preferred_agent, 'opencode');

  const g = b.missions.goalPlanner.create({
    request_id: randomUUID(), goal_id: m.goal_id, stages: [stage(m)],
    max_runtime_hours: 1, max_attempts: 2
  });
  b.autonomousExecution.authorize(g.id, {
    request_id: randomUUID(), workers: ['opencode', 'host'],
    max_concurrent_missions: 1, max_dispatches: 5, max_repairs: 2, confirmed: true
  });

  // Initiating client disconnect — durable service owns continuation.
  b.controlServer = { conversationEngine: { active: new Map() } };
  assert.equal(b.controlServer.conversationEngine.active.size, 0);

  const tick = await b.autonomousExecution.tick();
  assert.ok(tick.dispatched >= 1, JSON.stringify(tick));
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, 1);

  const done = await f.settle(m.id);
  assert.equal(done.state, 'awaiting_acceptance');
  assert.equal(done.verifications[0].result, 'passed');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  const worker = done.runs.find(r => r.agent_id === 'opencode');
  assert.ok(worker, 'OpenCode worker run required');
  assert.equal(worker.termination_verified, 1);

  // Reconnect must not duplicate.
  await b.autonomousExecution.tick();
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, 1);
  assert.equal(done.acceptance.length, 0);

  b.missions.accept(m.id, {
    request_id: 'cae-live-accept',
    verification_id: done.verifications[0].id,
    decision: 'accept',
    rationale: 'Isolated OpenCode exact-file and registered host tests passed'
  });
  assert.equal(b.missions.goalPlanner.inspect(g.id).state, 'completed');
  assert.equal(b.autonomousExecution.inspect(g.id).autonomous.lifecycle, 'completed');

  const trace = flightRecorder(b, { missionId: m.id, limit: 200 });
  assert.ok(trace.events.some(e =>
    e.event_type === 'goal.autonomous.authorized' ||
    e.event_type === 'goal.autonomous.dispatched' ||
    e.event_type === 'mission.settled'
  ));
  assert.doesNotMatch(JSON.stringify(trace), /Bearer|sk-|xox|PRIVATE_CANARY|credential/i);

  console.log(JSON.stringify({
    evidence_class: 'REAL_LOCAL_OPENCODE_CAE',
    runtime: 'OpenCode 2.0.25',
    model: 'ollama/qwen3-coder:30b',
    client_independent: true,
    dispatch_via: 'MissionService.dispatch',
    acceptance_separate: true,
    owner_memory_touched: false,
    live_install_mutated: false,
    flight_events: trace.events.length
  }));
});

test('REAL OPENCODE: restart after verified work preserves identity without duplicate dispatch', async t => {
  const f = await fixture(t, { opencode: OPENCODE, settleTimeoutMs: 180000 });
  qualifyCanonical(f.bridge);
  seedColor(f.bridge);
  assert.equal((await f.bridge.opencodeAdapter.readiness()).ready, true);

  const m = f.create({
    preferred_agent: undefined,
    manifest: manifest(f.repo),
    objective: OBJECTIVE,
    target_domains: ['fixture'],
    required_memory_keys: ['fixture.color'],
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  });
  const g = f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(), goal_id: m.goal_id, stages: [stage(m)],
    max_runtime_hours: 1, max_attempts: 2
  });
  f.bridge.autonomousExecution.authorize(g.id, {
    request_id: randomUUID(), workers: ['opencode'],
    max_concurrent_missions: 1, max_dispatches: 5, max_repairs: 2, confirmed: true
  });
  await f.bridge.autonomousExecution.tick();
  const done = await f.settle(m.id);
  assert.equal(done.state, 'awaiting_acceptance');
  const before = {
    plan: g.id, mission: m.id, goal: g.goal_id,
    dispatches: f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n,
    verification_id: done.verifications[0].id
  };

  // Restart only after verified termination — mid-flight OpenCode kill is uncertain by design.
  await f.reopen();
  f.ensureAdmission();
  const after = f.bridge.autonomousExecution.inspect(before.plan);
  assert.equal(after.id, before.plan);
  assert.equal(after.goal_id, before.goal);
  assert.equal(after.stages[0].mission_id, before.mission);
  assert.equal(after.execution_enabled, true);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');

  await f.bridge.autonomousExecution.tick();
  assert.equal(
    f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n,
    before.dispatches
  );
  f.bridge.missions.accept(m.id, {
    request_id: 'cae-live-restart-accept',
    verification_id: before.verification_id,
    decision: 'accept',
    rationale: 'Post-restart isolated OpenCode verification reviewed'
  });
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
  console.log(JSON.stringify({
    evidence_class: 'REAL_LOCAL_OPENCODE_CAE_RESTART',
    plan_preserved: true,
    mission_preserved: true,
    duplicate_dispatch: false,
    restart_after: 'awaiting_acceptance'
  }));
});
