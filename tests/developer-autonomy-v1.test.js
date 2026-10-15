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
    objective: 'DA revoke probe ' + randomUUID(),
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  }, 'operator');
  const mission = f.bridge.missions.create(auth.mission_input, 'operator');
  assert.equal(mission.state, 'ready');
  da.revoke({ policy_id: policy.policy_id, policy_hash: policy.policy_hash, confirmed: true }, 'operator');
  assert.throws(() => f.bridge.missions.dispatch(mission.id, { request_id: randomUUID() }), /revoked|expired|changed|grant/i);

  const policy2 = da.enroll({ ...f.enrollInput, alias: 'fixture-da-exp' }, 'operator');
  const grant = da.authorizeRoutine({
    policy_id: policy2.policy_id,
    request_id: randomUUID(),
    objective: 'DA expiry probe ' + randomUUID(),
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
    objective: 'Change fixture.txt from alpha to beta. DA acceptance ' + randomUUID(),
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
