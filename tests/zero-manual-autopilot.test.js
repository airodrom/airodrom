'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { preferUniqueProject, matchNamedProjects } = require('../src/project-resolution');
const { liveRepositories, isLiveGitRoot } = require('../src/project-defaults');

function gitInit(dir, { remote = 'git@github.com:example/repo.git', tasks = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { typecheck: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  if (tasks) {
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vscode/tasks.json'), JSON.stringify({
      version: '2.0.0',
      tasks: [
        { label: 'diff-check', type: 'process', command: 'git', args: ['diff', '--check'] },
        { label: 'fixture-test', type: 'process', command: 'node', args: ['-e', 'process.exit(0)'] },
      ],
    }));
  }
  spawnSync('git', ['-C', dir, 'add', '.'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base'], { encoding: 'utf8' });
  return dir;
}

test('live repository filter ignores cleaned non-git worktree leftovers', () => {
  const root = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'live-git-')));
  const dead = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-wt-'));
  fs.writeFileSync(path.join(dead, 'leftover.txt'), 'x');
  const project = { repositories: [root, dead] };
  assert.deepEqual(liveRepositories(project), [fs.realpathSync(root)]);
  assert.equal(isLiveGitRoot(dead), false);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dead, { recursive: true, force: true });
});

test('owner-configured default project wins shared token ambiguity', () => {
  const hits = matchNamedProjects('Continue Arecibo in Cursor', [
    { projectId: 'a', name: 'Arecibo Core', repositories: ['/tmp/a'] },
    { projectId: 'b', name: 'Arecibo product research', repositories: ['/tmp/b'] },
  ]);
  const ambiguous = preferUniqueProject(hits);
  assert.equal(ambiguous.clarify, true);
  const resolved = preferUniqueProject(hits, { defaultProjectIds: new Set(['a']) });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.project.projectId, 'a');
});

test('project default persists and selects the configured repository', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  const primary = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'arecibo-primary-')));
  const leftover = fs.mkdtempSync(path.join(os.tmpdir(), 'arecibo-leftover-'));
  fs.writeFileSync(path.join(leftover, 'gone.txt'), 'x');
  t.after(() => {
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(leftover, { recursive: true, force: true });
  });
  const project = f.bridge.projects.createProject({
    name: 'Arecibo Core',
    repositories: [primary, leftover],
    privacyPolicy: 'local_only',
  });
  const defaults = f.bridge.projectDefaults;
  const set = defaults.setDefault({
    project_id: project.projectId,
    repository: primary,
    confirmed: true,
    request_id: randomUUID(),
  }, 'operator');
  assert.equal(set.repository, fs.realpathSync(primary));
  assert.equal(defaults.read(project.projectId).repository, fs.realpathSync(primary));
  const selected = defaults.selectRepository(project, { instruction: 'Start the Arecibo Core release-readiness audit in Cursor. Do not deploy production.' });
  assert.equal(selected.ok, true);
  assert.equal(selected.workspace, fs.realpathSync(primary));
  assert.equal(selected.defaulted, true);
});

test('zero-setup Autopilot path uses default repo and does not ask for cleaned worktrees', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  f.bridge.globalAutopilot.enable({ confirmed: true, request_id: randomUUID() }, 'operator');
  const primary = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'arecibo-auto-')));
  const leftover = fs.mkdtempSync(path.join(os.tmpdir(), 'arecibo-auto-dead-'));
  t.after(() => {
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(leftover, { recursive: true, force: true });
  });
  const project = f.bridge.projects.createProject({
    name: 'Arecibo Core',
    repositories: [primary, leftover],
    privacyPolicy: 'local_only',
  });
  f.bridge.projectDefaults.setDefault({
    project_id: project.projectId,
    repository: primary,
    confirmed: true,
    request_id: randomUUID(),
  }, 'operator');

  const resolved = f.bridge.zeroSetupWork.resolveEnrolledProject('Start the Arecibo Core release-readiness audit in Cursor. Do not deploy production.');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.workspace, fs.realpathSync(primary));
  assert.ok(!resolved.clarify);

  const result = await f.bridge.zeroSetupWork.ask({
    instruction: 'Start the Arecibo Core release-readiness audit in Cursor. Do not deploy production.',
    request_id: randomUUID(),
  }, 'operator');
  assert.ok(!JSON.stringify(result.blockers || []).includes('ENROLLED_REPOSITORY_AMBIGUOUS'));
  assert.ok(!JSON.stringify(result.blockers || []).includes('projectless_exact_two_file'));
  assert.ok(result.state === 'PLANNING' || result.state === 'WAIT' || result.state === 'BLOCKED' || result.state === 'CLARIFY' || result.cognitive || result.execution_authorized === false);
  if (result.code) assert.notEqual(result.code, 'ENROLLED_REPOSITORY_AMBIGUOUS');
});

test('unauthorized repository default is rejected', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  const enrolled = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'enrolled-only-')));
  const outsider = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'outsider-only-')));
  t.after(() => {
    fs.rmSync(enrolled, { recursive: true, force: true });
    fs.rmSync(outsider, { recursive: true, force: true });
  });
  const project = f.bridge.projects.createProject({ name: 'Solo Product', repositories: [enrolled], privacyPolicy: 'local_only' });
  assert.throws(() => f.bridge.projectDefaults.setDefault({
    project_id: project.projectId,
    repository: outsider,
    confirmed: true,
    request_id: randomUUID(),
  }, 'operator'), /already be enrolled/i);
});

test('exact workspace label selects the matching live enrollment', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  const primary = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'label-primary-')));
  const secondary = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'label-secondary-')));
  t.after(() => {
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(secondary, { recursive: true, force: true });
  });
  const project = f.bridge.projects.createProject({
    name: 'Dual Core',
    repositories: [primary, secondary],
    privacyPolicy: 'local_only',
  });
  const label = path.basename(primary);
  const selected = f.bridge.projectDefaults.selectRepository(project, { explicitWorkspace: label });
  assert.equal(selected.ok, true);
  assert.equal(selected.workspace, fs.realpathSync(primary));
});

test('genuine ambiguity without default fails closed', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  const a = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'ambig-a-')));
  const b = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'ambig-b-')));
  t.after(() => {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
  const project = f.bridge.projects.createProject({
    name: 'Ambiguous Product',
    repositories: [a, b],
    privacyPolicy: 'local_only',
  });
  const selected = f.bridge.projectDefaults.selectRepository(project, {
    instruction: 'Continue developing Ambiguous Product in Cursor.',
  });
  assert.equal(selected.ok, false);
  assert.equal(selected.code, 'ENROLLED_REPOSITORY_AMBIGUOUS');
});

test('project default persists across ProjectDefaults reconstruction', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  const primary = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'persist-primary-')));
  t.after(() => fs.rmSync(primary, { recursive: true, force: true }));
  const project = f.bridge.projects.createProject({
    name: 'Persist Product',
    repositories: [primary],
    privacyPolicy: 'local_only',
  });
  f.bridge.projectDefaults.setDefault({
    project_id: project.projectId,
    repository: primary,
    confirmed: true,
    request_id: randomUUID(),
  }, 'operator');
  const { ProjectDefaults } = require('../src/project-defaults');
  const reloaded = new ProjectDefaults(f.bridge);
  assert.equal(reloaded.read(project.projectId).repository, fs.realpathSync(primary));
});

test('Autopilot verification accepts tasks.json when present', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  f.bridge.globalAutopilot.enable({ confirmed: true, request_id: randomUUID() }, 'operator');
  const primary = fs.realpathSync(gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-present-'))));
  t.after(() => fs.rmSync(primary, { recursive: true, force: true }));
  const project = f.bridge.projects.createProject({
    name: 'Tasks Present',
    repositories: [primary],
    privacyPolicy: 'local_only',
  });
  const policy = f.bridge.globalAutopilot.ensureRepositoryPolicy(project, primary);
  assert.ok(policy?.policy_id || policy?.alias || policy?.repository);
});

test('Autopilot re-enrolls after a revoked policy occupies the base alias', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  f.bridge.globalAutopilot.enable({ confirmed: true, request_id: randomUUID() }, 'operator');
  const primary = fs.realpathSync(gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'alias-reuse-'))));
  t.after(() => fs.rmSync(primary, { recursive: true, force: true }));
  const project = f.bridge.projects.createProject({
    name: 'Alias Reuse',
    repositories: [primary],
    privacyPolicy: 'local_only',
  });
  const first = f.bridge.globalAutopilot.ensureRepositoryPolicy(project, primary);
  assert.ok(first?.policy_id);
  const hash = first.policy_hash || f.bridge.developerAutonomy.inspect(first.policy_id)?.policy_hash
    || f.bridge.developerAutonomy.inspect(first.policy_id)?.hash;
  f.bridge.developerAutonomy.revoke({ policy_id: first.policy_id, policy_hash: hash, confirmed: true }, 'operator');
  const second = f.bridge.globalAutopilot.ensureRepositoryPolicy(project, primary);
  assert.ok(second?.policy_id);
  assert.notEqual(second.policy_id, first.policy_id);
  assert.match(second.alias || '', /^autopilot-/);
});

test('Autopilot without tasks.json and without Work template fails closed', async t => {
  const f = await fixture(t);
  f.bridge.missionAuthority.initializeOperatorKey();
  f.bridge.globalAutopilot.enable({ confirmed: true, request_id: randomUUID() }, 'operator');
  const primary = fs.realpathSync(gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-absent-')), { tasks: false }));
  t.after(() => fs.rmSync(primary, { recursive: true, force: true }));
  const project = f.bridge.projects.createProject({
    name: 'Tasks Absent',
    repositories: [primary],
    privacyPolicy: 'local_only',
  });
  assert.throws(
    () => f.bridge.globalAutopilot.ensureRepositoryPolicy(project, primary),
    /registered verification|tasks\.json|Work template/i
  );
});
