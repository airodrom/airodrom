'use strict';
// Task-scoped sandbox for work that does not name an authorized repository.
// The directory is new, private, and not a view of any enrolled project.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function allocate() {
  const parent = path.join(os.tmpdir(), 'airodrom-task-sandboxes');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'task-')));
  fs.chmodSync(workspace, 0o700);
  fs.writeFileSync(path.join(workspace, 'TASK.md'), 'Task-scoped sandbox. No registered Project. No personal files.\n', { mode: 0o600 });
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  if (git.status !== 0) throw Error('task_sandbox_unavailable');
  return { workspace, projectless: true, project: null, filesystem: 'task_sandbox_only' };
}

function seedExactFixture(workspace) {
  fs.mkdirSync(path.join(workspace, 'tests'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'alpha\n', { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'tests', 'fixture.test.cjs'), "const assert=require('node:assert/strict');assert.equal(require('node:fs').readFileSync('fixture.txt','utf8'),'beta\\n');\n", { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'diff-check', type: 'process', command: 'git', args: ['diff', '--check'] }, { label: 'fixture-test', type: 'process', command: 'node', args: ['--test', 'tests/fixture.test.cjs'] }] }), { mode: 0o600 });
  const git = (...args) => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  if (git('add', '.').status !== 0) throw Error('task_sandbox_unavailable');
  const commit = spawnSync('git', ['-C', workspace, '-c', 'user.name=Airodrom', '-c', 'user.email=sandbox@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'task sandbox baseline'], { encoding: 'utf8' });
  if (commit.status !== 0) throw Error('task_sandbox_unavailable');
  return workspace;
}

function exactMissionInput(workspace, requestId) {
  return {
    request_id: requestId,
    projectless: true,
    objective: 'Change fixture.txt from alpha to beta. Make its test pass.',
    workspace,
    allowed_files: ['fixture.txt'],
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
    verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] },
    preferred_agent: 'opencode',
    fallback_agents: [],
    capability_scopes: ['repo', 'developer_environment'],
    data_class: 'public',
    risk_auto_acceptance: true,
    dispatch_policy: require('./default-runtime').LOCAL_POLICY,
    task_type: 'focused_refactor',
  };
}

module.exports = { allocate, seedExactFixture, exactMissionInput };
