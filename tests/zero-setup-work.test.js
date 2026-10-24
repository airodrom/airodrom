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

test('standing Cursor intake executes once and reconnects without a repeated approval',async t=>{
 const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:0});f.plan=f.plan.slice(0,1);
 const prepared=await f.ask({review:false});assert.ok(prepared.mission_id,JSON.stringify(prepared));
 const done=await f.settle(prepared.mission_id,'completed');assert.equal(done.acceptance.length,1);assert.equal(f.calls.length,1);
 const replay=await f.bridge.zeroSetupWork.ask(f.request,'operator');assert.equal(replay.mission_id,done.id);assert.equal(replay.state,'ACCEPTED');assert.equal(f.calls.length,1);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT missions_used n FROM cp_standing_cursor_development WHERE id=?').get(f.grant.id).n,1);
});

test('MCP catalog includes ask_airodrom and get_ask_status', () => {
  const names = TOOLS.map(t => t.name);
  assert.ok(names.includes('ask_airodrom'));
  assert.ok(names.includes('get_ask_status'));
  assert.ok(names.includes('list_authorized_scopes'));
  for (const n of ['prepare_mission', 'inspect_mission_proposal', 'get_mission_status', 'get_mission_events', 'get_mission_evidence', 'request_mission_correction', 'cancel_mission']) assert.ok(names.includes(n), n);
  assert.equal(names.length, 53);
  assert.equal(new Set(names).size, 53, 'Every registered tool has a unique name');
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

test('Cursor first failure stays observable through correction and ends after bounded repair',async t=>{
 const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:1});f.plan=f.plan.slice(0,1);f.wrongFirst=true;
 let release,observe;const gate=new Promise(r=>release=r),started=new Promise(r=>observe=r),evaluate=f.evaluate;t.after(()=>release());
 f.evaluate=async o=>{if(f.evaluations.length===1){observe();await gate;}return evaluate(o);};
 const p=await f.ask({review:false});await started;
 const waiting=f.bridge.zeroSetupWork.refreshState(f.request.request_id);assert.ok(['RUNNING','VERIFYING'].includes(waiting.state),JSON.stringify(waiting));
 assert.equal(require('../src/zero-setup-terminal').isTerminalView(waiting),false);release();
 const done=await f.settle(p.mission_id,'completed');assert.equal(done.specialists.repair_attempts,1);assert.equal(done.specialists.assignments[0].attempts.length,2);
 const final=f.bridge.zeroSetupWork.refreshState(f.request.request_id);assert.equal(final.state,'ACCEPTED');assert.equal(require('../src/zero-setup-terminal').isTerminalView(final),true);
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
