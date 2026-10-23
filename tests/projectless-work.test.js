'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ZeroSetupWork } = require('../src/zero-setup-work');
const intent = require('../src/assistant-intent');
const router = require('../src/model-worker-router');

function gitRepo(t, name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}
function bridge(projects) {
  const db = new DatabaseSync(':memory:');
  const b = {
    controlStore: { db },
    projects: { listProjects: () => projects },
    developerAutonomy: { list: () => [] },
    workTemplates: { list: () => [] }
  };
  b.projectDefaults = new (require('../src/project-defaults').ProjectDefaults)(b);
  return b;
}
function project(name, repo) {
  return { projectId: name.replace(/ /g, '-'), name, status: 'active', repositories: [repo], limitations: [] };
}

test('zero, one, and many projects do not prompt or borrow an unnamed repository', t => {
  const only = gitRepo(t, 'only-');
  const left = gitRepo(t, 'left-');
  const right = gitRepo(t, 'right-');
  const instruction = 'Fix the login bug and run the tests.';
  for (const projects of [[], [project('Only Repo', only)], [project('Left Repo', left), project('Right Repo', right)]]) {
    const scope = new ZeroSetupWork(bridge(projects)).resolveScope(instruction, { kind: 'general', objective: instruction });
    assert.equal(scope.ok, true);
    assert.equal(scope.projectless, true);
    assert.equal(scope.project, null);
    assert.equal(scope.filesystem, 'task_sandbox_only');
    assert.ok(!String(scope.message || '').match(/which registered project|name a registered project/i));
    assert.ok(![only, left, right].includes(scope.workspace));
    assert.equal(fs.readFileSync(path.join(scope.workspace, 'TASK.md'), 'utf8').includes('No registered Project'), true);
    fs.rmSync(scope.workspace, { recursive: true, force: true });
  }
});

test('an explicitly named authorized repository is used and an unauthorized path is refused', t => {
  const repo = gitRepo(t, 'named-');
  const other = gitRepo(t, 'other-');
  const work = new ZeroSetupWork(bridge([project('Named Fixture', repo)]));
  const named = work.resolveScope('Update Named Fixture and run tests.', { kind: 'general', objective: 'named' });
  assert.equal(named.projectless, undefined);
  assert.equal(named.workspace, repo);
  const byPath = work.resolveScope('Update the repository ' + repo, { kind: 'general', objective: 'path' });
  assert.equal(byPath.workspace, repo);
  const denied = work.resolveScope('Edit files in ' + other, { kind: 'general', objective: 'denied' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /not authorized/);
  assert.equal(fs.existsSync(path.join(other, 'TASK.md')), false);
});

test('operator settings and projectless preparation do not select a project or authorize execution', () => {
  assert.equal(intent.parse('Read settings').kind, 'operator_control');
  const db = new DatabaseSync(':memory:');
  const work = new ZeroSetupWork({ controlStore: { db }, projects: { listProjects: () => [] }, developerAutonomy: { list: () => [] }, workTemplates: { list: () => [] } });
  return work.ask({ instruction: 'Implement the small parser fix.', request_id: '11111111-1111-4111-8111-111111111111' }, 'operator').then(view => {
    assert.equal(view.projectless, true);
    assert.equal(view.execution_authorized, false);
    assert.match(view.message, /No registered Project/);
    assert.equal(view.presentation.project_name, null);
  });
});

test('AIRODROM_WORK_V1 packets route as WORK through assistant chat intent', () => {
  const packet = 'AIRODROM_WORK_V1\n' + JSON.stringify({
    version: 1,
    worker: 'cursor',
    files: [{ path: 'alpha.txt', content: 'alpha-one\n' }, { path: 'beta.txt', content: 'beta-two\n' }]
  });
  const parsed = intent.parse(packet);
  assert.equal(parsed.kind, 'work');
  assert.equal(parsed.objective, packet.trim());
  assert.equal(intent.parse('hello there').kind, 'conversation');
});

test('governed Cursor stays selectable only when qualified, and local work stays on OpenCode', async () => {
  const ready = { ready: true, available: true, version: '2026.09.28-64d2043', auth_state: 'credential_file', reason: null, tiers: { qualified: true } };
  const catalog = await router.inspect({
    opencodeAdapter: { options: { model: router.MODEL }, readiness: async () => ({ ready: true, reason: null }) },
    workers: { catalog: () => [] },
    cursorWorker: { readiness: async () => ready, options: {} }
  }, { conversation: async () => ({ state: 'WAIT' }) });
  catalog.workers[0] = { ...catalog.workers[0], qualification: 'qualified', available: true };
  catalog.models[0] = { ...catalog.models[0], qualification: 'qualified', available: true, expires_at: Date.now() + 1000 };
  assert.equal(router.select(catalog, { mission_class: 'WORK', data_class: 'public', privacy: 'approved_external', worker: 'cursor' }).worker, 'cursor');
  assert.equal(router.select(catalog, { mission_class: 'WORK', data_class: 'personal', privacy: 'local_only' }).worker, 'opencode');
  const denied = await router.inspect({
    opencodeAdapter: { options: { model: router.MODEL }, readiness: async () => ({ ready: false }) },
    workers: { catalog: () => [] },
    cursorWorker: { readiness: async () => ({ ready: false, available: false, reason: 'cursor_execution_unqualified', tiers: { qualified: false } }), options: {} }
  }, { conversation: async () => ({ state: 'WAIT' }) });
  assert.equal(router.select(denied, { mission_class: 'WORK', data_class: 'public', privacy: 'approved_external', worker: 'cursor' }).state, 'WAIT');
});

test('missing verification cannot auto-accept', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/expanded-autonomy.js'), 'utf8');
  assert.match(source, /independent_verification_required/);
  assert.match(source, /verification_not_ready/);
});
