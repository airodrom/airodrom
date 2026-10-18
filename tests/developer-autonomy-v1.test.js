'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const ControlServer = require('../src/control-server');

// Objectives are human-readable fixture labels, not random identifiers.
let objectiveSequence = 0;
async function setup(t) {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals.find(g => g.status === 'active')
    || f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Developer Autonomy fixture goal' });
  f.seed = { project_id: project.projectId, goal_id: goal.goalId };
  f.enrollInput = {
    alias: 'fixture-da',
    repository: f.repo,
    project_id: f.seed.project_id,
    goal_id: f.seed.goal_id,
    workflows: ['routine_edit', 'test', 'repair', 'feature_branch', 'draft_pr'],
    budgets: { max_repairs: 2, max_concurrent_missions: 1, grant_ttl_minutes: 60, max_files: 8, max_worktrees: 4, max_runtime_hours: 2, max_disk_mb: 512 },
    workers: ['opencode'],
    duration_days: 30,
    confirmed: true,
    diff_check: 'diff-check',
    default_tests: ['fixture-test']
  };
  return f;
}

test('generated manifest UUID avoids card-text false positives without allowing secret titles or malformed IDs', async t => {
  const f = await setup(t), da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  const auth = da.authorizeRoutine({ policy_id: policy.policy_id, request_id: randomUUID(), objective: 'Manifest identity fixture', allowed_files: ['fixture.txt'] }, 'operator');
  const { containsSecret } = require('../src/personal-memory');
  const id = Array.from({ length: 100 }, (_, n) => 'da-grant-41111111-1111-4' + String(n).padStart(3, '0') + '-8111-abcdefabcdef').find(containsSecret);
  assert.ok(id);
  const manifest = structuredClone(auth.mission_input.manifest);
  const options = { workspace: auth.mission_input.workspace, allowedFiles: auth.mission_input.allowed_files, verification: auth.mission_input.verification };
  manifest.mission.id = id;
  const normalize = require('../src/mission-manifest').normalizeManifest;
  assert.equal(normalize(manifest, options).id, id);
  for (const invalid of [id + '-extra', 'da-grant-4111111111111111', 'sk-fixtureprivatecredential'])
    assert.throws(() => normalize({ mission: { ...manifest.mission, id: invalid } }, options), /sensitive manifest id/);
  assert.throws(() => normalize({ mission: { ...manifest.mission, title: 'sk-fixtureprivatecredential' } }, options), /sensitive manifest title/);
});

test('owner-only enrollment, durable inspection, and reject unconfirmed consent', async t => {
  const f = await setup(t);
  const da = f.bridge.developerAutonomy;
  assert.throws(() => da.enroll(f.enrollInput, 'mcp:fixture'), /operator/);
  assert.throws(() => da.enroll({ ...f.enrollInput, confirmed: false }, 'operator'), /consent/);
  const policy = da.enroll(f.enrollInput, 'operator');
  assert.equal(policy.state, 'active');
  assert.equal(policy.privacy, 'local_only');
  assert.deepEqual(policy.workers, ['opencode']);
  assert.ok(policy.never_auto.includes('protected_branch_merge'));
  assert.throws(() => da.enroll(f.enrollInput, 'operator')); // alias unique
  await f.reopen();
  assert.equal(f.bridge.developerAutonomy.list('operator')[0].policy_hash, policy.policy_hash);
});

test('dirty source preserves unique work and creates disposable worktree', async t => {
  const f = await setup(t);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  fs.writeFileSync(path.join(f.repo, 'owner-note.txt'), 'unique owner work\n');
  const dirtyBefore = fs.readFileSync(path.join(f.repo, 'owner-note.txt'), 'utf8');
  const ws = da.prepareWorkspace({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    prefer_disposable: false
  }, 'operator');
  assert.equal(ws.disposable, true);
  assert.match(ws.reason, /dirty_source_preserved|disposable/);
  assert.ok(ws.preserved_dirty.includes('owner-note.txt'));
  assert.equal(fs.readFileSync(path.join(f.repo, 'owner-note.txt'), 'utf8'), dirtyBefore);
  assert.ok(fs.existsSync(path.join(ws.path, 'fixture.txt')));
  assert.equal(fs.existsSync(path.join(ws.path, 'owner-note.txt')), false);
});

test('symlink, path escape, and root substitution fail closed', async t => {
  const f = await setup(t);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  const ws = da.prepareWorkspace({ policy_id: policy.policy_id, request_id: randomUUID() }, 'operator');
  fs.symlinkSync(path.join(ws.path, 'fixture.txt'), path.join(ws.path, 'linked.txt'));
  assert.throws(() => da.issueGrant({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    workspace: ws.path,
    workspace_id: ws.workspace_id,
    allowed_files: ['linked.txt'],
    workflow: 'routine_edit',
    objective: 'Synthetic'
  }, 'operator'), /symlink|regular file/i);
  assert.throws(() => da.issueGrant({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    workspace: ws.path,
    workspace_id: ws.workspace_id,
    allowed_files: ['../outside'],
    workflow: 'routine_edit',
    objective: 'Synthetic'
  }, 'operator'), /file|Exact/i);
  // Root substitution: rename enrolled repository identity
  const renamed = f.repo + '-moved';
  fs.renameSync(f.repo, renamed);
  try {
    const inspected = da.inspect(policy.policy_id);
    assert.equal(inspected.state, 'invalid');
  } catch (e) {
    assert.match(String(e.message || e), /identity|ENOENT|mismatch|repository|integrity/i);
  } finally {
    if (!fs.existsSync(f.repo) && fs.existsSync(renamed)) fs.renameSync(renamed, f.repo);
  }
});

test('revoked and expired policy/grant fail closed at dispatch', async t => {
  const f = await setup(t);
  qualifyCanonical(f.bridge);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  const auth = da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'DA revoke probe ' + (++objectiveSequence),
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  }, 'operator');
  const mission = f.bridge.missions.create(auth.mission_input, 'operator');
  assert.equal(mission.state, 'ready');
  assert.throws(() => f.bridge.missions.create({ ...auth.mission_input, request_id: randomUUID(), contract: { permissions: { allowed_tools: ['shell:node:extra'] } } }, 'operator'), /host-derived/);
  da.revoke({ policy_id: policy.policy_id, policy_hash: policy.policy_hash, confirmed: true }, 'operator');
  assert.throws(() => f.bridge.missions.dispatch(mission.id, { request_id: randomUUID() }), /revoked|expired|changed|grant/i);

  const policy2 = da.enroll({ ...f.enrollInput, alias: 'fixture-da-exp' }, 'operator');
  const grant = da.authorizeRoutine({
    policy_id: policy2.policy_id,
    request_id: randomUUID(),
    objective: 'DA expiry probe ' + (++objectiveSequence),
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  }, 'operator');
  const m2 = f.bridge.missions.create(grant.mission_input, 'operator');
  const now = Date.now;
  try {
    Date.now = () => grant.grant.expires_at + 1;
    assert.equal(da.inspectGrant(grant.grant.grant_id).state, 'expired');
    assert.throws(() => f.bridge.missions.dispatch(m2.id, { request_id: randomUUID() }), /expired|changed|grant/i);
  } finally {
    Date.now = now;
  }
});

test('authorizeRoutine Mission completes with OpenCode fixture without WORK template renewal', async t => {
  const f = await setup(t);
  qualifyCanonical(f.bridge);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  // No WORK template registered — standing DA policy alone is enough.
  assert.equal(f.bridge.workTemplates.list('operator').length, 0);
  const auth = da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'Change fixture.txt from alpha to beta. DA acceptance ' + (++objectiveSequence),
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  }, 'operator');
  assert.ok(auth.workspace.disposable);
  assert.equal(auth.grant.state, 'active');
  assert.ok(auth.workspace.path.includes('.airodrom-da-worktrees'));
  const mission = f.bridge.missions.create(auth.mission_input, 'operator');
  f.bridge.missions.dispatch(mission.id, { request_id: randomUUID() });
  const done = await f.settle(mission.id);
  assert.equal(done.state, 'awaiting_acceptance');
  assert.equal(done.runs[0].agent_id, 'opencode');
  assert.ok(done.envelope.contract?.scope_fingerprint);
  assert.equal(done.envelope.contract.identity.expires_at, auth.grant.expires_at);
  assert.ok(done.verifications[0].evidence.some(c => c.id === 'security:secret_scan' && c.status === 'passed'));
  assert.ok(done.verifications[0].evidence.some(c => c.id === 'task:fixture-test' && c.status === 'passed'));
  assert.equal(fs.readFileSync(path.join(auth.workspace.path, 'fixture.txt'), 'utf8'), 'beta\n');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
});

test('cleanup holds on unique commits and cleans empty disposable', async t => {
  const f = await setup(t);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  const ws = da.prepareWorkspace({ policy_id: policy.policy_id, request_id: randomUUID() }, 'operator');
  // Empty disposable with no unique commits → clean
  const cleaned = da.cleanupWorkspace({ workspace_id: ws.workspace_id, confirmed: true }, 'operator');
  assert.equal(cleaned.state, 'cleaned');
  assert.equal(cleaned.cleanup.action, 'clean');

  const ws2 = da.prepareWorkspace({ policy_id: policy.policy_id, request_id: randomUUID() }, 'operator');
  fs.writeFileSync(path.join(ws2.path, 'fixture.txt'), 'changed\n');
  execFileSync('/usr/bin/git', ['-C', ws2.path, 'add', 'fixture.txt'], { stdio: 'pipe' });
  execFileSync('/usr/bin/git', ['-C', ws2.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'unique'], { stdio: 'pipe' });
  const held = da.cleanupWorkspace({ workspace_id: ws2.workspace_id, confirmed: true }, 'operator');
  assert.equal(held.state, 'held');
  assert.equal(held.cleanup.action, 'hold');
  assert.ok(fs.existsSync(ws2.path));
});

test('budget exhaustion and concurrent grant ceiling fail closed', async t => {
  const f = await setup(t);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll({
    ...f.enrollInput,
    alias: 'fixture-da-budget',
    budgets: { ...f.enrollInput.budgets, max_concurrent_missions: 1, max_worktrees: 1 }
  }, 'operator');
  const a = da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'Change fixture.txt from alpha to beta.',
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit'
  }, 'operator');
  assert.ok(a.grant.grant_id);
  assert.throws(() => da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'Second concurrent',
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit'
  }, 'operator'), /budget|Concurrent|Worktree/i);
  assert.throws(() => da.issueGrant({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    workspace: a.workspace.path,
    workspace_id: a.workspace.workspace_id,
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    repair_budget: 99,
    objective: 'Over budget'
  }, 'operator'), /Repair budget|exceed|Concurrent Mission budget/i);
});

test('draft PR preparation never implies merge and requires feature branch workflow', async t => {
  const f = await setup(t);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  const auth = da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'Change fixture.txt from alpha to beta.',
    allowed_files: ['fixture.txt'],
    workflow: 'draft_pr'
  }, 'operator');
  // Clean workspace on feature branch
  const plan = da.prepareDraftPr({
    grant_id: auth.grant.grant_id,
    title: 'Draft: fixture alpha to beta',
    body: 'Synthetic draft. Review required.',
    confirmed: true
  }, 'operator');
  assert.equal(plan.draft, true);
  assert.equal(plan.merge, false);
  assert.equal(plan.deploy, false);
  assert.equal(plan.status, 'prepared');
  assert.ok(plan.branch.startsWith('airodrom/da/'));
});

test('ceiling escalation and WORK-template mutual exclusion', async t => {
  const f = await setup(t);
  qualifyCanonical(f.bridge);
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll(f.enrollInput, 'operator');
  const auth = da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'Change fixture.txt from alpha to beta.',
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  }, 'operator');
  assert.throws(() => f.bridge.missions.create({
    ...auth.mission_input,
    request_id: randomUUID(),
    capability_scopes: ['host']
  }, 'operator'), /ceiling|mismatch/i);
  // Mutual exclusion with work template ref
  f.bridge.workTemplates.register({
    project: 'fixture',
    workspace_alias: 'local',
    project_id: f.seed.project_id,
    goal_id: f.seed.goal_id,
    workspace: f.repo,
    allowed_files: ['fixture.txt'],
    diff_check: 'diff-check',
    tests: ['fixture-test'],
    duration_minutes: 60,
    confirmed: true
  }, 'operator');
  assert.throws(() => f.bridge.missions.create({
    ...auth.mission_input,
    request_id: randomUUID(),
    work_template: { project: 'fixture', workspace: 'local', hash: f.bridge.workTemplates.list('operator')[0].template_hash }
  }, 'operator'), /mutually exclusive/i);
});

test('API requires operator token; MCP and cross-origin fail closed', async t => {
  const f = await setup(t);
  const server = new ControlServer(f.bridge, { port: 0 });
  await server.start();
  t.after(() => server.close());
  for (const route of [
    '/api/assistant/developer-autonomy',
    '/api/assistant/developer-autonomy/enroll',
    '/api/assistant/developer-autonomy/revoke'
  ]) {
    for (const token of [null, server.mcpToken]) {
      const post = route.endsWith('enroll') || route.endsWith('revoke');
      const response = await fetch(server.origin + route, {
        method: post ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        ...(post ? { body: JSON.stringify(f.enrollInput) } : {})
      });
      assert.equal(response.status, 401);
    }
  }
  const cross = await fetch(server.origin + '/api/assistant/developer-autonomy/enroll', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + server.token,
      'Content-Type': 'application/json',
      Origin: 'https://untrusted.invalid'
    },
    body: JSON.stringify(f.enrollInput)
  });
  assert.equal(cross.status, 403);
  assert.equal(f.bridge.developerAutonomy.list('operator').length, 0);
});

test('supervisor standingAuthorization surfaces Developer Autonomy', async t => {
  const f = await setup(t);
  const da = f.bridge.developerAutonomy;
  let standing = require('../src/autonomous-supervisor').standingAuthorization(f.bridge);
  assert.equal(standing.active_count, 0);
  da.enroll(f.enrollInput, 'operator');
  standing = require('../src/autonomous-supervisor').standingAuthorization(f.bridge);
  assert.equal(standing.mechanism, 'developer_autonomy');
  assert.equal(standing.active_count, 1);
  assert.ok(standing.developer_autonomy.active_count === 1);
});


function routine(da, policy, extra = {}) {
  return da.authorizeRoutine({ policy_id: policy.policy_id, request_id: randomUUID(),
    objective: 'Change fixture.txt from alpha to beta. ' + (++objectiveSequence), allowed_files: ['fixture.txt'],
    workflow: 'routine_edit', ...extra }, 'operator');
}

test('enrolled verifier definitions and inputs stay immutable in disposable clones', async t => {
  const f = await setup(t), da = f.bridge.developerAutonomy, policy = da.enroll(f.enrollInput, 'operator');
  const ws = da.prepareWorkspace({policy_id: policy.policy_id, request_id: randomUUID()}, 'operator');
  const taskFile = path.join(ws.path, '.vscode/tasks.json'), before = fs.readFileSync(taskFile);
  const config = JSON.parse(before); config.tasks.find(task => task.label === 'fixture-test').args = ['--version'];
  fs.writeFileSync(taskFile, JSON.stringify(config));
  const input = {policy_id: policy.policy_id, request_id: randomUUID(), workspace: ws.path, workspace_id: ws.workspace_id,
    allowed_files: ['fixture.txt'], workflow: 'routine_edit', objective: 'Reject substituted verifier'};
  assert.throws(() => da.issueGrant(input, 'operator'), /verification definitions/);
  fs.writeFileSync(taskFile, before);
  const grant = da.issueGrant(input, 'operator');
  fs.writeFileSync(taskFile, JSON.stringify(config));
  assert.throws(() => da.grantScope(grant.grant_id), /verification definitions/);
  fs.writeFileSync(taskFile, before);
  fs.renameSync(taskFile, taskFile + '.saved'); fs.symlinkSync(taskFile + '.saved', taskFile);
  assert.throws(() => da.grantScope(grant.grant_id), /verification definitions/);
});

test('cleanup holds queued Missions and requires proven terminal ownership', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput, 'operator');
  const auth = routine(da, policy), m = b.missions.create(auth.mission_input, 'operator');
  b.missions.dispatch(m.id, {request_id: randomUUID()});
  assert.equal(da.inspectWorkspace(auth.workspace.workspace_id).mission_id, m.id);
  const held = da.cleanupWorkspace({workspace_id: auth.workspace.workspace_id, confirmed: true}, 'operator');
  assert.equal(held.state, 'held'); assert.ok(fs.existsSync(auth.workspace.path));
  b.missions.cancel(m.id, {request_id: randomUUID()});
  assert.equal(da.cleanupWorkspace({workspace_id: auth.workspace.workspace_id, confirmed: true}, 'operator').state, 'cleaned');
});

test('cleanup holds unverified termination and ignored preservation content', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput, 'operator');
  const auth = routine(da, policy), m = b.missions.create(auth.mission_input, 'operator');
  b.missions.cancel(m.id, {request_id: randomUUID()});
  const run = b.controlStore.startRun({id: randomUUID(), missionId: m.id, taskId: m.task_id, agentId: 'host'});
  const held = da.cleanupWorkspace({workspace_id: auth.workspace.workspace_id, confirmed: true}, 'operator');
  assert.equal(held.state, 'held'); assert.ok(fs.existsSync(auth.workspace.path));
  b.controlStore.updateRun(run.id || run, {state:'cancelled', processState:'not_started', verified:true});
  fs.appendFileSync(path.join(auth.workspace.path, '.git/info/exclude'), '\nkeep-note\n');
  fs.writeFileSync(path.join(auth.workspace.path, 'keep-note'), 'synthetic retained content');
  assert.equal(da.cleanupWorkspace({workspace_id: auth.workspace.workspace_id, confirmed: true}, 'operator').cleanup.reason, 'ignored_or_unknown_content_retained');
});

test('workspace identity substitution and container symlinks fail closed', async t => {
  const f = await setup(t), da = f.bridge.developerAutonomy, policy = da.enroll(f.enrollInput, 'operator');
  const alternate = path.join(f.root, 'alternate'); fs.mkdirSync(alternate);
  const container = path.join(path.dirname(f.repo), '.airodrom-da-worktrees');
  fs.symlinkSync(alternate, container);
  assert.throws(() => da.prepareWorkspace({policy_id: policy.policy_id, request_id: randomUUID()}, 'operator'), /identity|ownership/);
  fs.unlinkSync(container);
  const ws = da.prepareWorkspace({policy_id: policy.policy_id, request_id: randomUUID()}, 'operator');
  const retained = ws.path + '-retained'; fs.renameSync(ws.path, retained);
  execFileSync('/usr/bin/git', ['clone', '--local', '--no-hardlinks', retained, ws.path], {stdio:'pipe'});
  assert.equal(da.cleanupWorkspace({workspace_id: ws.workspace_id, confirmed:true}, 'operator').state, 'held');
  assert.ok(fs.existsSync(ws.path)); assert.ok(fs.existsSync(retained));
});

test('authorization replay reuses one workspace and grant; unrelated Mission reuse is denied', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput, 'operator');
  const input = {request_id: randomUUID(), objective: 'Replay bounded edit'};
  const first = routine(da, policy, input), replay = routine(da, policy, input);
  assert.equal(replay.grant.grant_id, first.grant.grant_id);
  assert.equal(replay.workspace.workspace_id, first.workspace.workspace_id);
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_developer_autonomy_workspaces').get().n, 1);
  const mission = b.missions.create(first.mission_input, 'operator');
  assert.equal(b.missions.create(first.mission_input, 'operator').id, mission.id);
  assert.throws(() => b.missions.create({...first.mission_input, request_id: randomUUID(), objective:'Second Mission'}, 'operator'), /already bound/);
  assert.throws(() => routine(da, policy, {...input, objective:'Changed replay'}), /replay/);
  b.missions.cancel(mission.id, {request_id:randomUUID()});
  assert.equal(da.inspectGrant(first.grant.grant_id).state, 'consumed');
  assert.ok(routine(da, policy).grant.grant_id);
});

test('disk budget rejects clone preparation before allocating a new workspace', async t => {
  const f = await setup(t), da = f.bridge.developerAutonomy;
  const policy = da.enroll({...f.enrollInput, budgets:{...f.enrollInput.budgets,max_disk_mb:64}}, 'operator');
  const trees = path.join(da.dataRoot(f.repo), 'worktrees'), canary = path.join(trees, 'retained-large-file');
  const fd = fs.openSync(canary, 'wx'); fs.ftruncateSync(fd, 65*1024*1024); fs.closeSync(fd);
  assert.throws(() => routine(da, policy), /disk budget/);
  assert.ok(fs.existsSync(canary));
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_developer_autonomy_workspaces').get().n,0);
});

test('ordinary owner request uses enrollment; MCP remains a proposal', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy;
  const policy = da.enroll({...f.enrollInput, workflows:['routine_edit'], budgets:{...f.enrollInput.budgets,max_repairs:0}}, 'operator');
  const instruction = 'Fix fixture.txt from alpha to beta';
  const remoteId = randomUUID();
  const remote = await b.zeroSetupWork.ask({instruction, request_id:remoteId}, 'mcp:fixture');
  assert.equal(remote.state,'WAIT'); assert.equal(remote.execution_authorized,false);
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_developer_autonomy_grants').get().n,0);
  const localId = randomUUID();
  const local = await b.zeroSetupWork.ask({instruction, request_id:localId}, 'operator');
  assert.equal(local.execution_authorized,true);
  const record = b.zeroSetupWork.read(localId), mission = b.controlStore.requireMission(record.mission_id);
  assert.equal(mission.envelope.developer_autonomy.policy_id,policy.policy_id);
  assert.notEqual(mission.envelope.workspace,f.repo);
  assert.equal(da.inspectGrant(mission.envelope.developer_autonomy.grant_id).repair_budget,0);
  assert.equal(b.workTemplates.list('operator').length,0);
  b.missions.cancel(mission.id,{request_id:randomUUID()});
});

test('repair keeps grant lineage and rejects zero budget and revocation', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput,'operator');
  const auth = routine(da,policy,{objective:'Synthetic unchanged implementation',repair_budget:0,
    criteria:[{id:'expected-file',type:'exact_file',path:'fixture.txt',content:'beta\n'}]});
  const m = b.missions.create(auth.mission_input,'operator'); b.missions.dispatch(m.id,{request_id:randomUUID()});
  await f.settle(m.id,'needs_rework');
  const failed = b.controlStore.requireMission(m.id), repair = require('../src/autonomous-repair');
  const input = repair.repairInput(failed,{objective:'Bounded correction'},{request_id:randomUUID()});
  assert.deepEqual(input.developer_autonomy,failed.envelope.developer_autonomy);
  assert.throws(()=>b.missions.create({...input,developer_autonomy:undefined},'operator'),/retain.*grant/);
  assert.throws(()=>b.missions.create(input,'operator'),/repair budget/);
  da.revoke({policy_id:policy.policy_id,policy_hash:policy.policy_hash,confirmed:true},'operator');
  assert.throws(()=>b.missions.create(input,'operator'),/revoked|expired|changed/);
});

test('explicitly named enrolled requests retain the full instruction beyond the plan display limit', async t => {
  const f=await setup(t),b=f.bridge,da=b.developerAutonomy;
  da.enroll({...f.enrollInput,workflows:['routine_edit'],budgets:{...f.enrollInput.budgets,max_repairs:0}},'operator');
  const instruction='For Fixture project, fix fixture.txt with these requirements: '+ 'Preserve existing content. '.repeat(45) + 'Final requirement: keep the trailing newline.';
  assert.ok(instruction.length>1000);
  const request_id=randomUUID();
  const result=await b.zeroSetupWork.ask({instruction,request_id},'operator');
  assert.equal(result.execution_authorized,true);
  const record=b.zeroSetupWork.read(request_id),mission=b.controlStore.requireMission(record.mission_id);
  assert.equal(record.intent.objective,instruction);
  assert.equal(mission.envelope.objective,instruction);
  assert.equal(mission.envelope.contract.objective.original_instruction,instruction);
  b.missions.cancel(mission.id,{request_id:randomUUID()});
});


test('permitted repair preserves limits, completes, and releases its reservation', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput,'operator');
  const auth = routine(da,policy,{objective:'Synthetic unchanged implementation',repair_budget:1,
    criteria:[{id:'expected-file',type:'exact_file',path:'fixture.txt',content:'beta\n'}]});
  const parent = b.missions.create(auth.mission_input,'operator'); b.missions.dispatch(parent.id,{request_id:randomUUID()});
  await f.settle(parent.id,'needs_rework');
  const failed = b.controlStore.requireMission(parent.id);
  const repair = require('../src/autonomous-repair');
  const childId = b.controlStore.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(parent.id).id;
  const queued = b.controlStore.getMission(childId);
  assert.equal(queued.envelope.authority.expiresAt, parent.envelope.authority.expiresAt);
  assert.equal(queued.envelope.developer_autonomy.grant_id, auth.grant.grant_id);
  assert.equal(b.missions.detail(childId).acceptance.length, 0);
  assert.throws(()=>b.missions.create(repair.repairInput(failed,{objective:'Extra correction'},{request_id:randomUUID()}),'operator'),/repair budget|repair already/);
  const done = await f.settle(childId);
  assert.equal(done.state,'awaiting_acceptance');
  b.missions.accept(childId,{request_id:randomUUID(),decision:'accept',verification_id:done.verifications[0].id,rationale:'Synthetic exact bytes and independent checks verified'},'operator');
  assert.equal(da.inspectGrant(auth.grant.grant_id).state,'consumed');
  assert.ok(routine(da,policy).grant.grant_id);
});

test('owner Acceptance remains available after Developer Autonomy grant TTL expiry', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput,'operator');
  const auth = routine(da,policy,{criteria:[{id:'expected-file',type:'exact_file',path:'fixture.txt',content:'beta\n'}]});
  const m = b.missions.create(auth.mission_input,'operator');
  b.missions.dispatch(m.id,{request_id:randomUUID()});
  const done = await f.settle(m.id);
  assert.equal(done.state,'awaiting_acceptance');
  da.assertMission(b.controlStore.requireMission(m.id));
  b.controlStore.db.prepare('UPDATE cp_developer_autonomy_grants SET expires_at=? WHERE grant_id=?')
    .run(Date.now() - 1, auth.grant.grant_id);
  assert.equal(da.inspectGrant(auth.grant.grant_id).state,'expired');
  assert.throws(()=>da.assertMission(b.controlStore.requireMission(m.id)),/expired|revoked|changed/);
  assert.throws(()=>da.assertDispatch(b.controlStore.requireMission(m.id)),/expired|revoked|changed|not active/);
  da.assertMission(b.controlStore.requireMission(m.id),{allowExpiredGrant:true});
  // Supervisor must not convert verified awaiting_acceptance into blocked on TTL expiry.
  const task = b.tasks.get(m.task_id);
  const expiredAuthority = { ...task.mission.authority, expiresAt: Date.now() - 1 };
  task.mission = { ...task.mission, authority: expiredAuthority };
  b.tasks.save(task);
  await b.supervisor.tick(Date.now());
  assert.equal(b.controlStore.requireMission(m.id).state,'awaiting_acceptance');
  b.missions.accept(m.id,{
    request_id:randomUUID(),
    decision:'accept',
    verification_id:done.verifications[0].id,
    rationale:'Independent verification already passed; grant TTL must not block owner Acceptance.'
  },'operator');
  assert.equal(b.controlStore.requireMission(m.id).state,'completed');
});

test('owner Acceptance still works if authority expiry incorrectly blocked after verification', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput,'operator');
  const auth = routine(da,policy,{criteria:[{id:'expected-file',type:'exact_file',path:'fixture.txt',content:'beta\n'}]});
  const m = b.missions.create(auth.mission_input,'operator');
  // Live DA asks bind Missions into goal plans; Accept must survive that assert path too.
  b.missions.goalPlanner.create({
    request_id: randomUUID(),
    goal_id: m.goal_id,
    stages: [{ id: 'work', depends_on: [], mission_id: m.id, objective: 'o', acceptance_criteria: ['a'], verification_requirements: ['v'], human_checkpoint: false }],
    max_runtime_hours: 1,
    max_attempts: 3
  });
  b.missions.dispatch(m.id,{request_id:randomUUID()});
  const done = await f.settle(m.id);
  assert.equal(done.state,'awaiting_acceptance');
  const verifiedRevision = b.controlStore.requireMission(m.id).revision;
  b.controlStore.state(m.id,'blocked','Mission authority expired');
  assert.equal(b.controlStore.requireMission(m.id).state,'blocked');
  assert.ok(b.controlStore.requireMission(m.id).revision > verifiedRevision);
  b.controlStore.db.prepare('UPDATE cp_developer_autonomy_grants SET expires_at=? WHERE grant_id=?')
    .run(Date.now() - 1, auth.grant.grant_id);
  assert.doesNotThrow(() => b.missions.goalPlanner.assertMission(b.controlStore.requireMission(m.id)));
  assert.doesNotThrow(() => b.missions.program.assertAcceptance(b.controlStore.requireMission(m.id), done.verifications[0].id));
  b.missions.accept(m.id,{
    request_id:randomUUID(),
    decision:'accept',
    verification_id:done.verifications[0].id,
    rationale:'Verified work remains Acceptable after mistaken authority-expiry block.'
  },'operator');
  assert.equal(b.controlStore.requireMission(m.id).state,'completed');
});

test('unused revoked grant can clean only its proven idle disposable clone', async t => {
  const f = await setup(t), da = f.bridge.developerAutonomy, policy = da.enroll(f.enrollInput,'operator');
  const auth = routine(da,policy);
  assert.equal(da.cleanupWorkspace({workspace_id:auth.workspace.workspace_id,confirmed:true},'operator').state,'held');
  da.revoke({policy_id:policy.policy_id,policy_hash:policy.policy_hash,confirmed:true},'operator');
  assert.equal(da.cleanupWorkspace({workspace_id:auth.workspace.workspace_id,confirmed:true},'operator').state,'cleaned');
});

test('alternate registered test cannot broaden enrolled verification', async t => {
  const f = await setup(t);
  const name = path.join(f.repo,'.vscode/tasks.json'), tasks = JSON.parse(fs.readFileSync(name,'utf8'));
  tasks.tasks.push({label:'alternate-check',type:'process',command:'node',args:['custom-validator.cjs']});
  fs.writeFileSync(name,JSON.stringify(tasks)); fs.writeFileSync(path.join(f.repo,'custom-validator.cjs'),'process.exitCode=0;\n');
  execFileSync('/usr/bin/git',['-C',f.repo,'add','.'],{stdio:'pipe'});
  execFileSync('/usr/bin/git',['-C',f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','-qm','fixture alternate verifier'],{stdio:'pipe'});
  const da=f.bridge.developerAutonomy, policy=da.enroll(f.enrollInput,'operator');
  assert.throws(()=>routine(da,policy,{tests:['alternate-check'],allowed_files:['custom-validator.cjs']}),/enrolled tasks/);
});

test('MANUAL Developer Autonomy cannot enable or inherit automatic Acceptance', async t => {
  const f = await setup(t), b = f.bridge, da = b.developerAutonomy, policy = da.enroll(f.enrollInput,'operator');
  assert.throws(()=>b.missions.riskAcceptance.setPreference({enabled:true,confirmed:true},'operator'),/MANUAL/);
  const auth = routine(da,policy,{criteria:[{id:'expected-file',type:'exact_file',path:'fixture.txt',content:'beta\n'}]});
  assert.throws(()=>b.missions.create({...auth.mission_input,risk_auto_acceptance:true},'operator'),/explicit Acceptance/);
  const m=b.missions.create(auth.mission_input,'operator');
  assert.equal(m.envelope.risk_auto_acceptance,undefined);
  assert.throws(()=>b.missions.riskAcceptance.authorizeExisting(m.id,{request_id:randomUUID(),confirmed:true},'operator'),/explicit Acceptance/);
  assert.equal(b.missions.riskAcceptance.evaluate(m.id).reason,'expanded_autonomy_manual_or_stopped');
  b.missions.dispatch(m.id,{request_id:randomUUID()});
  const done=await f.settle(m.id);
  assert.equal(done.state,'awaiting_acceptance');
});


test('cleanup preserves tracked changes hidden by either Git index flag', async t => {
  const f=await setup(t),da=f.bridge.developerAutonomy,policy=da.enroll(f.enrollInput,'operator');
  for(const flag of ['--assume-unchanged','--skip-worktree']) {
    const ws=da.prepareWorkspace({policy_id:policy.policy_id,request_id:randomUUID()},'operator');
    execFileSync('/usr/bin/git',['-C',ws.path,'update-index',flag,'fixture.txt'],{stdio:'pipe'});
    fs.writeFileSync(path.join(ws.path,'fixture.txt'),'unique synthetic preserved content\n');
    const result=da.cleanupWorkspace({workspace_id:ws.workspace_id,confirmed:true},'operator');
    assert.equal(result.state,'held');
    assert.equal(result.cleanup.reason,'hidden_index_content_retained');
    assert.equal(fs.readFileSync(path.join(ws.path,'fixture.txt'),'utf8'),'unique synthetic preserved content\n');
  }
});

test('an enrolled linked checkout can prepare a separate self-contained clone', async t => {
  const f=await setup(t),b=f.bridge,da=b.developerAutonomy;
  const linked=path.join(f.root,'linked-checkout');
  execFileSync('/usr/bin/git',['-C',f.repo,'worktree','add','--detach',linked],{stdio:'pipe'});
  b.projects.updateProject(f.seed.project_id,{repositories:[f.repo,linked]});
  const policy=da.enroll({...f.enrollInput,repository:linked},'operator');
  const ws=da.prepareWorkspace({policy_id:policy.policy_id,request_id:randomUUID()},'operator');
  assert.ok(fs.lstatSync(path.join(ws.path,'.git')).isDirectory());
  assert.equal(fs.readFileSync(path.join(linked,'fixture.txt'),'utf8'),'alpha\n');
});

test('explicit auxiliary merchant app tests may change under pinned static verification', async t => {
  const f = await setup(t), da = f.bridge.developerAutonomy;
  const relative = 'tests/unit/test_merchant_hub_policy.ts';
  const sourceTest = path.join(f.repo, relative);
  fs.mkdirSync(path.dirname(sourceTest), { recursive: true });
  const initial = 'import assert from "node:assert/strict";\nassert.equal(1, 1);\nassert.notEqual(1, 2);\n';
  fs.writeFileSync(sourceTest, initial);
  const taskPath = path.join(f.repo, '.vscode/tasks.json');
  const tasks = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  tasks.tasks.push({ label: 'static-typecheck', type: 'process', command: 'npm', args: ['run', 'typecheck'] });
  fs.writeFileSync(taskPath, JSON.stringify(tasks));
  const packagePath = path.join(f.repo, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch { /* disposable fixture */ }
  fs.writeFileSync(packagePath, JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, typecheck: 'tsc --noEmit' } }));
  execFileSync('/usr/bin/git', ['-C', f.repo, 'add', '.vscode/tasks.json', 'package.json', relative]);
  execFileSync('/usr/bin/git', ['-C', f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Register static verifier and application test'], { stdio: 'pipe' });

  const policy = da.enroll({ ...f.enrollInput, default_tests: ['static-typecheck'] }, 'operator');
  const ws = da.prepareWorkspace({ policy_id: policy.policy_id, request_id: randomUUID() }, 'operator');
  const grant = da.issueGrant({
    policy_id: policy.policy_id, request_id: randomUUID(), workspace: ws.path, workspace_id: ws.workspace_id,
    allowed_files: [relative], workflow: 'routine_edit', objective: 'Extend the auxiliary test'
  }, 'operator');
  assert.ok(grant.grant_id);
  const scope = da.grantScope(grant.grant_id);
  const mission = f.bridge.missions.create({
    request_id: randomUUID() + ':mission',
    project_id: scope.project_id,
    goal_id: scope.goal_id,
    objective: 'Extend the auxiliary test',
    workspace: scope.workspace,
    allowed_files: scope.allowed_files,
    criteria: scope.criteria,
    verification: scope.verification,
    preferred_agent: 'opencode',
    fallback_agents: [],
    capability_scopes: scope.capability_scopes,
    authority: scope.authority,
    manifest: scope.manifest,
    dispatch_policy: scope.dispatch_policy,
    developer_autonomy: scope.developer_autonomy
  }, 'operator');
  assert.equal(mission.state, 'ready');
  assert.ok(mission.envelope.contract.permissions.allowed_write_paths.includes(relative));
  assert.throws(() => f.bridge.missions.create({
    request_id: randomUUID(), project_id: scope.project_id, goal_id: scope.goal_id,
    objective: 'Ungranted test edit', workspace: scope.workspace, allowed_files: [relative],
    criteria: scope.criteria, verification: scope.verification, preferred_agent: 'opencode'
  }, 'operator'), /protected/);
  const target = path.join(ws.path, relative);
  fs.appendFileSync(target, 'assert.equal(2, 2);\n');
  assert.doesNotThrow(() => da.assertVerifiers(policy, ws.path, [relative]));

  fs.writeFileSync(target, '/* weakened tests */\n');
  assert.throws(() => da.assertVerifiers(policy, ws.path, [relative]), /weakened existing assertions/);
  fs.writeFileSync(target, initial.replace('assert.equal(1, 1);', 'assert.equal(true, true);'));
  assert.throws(() => da.assertVerifiers(policy, ws.path, [relative]), /weakened existing assertions/);
  fs.writeFileSync(target, initial.replace('assert.notEqual(1, 2);', 'assert.equal(1, 1);'));
  assert.throws(() => da.assertVerifiers(policy, ws.path, [relative]), /weakened existing assertions/);
  fs.writeFileSync(target, initial + 'if (false) { assert.equal(1, 1); }\n');
  assert.throws(() => da.assertVerifiers(policy, ws.path, [relative]), /not a recognized additive assertion/);
  fs.writeFileSync(target, 'const assert = { equal() {}, notEqual() {} };\n' + initial);
  assert.throws(() => da.assertVerifiers(policy, ws.path, [relative]), /weakened existing assertions/);
  fs.writeFileSync(target, initial);
  fs.writeFileSync(path.join(ws.path, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node weaken.js' } }));
  assert.throws(() => da.assertVerifiers(policy, ws.path, [relative]), /overlap writable scope|verification definitions|weakened/);
  fs.writeFileSync(path.join(ws.path, 'package.json'), fs.readFileSync(path.join(f.repo, 'package.json')));
  const config = fs.readFileSync(path.join(ws.path, '.vscode/tasks.json'), 'utf8');
  fs.writeFileSync(path.join(ws.path, '.vscode/tasks.json'), config + ' ');
  assert.throws(() => da.assertVerifiers(policy, ws.path, [relative]), /verification definitions/);

  const locked = da.enroll({ ...f.enrollInput, alias: 'fixture-da-immutable' }, 'operator');
  assert.throws(() => da.assertVerifiers(locked, f.repo, [relative]), /overlap writable scope/);
});

test('a granted application test survives creation, comparison, and host verification', async t => {
  const f = await setup(t);
  qualifyCanonical(f.bridge);
  const source = 'export function validate(value: unknown): { ok: false, code: string } { return { ok: false, code: "missing_id" }; }\n';
  const applicationTest = 'const assert = { equal(actual: unknown, expected: unknown): void { if (actual !== expected) throw new Error("not equal"); } };\nassert.equal(1, 1);\n';
  fs.mkdirSync(path.join(f.repo, 'src'));
  fs.writeFileSync(path.join(f.repo, 'src/events.ts'), source);
  fs.writeFileSync(path.join(f.repo, 'tests/events.test.ts'), applicationTest);
  fs.writeFileSync(path.join(f.repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { typecheck: 'tsc --noEmit' } }));
  const tasks = JSON.parse(fs.readFileSync(path.join(f.repo, '.vscode/tasks.json'), 'utf8'));
  tasks.tasks.push({ label: 'static-typecheck', type: 'process', command: 'npm', args: ['run', 'typecheck'] });
  fs.writeFileSync(path.join(f.repo, '.vscode/tasks.json'), JSON.stringify(tasks));
  execFileSync('/usr/bin/git', ['-C', f.repo, 'add', 'src/events.ts', 'tests/events.test.ts', 'package.json', '.vscode/tasks.json'], { stdio: 'pipe' });
  execFileSync('/usr/bin/git', ['-C', f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Pin static typecheck and application test'], { stdio: 'pipe' });
  const tscDir = path.join(f.repo, 'node_modules/.bin');
  fs.mkdirSync(tscDir, { recursive: true });
  fs.writeFileSync(path.join(tscDir, 'tsc'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  const previous = f.host.exec.resolveFirst.bind(f.host.exec);
  f.host.exec.resolveFirst = candidates => {
    const npm = candidates.find(candidate => typeof candidate === 'string' && candidate.endsWith('/npm'));
    if (npm && fs.existsSync(npm)) return npm;
    return previous(candidates);
  };
  const worker = path.join(f.root, 'auxiliary-worker');
  fs.writeFileSync(worker, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('opencode v2.0.25');process.exit(0);}
let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{
  const objective=JSON.parse(raw).objective;
  const result={summary:'deterministic auxiliary fixture',changed_files:[],tests:[],artifacts:[],limitations:[]};
  if(objective.includes('AUXILIARY_GRANT_APPEND')){
    fs.writeFileSync('src/events.ts', ${JSON.stringify(source.replace('missing_id', 'checked'))});
    fs.writeFileSync('tests/events.test.ts', fs.readFileSync('tests/events.test.ts','utf8')+'assert.equal(2, 2);\\n');
    result.changed_files=['src/events.ts','tests/events.test.ts'];
  } else if(objective.includes('AUXILIARY_GRANT_REPLACE')){
    fs.writeFileSync('tests/events.test.ts','assert.equal(true, true);\\n');
    result.changed_files=['tests/events.test.ts'];
  } else if(objective.includes('AUXILIARY_GRANT_OUTSIDE')){
    fs.writeFileSync('outside.txt','nope\\n');
    result.changed_files=['outside.txt'];
  }
  console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'message_fixture',text:JSON.stringify(result)}}));
});
`, { mode: 0o755 });
  f.bridge.opencodeAdapter.options = Object.freeze({ ...f.bridge.opencodeAdapter.options, fixtureExecutable: worker });
  const da = f.bridge.developerAutonomy;
  const policy = da.enroll({ ...f.enrollInput, alias: 'fixture-da-lifecycle', default_tests: ['static-typecheck'] }, 'operator');
  const allowed = ['src/events.ts', 'tests/events.test.ts'];
  const auth = da.authorizeRoutine({
    policy_id: policy.policy_id, request_id: randomUUID(),
    objective: 'AUXILIARY_GRANT_APPEND implement the validator and append one assertion',
    allowed_files: allowed, workflow: 'routine_edit', diff_check: 'diff-check', tests: ['static-typecheck']
  }, 'operator');
  assert.throws(() => f.bridge.missions.create({
    ...auth.mission_input, request_id: randomUUID(),
    developer_autonomy: { ...auth.mission_input.developer_autonomy, hash: '0'.repeat(64) }
  }, 'operator'), /expired|revoked|changed/);
  assert.throws(() => f.bridge.missions.create({
    ...auth.mission_input, request_id: randomUUID(), allowed_files: ['tests/other.test.ts']
  }, 'operator'), /ceiling|protected|grant/);
  assert.throws(() => da.boundAuxiliaryFiles({ ...auth.mission_input, workspace: f.repo }), /Workspace grant mismatch/);
  assert.throws(() => f.bridge.missions.create({
    ...auth.mission_input, request_id: randomUUID(), developer_autonomy: undefined, allowed_files: ['tests/events.test.ts']
  }, 'operator'), /protected/);
  const mission = f.bridge.missions.create(auth.mission_input, 'operator');
  assert.equal(mission.state, 'ready');
  assert.deepEqual(mission.envelope.verification_manifest.authorized_auxiliary_files, ['tests/events.test.ts']);
  f.bridge.missions.dispatch(mission.id, { request_id: randomUUID() });
  const done = await f.settle(mission.id);
  assert.equal(done.state, 'awaiting_acceptance');
  assert.equal(done.acceptance.length, 0);
  assert.equal(done.verifications[0].result, 'operator_review');
  const checks = done.verifications[0].evidence;
  for (const id of ['repository_v2', 'creation_repository_v2', 'task:static-typecheck', 'task:diff-check', 'protected_tests_unchanged', 'verifier_inputs_unchanged']) {
    assert.equal(checks.find(check => check.id === id).status, id.startsWith('task:') || !id.includes('review') ? 'passed' : 'passed', id);
  }
  assert.equal(fs.readFileSync(path.join(auth.workspace.path, 'tests/events.test.ts'), 'utf8'), applicationTest + 'assert.equal(2, 2);\n');
  assert.match(fs.readFileSync(path.join(auth.workspace.path, 'src/events.ts'), 'utf8'), /checked/);
  const run = done.runs.find(item => item.agent_id === 'opencode');
  assert.equal(run.state, 'completed');
  assert.equal(run.termination_verified, 1);
  const leases = f.bridge.controlStore.db.prepare('SELECT state FROM cp_leases WHERE mission_id=?').all(mission.id);
  assert.ok(leases.length > 0);
  assert.ok(leases.every(lease => lease.state === 'released'));

  const replacement = da.enroll({ ...f.enrollInput, alias: 'fixture-da-replace', default_tests: ['static-typecheck'] }, 'operator');
  const denied = da.authorizeRoutine({
    policy_id: replacement.policy_id, request_id: randomUUID(),
    objective: 'AUXILIARY_GRANT_REPLACE rewrite the application test',
    allowed_files: ['tests/events.test.ts'], workflow: 'routine_edit', diff_check: 'diff-check', tests: ['static-typecheck']
  }, 'operator');
  const rejected = f.bridge.missions.create(denied.mission_input, 'operator');
  f.bridge.missions.dispatch(rejected.id, { request_id: randomUUID() });
  let settled;
  for (let n = 0; n < 200; n++) {
    await f.bridge.missions.tick();
    settled = f.bridge.missions.detail(rejected.id);
    if (['needs_rework', 'blocked', 'failed', 'awaiting_acceptance'].includes(settled.state)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.notEqual(settled.state, 'awaiting_acceptance');
  assert.equal(settled.acceptance.length, 0);
  assert.equal(fs.readFileSync(path.join(denied.workspace.path, 'tests/events.test.ts'), 'utf8'), applicationTest);
});
