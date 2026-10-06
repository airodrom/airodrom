'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Controller = require('../src/bridge-controller');
const { McpTools, validate, TOOLS } = require('../src/mcp-tools');
const { CRITERION, satisfied } = require('../src/supervisor-acceptance');
const args = { description: 'Supervisor acceptance', message: 'Run the deterministic fixture only.', request_id: 'acceptance-fixture-001', acceptance_mode: 'incomplete_once', acceptance_criterion: CRITERION };
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Fixture did not settle');
}
async function setup(t) {
  const root = fs.mkdtempSync('/private/tmp/br-accept-'), profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const options = { defaultRuntime:'pi', dataDir: path.join(root, 'data'), sourceProfile: profile, executable: '/nonexistent/no-model-permitted' };
  let b = await new Controller(options).initialize();
  const create=b.createTask.bind(b);b.createTask=(...args)=>{const task=create(...args);require('./fixtures/git-baseline.cjs')(task.workspace);return task;};
  t.after(async () => { await b.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get bridge() { return b; }, async restart() { await b.shutdown(); b = await new Controller(options).initialize(); return b; } };
}
test('explicit MCP criteria persist in SQLite and one fresh recovery satisfies runtime evidence across restart', async t => {
  const fixture = await setup(t), b = fixture.bridge;
  b.supervisor.close(); b.supervisor.schedule = () => {}; // Simulate service stopping after first settlement, before recovery.
  const mcp = new McpTools(b), receipt = await mcp.call('create_task', args);
  await until(() => !b.inFlight.size);
  const task = b.tasks.get(receipt.task_id), initialSession = task.sessionId;
  assert.deepEqual(b.snapshotTask(task).mission.criteria, [CRITERION]);
  assert.equal(task.mission.attempts, 0); assert.equal(satisfied(task), false);
  assert.deepEqual(JSON.parse(b.memory.latestCheckpoint(task.id).content).completedGates, []);
  task.lastResult = 'Everything is complete';
  const cp = JSON.parse(b.memory.latestCheckpoint(task.id).content); cp.completedGates = [CRITERION];
  assert.throws(() => b.memory.saveCheckpoint(task.id, cp, { sessionId: task.sessionId, model: true }), /cannot certify/);
  assert.equal(satisfied(task), false);
  const stored = JSON.parse(b.memory.db.prepare('SELECT snapshot FROM task_states WHERE id = ?').get(task.id).snapshot);
  assert.deepEqual(stored.mission.criteria, [CRITERION]);
  assert.equal(stored.mission.runtimeEvidence.initial.sessionId, initialSession);
  const restored = await fixture.restart(), recovered = restored.tasks.get(task.id);
  await until(() => recovered.mission.status === 'completed');
  const compact = await new McpTools(restored).call('get_task_status', { task_id: task.id });
  assert.equal(compact.task_id,task.id);const status={...restored.snapshotTask(recovered),session_id:compact.session_id};
  assert.deepEqual(status.mission.criteria, [CRITERION]); assert.equal(status.mission.attempts, 1);
  assert.equal(status.mission.runtimeEvidence.initial.sessionId, initialSession);
  assert.notEqual(status.session_id, initialSession); assert.equal(satisfied(recovered), true);
  assert.equal(status.recovery, null); assert.deepEqual(status.approvals, []);
  assert.equal(status.transitions.filter(e => e.state === 'recovering').length, 1);
  assert.deepEqual(fs.readdirSync(recovered.workspace).filter(name=>!['.git','.gitignore'].includes(name)), []); assert.equal(restored.runtimes.size, 0);
  await restored.supervisor.tick(); assert.equal(recovered.mission.attempts, 1);
  assert.equal((await new McpTools(restored).call('create_task', args)).duplicate, true);
  const final = await fixture.restart();
  assert.equal(final.tasks.get(task.id).mission.status, 'completed');
  assert.equal(satisfied(final.tasks.get(task.id)), true);
});
test('cancellation stops the fixture before settlement and remains stopped after restart', async t => {
  const fixture = await setup(t), b = fixture.bridge, mcp = new McpTools(b);
  const receipt = await mcp.call('create_task', args);
  await mcp.call('cancel_task', { task_id: receipt.task_id });
  await until(() => !b.inFlight.size); await b.supervisor.tick();
  const task = b.tasks.get(receipt.task_id);
  assert.equal(task.status, 'cancelled'); assert.equal(task.mission.attempts, 0);
  assert.equal(task.mission.runtimeEvidence, undefined);
  const restored = await fixture.restart(); await restored.supervisor.tick();
  assert.equal(restored.tasks.get(task.id).mission.status, 'cancelled');
  assert.equal(restored.tasks.get(task.id).mission.attempts, 0);
});
test('schema keeps legacy requests and requires exact opt-in fixture contract', async t => {
  assert.equal(TOOLS.length, 21);
  const legacy = { description: 'Legacy', message: 'Acceptance criterion mentioned only in prose', request_id: 'legacy-request-001' };
  validate('create_task', legacy);
  for (const changed of [{ acceptance_criterion: 'other' }, { workspace: 'bridge' }, { acceptance_mode: 'arbitrary' }, { acceptance_mode: undefined }]) {
    assert.throws(() => validate('create_task', { ...args, ...changed }));
  }
  const fixture = await setup(t), b = fixture.bridge;
  b.prompt = async () => {}; // Registration test only; no model process.
  const mcp = new McpTools(b), old = await mcp.call('create_task', legacy);
  assert.deepEqual(b.snapshotTask(b.tasks.get(old.task_id)).mission.criteria, []);
  const explicit = await mcp.call('create_task', { ...legacy, request_id: 'legacy-explicit-001', acceptance_criterion: 'operator gate' });
  assert.deepEqual(b.snapshotTask(b.tasks.get(explicit.task_id)).mission.criteria, ['operator gate']);
  assert.equal((await mcp.call('create_task', legacy)).duplicate, true);
  await assert.rejects(mcp.call('create_task', { ...legacy, acceptance_criterion: 'changed' }), /different inputs/);
});
