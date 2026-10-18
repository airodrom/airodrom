'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { parseExactFileIntent } = require('../src/zero-setup-work');
const { TOOLS } = require('../src/mcp-tools');

test('exact-file natural language intent is recognized without IDs', () => {
  const intent = parseExactFileIntent('Airodrom, change the test file from alpha to beta, verify the result, and tell me when you are finished.');
  assert.equal(intent.kind, 'exact_file');
  assert.equal(intent.file, 'fixture.txt');
  assert.equal(intent.to, 'beta\n');
});

test('ask prepares WAIT approval without writing or dispatching; approve runs once', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  // This fixture explicitly authorizes automatic Acceptance; production defaults remain MANUAL.
  f.bridge.expandedAutonomy.setMode({mode:'routine_auto',confirmed:true,sync_risk_acceptance:false,request_id:require('node:crypto').randomUUID()},'operator');
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  const project = f.bridge.projects.createProject({ name: 'Human Acceptance Exact File', repositories: [f.repo], privacyPolicy: 'local_only' });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const request_id = randomUUID();
  const prepared = await f.bridge.zeroSetupWork.ask({
    instruction: 'Airodrom, change the test file from alpha to beta, verify the result, and tell me when you are finished.',
    request_id,
  }, 'mcp:zero-setup-test');
  assert.equal(prepared.state, 'WAIT');
  assert.equal(prepared.execution_authorized, false);
  assert.equal(prepared.presentation.project_name, 'Human Acceptance Exact File');
  assert.deepEqual(prepared.presentation.files, ['fixture.txt']);
  assert.match(prepared.presentation.worker, /OpenCode/i);
  assert.match(prepared.presentation.completion_policy, /initial approval.*preauthorizes automatic completion/i);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
  assert.equal(f.bridge.controlStore.listMissions({ owner: 'operator', limit: 20 }).filter(m => m.envelope?.work_template).length, 0);
  assert.equal(f.bridge.workTemplates.list('operator').length, 0);
  assert.equal(f.bridge.workTemplates.listProposals('operator').length, 1);

  const approved = await f.bridge.zeroSetupWork.approve({ request_id, confirmed: true }, 'operator');
  assert.equal(approved.execution_authorized, true);
  assert.ok(approved.technical.mission_id);
  assert.ok(approved.technical.plan_id);
  assert.equal(f.bridge.workTemplates.list('operator')[0].state, 'active');
  const mission = f.bridge.missions.require(approved.technical.mission_id);
  assert.ok(['ready', 'dispatching', 'running', 'verifying', 'awaiting_acceptance'].includes(mission.state), mission.state);
  // Owner approval triggers CAE; OpenCode runs without further ChatGPT/Cursor prompts.
  const done = await f.settle(approved.technical.mission_id, 'completed');
  assert.equal(done.state, 'completed');
  assert.equal(done.verifications[0].result, 'passed');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  assert.ok(done.verifications[0].evidence.some(c => c.id === 'task:fixture-test' && c.status === 'passed'));
  assert.equal(done.acceptance.length, 1);
  assert.equal(done.acceptance[0].decision, 'accept');
  assert.equal(done.program_contract.settlement.state, 'settled');
  const replay = await f.bridge.zeroSetupWork.ask({
    instruction: 'Airodrom, change the test file from alpha to beta, verify the result, and tell me when you are finished.',
    request_id,
  }, 'mcp:zero-setup-test');
  assert.equal(replay.technical.mission_id, approved.technical.mission_id);
});

test('MCP catalog includes ask_airodrom and get_ask_status', () => {
  const names = TOOLS.map(t => t.name);
  assert.ok(names.includes('ask_airodrom'));
  assert.ok(names.includes('get_ask_status'));
  assert.ok(names.includes('list_authorized_scopes'));
  for (const n of ['prepare_mission', 'inspect_mission_proposal', 'get_mission_status', 'get_mission_events', 'get_mission_evidence', 'request_mission_correction', 'cancel_mission']) assert.ok(names.includes(n), n);
  assert.equal(names.length, 43);
});

test('approval boundary rejects unconfirmed approve and MCP cannot register templates', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  const project = f.bridge.projects.createProject({ name: 'Human Acceptance Exact File', repositories: [f.repo] });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const request_id = randomUUID();
  await f.bridge.zeroSetupWork.ask({
    instruction: 'Change the test file from alpha to beta and verify it.',
    request_id,
  }, 'mcp:boundary');
  await assert.rejects(() => f.bridge.zeroSetupWork.approve({ request_id, confirmed: false }, 'operator'), /approval|confirm/i);
  assert.throws(() => f.bridge.workTemplates.register({
    project: 'x', workspace_alias: 'y', project_id: project.projectId, goal_id: randomUUID(),
    workspace: f.repo, allowed_files: ['fixture.txt'], diff_check: 'diff-check', tests: ['fixture-test'],
    duration_minutes: 60, confirmed: true,
  }, 'mcp:boundary'), /operator/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
});

test('limitations denying Production do not hide disposable Projects', async t => {
  const f = await fixture(t);
  const { ZeroSetupWork } = require('../src/zero-setup-work');
  const z = new ZeroSetupWork(f.bridge);
  const p = f.bridge.projects.createProject({
    name: 'Self-Repair Scope Fixture',
    repositories: [f.repo],
    limitations: ['Disposable self-repair acceptance only. No Production.'],
  });
  fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'alpha\n');
  const scope = z.resolveScope('In the Self-Repair Scope Fixture project, change fixture.txt from alpha to beta.', { kind: 'exact_file', file: 'fixture.txt', from: 'alpha\n', to: 'beta\n' });
  assert.equal(scope.ok, true);
  assert.equal(scope.project.projectId, p.projectId);
});

test('prepared self-repair test workspace resolves to Self-Repair Acceptance when registered', async t => {
  const f = await fixture(t);
  const otherRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'airodrom-other-self-repair-'));
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  for (const root of [f.repo, otherRoot]) {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'alpha\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
    require('node:child_process').spawnSync('git', ['-C', root, 'init'], { encoding: 'utf8' });
    require('node:child_process').spawnSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8' });
    require('node:child_process').spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'init'], { encoding: 'utf8' });
  }
  const acceptance = f.bridge.projects.createProject({ name: 'Self-Repair Acceptance', repositories: [f.repo], privacyPolicy: 'local_only' });
  f.bridge.projects.createProject({ name: 'Self-Repair Scratch', repositories: [otherRoot], privacyPolicy: 'local_only' });
  const { ZeroSetupWork } = require('../src/zero-setup-work');
  const z = new ZeroSetupWork(f.bridge);
  const scope = z.resolveScope(
    'In the prepared self-repair test workspace, change fixture.txt from alpha to beta.',
    { kind: 'exact_file', file: 'fixture.txt', from: 'alpha\n', to: 'beta\n' },
  );
  assert.equal(scope.ok, true);
  assert.equal(scope.project.projectId, acceptance.projectId);
  assert.equal(scope.workspace, fs.realpathSync(f.repo));
});

test('needs_rework stays non-terminal until repair is genuinely blocked', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  const project = f.bridge.projects.createProject({ name: 'Self-Repair Acceptance', repositories: [f.repo], privacyPolicy: 'local_only' });
  const goal = f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const { manifest } = require('./fixtures/opencode-fixture.cjs');
  const parent = f.create({
    project_id: project.projectId,
    goal_id: goal.goalId,
    objective: 'Change fixture.txt from alpha to beta. Preserve exactly one trailing newline.',
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'gamma\n' }],
    manifest: manifest(f.repo),
    task_type: 'local_files',
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'gamma\n' }],
    },
  });
  const plan = f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(),
    goal_id: goal.goalId,
    stages: [{
      id: 'work', depends_on: [], mission_id: parent.id,
      objective: parent.envelope.objective,
      acceptance_criteria: ['Independent host verification passed'],
      verification_requirements: ['exact_file_or_registered_tests'],
      human_checkpoint: false,
    }],
    max_runtime_hours: 1,
    max_attempts: 2,
  }, 'operator');
  f.bridge.autonomousExecution.authorize(plan.id, {
    request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 3, max_repairs: 1, confirmed: true,
  }, 'operator');
  const request_id = randomUUID();
  f.bridge.zeroSetupWork.write(request_id, 'operator', {
    version: 1,
    instruction: 'change fixture',
    intent: { kind: 'exact_file', file: 'fixture.txt', from: 'alpha\n', to: 'beta\n' },
    project_id: project.projectId,
    project_name: project.name,
    goal_id: goal.goalId,
    mission_id: parent.id,
    plan_id: plan.id,
    presentation: { status: 'Working', files: ['fixture.txt'] },
    execution_enabled: true,
    authority: false,
  }, 'running');
  f.bridge.missions.dispatch(parent.id, { request_id: randomUUID() });
  await f.settle(parent.id, 'needs_rework');

  const pending = f.bridge.zeroSetupWork.refreshState(request_id);
  assert.equal(pending.state, 'RUNNING');
  assert.match(pending.presentation.status, /Verification failed|Repairing|preparing automatic repair/i);
  assert.notEqual(pending.state, 'BLOCKED');

  const autonomous = f.bridge.autonomousExecution.readAutonomous(f.bridge.autonomousExecution.planRow(plan.id));
  autonomous.repair_blocked = { work: 'repair_budget' };
  autonomous.last_action = 'repair_blocked';
  f.bridge.autonomousExecution.writeAutonomous(plan.id, autonomous);
  const blocked = f.bridge.zeroSetupWork.refreshState(request_id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.technical.repair_blocked_reason, 'repair_budget');
  assert.match(blocked.presentation.status, /repair_budget/);
});


test('named release project overrides unrelated self-repair fixture heuristics', async t => {
  const f = await fixture(t);
  const release = f.bridge.projects.createProject({ name: 'Airodrom Release Qualification', repositories: [f.repo] });
  f.bridge.projects.createProject({ name: 'Self-Repair Acceptance', repositories: [f.repo] });
  const { ZeroSetupWork } = require('../src/zero-setup-work');
  const scope = new ZeroSetupWork(f.bridge).resolveScope(
    'In Airodrom Release Qualification, inspect the local development test.',
    { kind: 'general', objective: 'Inspect development test' }
  );
  assert.equal(scope.ok, true);
  assert.equal(scope.project.projectId, release.projectId);
});

test('general instructions select only one already-registered active WORK template', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  const release = f.bridge.projects.createProject({ name: 'Airodrom Release Qualification', repositories: [f.repo] });
  const goal = f.bridge.projects.createGoal({ projectId: release.projectId, name: 'Verify test fixture' });
  f.bridge.projects.createProject({ name: 'Self-Repair Acceptance', repositories: [f.repo] });
  f.bridge.workTemplates.register({
    project: 'release-qualification', workspace_alias: 'safe-dev',
    project_id: release.projectId, goal_id: goal.goalId, workspace: f.repo,
    allowed_files: ['fixture.txt'], diff_check: 'diff-check',
    tests: ['fixture-test'], duration_minutes: 60, confirmed: true,
  }, 'operator');
  const { ZeroSetupWork } = require('../src/zero-setup-work');
  const scope = new ZeroSetupWork(f.bridge).resolveScope(
    'Please repair this bounded development test and verify it.',
    { kind: 'general', objective: 'Repair bounded test' }
  );
  assert.equal(scope.ok, true);
  assert.equal(scope.projectless, true);
  assert.equal(scope.project, null);
  assert.notEqual(scope.workspace, fs.realpathSync(f.repo));
  const named = new ZeroSetupWork(f.bridge).resolveScope(
    'Please repair Airodrom Release Qualification and verify it.',
    { kind: 'general', objective: 'Repair the named project' }
  );
  assert.equal(named.project.projectId, release.projectId);
  assert.equal(named.workspace, fs.realpathSync(f.repo));
});
