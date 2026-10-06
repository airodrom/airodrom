const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Bridge = require('./fixtures/test-bridge.cjs');
const MemoryStore = require('../src/memory-store');
const TaskSessionManager = require('../src/task-session-model');
const { ProjectMemoryV2Adapter } = require('../src/project-memory-v2-adapter');

test('createTask persists mission identity into Memory V2', t => {
  // Keep the synthetic task workspace outside the source checkout so it never
  // inherits the checkout's repository state (including a detached PR HEAD).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2c-'));
  const memory = new MemoryStore(path.join(root, 'memory.sqlite'));
  const bridge = new Bridge({ defaultRuntime: 'host', dataDir: root });
  bridge.memory = memory;
  bridge.tasks = new TaskSessionManager(root, memory.db);
  bridge.projectMemoryV2 = new ProjectMemoryV2Adapter({ db: memory.db });
  t.after(() => { memory.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const task = bridge.createTask('m2', { missionObjective: 'persist me' });
  const resumed = bridge.projectMemoryV2.prepareResume({ missionId: task.mission.id });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.mission.missionId, task.mission.id);
  assert.equal(resumed.mission.taskId, task.id);
  assert.equal(resumed.mission.objective, task.mission.objective);
  assert.equal(resumed.mission.workspace, task.workspace);
});
