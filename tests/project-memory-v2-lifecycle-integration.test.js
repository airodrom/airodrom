'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Bridge = require('../src/bridge-controller');
const MemoryStore = require('../src/memory-store');
const TaskSessionManager = require('../src/task-session-model');
const { ProjectMemoryV2Adapter } = require('../src/project-memory-v2-adapter');

function repository(head = 'memory-head-a') {
  return {
    repositoryId: 'memory-fixture',
    branch: 'main',
    head,
    dirty: true,
    modifiedFiles: ['src/feature.js'],
    worktree: 'memory-fixture-worktree',
    observedAt: 1_790_730_000_000
  };
}

test('BridgeController persists Memory V2 lifecycle evidence and fails stale recovery closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-m2-life-'));
  const memory = new MemoryStore(path.join(root, 'memory.sqlite'));
  const bridge = new Bridge({ defaultRuntime: 'pi', dataDir: root });

  bridge.memory = memory;
  bridge.tasks = new TaskSessionManager(root, memory.db);
  bridge.projectMemoryV2 = new ProjectMemoryV2Adapter({ db: memory.db });
  bridge._projectMemoryRepositorySnapshot = () => repository();

  t.after(() => {
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const task = bridge.createTask('Memory lifecycle integration', {
    missionObjective: 'Persist verified lifecycle evidence'
  });

  const created = bridge.projectMemoryV2.prepareResume({
    missionId: task.mission.id,
    currentRepository: repository()
  });

  assert.equal(created.ok, true);
  assert.equal(created.repositoryStatus, 'current');

  bridge._recordProjectMemoryToolReceipt(
    task,
    'write',
    {},
    { input: { path: 'src/feature.js' } }
  );

  bridge._recordProjectMemoryToolReceipt(
    task,
    'run_job',
    { exitCode: 0, output: '# pass 1\n# fail 0\n# skipped 0\n' },
    { input: { jobName: 'focused_test', target: 'tests/feature.test.js' } }
  );

  bridge._recordProjectMemoryBlocker(
    task,
    { toolName: 'write' },
    { kind: 'fixture_denial', executionStatus: 'NOT_EXECUTED' }
  );

  const contextCheckpoint = bridge._recordProjectMemoryContextPressure(task, {
    warning: true,
    continuation: true
  });

  assert.notEqual(contextCheckpoint?.ok, false);

  const resumed = bridge.projectMemoryV2.prepareResume({
    missionId: task.mission.id,
    currentRepository: repository()
  });

  assert.equal(resumed.ok, true);
  assert.match(resumed.serialized, /src\/feature\.js/);
  assert.match(resumed.serialized, /tests\/feature\.test\.js/);
  assert.match(resumed.serialized, /fixture_denial/);

  const recovery = bridge._prepareProjectMemoryRecovery(task);
  assert.equal(recovery.ok, true);
  assert.ok(recovery.bytes <= 6000);

  bridge._projectMemoryRepositorySnapshot = () => repository('memory-head-b');

  const stale = bridge._prepareProjectMemoryRecovery(task);
  assert.equal(stale.ok, false);
  assert.equal(stale.repositoryStatus, 'stale');

  bridge._projectMemoryRepositorySnapshot = () => repository();
  task.status = 'completed';

  const terminalReceipt = bridge._recordProjectMemoryTerminal(task);
  assert.notEqual(terminalReceipt?.ok, false);

  const terminal = bridge.projectMemoryV2.prepareResume({
    missionId: task.mission.id,
    currentRepository: repository()
  });

  assert.equal(terminal.ok, true);
  assert.match(terminal.serialized, /completed/);
});
