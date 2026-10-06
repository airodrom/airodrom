'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger, SCHEMA_VERSION, MAX_PAYLOAD_BYTES, MAX_STORED_PAYLOAD_BYTES } = require('../src/event-ledger');
const BridgeController = require('../src/bridge-controller');
const { McpTools } = require('../src/mcp-tools');

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join('/private/tmp', prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function event(overrides = {}) {
  return {
    eventType: 'agent.instruction.sent', agent: 'chatgpt', direction: 'outgoing',
    taskId: 'task-a', runId: 'run-a', missionId: 'mission-a', sessionId: 'session-a', requestId: 'request-a', traceId: 'trace-a',
    workspace: 'bridge', repository: 'pi-chatgpt-bridge', branch: 'feature/ledger', status: 'recorded',
    payload: 'Inspect src/example.js', metadata: { target: 'pi' }, ...overrides
  };
}

function bridge(t) {
  const root = temporary(t, 'pi-event-ledger-');
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const controller = new BridgeController({ defaultRuntime: 'pi',
    dataDir: path.join(root, 'data'), sourceProfile: profile,
    executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), allowFixtureWorker: true,
    taskTimeoutMs: 10_000, maxConcurrent: 1
  });
  t.after(async () => { try { await controller.shutdown(); } catch {} });
  return controller;
}

async function settle(controller, taskId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const task = controller.tasks.get(taskId);
    if (!controller.leases.has(taskId) && !controller.inFlight.has(taskId) && task.status === 'completed') return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Task ${taskId} did not settle`);
}

test('fresh initialization, migration, ordering, correlation, and restart persistence', t => {
  const root = temporary(t, 'ledger-db-');
  const file = path.join(root, 'memory.sqlite');
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE task_states (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
  db.prepare('INSERT INTO task_states(id,snapshot) VALUES (?,?)').run('old-task', '{}');
  let clock = 1_700_000_000_000;
  let ledger = new EventLedger(db, { now: () => clock });
  assert.equal(ledger.health().schema_version, SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_states').get().n, 1, 'existing bridge tables remain intact');
  const first = ledger.record(event({ idempotencyKey: 'instruction:one' }));
  clock += 1;
  const second = ledger.record(event({ eventType: 'agent.result.received', agent: 'pi', direction: 'incoming', idempotencyKey: 'result:one', payload: 'done' }));
  assert.equal(first.sequence + 1, second.sequence);
  assert.deepEqual(ledger.listTaskEvents('task-a').events.map(row => row.sequence), [first.sequence, second.sequence]);
  assert.equal(ledger.listTrace('trace-a').events.length, 2);
  assert.equal(ledger.list({ runId: 'run-a', sessionId: 'session-a', requestId: 'request-a' }).events.length, 2);
  db.close();
  db = new DatabaseSync(file); ledger = new EventLedger(db);
  assert.equal(ledger.listTaskEvents('task-a').events.length, 2, 'events survive reopening the existing database');
  db.close();
});

test('retries are idempotent and concurrent callers receive monotonic sequence ordering', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const ledger = new EventLedger(db);
  const original = event({ idempotencyKey: 'retry-key' });
  const first = ledger.record(original);
  const duplicate = ledger.record({ ...original, eventId: randomUUID() });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sequence, first.sequence);
  const mismatchDb = new DatabaseSync(':memory:');
  const mismatch = new EventLedger(mismatchDb); mismatch.record(original);
  assert.throws(() => mismatch.record({ ...original, payload: 'changed payload' }), /replay does not match/);
  mismatchDb.close();

  const concurrent = [];
  for (let index = 0; index < 48; index++) concurrent.push(Promise.resolve().then(() => ledger.record(event({ eventType: 'task.phase_changed', idempotencyKey: `concurrent:${index}`, status: `phase-${index}` }))));
  return Promise.all(concurrent).then(rows => {
    const sequences = rows.map(row => row.sequence).sort((a, b) => a - b);
    assert.equal(new Set(sequences).size, 48);
    assert.deepEqual(sequences, Array.from({ length: 48 }, (_, index) => first.sequence + index + 1));
  });
});

test('the live create-to-continue sequence keeps request idempotency separate from task-start, result, approval, and tool events across restart', async t => {
  const root = temporary(t, 'ledger-live-continue-');
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const dataDir = path.join(root, 'data');
  const makeController = () => new BridgeController({ defaultRuntime: 'pi',
    dataDir, sourceProfile: profile, executable: path.join(__dirname, 'fixtures/fake-pi.cjs'),
    allowFixtureWorker: true, taskTimeoutMs: 10_000, maxConcurrent: 1
  });
  let controller = makeController();
  t.after(async () => { try { await controller.shutdown(); } catch {} });
  await controller.initialize();
  let mcp = new McpTools(controller);
  const requestA = 'ledger_live_A_20260930_0243';
  const requestB = 'ledger_live_B_20260930_0244';
  const requestC = 'ledger_live_C_20260930_0246';
  const requestD = 'ledger_live_D_20260930_0248';
  const messageA = 'Verify the ledger smoke fixture and report only FIXTURE_OK.';
  const messageB = 'Continue the ledger smoke fixture with a distinct turn.';
  const messageC = 'Continue after the rejected replay conflict.';

  const created = await mcp.call('create_task', { description: 'Ledger live continuation fixture', message: messageA, request_id: requestA });
  await settle(controller, created.task_id);
  await controller.supervisor.tick();
  assert.equal(controller.tasks.get(created.task_id).mission.status, 'needs_review', 'the isolated sequence reproduces the supervisor review state from the live task');
  // Simulate the already-running daemon before this P0 fix: its durable V1
  // rows exist, but the newly introduced task-start cache fields do not.
  const legacyTask = controller.tasks.get(created.task_id);
  delete legacyTask.ledgerStartRequestId;
  delete legacyTask.ledgerTraceId;
  delete legacyTask.ledgerGitBaseline;
  controller.tasks.save(legacyTask);
  const continuedB = await mcp.call('continue_task', { task_id: created.task_id, message: messageB, request_id: requestB });
  assert.equal(continuedB.duplicate, false);
  await settle(controller, created.task_id);
  await controller.supervisor.tick();

  const instructions = () => controller.ledger.list({ taskId: created.task_id, eventType: 'agent.instruction.sent', limit: 20 }).events;
  assert.deepEqual(instructions().map(row => row.request_id), [requestA, requestB]);
  const retriedB = await mcp.call('continue_task', { task_id: created.task_id, message: messageB, request_id: requestB });
  assert.equal(retriedB.duplicate, true);
  assert.equal(instructions().filter(row => row.request_id === requestB).length, 1, 'an exact retry reuses B without a second instruction event');

  // This direct call exercises the ledger-side conflict path. MCP rejects the
  // same misuse before dispatch, but the durable ledger must also reject it
  // without declaring SQLite unhealthy.
  const task = controller.tasks.get(created.task_id);
  task.latestMcpRequestId = requestB; controller.tasks.save(task);
  await assert.rejects(controller.prompt(created.task_id, 'materially different payload for request B'), error => error?.code === 'LEDGER_IDEMPOTENCY_CONFLICT');
  assert.equal(controller.ledger.health().state, 'healthy');
  assert.equal(controller.tasks.get(created.task_id).failureKind, 'ledger_idempotency_conflict');
  assert.equal(controller.leases.has(created.task_id), false);
  await assert.rejects(mcp.call('continue_task', { task_id: created.task_id, message: 'materially different payload for request B', request_id: requestB }), /request_id was already used/);

  const continuedC = await mcp.call('continue_task', { task_id: created.task_id, message: messageC, request_id: requestC });
  assert.equal(continuedC.duplicate, false);
  await settle(controller, created.task_id);
  await controller.supervisor.tick();
  assert.equal(controller.ledger.health().state, 'healthy');
  assert.deepEqual(instructions().map(row => row.request_id), [requestA, requestB, requestC]);
  const turnEvents = controller.ledger.listTaskEvents(created.task_id, { limit: 200 }).events;
  assert.equal(turnEvents.filter(row => row.event_type === 'agent.result.received').length, 3, 'results sharing a task remain separate from instruction events');
  assert.equal(turnEvents.filter(row => row.event_type === 'task.created').length, 1, 'task-start event remains a single stable record');
  assert.equal(turnEvents.filter(row => row.event_type === 'git.baseline.observed').length, 1, 'Git baseline remains a single stable record');

  const approval = controller.policy.check(created.task_id, { toolName: 'bash', input: { command: 'touch approval-marker' }, toolCallId: 'same-correlation-id' });
  assert.equal(approval.allow, false);
  controller._recordCapabilityRequested(controller.tasks.get(created.task_id), 'run_job', {
    request: { toolCallId: 'same-correlation-id', input: { jobName: 'focused_test' } }, describedJob: { kind: 'trusted-development' }
  });
  const correlated = controller.ledger.listTaskEvents(created.task_id, { limit: 200 }).events;
  assert.ok(correlated.some(row => row.event_type === 'approval.requested'));
  assert.ok(correlated.some(row => row.event_type === 'test.started'));

  const eventIdsBeforeRestart = correlated.map(row => row.event_id);
  await controller.shutdown();
  controller = makeController(); await controller.initialize(); mcp = new McpTools(controller);
  await controller.supervisor.tick();
  const afterRestart = controller.ledger.listTaskEvents(created.task_id, { limit: 200 }).events;
  assert.deepEqual(afterRestart.slice(0, eventIdsBeforeRestart.length).map(row => row.event_id), eventIdsBeforeRestart, 'restart preserves existing rows in append order');
  const replayAfterRestart = await mcp.call('continue_task', { task_id: created.task_id, message: messageC, request_id: requestC });
  assert.equal(replayAfterRestart.duplicate, true);
  const continuedD = await mcp.call('continue_task', { task_id: created.task_id, message: 'Continuation after restart remains distinct.', request_id: requestD });
  assert.equal(continuedD.duplicate, false);
  await settle(controller, created.task_id);
  assert.deepEqual(controller.ledger.list({ taskId: created.task_id, eventType: 'agent.instruction.sent', limit: 20 }).events.map(row => row.request_id), [requestA, requestB, requestC, requestD]);
});

test('payloads are redacted before SQLite persistence while preserving original UTF-8 hashes and explicit bounds', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const ledger = new EventLedger(db);
  const secret = 'token=super-secret-value\nAuthorization: Bearer credential-secret-value\npath=/Users/operator/private.txt';
  const saved = ledger.record(event({ payload: secret, idempotencyKey: 'secret-test' }));
  assert.equal(saved.payload_sha256, createHash('sha256').update(Buffer.from(secret, 'utf8')).digest('hex'));
  assert.equal(saved.payload_byte_length, Buffer.byteLength(secret));
  const persisted = db.prepare('SELECT payload, metadata FROM event_ledger_events WHERE event_id=?').get(saved.event_id);
  assert.doesNotMatch(persisted.payload, /super-secret-value|credential-secret-value|\/Users\/operator/);
  assert.doesNotMatch(persisted.metadata, /super-secret-value|credential-secret-value/);
  assert.equal(saved.payload_redacted, true);

  const oversized = 'x'.repeat(MAX_STORED_PAYLOAD_BYTES + 800);
  const clipped = ledger.record(event({ payload: oversized, idempotencyKey: 'oversized-display' }));
  assert.equal(clipped.payload_truncated, true);
  assert.equal(clipped.payload_byte_length, Buffer.byteLength(oversized));
  assert.ok(clipped.payload_stored_byte_length <= MAX_STORED_PAYLOAD_BYTES);

  const rejecting = new EventLedger(new DatabaseSync(':memory:'));
  assert.throws(() => rejecting.record(event({ payload: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) })), /maximum input size/);
  assert.equal(rejecting.health().state, 'healthy', 'invalid caller input does not poison a healthy store');
  rejecting.db.close();
  assert.throws(() => rejecting.record(event({ idempotencyKey: 'closed-db' })), /closed|database/i);
  assert.equal(rejecting.health().state, 'degraded', 'a durable write failure closes future dispatch');
});

test('spans and structured queries retain causal correlation', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let now = 1000;
  const ledger = new EventLedger(db, { now: () => now });
  const started = ledger.startSpan(event({ eventType: 'test.started', agent: 'shell', direction: 'internal', spanId: 'span-a', idempotencyKey: 'span-start' }));
  now = 1057;
  const completed = ledger.completeSpan(started, event({ eventType: 'test.completed', agent: 'shell', direction: 'internal', idempotencyKey: 'span-end', status: 'completed' }));
  assert.equal(completed.duration_ms, 57);
  assert.equal(completed.parent_event_id, started.event_id);
  assert.equal(ledger.list({ spanId: 'span-a' }).events.length, 2);
  assert.equal(ledger.list({ agent: 'shell', eventType: 'test.completed', fromMs: 1001, toMs: 2000 }).events.length, 1);
});

test('local Ollama routing events retain only safe final transport and native-response metadata', async t => {
  const controller = bridge(t); await controller.initialize();
  const task = controller.createTask('safe provider transport projection');
  controller._recordLocalOllamaAudit({
    task, decision: 'allow', executionStatus: 'COMPLETED', inputBytes: 123, outputBytes: 456, durationMs: 78,
    transport: {
      temperature: 0, toolsPresent: true, toolNames: ['personal_memory_search'],
      toolSchemaSha256: 'a'.repeat(64), toolChoice: 'function:personal_memory_search',
      toolProtocol: { available: true, source: 'ollama_show', reason: null },
      response: { finishReason: 'tool_calls', nativeToolCallsPresent: true, nativeToolNames: ['personal_memory_search'], malformedSse: false }
    }
  });
  const event = controller.ledger.list({ taskId: task.id, eventType: 'routing.decision' }).events[0];
  assert.equal(event.payload, null, 'the final provider request and response text are never ledger payloads');
  assert.deepEqual(event.metadata, {
    selected_agent: 'pi', provider: 'ollama', model: 'qwen3-coder:30b',
    primary_model: 'qwen3-coder:30b', tool_model: 'qwen3-coder:30b', route_role: null,
    local: true, decision: 'allow', reason: null, input_bytes: 123, output_bytes: 456, duration_ms: 78,
    temperature: 0, tools_present: true, tool_names: ['personal_memory_search'],
    tool_schema_sha256: 'a'.repeat(64), tool_choice: 'function:personal_memory_search',
    native_tool_protocol_available: true, native_tool_protocol_reason: null,
    capability_status: null, capability_allow: null, capability_reason: null,
    model_digest: null, template_hash: null,
    provider_finish_reason: 'tool_calls', provider_native_tool_calls_present: true,
    provider_native_tool_names: ['personal_memory_search'], provider_malformed_sse: false
  });
});

test('a degraded ledger blocks new instructions and pending approvals without preventing an already-running lease from settling', async t => {
  const controller = bridge(t); await controller.initialize();

  const blockedTask = controller.createTask('ledger dispatch failure');
  controller.ledger.markDegraded(new Error('simulated disk full'));
  await assert.rejects(controller.prompt(blockedTask.id, 'must not reach Pi'), /ledger is degraded/);
  assert.equal(controller.runtimes.has(blockedTask.id), false);
  assert.equal(controller.leases.has(blockedTask.id), false);
  assert.equal(controller.tasks.get(blockedTask.id).status, 'blocked');

  const approvalTask = controller.createTask('ledger approval failure');
  assert.throws(() => controller.policy.check(approvalTask.id, { toolName: 'bash', input: { command: 'touch approval-marker' }, toolCallId: 'approval-call' }), /ledger is degraded/);
  assert.equal(controller.policy.list(approvalTask.id).length, 0, 'approval is never created when its audit event cannot be stored');

  // A separate healthy controller proves degradation only closes new work. Its
  // active lease still reaches the normal cancellation and compare-release path.
  const active = bridge(t); await active.initialize();
  const task = active.createTask('active lease settles during ledger outage');
  const running = active.prompt(task.id, 'never settle');
  for (let index = 0; index < 100 && !active.runtimes.has(task.id); index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(active.runtimes.has(task.id));
  active.ledger.markDegraded(new Error('simulated ledger outage'));
  await active.cancel(task.id);
  await assert.rejects(running, /cancelled|shutdown|stopped/i);
  assert.equal(active.leases.has(task.id), false);
  assert.equal(active.snapshotTask(active.tasks.get(task.id)).busy, false);
});

test('bridge ledger records a Git baseline and keeps approvals distinct from execution results', async t => {
  const controller = bridge(t); await controller.initialize();
  const task = controller.createTask('git baseline attribution');
  await controller.prompt(task.id, 'ok');
  const events = controller.ledger.listTaskEvents(task.id).events;
  assert.ok(events.some(row => row.event_type === 'git.baseline.observed'));
  assert.ok(events.some(row => row.event_type === 'agent.instruction.sent'));
  assert.ok(events.some(row => row.event_type === 'agent.result.received' && row.agent === 'pi'));
  controller._recordCapabilityRequested(controller.tasks.get(task.id), 'run_job', {
    request: { toolCallId: 'focused-ledger-test', input: { jobName: 'focused_test' } },
    describedJob: { kind: 'trusted-development' }
  });
  controller._recordCapabilityCompleted(controller.tasks.get(task.id), 'run_job', JSON.stringify({
    name: 'focused_test', kind: 'trusted-development', exitCode: 0, signal: null, timedOut: false, output: '2 tests passed', outputTruncated: false
  }), { toolCallId: 'focused-ledger-test', input: { jobName: 'focused_test' } });
  const testEvents = controller.ledger.listTaskEvents(task.id).events;
  assert.ok(testEvents.some(row => row.event_type === 'test.started'));
  assert.ok(testEvents.some(row => row.event_type === 'test.completed' && row.status === 'completed'));

  const pending = controller.createTask('approval semantics');
  const decision = controller.policy.check(pending.id, { toolName: 'bash', input: { command: 'touch approval-marker' }, toolCallId: 'approval-semantics' });
  assert.equal(decision.allow, false);
  const approval = controller.policy.list(pending.id)[0];
  controller.approve(approval.id);
  const approvalEvents = controller.ledger.listTaskEvents(pending.id).events;
  assert.ok(approvalEvents.some(row => row.event_type === 'approval.requested'));
  assert.ok(approvalEvents.some(row => row.event_type === 'approval.approved'));
  assert.equal(approvalEvents.some(row => row.event_type === 'task.completed'), false, 'approval is permission, not execution success');
});
