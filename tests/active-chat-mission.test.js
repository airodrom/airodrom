'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const BridgeController = require('./fixtures/test-bridge.cjs');
const TaskSessionManager = require('../src/task-session-model');
const { MissionAuthority } = require('../src/mission-authority');
const { McpTools } = require('../src/mcp-tools');
const {
  ACTIVE_CHAT_MODE, ACTIVE_CHAT_PROFILE_ID, DESCRIPTION, TASK_A_REQUEST, TASK_B_REQUEST,
  MCP_CONTINUATION, missionFields, prepareFixtures, assertActiveChatMission
} = require('../src/active-chat-mission');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-chat-smoke-'));
  t.after(() => {
    const makeRemovable = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) makeRemovable(path.join(directory, entry.name));
      fs.chmodSync(directory, 0o700);
    };
    makeRemovable(root); fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function createBridge(t, { now = () => Date.now() } = {}) {
  const root = sandbox(t);
  const authority = new MissionAuthority({ authorityDir: path.join(root, 'authority'), now });
  const bridge = new BridgeController({ defaultRuntime: 'host', dataDir: path.join(root, 'runtime'), missionAuthority: authority });
  bridge.tasks = new TaskSessionManager(bridge.dataDir);
  bridge.config = { provider: 'ollama', model: 'qwen3-coder:30b', profile: path.join(root, 'profile') };
  return { root, authority, bridge };
}
function activeArgs(requestId) {
  return { description: DESCRIPTION, message: TASK_A_REQUEST, workspace: 'isolated', mission_mode: ACTIVE_CHAT_MODE, request_id: requestId };
}
function preparedMission(root) {
  const workspace = path.join(root, `workspace-${randomUUID()}`); fs.mkdirSync(workspace);
  return missionFields({ id: randomUUID(), workspace, fixtures: prepareFixtures(workspace) });
}

 test('SIMULATION: fixtures are created privately, sealed read-only, and their per-mission values are absent from task prompts', t => {
  const root = sandbox(t); const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const fixtures = prepareFixtures(workspace, { entropy: size => Buffer.alloc(size, 7) });
  const taskA = fs.readFileSync(path.join(workspace, fixtures.taskA.path), 'utf8');
  const taskB = fs.readFileSync(path.join(workspace, fixtures.taskB.path), 'utf8');
  assert.equal(fs.statSync(path.join(workspace, 'evidence')).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(workspace, fixtures.taskA.path)).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(workspace, fixtures.taskB.path)).mode & 0o777, 0o400);
  assert.notEqual(fixtures.taskA.sha256, fixtures.taskB.sha256);
  assert.equal(TASK_A_REQUEST.includes(taskA.trim()), false);
  assert.equal(TASK_B_REQUEST.includes(taskB.trim()), false);
  assert.throws(() => prepareFixtures(workspace), /already exists/);
 });

test('SIMULATION: production authority is inert before protected key initialization and issues only the fixed active-chat scope', t => {
  const { root, authority } = createBridge(t);
  const mission = preparedMission(root);
  assert.throws(() => authority.issueOperatorGrant(mission, { authorizationId: randomUUID() }), /not initialized/);
  const initialized = authority.initializeOperatorKey();
  assert.equal(initialized.initialized, true);
  assert.equal(fs.statSync(path.join(root, 'authority', 'operator-hmac-key.json')).mode & 0o077, 0);
  const grant = authority.issueOperatorGrant(mission, { authorizationId: randomUUID() });
  assert.deepEqual(grant.capabilities, ['inference', 'read']);
  assert.equal(grant.egress, 'local-only');
  assert.equal(grant.budget.maxActions, 6);
  assert.throws(() => authority.issueOperatorGrant({ ...mission, objective: 'expanded by model output' }, { authorizationId: randomUUID() }), /identity changed/);
});

test('SIMULATION: Task B remains undispatched until a host-recorded Task A broker read and authenticated MCP continuation', async t => {
  const { authority, bridge } = createBridge(t);
  const connection = { epoch: 'a'.repeat(64), authenticatedAt: Date.now() };
  const mcp = new McpTools(bridge, { authenticatedConnection: () => connection });
  const prompts = [];
  bridge.prompt = async (id, message, options) => { prompts.push({ id, message, options }); };
  // Construct only the internal policy fixture; the retired mode is absent from the public schema.
  const created = bridge.createActiveChatTask();
  const task = bridge.tasks.get(created.id);
  task.source = { transport: 'mcp', request_id: 'active-create-0001', client_reported: { name: 'untrusted-client-name', version: '1' }, connectionAuthenticated: true, mcpConnection: { ...connection } };
  task.mcpRequests = { 'active-create-0001': mcp.hash(TASK_A_REQUEST) };
  task.latestMcpRequestId = 'active-create-0001'; bridge.tasks.save(task);
  assert.equal(task.status, 'awaiting_operator_grant');
  assert.equal(task.source.connectionAuthenticated, true);
  assert.equal(task.source.client_reported.name, 'untrusted-client-name');
  assert.deepEqual(prompts, [], 'MCP task text cannot dispatch a worker before an operator grant');
  assert.throws(() => bridge.authorizeActiveChatMission(task.id, { trusted: false, id: randomUUID(), mcpConnectionEpoch: connection.epoch }), /operator authorization/);
  authority.initializeOperatorKey();
  bridge.authorizeActiveChatMission(task.id, { trusted: true, id: randomUUID(), mcpConnectionEpoch: connection.epoch });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prompts.map(prompt => prompt.message), [TASK_A_REQUEST]);
  assert.equal(task.activeChat.phase, 'task_a_dispatching');
  assert.throws(() => bridge.continueActiveChatMission(task.id, MCP_CONTINUATION, { requestId: 'active-before-a-0001', mcpConnectionEpoch: connection.epoch }), /not settled/);

  task.activeChat.phase = 'task_a_running';
  task.lastResult = 'ACTIVE_CHAT_TASK_A=guessed';
  assert.throws(() => bridge._settleActiveChatResult(task), /host-recorded broker read/);
  assert.equal(bridge.localOllamaBroker.authorize(task).allow, true, 'first brokered local inference request is separately authorized');
  const taskARead = await bridge.capabilityBroker.execute(task.id, { toolName: 'read', input: { path: 'evidence/task-a.txt' }, toolCallId: 'task-a-read-0001' });
  assert.equal(taskARead.allow, true);
  assert.equal(task.mission.used.reads, 1);
  assert.equal(task.mission.used.inferenceRequests, 1);
  assert.equal(bridge.localOllamaBroker.authorize(task).allow, true, 'Task A final evidence response consumes its own bounded local inference request');
  assert.equal(task.mission.used.inferenceRequests, 2);
  assert.equal(task.activeChat.readEvidence.task_a.missionId, task.mission.id);
  assert.equal(task.activeChat.readEvidence.task_a.taskId, task.id);
  assert.equal(task.activeChat.readEvidence.task_a.sessionId, task.sessionId);
  assert.equal(task.activeChat.readEvidence.task_a.path, 'evidence/task-a.txt');
  const originalSession = task.activeChat.readEvidence.task_a.sessionId;
  task.activeChat.readEvidence.task_a.sessionId = 'cross-session'; task.lastResult = taskARead.output;
  assert.throws(() => bridge._settleActiveChatResult(task), /host-recorded broker read/);
  task.activeChat.readEvidence.task_a.sessionId = originalSession;
  task.lastResult = taskARead.output; bridge._settleActiveChatResult(task); bridge.tasks.save(task);
  assert.equal(task.status, 'awaiting_mcp_continuation');
  assert.equal(mcp.status(task).result, taskARead.output.trim(), 'MCP receives only host-verified selected evidence');
  task.lastResult = `${taskARead.output}stale`;
  assert.throws(() => bridge.continueActiveChatMission(task.id, MCP_CONTINUATION, { requestId: 'active-stale-result-0001', mcpConnectionEpoch: connection.epoch }), /stale or was changed/);
  task.lastResult = taskARead.output;
  await assert.rejects(mcp.call('continue_task', { task_id: task.id, message: 'pick task b now', request_id: 'active-wrong-next-0001' }), /fixed Task B request/);
  assert.equal(prompts.length, 1);
  const continued = await mcp.call('continue_task', { task_id: task.id, message: MCP_CONTINUATION, request_id: 'active-next-0001' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(continued.accepted, true);
  assert.deepEqual(prompts.map(prompt => prompt.message), [TASK_A_REQUEST, TASK_B_REQUEST]);
  assert.equal(task.activeChat.phase, 'task_b_dispatching');
  const replay = await mcp.call('continue_task', { task_id: task.id, message: MCP_CONTINUATION, request_id: 'active-next-0001' });
  assert.equal(replay.duplicate, true);
  connection.epoch = 'b'.repeat(64);
  await assert.rejects(mcp.call('continue_task', { task_id: task.id, message: MCP_CONTINUATION, request_id: 'active-cross-connection-0001' }), /authenticated MCP connection/);

  task.activeChat.phase = 'task_b_running';
  assert.equal(bridge.localOllamaBroker.authorize(task).allow, true, 'second brokered local inference request is separately authorized');
  const taskBRead = await bridge.capabilityBroker.execute(task.id, { toolName: 'read', input: { path: 'evidence/task-b.txt' }, toolCallId: 'task-b-read-0001' });
  assert.equal(taskBRead.allow, true);
  assert.equal(task.mission.used.reads, 2);
  assert.equal(task.mission.used.inferenceRequests, 3);
  assert.equal(bridge.localOllamaBroker.authorize(task).allow, true, 'Task B final evidence response consumes the last allowed inference request');
  assert.equal(task.mission.used.inferenceRequests, 4);
  assert.equal(task.mission.used.actions, 6);
  task.lastResult = taskBRead.output; bridge._settleActiveChatResult(task); bridge.tasks.save(task);
  assert.equal(task.status, 'completed');
  assert.equal(mcp.status(task).result, taskBRead.output.trim());
  assert.equal(authority.snapshot(task.mission).status, 'completed');
});

test('SIMULATION: active grant expiry, cancellation, action exhaustion, and immutable mission identity fail closed with read and inference counters', t => {
  let now = 1_000_000;
  const { root, authority } = createBridge(t, { now: () => now });
  const mission = preparedMission(root);
  authority.initializeOperatorKey();
  const grant = authority.issueOperatorGrant(mission, { authorizationId: randomUUID() });
  mission.grantId = grant.id;
  for (const [capability, usageKind] of [['inference', 'inference'], ['read', 'read'], ['inference', 'inference'], ['inference', 'inference'], ['read', 'read'], ['inference', 'inference']]) assert.equal(authority.verify(mission, capability, { consumeAction: true, usageKind }).allow, true);
  const exhausted = authority.snapshot(mission);
  assert.deepEqual(exhausted.used, { actions: 6, runtimeMs: 0, retries: 0, reads: 2, inferenceRequests: 4, promptTurns: 0 });
  assert.equal(authority.verify(mission, 'read').allow, false, 'cumulative action budget is not enlarged');
  authority.revoke(mission.id, 'operator cancelled');
  assert.equal(authority.verify(mission, 'read').allow, false, 'cancelled grant remains latched');
  const fresh = preparedMission(root);
  const expiring = authority.issueOperatorGrant(fresh, { authorizationId: randomUUID() });
  fresh.grantId = expiring.id; now += 240_000;
  assert.match(authority.verify(fresh, 'read').reason, /expired/);
  fresh.objective = 'changed objective';
  assert.throws(() => assertActiveChatMission(fresh), /identity changed/);
});

test('retired optional Active Chat smoke cannot create executable tasks in the product', async () => {
 const Bridge=require('../src/bridge-controller');const bridge=new Bridge();
 assert.throws(()=>bridge.createActiveChatTask(),/retired/);
 await assert.rejects(new McpTools(bridge).call('create_task',activeArgs('retired-create-0001')),/Invalid mission_mode/);
 assert.equal(bridge.runtimes.size,0);
});
