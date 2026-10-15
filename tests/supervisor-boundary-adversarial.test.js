'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const supervisor = require('../src/autonomous-supervisor');
const board = require('../src/live-activity-board');
const display = require('../src/product-observability');
const observatory = require('../src/live-observatory');
const {
  safeRel,
  collectWatchRoots,
  authorizedScopes,
  createWorkspaceActivityWatch,
  pathAuthorized
} = require('../src/workspace-activity-watch');

const url = (q = '') => new URL('http://localhost/api/product/live-activity?' + q);

function seedRun(b, mission, {
  state = 'running',
  process_state = 'alive',
  termination_verified = 0,
  agent_id = 'opencode'
} = {}) {
  const runId = randomUUID();
  const dispatchId = randomUUID();
  const now = Date.now();
  b.controlStore.db.prepare(`
    INSERT INTO cp_runs(id,mission_id,task_id,agent_id,generation,state,process_state,liveness_state,termination_verified,created_at,updated_at)
    VALUES(?,?,?,?,1,?,?,?,?,?,?)`).run(
    runId, mission.id, mission.task_id, agent_id, state, process_state,
    process_state === 'alive' ? 'alive' : 'unknown',
    termination_verified, now, now
  );
  b.controlStore.db.prepare(`
    INSERT INTO cp_dispatches(id,mission_id,task_id,state,decision_id,route,run_id,created_at,updated_at)
    VALUES(?,?,?,?,NULL,NULL,?,?,?)`).run(dispatchId, mission.id, mission.task_id, 'running', runId, now, now);
  return runId;
}

function fileEvents(b) {
  return observatory.liveEvents(b, new URL('http://local/api/product/live-events?after=0&category=File')).events || [];
}

test('interrupted and termination_unverified Runs are not advancing workers', async t => {
  const f = await fixture(t), b = f.bridge;
  const interrupted = f.create({ objective: 'Interrupted ownership fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(interrupted.id);
  seedRun(b, b.missions.require(interrupted.id), {
    state: 'interrupted',
    process_state: 'unknown',
    termination_verified: 0
  });
  const runI = supervisor.activeRun(b, b.missions.require(interrupted.id));
  assert.equal(runI.advancing, false);
  assert.equal(runI.ownership, 'unknown');
  assert.equal(runOwnershipLabel(runI), 'unknown');

  const unverified = f.create({ objective: 'Termination unverified fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='blocked' WHERE id=?").run(unverified.id);
  seedRun(b, b.missions.require(unverified.id), {
    state: 'termination_unverified',
    process_state: 'unknown',
    termination_verified: 0
  });
  const runU = supervisor.activeRun(b, b.missions.require(unverified.id));
  assert.equal(runU.advancing, false);
  assert.ok(['unknown', 'unverified'].includes(runU.ownership));

  const sessions = supervisor.executionSessions(b);
  assert.equal(sessions.summary.active_agent_runs, 0);
  assert.ok(sessions.summary.unverified_runs + sessions.summary.unknown_ownership_runs >= 1);

  const card = board.liveActivityBoard(b, url('tab=now')).now.missions.find(c => c.id === interrupted.id)
    || board.liveActivityBoard(b, url('tab=now')).now.missions[0];
  // Interrupted must not report worker_active even if Mission state is still running.
  const interruptedCard = board.liveActivityBoard(b, url('tab=now')).now.missions.find(c => c.id === interrupted.id);
  if (interruptedCard) {
    assert.equal(interruptedCard.worker_active, false);
    assert.equal(interruptedCard.active_run, null);
    assert.ok(interruptedCard.run_ownership);
    assert.notEqual(interruptedCard.run_ownership.ownership, 'advancing');
  }
});

function runOwnershipLabel(run) {
  return run?.ownership || 'none';
}

test('unknown process and stale running row are not advancing', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Stale running unknown process' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  seedRun(b, b.missions.require(m.id), {
    state: 'running',
    process_state: 'unknown',
    termination_verified: 0
  });
  const run = supervisor.activeRun(b, b.missions.require(m.id));
  assert.equal(run.advancing, false);
  assert.equal(run.ownership, 'unknown');
  const sessions = supervisor.executionSessions(b);
  assert.equal(sessions.summary.active_agent_runs, 0);
  assert.ok(sessions.summary.unknown_ownership_runs >= 1);
  const card = board.liveActivityBoard(b, url('tab=now')).now.missions.find(c => c.id === m.id);
  assert.ok(card);
  assert.equal(card.worker_active, false);
  assert.equal(card.active_run, null);
});

test('confirmed advancing OpenCode Run counts once with trustworthy process evidence', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Advancing OpenCode fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  const runId = seedRun(b, b.missions.require(m.id), {
    state: 'running',
    process_state: 'alive',
    termination_verified: 0,
    agent_id: 'opencode'
  });
  const run = supervisor.activeRun(b, b.missions.require(m.id));
  assert.equal(run.advancing, true);
  assert.equal(run.ownership, 'advancing');
  assert.equal(run.run_id, runId);
  assert.equal(run.worker, 'opencode');
  const sessions = supervisor.executionSessions(b);
  assert.equal(sessions.summary.active_agent_runs, 1);
  const card = board.liveActivityBoard(b, url('tab=now')).now.missions.find(c => c.id === m.id);
  assert.equal(card.worker_active, true);
  assert.equal(card.active_run.run_id, runId);
});

test('multi-generation Missions count only the latest advancing Run', async t => {
  const f = await fixture(t), b = f.bridge;
  const root = f.create({ objective: 'Gen root' });
  const child = f.create({ objective: 'Gen child' });
  b.controlStore.db.prepare("UPDATE cp_missions SET envelope=json_set(envelope,'$.repair_of',?), state='running' WHERE id=?")
    .run(root.id, child.id);
  seedRun(b, b.missions.require(root.id), {
    state: 'failed',
    process_state: 'exited',
    termination_verified: 1
  });
  seedRun(b, b.missions.require(child.id), {
    state: 'running',
    process_state: 'alive',
    termination_verified: 0
  });
  assert.equal(supervisor.activeRun(b, b.missions.require(root.id)).advancing, false);
  assert.equal(supervisor.activeRun(b, b.missions.require(child.id)).advancing, true);
  assert.equal(supervisor.executionSessions(b).summary.active_agent_runs, 1);
});

test('safeRel denies sensitive, dotfile and escape paths', () => {
  assert.equal(safeRel('fixture.txt'), 'fixture.txt');
  assert.equal(safeRel('.env'), null);
  assert.equal(safeRel('config/private.pem'), null);
  assert.equal(safeRel('secrets/token.txt'), null);
  assert.equal(safeRel('.ssh/id_rsa'), null);
  assert.equal(safeRel('id_rsa.key'), null);
  assert.equal(safeRel('../escape'), null);
  assert.equal(safeRel('.hidden'), null);
  assert.equal(safeRel('docs/.env.local'), null);
});

test('watch roots exclude idle projects, host root and awaiting_acceptance only', async t => {
  const f = await fixture(t), b = f.bridge;
  b.hostRepoRoot = f.repo;
  // Idle ready Mission must not authorize a watch root.
  f.create({ objective: 'Idle ready watch deny' });
  assert.deepEqual(collectWatchRoots(b), []);

  const awaiting = f.create({ objective: 'Awaiting acceptance watch deny' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(awaiting.id);
  assert.deepEqual(collectWatchRoots(b), []);

  const active = f.create({ objective: 'Active running watch allow' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(active.id);
  const roots = collectWatchRoots(b);
  assert.deepEqual(roots, [fs.realpathSync(f.repo)]);
  const scopes = authorizedScopes(b);
  assert.equal(scopes.length, 1);
  assert.ok(scopes[0].allowed_files.has('fixture.txt'));
});

test('watcher emits authorized fixture.txt but never sensitive or out-of-allowlist paths', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Authorized watch emit' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  seedRun(b, b.missions.require(m.id), { state: 'running', process_state: 'alive', agent_id: 'opencode' });

  const watch = createWorkspaceActivityWatch(b);
  t.after(() => watch.stop());
  watch.start();
  assert.ok(watch.status().watched_roots >= 1);

  const before = fileEvents(b).length;
  // Direct emit path (debounce-independent) for adversarial assertions.
  watch.emitForTest(fs.realpathSync(f.repo), 'fixture.txt');
  watch.emitForTest(fs.realpathSync(f.repo), '.env');
  watch.emitForTest(fs.realpathSync(f.repo), 'config/private.pem');
  watch.emitForTest(fs.realpathSync(f.repo), 'unauthorized.txt');
  fs.writeFileSync(path.join(f.repo, 'unauthorized.txt'), 'nope\n');

  const events = fileEvents(b).slice(before);
  assert.ok(events.some(e => e.path === 'fixture.txt' && e.mission_id === m.id), 'authorized fixture observed');
  assert.equal(events.some(e => e.path === '.env'), false);
  assert.equal(events.some(e => String(e.path || '').includes('private.pem')), false);
  assert.equal(events.some(e => e.path === 'unauthorized.txt'), false);
});

test('expired WORK templates do not authorize watch scopes or standing observation', async t => {
  const f = await fixture(t), b = f.bridge;
  b.missionAuthority.initializeOperatorKey();
  const seed = f.create({ objective: 'Template seed' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='cancelled' WHERE id=?").run(seed.id);
  const registered = b.workTemplates.register({
    project: 'accept',
    workspace_alias: 'local',
    project_id: seed.project_id,
    goal_id: seed.goal_id,
    workspace: f.repo,
    allowed_files: ['fixture.txt'],
    diff_check: 'diff-check',
    tests: ['fixture-test'],
    duration_minutes: 60,
    confirmed: true
  }, 'operator');
  assert.equal(registered.state, 'active');
  assert.ok(collectWatchRoots(b).includes(fs.realpathSync(f.repo)));

  const now = Date.now;
  try {
    Date.now = () => registered.expires_at + 1;
    assert.equal(b.workTemplates.list('operator')[0].state, 'expired');
    assert.deepEqual(collectWatchRoots(b), []);
    const standing = supervisor.standingAuthorization(b);
    assert.equal(standing.active_count, 0);
  } finally {
    Date.now = now;
  }
});

test('symlink escape and Mission-null idle observations are refused', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Symlink deny' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  const outside = path.join(f.root, 'outside-secret.txt');
  fs.writeFileSync(outside, 'secret\n');
  const link = path.join(f.repo, 'linked.txt');
  fs.symlinkSync(outside, link);

  const scopes = authorizedScopes(b);
  // linked.txt is not in allowed_files
  assert.equal(pathAuthorized(scopes, fs.realpathSync(f.repo), 'linked.txt'), null);

  // Idle project: no active mission — emit must not create Mission-null File events for unknown writers.
  b.controlStore.db.prepare("UPDATE cp_missions SET state='ready' WHERE id=?").run(m.id);
  const watch = createWorkspaceActivityWatch(b);
  t.after(() => watch.stop());
  watch.start();
  assert.equal(watch.status().watched_roots, 0);
  const before = fileEvents(b).length;
  watch.emitForTest(fs.realpathSync(f.repo), 'fixture.txt');
  assert.equal(fileEvents(b).length, before);
});

test('acceptance evidence file for prior isolated OpenCode gate remains preserved on disk', () => {
  const evidence = '/Users/andrew/Documents/Codex/2026-10-14/airodrom-autonomous-supervisor-v1/evidence/autonomous-supervisor-v1/acceptance/05-acceptance-gate.json';
  assert.equal(fs.existsSync(evidence), true);
  const body = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  assert.equal(body.results.acceptance_gate, true);
  assert.equal(body.revision, 'e2edb277c1a2570d5fa0498dbf0c48537c85440f');
  assert.ok(body.phases.handoff.mission_id);
});
