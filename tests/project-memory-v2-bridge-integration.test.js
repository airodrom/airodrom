const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Bridge = require('../src/bridge-controller');
const { ProjectMemoryV2Adapter } = require('../src/project-memory-v2-adapter');

function makeProfile(root) {
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}\n');
  return profile;
}

test('BridgeController initializes ProjectMemoryV2Adapter on the bridge database', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '.tmp-m2a-'));
  const bridge = await new Bridge({ defaultRuntime: 'pi', dataDir: root, sourceProfile: makeProfile(root) }).initialize();

  t.after(async () => {
    await bridge.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.ok(
    bridge.projectMemoryV2 instanceof ProjectMemoryV2Adapter,
    'BridgeController must expose projectMemoryV2 backed by its existing SQLite database'
  );
});

test('createTask persists the existing task and mission identity into Memory V2', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '.tmp-m2b-'));
  const bridge = await new Bridge({ defaultRuntime: 'pi', dataDir: root, sourceProfile: makeProfile(root) }).initialize();

  t.after(async () => {
    await bridge.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const task = bridge.createTask('Memory V2 lifecycle integration', {
    missionObjective: 'Persist this exact mission identity',
  });

  const resumed = bridge.projectMemoryV2.prepareResume({ missionId: task.mission.id });

  assert.equal(resumed.ok, true, 'createTask must initialize the same mission in Memory V2');
  assert.equal(resumed.mission.missionId, task.mission.id);
  assert.equal(resumed.mission.taskId, task.id);
  assert.equal(resumed.mission.objective, task.mission.objective);
  assert.equal(resumed.mission.workspace, task.workspace);
  assert.deepEqual(resumed.mission.scope, task.mission.scope);
});