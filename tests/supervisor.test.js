'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Controller = require('../src/bridge-controller');
const { McpTools, TOOLS } = require('../src/mcp-tools');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await wait(10); } throw new Error('Fixture did not settle'); }
async function setup(t, options = {}) {
  const root = fs.mkdtempSync('/private/tmp/br-sup-'), profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const b = new Controller({ defaultRuntime: 'pi', dataDir: path.join(root, 'data'), sourceProfile: profile, allowFixtureWorker: true, executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), ...options });
  await b.initialize();
  const createTask=b.createTask.bind(b);b.createTask=(...args)=>{const task=createTask(...args);require('./fixtures/git-baseline.cjs')(task.workspace);return task;};
  t.after(async () => { await until(() => !b.inFlight.size); await b.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return b;
}
test('incomplete MCP goal automatically continues twice from durable checkpoints and stops at budget', async t => {
  const b = await setup(t), mcp = new McpTools(b);
  assert.equal(TOOLS.length, 21);
  const receipt = await mcp.call('create_task', { description: 'Local recovery fixture', message: 'first turn', request_id: 'supervisor-0001', acceptance_criterion: 'operator verified goal' });
  const task = b.tasks.get(receipt.task_id);
  await until(() => task.recovery?.reason === 'recovery_budget_exhausted');
  assert.equal(task.mission.attempts, 2); assert.equal(task.mission.status, 'needs_review'); assert.equal(task.status, 'completed');
  const wire = fs.readFileSync(path.join(task.workspace, 'wire.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(wire.length, 3); assert.equal(new Set(wire.map(r => r.pid)).size, 3);
  assert(wire[1].message.includes('Mission checkpoint')); assert(wire[1].message.includes('NOT EXECUTED'));
  for (const entry of wire) assert.doesNotMatch(entry.message, /andrew|\/Users\//i);
  assert.match(wire[1].message, /requires explicit human authorization/);
  assert(b.tasks.transitions(task.id).some(e => e.state === 'recovering'));
  assert.equal(b.snapshotTask(task).mission.status, 'needs_review');
  const cp = JSON.parse(b.memory.latestCheckpoint(task.id).content);
  assert.deepEqual(cp.completedGates, []); cp.completedGates = ['operator verified goal'];
  assert.throws(() => b.memory.saveCheckpoint(task.id, cp, { model: true }), /cannot certify/);
  b.memory.saveCheckpoint(task.id, cp, { sessionId: task.sessionId }); await b.supervisor.tick();
  assert.equal(task.mission.status, 'completed'); assert.equal(task.recovery, null);
});
test('deadline recovers automatically; healthy heartbeat does not hide activity stall', async t => {
  for (const trigger of ['deadline','stalled']) {
    const b = await setup(t), created = b.createTask(trigger, { acceptanceCriteria: ['verified'] }), task = b.tasks.get(created.id);
    const running = b.prompt(task.id, 'never settle', { timeoutMs: trigger === 'deadline' ? 60 : 5000 });
    const rejected = assert.rejects(running);
    await until(() => fs.existsSync(path.join(task.workspace, 'wire.log')));
    if (trigger === 'stalled') { task.lastHeartbeatAt = Date.now(); task.lastActivityAt = Date.now() - 70000; await b.supervisor.tick(); }
    await rejected;
    await until(() => task.recovery?.reason === 'recovery_budget_exhausted');
    assert(b.tasks.transitions(task.id).some(e => e.state === trigger));
    assert.equal(task.mission.attempts, 2);
  }
});
test('missing criteria prepares recovery; blocked and expired approvals never auto-dispatch', async t => {
  const b = await setup(t), created = b.createTask('Hold boundaries'), task = b.tasks.get(created.id);
  await b.prompt(task.id, 'first'); await b.supervisor.tick();
  assert.equal(task.recovery.reason, 'acceptance_criteria_required');
  task.mission.criteria = ['verified'];
  const decision = b.policy.check(task.id, { toolName: 'bash', input: { command: 'gcloud run deploy fixture --project=never-execute' }, toolCallId: 'blocked-write' });
  assert.equal(decision.allow, false); assert.equal(decision.executionStatus, 'NOT EXECUTED');
  task.lastRunBlocked = true; task.status = 'approval_required'; b.tasks.save(task);
  await b.supervisor.tick(); assert.equal(task.recovery.reason, 'human_or_execution_review'); assert.equal(task.mission.attempts, 0);
  b.policy.approvals.get(decision.approvalId).expiresAt = 0;
  await b.supervisor.tick(); assert.equal(task.status, 'approval_expired');
  assert.equal(fs.existsSync(path.join(task.workspace, 'blocked.txt')), false);
  await b.cancel(task.id); await b.supervisor.tick(); assert.equal(task.status, 'cancelled'); assert.equal(task.mission.attempts, 0);
});
test('journal survives reload, and uncertain dispatch is held instead of replayed', async t => {
  const b = await setup(t), created = b.createTask('Restart fixture', { acceptanceCriteria: ['verified'] }), task = b.tasks.get(created.id);
  task.mission.started = true; task.mission.attempts = 1; task.recovery = { state: 'dispatching' }; task.status = 'thinking'; b.tasks.save(task);
  const Manager = require('../src/task-session-model'); b.supervisor.close();
  b.tasks = new Manager(b.dataDir, b.memory.db);
  b.supervisor = new (require('../src/mission-supervisor'))(b); await b.supervisor.tick();
  const restored = b.tasks.get(task.id);
  assert.equal(restored.recovery.reason, 'execution_outcome_unknown'); assert.equal(restored.mission.attempts, 1);
  assert(b.tasks.transitions(task.id).some(e => e.state === 'interrupted'));
  await b.supervisor.tick(); assert.equal(b.inFlight.size, 0);
});
test('all required transition states are durable and repeated saves do not duplicate events', async t => {
  const b = await setup(t), task = b.tasks.get(b.createTask('Transitions').id);
  const states = ['queued','starting','running','thinking','blocked','approval_required','approval_expired','stalled','recovering','completed','failed','cancelled','deadline'];
  for (const state of states) { task.status = state; b.tasks.save(task); b.tasks.save(task); }
  assert.deepEqual(b.tasks.transitions(task.id).map(e => e.state), states);
});
test('routine policy checks require no operator approval; GCP remains an unapproved human gate', async t => {
  const b = await setup(t), task = b.tasks.get(b.createTask('Approval routing', { acceptanceCriteria: ['verified'] }).id);
  task.source = { transport: 'mcp' }; task.mission.started = true;
  assert.equal(b.policy.check(task.id, { toolName: 'bash', input: { command: 'git status --short' } }).allow, true);
  assert.equal(b.policy.list(task.id).length, 0);
  const decision = b.policy.check(task.id, { toolName: 'bash', input: { command: 'gcloud run deploy fixture --project=never-execute' } });
  assert.equal(decision.allow, false); assert.equal(decision.executionStatus, 'NOT EXECUTED');
  task.status = 'approval_required'; b.tasks.save(task);
  const result = await new McpTools(b).call('approve_once', { task_id: task.id, approval_id: decision.approvalId });
  assert.equal(result.approved, false); await b.supervisor.tick();
  assert.equal(b.policy.list(task.id)[0].status, 'pending'); assert.equal(task.mission.attempts, 0);
});
test('watchdog operates without polling, and runtime faults trigger bounded recovery', async t => {
  for (const fault of [false, true]) {
    const b = await setup(t, fault ? {} : { watchdogMs: 20, stallMs: 5000 });
    const task = b.tasks.get(b.createTask('Unattended recovery', { acceptanceCriteria: ['verified'] }).id);
    const rejected = assert.rejects(b.prompt(task.id, 'never settle', { timeoutMs: 5000 }));
    await until(() => fs.existsSync(path.join(task.workspace, 'wire.log')));
    if(!fault){task.lastActivityAt=Date.now()-6000;b.tasks.save(task);}
    if (fault) b.runtimes.get(task.id).rpc.emit('fault', new Error('Simulated runtime fault'));
    await rejected;
    await until(() => task.recovery?.reason === 'recovery_budget_exhausted');
    assert(b.tasks.transitions(task.id).some(e => e.state === (fault ? 'failed' : 'stalled')));
    assert.equal(task.mission.attempts, 2);
  }
});
test('shutdown drains an active turn before closing its journal', async t => {
  const b = await setup(t), task = b.createTask('Shutdown fixture');
  const rejected = assert.rejects(b.prompt(task.id, 'never settle'));
  await until(() => fs.existsSync(path.join(task.workspace, 'wire.log')));
  await b.shutdown(); await rejected;
  assert.equal(b.inFlight.size, 0);
});
