'use strict';
// Uses only disposable fake Pi fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const Bridge = require('./fixtures/test-bridge.cjs');
const ControlServer = require('../src/control-server');
const { TOOLS, validate } = require('../src/mcp-tools');
const { createClient, discovery } = require('../src/mcp-client');

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(predicate(), label);
}

async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/pi-mcp-');
  const profile = path.join(root, 'source');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  const f = { root, dataDir };
  f.start = async () => {
    f.bridge = await new Bridge({ defaultRuntime: 'host', dataDir, sourceProfile: profile, executable: path.join(__dirname, 'fixtures/host-worker.cjs'), allowFixtureWorker: true }).initialize();
    f.ui = new ControlServer(f.bridge, { port: 0 }); await f.ui.start();
  };
  f.restart = async () => { await f.ui.close(); await f.bridge.shutdown(); await f.start(); };
  await f.start();
  t.after(async () => { await f.ui.close(); await f.bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  f.request = (route, { method = 'GET', body, token = f.ui.token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request(f.ui.origin + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', part => { text += part; });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  f.call = (name, args, options = {}) => f.request('/api/mcp/call', { method: 'POST', token: f.ui.mcpToken, body: { name, args, clientInfo: { name: 'fixture-client', version: '1' } }, ...options });
  f.create = async (message = 'Fixture prompt', request_id = randomUUID()) => {
    const result = await f.call('create_task', { description: 'Disposable MCP fixture', message, request_id });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  f.settle = () => until(() => f.bridge.inFlight.size === 0, 'Fake Pi prompt should settle');
  f.wire = id => { const file = path.join(f.bridge.tasks.get(id).workspace, 'wire.log'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; };
  f.writeDiscovery = () => fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ port: f.ui.port, pid: process.pid, token: f.ui.mcpToken }), { mode: 0o600 });
  return f;
}

test('MCP exposes twenty-one high-level tools and rejects direct path, URL, RPC and SQL controls', () => {
  assert.deepEqual(TOOLS.map(tool => tool.name).sort(), ['acknowledge_task_event', 'agent_status', 'approve_once', 'cancel_task', 'capability_inventory', 'capability_invoke', 'capability_status', 'claim_agent_dispatch', 'continue_task', 'create_task', 'get_agent_dispatches', 'get_agent_results', 'get_provider_status', 'get_reasoning_admissions', 'get_task_events', 'get_task_status', 'inspect_context_pack', 'list_architecture_memories', 'native_tool_invoke', 'reject', 'report_agent_dispatch']);
  const task_id = randomUUID(), approval_id = randomUUID();
  const valid = {
    create_task: { description: 'Read the branch', message: 'Report the Git branch', request_id: randomUUID() },
    continue_task: { task_id, message: 'Explain the result', request_id: randomUUID() },
    get_task_status: { task_id }, approve_once: { task_id, approval_id }, reject: { task_id, approval_id }, cancel_task: { task_id },
    capability_invoke: { task_id, name: 'file_read', input: { path: 'README.md' }, request_id: randomUUID() },
    get_agent_results: {}, get_agent_dispatches: {}, claim_agent_dispatch: {dispatch_id: task_id}, report_agent_dispatch: {dispatch_id: task_id, attempt_id: task_id, outcome: {}}, capability_status: { name: 'file_read' }, capability_inventory: {}, agent_status: {}
  };
  for (const [name, args] of Object.entries(valid)) {
    assert.doesNotThrow(() => validate(name, args));
    for (const [key, value] of Object.entries({ path: '/etc', url: 'https://example.com/', rpc: { type: 'bash' }, command: 'echo bypass', sql: 'SELECT * FROM memories', token: 'forged', approved: true })) {
      assert.throws(() => validate(name, { ...args, [key]: value }), /Unknown tool argument/);
    }
  }
  for (const name of ['bash', 'read', 'web_fetch', 'memory_search', 'rpc', 'list_tasks']) assert.throws(() => validate(name, {}), /not exposed/);
  for (const workspace of ['/Users/fixture/code/airodrom', '../', 'https://example.com/']) assert.throws(() => validate('create_task', { ...valid.create_task, workspace }), /Invalid workspace/);
  for (const message of ['/compact', '!echo bypass', '@secret', '   ', 'a\0b']) assert.throws(() => validate('create_task', { ...valid.create_task, message }));
  assert.throws(() => validate('continue_task', { ...valid.continue_task, task_id: '../escape' }), /Invalid task_id/);
  assert.throws(() => validate('create_task', { ...valid.create_task, request_id: 'short' }), /Invalid request_id/);
});

test('MCP and operator credentials are isolated; host and cross-origin requests fail closed', async t => {
  const f = await fixture(t);
  assert.equal(f.ui.server.address().address, '127.0.0.1');
  assert.notEqual(f.ui.token, f.ui.mcpToken);
  const task = f.bridge.createTask('Operator-only fixture');
  const blocked = f.bridge.policy.check(task.id, { toolName: 'bash', input: { command: 'rm -- fixture.txt', timeout: 10 }, toolCallId: 'scope-fixture' });
  const routes = [
    ['/api/state', 'GET'], [`/api/memory?taskId=${task.id}`, 'GET'], ['/api/tasks', 'POST'], ['/api/memory', 'POST'],
    ...['prompt', 'cancel', 'web'].map(action => [`/api/tasks/${task.id}/${action}`, 'POST']),
    ...['approve', 'reject'].map(action => [`/api/approvals/${blocked.approvalId}/${action}`, 'POST'])
  ];
  for (const [route, method] of routes) assert.equal((await f.request(route, { method, token: f.ui.mcpToken, ...(method === 'POST' ? { body: {} } : {}) })).status, 401, route);
  const args = { task_id: task.id };
  assert.equal((await f.call('get_task_status', args, { token: f.ui.token })).status, 401);
  assert.equal((await f.call('get_task_status', args, { token: null })).status, 401);
  for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await f.call('get_task_status', args, { headers })).status, 403);
  assert.equal((await f.request('/api/mcp/call', { token: f.ui.mcpToken })).status, 405);
  assert.equal((await f.call('get_task_status', args, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.call('get_task_status', { ...args, sql: 'SELECT 1' })).status, 400);
  assert.equal((await f.call('bash', { command: 'echo bypass' })).status, 400);
  assert.equal(f.bridge.tasks.list().length, 1);
  assert.equal(f.bridge.policy.list(task.id)[0].status, 'pending');
});

test('MCP cannot inspect, continue, approve, reject or cancel operator-created tasks', async t => {
  const f = await fixture(t), task = f.bridge.createTask('Private operator task');
  const approval = f.bridge.policy.check(task.id, { toolName: 'bash', input: { command: 'rm -- fixture.txt', timeout: 10 }, toolCallId: 'private-fixture' });
  for (const [name, args] of [
    ['get_task_status', { task_id: task.id }], ['continue_task', { task_id: task.id, message: 'Read task', request_id: randomUUID() }],
    ['approve_once', { task_id: task.id, approval_id: approval.approvalId }], ['reject', { task_id: task.id, approval_id: approval.approvalId }], ['cancel_task', { task_id: task.id }]
  ]) {
    const response = await f.call(name, args); assert.equal(response.status, 400); assert.match(response.body.error, /not available to MCP/);
  }
  assert.equal(f.bridge.tasks.get(task.id).status, 'queued');
  assert.equal(f.bridge.policy.list(task.id)[0].status, 'pending');
  assert.equal(f.bridge.runtimes.size, 0);
});

test('invalid client metadata is rejected before creating a task at both service boundaries', async t => {
  const f = await fixture(t);
  const args = { description: 'Must not be created', message: 'Fixture request', request_id: randomUUID() };
  for (const clientInfo of [null, [], 'ChatGPT', { name: null }, { url: 'https://example.com/' }]) {
    const response = await f.request('/api/mcp/call', { method: 'POST', token: f.ui.mcpToken, body: { name: 'create_task', args, clientInfo } });
    assert.equal(response.status, 400); assert.match(response.body.error, /client metadata/);
    await assert.rejects(f.ui.mcp.call('create_task', args, clientInfo), /client metadata/);
    assert.equal(f.bridge.tasks.list().length, 0); assert.equal(f.bridge.inFlight.size, 0);
  }
});

test('create and continue preserve dedicated sessions and receipts; busy status hides stale results', async t => {
  const f = await fixture(t), request_id = randomUUID();
  const first = await f.create('First fixture prompt', request_id);
  const duplicate = await f.create('First fixture prompt', request_id);
  assert.equal(duplicate.task_id, first.task_id); assert.equal(duplicate.duplicate, true);
  await f.settle();
  assert.equal(f.wire(first.task_id).length, 1);
  const state = (await f.call('get_task_status', { task_id: first.task_id })).body;
  assert.equal(state.result, 'FIXTURE_OK'); assert.equal(f.bridge.tasks.get(first.task_id).safetyLoaded, true); assert.equal(state.result_untrusted, true);
  assert.equal(f.bridge.tasks.get(first.task_id).source.transport, 'mcp'); assert.equal(f.bridge.tasks.get(first.task_id).source.identity_verified, false);
  assert.equal(f.bridge.tasks.get(first.task_id).source.client_reported.name, 'fixture-client');
  assert(!JSON.stringify(state).includes(f.ui.token)); assert(!JSON.stringify(state).includes(f.ui.mcpToken));
  assert.equal((await f.call('create_task', { description: 'Disposable MCP fixture', message: 'Changed message', request_id })).status, 400);
  const second = await f.create('Separate task'); await f.settle();
  assert.notEqual(first.task_id, second.task_id); assert.notEqual(first.session_id, second.session_id);
  assert.notEqual(f.bridge.tasks.get(first.task_id).workspace, f.bridge.tasks.get(second.task_id).workspace);
  const nextId = randomUUID(), continuation = { task_id: first.task_id, message: 'never settle', request_id: nextId };
  assert.equal((await f.call('continue_task', continuation)).status, 200);
  await until(() => f.wire(first.task_id).length === 2, 'Continuation should reach the original task workspace');
  const busy = (await f.call('get_task_status', { task_id: first.task_id })).body;
  assert.equal(busy.session_id, first.session_id); assert.equal(busy.busy, true); assert.equal(busy.result, null); assert.equal(busy.latest_request_id, nextId);
  assert.equal(f.bridge.tasks.get(first.task_id).lastResult, null);
  assert.equal((await f.call('continue_task', continuation)).body.duplicate, true);
  assert.equal((await f.call('continue_task', { ...continuation, message: 'Different input' })).status, 400);
  assert.equal((await f.call('continue_task', { ...continuation, request_id: randomUUID() })).status, 400);
  assert.equal(f.wire(first.task_id).length, 2);
  const cancelled = await f.call('cancel_task', { task_id: first.task_id });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.status, 'cancelled'); assert.equal(cancelled.body.result, null);
  await f.settle(); assert.equal(f.bridge.runtimes.has(first.task_id), false);
});

test('ordinary MCP continuations explicitly reactivate only criterion-free review state and retain request-level idempotency', async t => {
  const f = await fixture(t);
  const requestA = 'ledger_live_A_20260930_0243';
  const requestB = 'ledger_live_B_20260930_0244';
  const requestC = 'ledger_live_C_20260930_0246';
  const created = await f.create('First ordinary continuation turn', requestA);
  await f.settle();
  await f.bridge.supervisor.tick();
  const task = f.bridge.tasks.get(created.task_id);
  assert.equal(task.mission.status, 'needs_review');
  assert.equal(task.recovery.reason, 'acceptance_criteria_required');

  const priorRuntime = f.bridge.runtimes.get(task.id);
  await f.bridge.stopTask(task.id);
  assert.equal(f.bridge.runtimes.has(task.id), false, 'a continuation may safely create a replacement runtime');

  const continuedB = await f.call('continue_task', { task_id: task.id, message: 'Second ordinary continuation turn', request_id: requestB });
  assert.equal(continuedB.status, 200, JSON.stringify(continuedB.body));
  await f.settle();
  assert.notEqual(f.bridge.runtimes.get(task.id), priorRuntime, 'replacement runtime belongs to the new run');
  await f.bridge.supervisor.tick();
  assert.equal(task.mission.status, 'needs_review');

  const exactReplay = await f.call('continue_task', { task_id: task.id, message: 'Second ordinary continuation turn', request_id: requestB });
  assert.equal(exactReplay.status, 200); assert.equal(exactReplay.body.duplicate, true);
  const conflictingReuse = await f.call('continue_task', { task_id: task.id, message: 'Materially different B payload', request_id: requestB });
  assert.equal(conflictingReuse.status, 400);
  assert.equal(f.bridge.ledger.health().state, 'healthy');

  const continuedC = await f.call('continue_task', { task_id: task.id, message: 'Third ordinary continuation turn', request_id: requestC });
  assert.equal(continuedC.status, 200, JSON.stringify(continuedC.body));
  await f.settle();
  assert.equal(f.bridge.inFlight.has(task.id), false);
  assert.equal(f.bridge.leases.has(task.id), false);
  const events = f.bridge.ledger.listTaskEvents(task.id, { limit: 100 }).events;
  assert.deepEqual(events.filter(event => event.event_type === 'agent.instruction.sent').map(event => event.request_id), [requestA, requestB, requestC]);
  assert.equal(events.filter(event => event.event_type === 'agent.result.received').length, 3, 'instruction and result records sharing a task remain distinct');
});

test('cancelled and safety-stopped MCP tasks cannot reactivate from review, while an authorization failure settles its lease', async t => {
  const f = await fixture(t);
  const cancelled = await f.create('Cancellation continuation fixture'); await f.settle(); await f.bridge.supervisor.tick();
  await f.bridge.cancel(cancelled.task_id);
  const cancelledTask = f.bridge.tasks.get(cancelled.task_id);
  const cancelledRequestCount = Object.keys(cancelledTask.mcpRequests).length;
  const cancelledContinuation = await f.call('continue_task', { task_id: cancelled.task_id, message: 'must remain denied', request_id: randomUUID() });
  assert.equal(cancelledContinuation.status, 400);
  assert.equal(Object.keys(cancelledTask.mcpRequests).length, cancelledRequestCount, 'a denied continuation receives no MCP receipt');

  const stopped = await f.create('Safety-stop continuation fixture'); await f.settle(); await f.bridge.supervisor.tick();
  const stoppedTask = f.bridge.tasks.get(stopped.task_id);
  stoppedTask.safetyStop = { latched: true, reason: 'fixture safety stop', evidence: { taskId: stopped.task_id } };
  f.bridge.policy.latchSafetyStop(stopped.task_id, stoppedTask.safetyStop.reason, stoppedTask.safetyStop.evidence);
  f.bridge.tasks.save(stoppedTask);
  const stoppedContinuation = await f.call('continue_task', { task_id: stopped.task_id, message: 'must remain safety denied', request_id: randomUUID() });
  assert.equal(stoppedContinuation.status, 400);
  assert.equal(f.bridge.inFlight.has(stopped.task_id), false);

  const failed = await f.create('Authorization failure settlement fixture'); await f.settle(); await f.bridge.supervisor.tick();
  const failedContinuation = await f.call('continue_task', { task_id: failed.task_id, message: 'simulate broker authorization failure', request_id: randomUUID() });
  assert.equal(failedContinuation.status, 200);
  await f.settle();
  const failedStatus = (await f.call('get_task_status', { task_id: failed.task_id })).body;
  assert.equal(failedStatus.busy, false);
  assert.equal(f.bridge.leases.has(failed.task_id), false);
  assert.match(failedStatus.error, /No active trusted mission grant/);
});

test('prototype-shaped request IDs remain durable receipts and never replay a continuation', async t => {
  const f = await fixture(t), created = await f.create(); await f.settle();
  const args = { task_id: created.task_id, message: 'Prototype receipt fixture', request_id: '__proto__' };
  assert.equal((await f.call('continue_task', args)).status, 200); await f.settle();
  assert.equal((await f.call('continue_task', args)).body.duplicate, true);
  assert.equal(f.wire(created.task_id).length, 2);
  assert.equal((await f.call('continue_task', { ...args, message: 'Changed prototype receipt' })).status, 400);
  await f.restart();
  assert.equal((await f.call('continue_task', args)).body.duplicate, true);
  assert.equal(f.wire(created.task_id).length, 2); assert.equal(f.bridge.runtimes.size, 0);
});

test('failed and interrupted requests never report the previous successful result', async t => {
  const f = await fixture(t), created = await f.create(); await f.settle();
  assert.equal((await f.call('get_task_status', { task_id: created.task_id })).body.result, 'FIXTURE_OK');
  assert.equal((await f.call('continue_task', { task_id: created.task_id, message: 'never settle', request_id: randomUUID() })).status, 200);
  await until(() => f.wire(created.task_id).length === 2, 'Failure fixture should receive its continuation');
  f.bridge.runtimes.get(created.task_id).rpc.child.kill('SIGTERM');
  await f.settle();
  const failed = (await f.call('get_task_status', { task_id: created.task_id })).body;
  assert.equal(failed.status, 'failed'); assert.equal(failed.result, null); assert(failed.error);
  // Simulate a persisted pre-fix snapshot left by a process interruption.
  const task = f.bridge.tasks.get(created.task_id); task.status = 'thinking'; task.lastResult = 'STALE_PREVIOUS_SUCCESS'; f.bridge.tasks.save(task);
  await f.restart();
  const interrupted = (await f.call('get_task_status', { task_id: created.task_id })).body;
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.result, null);
});

test('approve_once cannot grant permission; operator exact one-shot approval and task binding remain enforced', async t => {
  const f = await fixture(t), first = await f.create(); await f.settle();
  const call = { toolName: 'project_create', input: { name: 'MCP exact approval fixture', description: 'Local test' }, toolCallId: 'mcp-approval-fixture' };
  const pending = (await f.bridge.capabilityBroker.execute(first.task_id, call)).decision; assert(pending.approvalId);
  const args = { task_id: first.task_id, approval_id: pending.approvalId };
  const presented = await f.call('approve_once', args);
  assert.equal(presented.status, 200); assert.equal(presented.body.approved, false); assert.equal(presented.body.operator_confirmation_required, true);
  assert.equal(f.bridge.policy.list(first.task_id).find(item => item.id === pending.approvalId).status, 'pending');
  assert.equal(f.bridge.policy.check(first.task_id, call).allow, false);
  assert.equal((await f.request(`/api/approvals/${pending.approvalId}/approve`, { method: 'POST', body: {}, token: f.ui.mcpToken })).status, 401);
  const operator = await f.request(`/api/approvals/${pending.approvalId}/approve`, { method: 'POST', body: {} }); assert.equal(operator.status, 202);
  await f.settle();
  assert.equal(f.bridge.policy.check(first.task_id, { ...call, input: { ...call.input, name: 'different' } }).allow, false);
  assert.equal(f.bridge.policy.check(first.task_id, call).allow, false, 'operator resume already consumed the exact grant');
  assert.equal(f.bridge.policy.list(first.task_id).find(item => item.id === pending.approvalId).status, 'consumed');
  assert.equal(f.bridge.policy.check(first.task_id, call).allow, false);
  assert.equal((await f.call('approve_once', args)).status, 400);
  const second = await f.create(); await f.settle();
  const otherPending = (await f.bridge.capabilityBroker.execute(second.task_id, call)).decision;
  for (const name of ['approve_once', 'reject']) assert.equal((await f.call(name, { task_id: first.task_id, approval_id: otherPending.approvalId })).status, 400);
  assert.equal(f.bridge.policy.list(second.task_id).find(item => item.id === otherPending.approvalId).status, 'pending');
  const rejectArgs = { task_id: second.task_id, approval_id: otherPending.approvalId };
  assert.equal((await f.call('reject', rejectArgs)).body.rejected, true);
  assert.equal((await f.call('reject', rejectArgs)).body.rejected, true);
  assert.equal(f.bridge.policy.list(second.task_id).find(item => item.id === otherPending.approvalId).status, 'rejected');
  const revoke = f.bridge.policy.check(second.task_id, { ...call, input: { ...call.input, command: 'rm -- revoke-fixture.txt' } });
  assert.equal((await f.call('cancel_task', { task_id: second.task_id })).body.status, 'cancelled');
  assert.equal(f.bridge.policy.list(second.task_id).find(item => item.id === revoke.approvalId).status, 'revoked');
});

test('persisted create receipts recover after bridge restart without replaying Pi', async t => {
  const f = await fixture(t), request_id = randomUUID(), message = 'Durable receipt fixture';
  const first = await f.create(message, request_id); await f.settle();
  assert.equal(f.wire(first.task_id).length, 1);
  await f.restart();
  const duplicate = await f.create(message, request_id);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.task_id, first.task_id); assert.equal(duplicate.session_id, first.session_id);
  assert.equal(f.bridge.tasks.list().length, 1); assert.equal(f.bridge.runtimes.size, 0); assert.equal(f.wire(first.task_id).length, 1);
  const state = await f.call('get_task_status', { task_id: first.task_id }); assert.equal(state.body.result, 'FIXTURE_OK');
  assert.equal((await f.call('create_task', { description: 'Changed title', message, request_id })).status, 400);
});

test('local client requires private discovery, reloads rotated credentials and reports offline failure', async t => {
  const f = await fixture(t), created = await f.create(); await f.settle();
  f.writeDiscovery(); const client = createClient({ dataDir: f.dataDir });
  assert.equal((await client('get_task_status', { task_id: created.task_id })).result, 'FIXTURE_OK');
  const discoveryFile = path.join(f.dataDir, 'mcp.json');
  fs.chmodSync(discoveryFile, 0o644); assert.throws(() => discovery(f.dataDir), /private/);
  await assert.rejects(client('get_task_status', { task_id: created.task_id }), error => /unavailable|private discovery/.test(error.publicMessage));
  fs.chmodSync(discoveryFile, 0o600);
  fs.chmodSync(f.dataDir, 0o755); assert.throws(() => discovery(f.dataDir), /private/); fs.chmodSync(f.dataDir, 0o700);
  const saved = fs.readFileSync(discoveryFile); fs.unlinkSync(discoveryFile);
  const target = path.join(f.root, 'discovery-target'); fs.writeFileSync(target, saved, { mode: 0o600 }); fs.symlinkSync(target, discoveryFile);
  assert.throws(() => discovery(f.dataDir), /private/); fs.unlinkSync(discoveryFile); f.writeDiscovery();
  fs.writeFileSync(discoveryFile, JSON.stringify({ port: 80, pid: process.pid, token: 'bad-token' })); assert.throws(() => discovery(f.dataDir), /Invalid MCP discovery/);
  f.writeDiscovery();
  const oldMcpToken = f.ui.mcpToken, oldOperatorToken = f.ui.token;
  await f.restart(); f.writeDiscovery();
  assert.notEqual(f.ui.mcpToken, oldMcpToken); assert.equal(f.ui.token, oldOperatorToken);
  assert.equal((await f.call('get_task_status', { task_id: created.task_id }, { token: oldMcpToken })).status, 401);
  assert.equal((await f.request('/api/state', { token: oldOperatorToken })).status, 200);
  assert.equal((await client('get_task_status', { task_id: created.task_id })).result, 'FIXTURE_OK');
  await f.ui.close();
  await assert.rejects(client('get_task_status', { task_id: created.task_id }), error => /Local bridge request failed/.test(error.publicMessage) && !error.publicMessage.includes(f.ui.mcpToken));
});

test('checkpoint writes remain operator-only and preserve task-scoped evidence',async t=>{
  const f=await fixture(t),created=await f.create();await f.settle();
  const checkpoint={objective:'Operator checkpoint',verifiedFacts:[{fact:'Fixture completed',evidence:'fixture receipt'}],hypotheses:[],decisions:[],completedGates:[],failedApproaches:[],gitReferences:[],nextStep:'Continue fixture'};
  const body={taskId:created.task_id,checkpoint};
  assert.equal((await f.request('/api/checkpoints',{method:'POST',body,token:f.ui.mcpToken})).status,401);
  const saved=await f.request('/api/checkpoints',{method:'POST',body});assert.equal(saved.status,201);
  assert.equal(f.bridge.memory.latestCheckpoint(created.task_id).id,saved.body.id);
  assert.equal(saved.body.provenance.source,'operator-verified');
  assert.equal((await f.request('/api/checkpoints',{method:'POST',body:{...body,checkpoint:{...checkpoint,verifiedFacts:[{fact:'No evidence'}]}}})).status,400);
});


test('diagnostic payload uses workspace aliases without identifying data and preserves exact local permissions', async t => {
  const f = await fixture(t);
  // Capture dispatch without launching Pi inside the actual repository.
  const prompts = [];
  f.bridge.prompt = async (id, message) => { prompts.push({ id, message }); };
  const args = {
    description: 'Inspect bridge task schema', workspace: 'bridge',
    message: 'Inspect src/mcp-tools.js and report whether create_task exposes acceptance_criterion and acceptance_mode. Read only; do not change files or restart services.',
    request_id: 'diagnostic-schema-001', acceptance_criterion: 'operator verified schema'
  };
  const create = await f.call('create_task', args);
  assert.equal(create.status, 200);
  const task = f.bridge.tasks.get(create.body.task_id);
  assert.equal(task.workspace, fs.realpathSync(path.resolve(__dirname, '..')));
  assert.equal(prompts[0].message, args.message);
  assert.deepEqual(task.mission.criteria, [args.acceptance_criterion]);
  const status = await f.call('get_task_status', { task_id: task.id });
  assert.equal(status.body.workspace, 'bridge');
  const payload = JSON.stringify({ tools: TOOLS, request: args, receipt: create.body, status: status.body, prompts });
  assert.doesNotMatch(payload, /andrew|\/Users\//i);
  assert.equal(payload.includes(task.workspace), false);
  assert.match(TOOLS[0].description, /repository-relative paths/);
  assert.equal((await f.call('create_task', args)).body.duplicate, true);
  assert.equal(prompts.length, 1);
  assert.equal(f.bridge.policy.check(task.id, { toolName: 'bash', input: { command: 'git status --short' } }).allow, true);
  const input = { path: path.join(task.workspace, 'never-write.txt'), content: 'ordinary workspace edit' };
  assert.equal(f.bridge.policy.check(task.id, { toolName: 'write', input }).allow, true);
  const blocked = f.bridge.policy.check(task.id, { toolName: 'bash', input: { command: 'rm never-write.txt' } });
  assert.equal(blocked.allow, false);
  const pending = (await f.call('get_task_status', { task_id: task.id })).body.approvals[0];
  assert.equal(pending.workspace, undefined); assert.equal(pending.input, undefined);
  const captured=f.bridge.policy.list(task.id).find(a=>a.id===pending.id);
  assert.equal(captured.workspace,task.workspace);assert.deepEqual(captured.input,{command:'rm never-write.txt'});
  assert.equal((await f.call('approve_once', { task_id: task.id, approval_id: blocked.approvalId })).body.approved, false);
  assert.equal(f.bridge.policy.list(task.id)[0].status, 'pending');
  // Existing persisted tasks need no new metadata for the alias representation.
  await f.restart();
  assert.equal((await f.call('get_task_status', { task_id: task.id })).body.workspace, 'bridge');
});

test('isolated status uses an alias while functionally required caller text stays exact', async t => {
  const f = await fixture(t);
  const messages = [];
  f.bridge.prompt = async (_id, message) => { messages.push(message); };
  const args = {
    description: 'Explicit path investigation', request_id: 'exact-path-request-001',
    message: 'Explain this supplied path without executing tools: /Users/example/project',
    acceptance_criterion: 'Explain /Users/example/project'
  };
  const created = await f.call('create_task', args);
  assert.equal(created.status, 200);
  const task = f.bridge.tasks.get(created.body.task_id);
  assert.equal((await f.call('get_task_status', { task_id: task.id })).body.workspace, 'isolated');
  assert.equal(messages[0], args.message);
  assert.deepEqual(task.mission.criteria, [args.acceptance_criterion]);
  assert.equal((await f.call('create_task', { ...args, message: 'Changed meaning' })).status, 400);
});
