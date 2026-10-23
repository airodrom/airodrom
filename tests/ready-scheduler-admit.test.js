'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const G = require('../src/specialist-gateway');

async function setup(t) {
  const f = await fixture(t, { opencode: runtime(t).options, settleTimeoutMs: 45000 });
  const b = f.bridge;
  b.missionAuthority.initializeOperatorKey();
  qualifyCanonical(b);
  b.expandedAutonomy.setMode({
    mode: 'routine_auto', confirmed: true, request_id: randomUUID(), sync_risk_acceptance: false,
  }, 'operator');
  const p = b.projects.listProjects({ status: 'active' })[0];
  const g = b.projects.summary(p.projectId).goals[0];
  b.developerAutonomy.enroll({
    alias: 'ready-admit-fixture', repository: f.repo, project_id: p.projectId, goal_id: g.goalId,
    workflows: ['routine_edit', 'test'], workers: ['opencode'], duration_days: 1, confirmed: true,
    diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 },
    cognitive: {
      version: 3, files: ['fixture.txt'], delegated_callers: [], planning_attempts: 2,
      planning_ms: 120000, execution_ms: 120000, repair_attempts: 0, max_assignments: 2, acceptance: 'automatic',
    },
  }, 'operator');
  f.plan = [
    {
      id: 'read-1', worker: 'opencode', role: 'analysis', operation: 'read', paths: ['fixture.txt'],
      description: 'Read fixture.txt', depends_on: [], verification: [],
    },
    {
      id: 'change-1', worker: 'opencode', role: 'implementation', operation: 'edit', paths: ['fixture.txt'],
      description: 'Change alpha to beta', depends_on: ['read-1'], verification: [],
    },
  ];
  f.calls = [];
  f.evaluations = [];
  f.evaluate = (o) => ({
    ...o.coordination.result_contract,
    recommendation: o.coordination.host_checks.some((c) => c.status === 'failed') ? 'blocked' : 'ready',
    summary: o.coordination.assignment_contract?.operation === 'read'
      ? 'Host-verified read.'
      : 'Host-verified edit.',
  });
  const adapter = b.opencodeAdapter;
  const worker = adapter.execute.bind(adapter);
  adapter.execute = async (o) => {
    if (o.planning) {
      return {
        result: { summary: JSON.stringify({ ...o.planning, tasks: f.plan }) },
        changes: [], provenance: { termination_verified: true },
      };
    }
    if (o.coordination) {
      f.evaluations.push(o.coordination);
      assert.deepEqual(o.writable, []);
      return {
        result: { summary: JSON.stringify(await f.evaluate(o)) },
        changes: [],
        provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
      };
    }
    f.calls.push({ files: o.files, writable: o.writable });
    return worker(o.writable.length ? o : {
      ...o, objective: 'Inspect fixture.txt without changes', objectiveProof: null,
    });
  };
  // Simulate lost cognitive-dispatch / ignored prepared tick: Mission seals READY
  // with a prepared specialist graph and zero dispatches.
  f.holdAtPreparedReady = () => {
    b.missions.schedule = () => {};
    b.missions.program.tick = () => {};
    b.missions.dispatch = (id) => b.missions.detail(id);
  };
  f.ask = async ({ hold = false } = {}) => {
    if (hold) f.holdAtPreparedReady();
    const request_id = randomUUID();
    const instruction = 'In Fixture project read fixture.txt then change alpha to beta, preserving one final newline.';
    let view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    for (let i = 0; i < 400 && (view.state === 'PLANNING' || (!view.mission_id && !['BLOCKED', 'WAIT', 'REJECTED'].includes(view.state))); i++) {
      await new Promise((r) => setTimeout(r, 25));
      view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    }
    return view;
  };
  return f;
}

test('admitReady queues the first dependency-free assignment from prepared READY', async (t) => {
  const f = await setup(t);
  const view = await f.ask({ hold: true });
  assert.ok(view.mission_id, JSON.stringify(view));
  const live = f.bridge.controlStore.requireMission(view.mission_id);
  assert.equal(live.state, 'ready');
  assert.equal(
    f.bridge.controlStore.db.prepare('SELECT state FROM cp_mission_programs WHERE id=?').get(live.id).state,
    'prepared'
  );
  assert.equal(
    f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(live.id).n,
    0
  );
  const result = G.admitReady(f.bridge.missions, live);
  assert.equal(result.admitted, true, JSON.stringify(result));
  assert.ok(result.dispatch_id);
  assert.equal(
    f.bridge.controlStore.db.prepare('SELECT state FROM cp_mission_programs WHERE id=?').get(live.id).state,
    'running'
  );
  assert.equal(
    f.bridge.controlStore.db.prepare('SELECT state FROM cp_dispatches WHERE id=?').get(result.dispatch_id).state,
    'queued'
  );
  const nodes = G.inspect(f.bridge, f.bridge.controlStore.requireMission(live.id)).assignments;
  assert.equal(nodes.find((a) => a.id === 'read-1').state, 'queued');
  assert.notEqual(nodes.find((a) => a.id === 'change-1').state, 'queued');
});

test('admitPreparedReady watchdog admits overdue prepared READY Missions', async (t) => {
  const f = await setup(t);
  const view = await f.ask({ hold: true });
  assert.ok(view.mission_id, JSON.stringify(view));
  assert.equal(
    f.bridge.controlStore.requireMission(view.mission_id).state,
    'ready',
    JSON.stringify(view)
  );
  const scanned = G.admitPreparedReady(f.bridge.missions, { limit: 4 });
  assert.ok(scanned.admitted >= 1, JSON.stringify(scanned));
  assert.equal(
    f.bridge.controlStore.db.prepare(
      "SELECT count(*) n FROM cp_dispatches WHERE mission_id=? AND state='queued'"
    ).get(view.mission_id).n,
    1
  );
});

test('concurrent admitReady claims exactly one dispatch', async (t) => {
  const f = await setup(t);
  const view = await f.ask({ hold: true });
  assert.ok(view.mission_id);
  const live = f.bridge.controlStore.requireMission(view.mission_id);
  const first = G.admitReady(f.bridge.missions, live);
  const second = G.admitReady(f.bridge.missions, f.bridge.controlStore.requireMission(view.mission_id));
  assert.equal(first.admitted, true, JSON.stringify(first));
  assert.equal(second.admitted, false);
  assert.equal(
    f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(view.mission_id).n,
    1
  );
});

test('mission-program tick admits prepared READY without manual scheduler wake', async (t) => {
  const f = await setup(t);
  const view = await f.ask({ hold: true });
  assert.ok(view.mission_id);
  // Restore only program.tick — the path that previously skipped prepared.
  f.bridge.missions.program.tick = require('../src/mission-program').MissionProgram.prototype.tick.bind(f.bridge.missions.program);
  f.bridge.missions.program.tick();
  assert.equal(
    f.bridge.controlStore.db.prepare(
      "SELECT count(*) n FROM cp_dispatches WHERE mission_id=? AND state='queued'"
    ).get(view.mission_id).n,
    1
  );
  assert.equal(
    f.bridge.controlStore.db.prepare('SELECT state FROM cp_mission_programs WHERE id=?').get(view.mission_id).state,
    'running'
  );
});

test('full read→edit graph settles after automatic admit path', async (t) => {
  const f = await setup(t);
  const view = await f.ask();
  assert.ok(view.mission_id && ['DISPATCHED', 'RUNNING', 'SEALED'].includes(view.state), JSON.stringify(view));
  const mission = await f.settle(view.mission_id, 'completed');
  assert.equal(f.evaluations.length, 2);
  assert.equal(
    require('node:fs').readFileSync(path.join(mission.envelope.workspace, 'fixture.txt'), 'utf8'),
    'beta\n'
  );
  assert.equal(
    f.bridge.controlStore.db.prepare(
      "SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')"
    ).get(mission.id).n,
    0
  );
});

test('nativeStatus stays bounded under deferred readiness', async (t) => {
  const f = await setup(t);
  const b = f.bridge;
  // Simulate a slow OpenCode readiness probe that previously blocked menu polls ~10–11s.
  b.opencodeAdapter.readiness = async () => {
    await new Promise((r) => setTimeout(r, 8000));
    return { ready: true, reason: 'slow_probe' };
  };
  // Expired cache forces the race path; waitMs=2500 must dominate, not the 8s probe.
  b.opencodeAdapter._readinessCache = { value: { ready: true, reason: 'cached' }, at: Date.now() - 60000 };
  b.opencodeAdapter.lastReadiness = { ready: true, reason: 'cached' };
  b._installationCompatibilityCache = {
    value: { overall: 'Compatible', mutations_allowed: true, components: [] },
    at: Date.now(),
  };
  const started = Date.now();
  const status = await require('../src/product-observability').nativeStatus(b);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `nativeStatus took ${elapsed}ms`);
  assert.ok(status.status === 'Ready' || status.status === 'Degraded', status.status);
  assert.ok(typeof status.active_missions === 'number');
});

test('expired prepared READY fails closed without dispatch', async (t) => {
  const f = await setup(t);
  const view = await f.ask({ hold: true });
  assert.ok(view.mission_id);
  const db = f.bridge.controlStore.db;
  db.prepare('UPDATE cp_mission_programs SET expires_at=? WHERE id=?').run(Date.now() - 1000, view.mission_id);
  const result = G.admitReady(f.bridge.missions, f.bridge.controlStore.requireMission(view.mission_id));
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'deadline_elapsed');
  assert.equal(f.bridge.controlStore.requireMission(view.mission_id).state, 'blocked');
  assert.equal(
    db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(view.mission_id).n,
    0
  );
});
