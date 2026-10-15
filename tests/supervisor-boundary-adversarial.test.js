'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const supervisor = require('../src/autonomous-supervisor');
const board = require('../src/live-activity-board');
const observatory = require('../src/live-observatory');
const {
  safeRel,
  collectWatchRoots,
  authorizedScopes,
  createWorkspaceActivityWatch,
  pathAuthorized,
  canonicalAuthorizedFile,
  classifyWriter
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

function setAllowed(b, missionId, files) {
  b.controlStore.db.prepare(
    "UPDATE cp_missions SET envelope=json_set(envelope,'$.allowed_files',json(?)) WHERE id=?"
  ).run(JSON.stringify(files), missionId);
}

function makeRepo(parent, name) {
  const repo = path.join(parent, name);
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'fixture.txt'), 'alpha\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
  fs.writeFileSync(path.join(repo, 'tests/fixture.test.cjs'),
    "const assert=require('node:assert/strict');assert.ok(true);\n");
  fs.writeFileSync(path.join(repo, '.vscode/tasks.json'), JSON.stringify({
    version: '2.0.0',
    tasks: [
      { label: 'diff-check', type: 'process', command: 'git', args: ['diff', '--check'] },
      { label: 'fixture-test', type: 'process', command: 'node', args: ['--test', 'tests/fixture.test.cjs'] }
    ]
  }));
  execFileSync('/usr/bin/git', ['-C', repo, 'init', '-q']);
  execFileSync('/usr/bin/git', ['-C', repo, 'add', '.']);
  execFileSync('/usr/bin/git', [
    '-C', repo, '-c', 'user.name=Adversarial', '-c', 'user.email=adv@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'baseline'
  ]);
  return fs.realpathSync(repo);
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

  const interruptedCard = board.liveActivityBoard(b, url('tab=now')).now.missions.find(c => c.id === interrupted.id);
  if (interruptedCard) {
    assert.equal(interruptedCard.worker_active, false);
    assert.equal(interruptedCard.active_run, null);
    assert.ok(interruptedCard.run_ownership);
    assert.notEqual(interruptedCard.run_ownership.ownership, 'advancing');
  }
});

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
  assert.equal(supervisor.executionSessions(b).summary.active_agent_runs, 0);
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
  assert.equal(supervisor.executionSessions(b).summary.active_agent_runs, 1);
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
  assert.equal(safeRel('.pi/credentials.json'), null);
  assert.equal(safeRel('id_rsa.key'), null);
  assert.equal(safeRel('../escape'), null);
  assert.equal(safeRel('.hidden'), null);
});

test('watch roots exclude idle projects, host root and awaiting_acceptance only', async t => {
  const f = await fixture(t), b = f.bridge;
  b.hostRepoRoot = f.repo;
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
  assert.ok(scopes.some(s => s.mission_id === active.id && s.allowed_files.has('fixture.txt')));
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
  watch.emitForTest(fs.realpathSync(f.repo), 'fixture.txt');
  watch.emitForTest(fs.realpathSync(f.repo), '.env');
  watch.emitForTest(fs.realpathSync(f.repo), 'config/private.pem');
  fs.writeFileSync(path.join(f.repo, 'unauthorized.txt'), 'nope\n');
  watch.emitForTest(fs.realpathSync(f.repo), 'unauthorized.txt');

  const events = fileEvents(b).slice(before);
  assert.ok(events.some(e => e.path === 'fixture.txt'), 'authorized fixture observed');
  assert.equal(events.some(e => e.path === '.env'), false);
  assert.equal(events.some(e => String(e.path || '').includes('private.pem')), false);
  assert.equal(events.some(e => e.path === 'unauthorized.txt'), false);
});

test('two workspaces with identical filenames never cross-attribute Mission IDs', async t => {
  const f = await fixture(t), b = f.bridge;
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asv-dual-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repoA = makeRepo(scratch, 'ws-a');
  const repoB = makeRepo(scratch, 'ws-b');

  const projectA = b.projects.createProject({ name: 'Dual A', repositories: [repoA] });
  const goalA = b.projects.createGoal({ projectId: projectA.projectId, name: 'Goal A' });
  const projectB = b.projects.createProject({ name: 'Dual B', repositories: [repoB] });
  const goalB = b.projects.createGoal({ projectId: projectB.projectId, name: 'Goal B' });

  const mA = b.missions.create({
    request_id: randomUUID(),
    project_id: projectA.projectId,
    goal_id: goalA.goalId,
    objective: 'Workspace A fixture edit',
    workspace: repoA,
    allowed_files: ['fixture.txt'],
    criteria: [{ id: 'review', type: 'operator_review', description: 'review' }],
    verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] },
    preferred_agent: 'claude_code'
  });
  const mB = b.missions.create({
    request_id: randomUUID(),
    project_id: projectB.projectId,
    goal_id: goalB.goalId,
    objective: 'Workspace B fixture edit',
    workspace: repoB,
    allowed_files: ['fixture.txt'],
    criteria: [{ id: 'review', type: 'operator_review', description: 'review' }],
    verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] },
    preferred_agent: 'claude_code'
  });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id IN (?,?)").run(mA.id, mB.id);
  const runA = seedRun(b, b.missions.require(mA.id), { agent_id: 'opencode', process_state: 'alive' });
  const runB = seedRun(b, b.missions.require(mB.id), { agent_id: 'opencode', process_state: 'alive' });

  // Plant a recent OpenCode event for A only — basename fixture.txt must not bind to B.
  observatory.record(b, {
    eventType: 'fs.file_modified',
    missionId: mA.id,
    runId: runA,
    metadata: { path: 'fixture.txt', agent_id: 'opencode', writer_class: 'OPENCODE_WRITE' }
  });

  const writerB = classifyWriter(b, repoB, 'fixture.txt', [mB.id]);
  assert.notEqual(writerB.mission_id, mA.id, 'workspace B must not inherit Mission A');
  assert.notEqual(writerB.run_id, runA);
  if (writerB.mission_id) assert.equal(writerB.mission_id, mB.id);

  const watch = createWorkspaceActivityWatch(b);
  t.after(() => watch.stop());
  watch.start();
  const before = fileEvents(b).length;
  watch.emitForTest(repoB, 'fixture.txt');
  const events = fileEvents(b).slice(before).filter(e => e.path === 'fixture.txt');
  assert.ok(events.length >= 1);
  for (const e of events) {
    assert.notEqual(e.mission_id, mA.id, 'no cross-workspace Mission leakage');
    assert.notEqual(e.run_id, runA);
    if (e.mission_id) assert.equal(e.mission_id, mB.id);
  }
  void runB;
});

test('same-workspace disjoint Mission allowlists never cross-attribute', async t => {
  const f = await fixture(t), b = f.bridge;
  const mFixture = f.create({ objective: 'Allowlist fixture only' });
  const mOther = f.create({ objective: 'Allowlist other only' });
  setAllowed(b, mFixture.id, ['fixture.txt']);
  setAllowed(b, mOther.id, ['other.txt']);
  // Ensure other.txt exists and is committed so dirty/allow rules don't matter for watch.
  if (!fs.existsSync(path.join(f.repo, 'other.txt'))) {
    fs.writeFileSync(path.join(f.repo, 'other.txt'), 'other\n');
  }
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id IN (?,?)").run(mFixture.id, mOther.id);
  const runFixture = seedRun(b, b.missions.require(mFixture.id), { agent_id: 'opencode', process_state: 'alive' });
  seedRun(b, b.missions.require(mOther.id), { agent_id: 'opencode', process_state: 'alive' });

  observatory.record(b, {
    eventType: 'fs.file_modified',
    missionId: mFixture.id,
    runId: runFixture,
    metadata: { path: 'fixture.txt', agent_id: 'opencode', writer_class: 'OPENCODE_WRITE' }
  });

  // other.txt must not pick up mFixture even though fixture.txt OpenCode evidence is recent.
  const writerOther = classifyWriter(b, f.repo, 'other.txt', [mOther.id]);
  assert.notEqual(writerOther.mission_id, mFixture.id);
  if (writerOther.mission_id) assert.equal(writerOther.mission_id, mOther.id);

  const scopes = authorizedScopes(b);
  const authOther = pathAuthorized(scopes, f.repo, 'other.txt');
  assert.ok(authOther);
  assert.ok(authOther.matching.every(s => !s.mission_id || s.allowed_files.has('other.txt')));
  assert.equal(authOther.matching.some(s => s.mission_id === mFixture.id), false);

  const watch = createWorkspaceActivityWatch(b);
  t.after(() => watch.stop());
  watch.start();
  const before = fileEvents(b).length;
  watch.emitForTest(fs.realpathSync(f.repo), 'other.txt');
  const events = fileEvents(b).slice(before).filter(e => e.path === 'other.txt');
  assert.ok(events.length >= 1);
  for (const e of events) {
    assert.notEqual(e.mission_id, mFixture.id, 'disjoint allowlist must not leak Mission ID');
  }
});

test('approved nested path through in-repo directory symlink is refused', async t => {
  const f = await fixture(t), b = f.bridge;
  const realDir = path.join(f.repo, 'real-nested');
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, 'nested.txt'), 'nested\n');
  const linkDir = path.join(f.repo, 'via-link');
  fs.symlinkSync(realDir, linkDir);
  const lexical = 'via-link/nested.txt';
  assert.equal(fs.existsSync(path.join(f.repo, lexical)), true);
  assert.equal(canonicalAuthorizedFile(f.repo, lexical), null, 'symlink parent component denied');

  const m = f.create({ objective: 'Symlink parent deny' });
  setAllowed(b, m.id, ['via-link/nested.txt', 'fixture.txt']);
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  seedRun(b, b.missions.require(m.id), { agent_id: 'opencode', process_state: 'alive' });

  const watch = createWorkspaceActivityWatch(b);
  t.after(() => watch.stop());
  watch.start();
  const before = fileEvents(b).length;
  watch.emitForTest(fs.realpathSync(f.repo), lexical);
  assert.equal(fileEvents(b).slice(before).some(e => e.path === lexical), false);
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
    assert.equal(supervisor.standingAuthorization(b).active_count, 0);
  } finally {
    Date.now = now;
  }
});

test('symlink file escape and Mission-null idle observations are refused', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Symlink file deny' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  const outside = path.join(f.root, 'outside-secret.txt');
  fs.writeFileSync(outside, 'secret\n');
  const link = path.join(f.repo, 'linked.txt');
  fs.symlinkSync(outside, link);
  assert.equal(pathAuthorized(authorizedScopes(b), fs.realpathSync(f.repo), 'linked.txt'), null);

  b.controlStore.db.prepare("UPDATE cp_missions SET state='ready' WHERE id=?").run(m.id);
  const watch = createWorkspaceActivityWatch(b);
  t.after(() => watch.stop());
  watch.start();
  assert.equal(watch.status().watched_roots, 0);
  const before = fileEvents(b).length;
  watch.emitForTest(fs.realpathSync(f.repo), 'fixture.txt');
  assert.equal(fileEvents(b).length, before);
});

test('Control Center projects uncertain Run ownership instead of No active Run', () => {
  const hub = fs.readFileSync(path.join(__dirname, '../public/control-hub.js'), 'utf8');
  assert.match(hub, /Ownership unverified — review required/);
  assert.match(hub, /Unverified ownership/);
  assert.match(hub, /Unknown ownership/);
  assert.match(hub, /run_ownership/);
  assert.match(hub, /unverified_runs/);
  assert.match(hub, /unknown_ownership_runs/);
  assert.match(hub, /never counted as an active agent Run/);
});

test('optional acceptance evidence path is portable (no private absolute machine path)', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(source, /\/Users\/[A-Za-z0-9._-]+\//);
  assert.doesNotMatch(source, /Documents\/Codex/);
  // External qualification evidence may be supplied via env for host operators; unit suite stays hermetic.
  const external = process.env.AIRODROM_ACCEPTANCE_EVIDENCE;
  if (external) {
    assert.equal(fs.existsSync(external), true);
    const body = JSON.parse(fs.readFileSync(external, 'utf8'));
    assert.equal(body.results?.acceptance_gate, true);
  } else {
    assert.equal(external || null, null);
  }
});
