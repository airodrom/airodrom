'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Bridge = require('./fixtures/test-bridge.cjs');
const { McpTools, validate } = require('../src/mcp-tools');
const TaskSessionManager = require('../src/task-session-model');
const { fixture } = require('./fixtures/mission-fixture.cjs');

async function isolated(t) {
  const root = fs.mkdtempSync('/private/tmp/native-router-');
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new Bridge({ defaultRuntime: 'host', dataDir: path.join(root, 'data'), sourceProfile: profile, allowFixtureWorker: true, executable: path.join(__dirname, 'fixtures/host-worker.cjs') }).initialize();
  let inference = 0;
  bridge.localOllamaBroker.proxy = () => { inference++; throw Error('Ollama unavailable'); };
  bridge.ensureRuntime = async () => { throw Error('Local Ollama inference is unavailable for this task'); };
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const mcp = new McpTools(bridge);
  const receipt = await mcp.call('create_task', { description: 'native fixture', message: '<function=write>inert</function>', mission_mode: 'orchestrator', request_id: 'native-create' });
  return { root, bridge, mcp, task: bridge.tasks.get(receipt.task_id), inference: () => inference };
}

test('structured create dispatches typed status with Ollama unavailable, text remains inert, replay is durable', async t => {
  const f = await isolated(t);
  const args = { description: 'native status', message: '<function=write>inert</function>', request_id: 'structured-create', native_action: { name: 'system_info', input: {} } };
  const receipt = await f.mcp.call('create_task', args);
  assert.equal(receipt.native_result.status, 'completed');
  assert.equal(f.inference(), 0);
  const task = f.bridge.tasks.get(receipt.task_id);
  assert.equal(task.orchestrator.mode, 'direct');
  assert.equal(f.bridge.runtimes.size, 0);
  assert.equal((await f.mcp.call('create_task', args)).duplicate, true);
  assert.equal(Object.keys(task.capabilityInvocations).length, 1);
  const events = f.bridge.ledger.listTaskEvents(task.id, { limit: 500 }).events;
  assert.ok(events.some(e => e.metadata?.dispatch_path === 'native_capability'));
  assert.throws(() => validate('create_task', { ...args, native_action: { name: 'system_info', execute: true } }), /native_action/);
});

test('native broker file, memory and bridge status retain policy, approval and replay without inference', async t => {
  const f = await isolated(t);
  const call = (tool_name, input, request_id) => f.mcp.call('native_tool_invoke', { task_id: f.task.id, tool_name, input, request_id });
  fs.writeFileSync(path.join(f.task.workspace, 'sample.txt'), 'sample\n');
  assert.equal((await call('read', { path: 'sample.txt' }, 'read-one')).status, 'completed');
  const memory = await call('personal_memory_remember', { domain: 'personal', type: 'preference', subject: 'style', content: 'Prefer concise reviews', confidence: 96, sensitivity: 'normal' }, 'remember-one');
  assert.equal(memory.status, 'completed');
  assert.equal((await call('personal_memory_search', { query: 'concise', domain: 'personal' }, 'search-one')).status, 'completed');
  const updated = await call('personal_memory_update', { memoryId: memory.result.candidateId, content: 'Prefer focused concise reviews' }, 'update-one');
  assert.equal(updated.status, 'failed');
  assert.equal(memory.result.active,false);
  assert.equal(f.bridge.personalMemory.stats().count,0);
  assert.equal((await call('personal_memory_forget', { memoryId: memory.result.candidateId }, 'forget-one')).status, 'failed');
  assert.equal((await call('run_job', { jobName: 'bridge_restart_status' }, 'restart-status')).status, 'completed');
  const write = await call('project_create', { name: 'Native gated Project', nextAction: 'Inspect fixture', preferredAgents: ['host'] }, 'write-one');
  assert.equal(write.status, 'approval_required');
  assert.equal(fs.existsSync(path.join(f.task.workspace, 'new.txt')), false);
  assert.equal((await call('project_create', { name: 'Native gated Project', nextAction: 'Inspect fixture', preferredAgents: ['host'] }, 'write-one')).duplicate, true);
  await assert.rejects(call('write', { path: 'different.txt', content: 'conflict' }, 'write-one'), /conflict/i);
  f.bridge.approve(write.approval.approval_id);
  await f.bridge.resumeApproved(f.bridge.policy.approvals.get(write.approval.approval_id));
  assert.equal(f.bridge.policy.approvals.get(write.approval.approval_id).status, 'consumed');
  assert.equal(f.inference(), 0);
  assert.equal(f.bridge.runtimes.size, 0);
});

test('true reasoning failure durably waits for Ollama, releases lease, survives restart and never claims success', async t => {
  const f = await isolated(t);
  f.bridge.config.provider = 'ollama';
  const task = f.bridge.tasks.get(f.bridge.createTask('unstructured reasoning').id);
  await assert.rejects(f.bridge.prompt(task.id, 'Think about an ambiguous plan'), /Ollama/);
  assert.equal(task.status, 'waiting_for_provider');
  assert.equal(task.failureKind, 'ollama_unavailable');
  assert.deepEqual(task.providerWait, { provider: 'ollama', reason: 'ollama_unavailable', fallback: 'none', automatic_switch: false });
  assert.equal(f.bridge.leases.size, 0);
  const recovered = new TaskSessionManager(path.join(f.root, 'data'), f.bridge.memory.db).get(task.id);
  assert.equal(recovered.status, 'waiting_for_provider');
  assert.equal(recovered.providerWait.reason, 'ollama_unavailable');
  const policyTask = { id: task.id };
  assert.equal(f.bridge.nativeExecution.providerFailure(policyTask, Error('Mission grant does not authorize local inference')), false);
  assert.equal(f.bridge.nativeExecution.providerFailure(policyTask, Error('Worker exited before the task settled')), false);
});

test('Claude Mission, Decision exact continuation and verification/acceptance bypass unavailable Ollama', async t => {
  const f = await fixture(t);
  f.bridge.config.provider = 'ollama';
  const m = f.create({ objective: 'DECISION before editing' });
  f.bridge.missions.dispatch(m.id, { request_id: 'native-mission' });
  const waiting = await f.settle(m.id, 'waiting_for_operator');
  const decision = waiting.decisions[0];
  f.bridge.missions.answer(decision.id, { request_id: 'native-answer', option_id: 'A' });
  f.bridge.missions.answer(decision.id, { request_id: 'native-answer-replay', option_id: 'B' });
  const done = await f.settle(m.id);
  assert.equal(f.bridge.missions.accept(m.id, { request_id: 'native-accept', verification_id: done.verifications[0].id, decision: 'accept', rationale: 'Typed evidence passed' }).state, 'completed');
  assert.equal(f.calls(), 2);
  assert.equal(f.inference(), 0);
  const events = f.bridge.ledger.list({ missionId: m.id, limit: 500 }).events;
  for (const dispatch_path of ['agent_direct', 'decision_resume_native', 'verification_native']) assert.ok(events.some(e => e.metadata?.dispatch_path === dispatch_path), dispatch_path);
  assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_continuations WHERE decision_id=?').get(decision.id).n, 1);
});


test('Slack bot gateway delivery and validated answer resume use no unavailable Ollama', async t => {
  const f = await fixture(t);
  f.bridge.config.provider = 'ollama';
  const messages = [];
  const { SlackRuntime } = require('../src/slack-runtime');
  const runtime = new SlackRuntime(f.bridge, {
    config: { enabled: true, outboundEnabled: true, decisionsEnabled: true, teamId: 'T1', botUserId: 'UBOT', operatorIds: ['U1'], channelIds: ['C1'], appTokenRef: 'fixture-app', botTokenRef: 'fixture-bot' },
    resolveCredential: async () => 'fixture-value',
    transportFactory: () => ({ connect: async () => ({ team_id: 'T1', user_id: 'UBOT' }), close: async () => {}, send: async body => { messages.push(body); return { ok: true, channel: body.channel, ts: `123.${messages.length}` }; } })
  });
  f.bridge.slackRuntime = runtime;
  await runtime.start();
  const m = f.create({ objective: 'DECISION before editing' });
  f.bridge.missions.dispatch(m.id, { request_id: 'slack-native' });
  const waiting = await f.settle(m.id, 'waiting_for_operator');
  for (let n = 0; n < 4; n++) await runtime.tick();
  assert.ok(messages.length > 0);
  assert.ok(messages.some(body => body.blocks));
  const d = waiting.decisions[0];
  const thread = f.bridge.memory.db.prepare('SELECT * FROM cp_slack_threads WHERE mission_id=?').get(m.id);
  const interaction = (user, envelope_id) => ({ envelope_id, body: { team: { id: 'T1' }, user: { id: user }, channel: { id: 'C1' }, message: { thread_ts: thread.thread_ts }, actions: [{ action_id: 'decision_answer:1', value: JSON.stringify({ decision_id: d.id, nonce: d.nonce, option_id: 'A' }) }] }, ack: async () => {} });
  await runtime.gateway.receive(interaction('U2', 'bad-identity'));
  assert.equal(f.bridge.controlStore.decision(d.id).state, 'waiting_for_operator');
  await runtime.gateway.receive(interaction('U1', 'valid-answer'));
  await runtime.gateway.receive(interaction('U1', 'valid-answer'));
  await f.settle(m.id);
  assert.equal(f.calls(), 2);
  assert.equal(f.inference(), 0);
  assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_continuations WHERE decision_id=?').get(d.id).n, 1);
  assert.ok(f.bridge.ledger.list({ missionId: m.id, limit: 500 }).events.some(e => e.event_type === 'slack.message.sent' && e.metadata?.dispatch_path === 'native_workflow'));
});

test('declared agent fallback remains explicit and policy-bound without inference', async t => {
  const f = await fixture(t); f.bridge.config.provider = 'ollama';
  const m = f.create({ preferred_agent: 'cursor', fallback_agents: ['claude_code'] });
  f.bridge.missions.dispatch(m.id, { request_id: 'fallback-native' });
  await f.settle(m.id);
  const route = JSON.parse(f.bridge.memory.db.prepare('SELECT route FROM cp_dispatches WHERE mission_id=?').get(m.id).route);
  assert.equal(route.selected, 'claude_code');
  assert.equal(f.inference(), 0);
  const g = await fixture(t); g.bridge.config.provider = 'ollama';
  const denied = g.create({ preferred_agent: 'cursor' });
  g.bridge.missions.dispatch(denied.id, { request_id: 'no-fallback-native' });
  assert.equal((await g.settle(denied.id, 'blocked')).reason, 'no_compatible_available_agent');
  assert.equal(g.inference(), 0);
  assert.equal(g.calls(), 0);
  assert.equal(f.calls(), 1);
});


test('typed Git, file and status operations bypass Ollama; protected paths remain denied', async t => {
  const f = await fixture(t); f.bridge.config.provider = 'ollama';
  const task = f.bridge.tasks.get(f.bridge.createTask('Git native fixture', { workspace: f.repo }).id);
  for (const [name, input] of [['git_status', { repo: '.' }], ['git_diff', { repo: '.' }], ['git_log', { repo: '.' }], ['file_read', { path: 'fixture.txt' }], ['system_info', {}]]) {
    const result = await f.bridge.invokeCapability(task.id, { name, input, requestId: `typed-${name}` });
    assert.equal(result.status, 'completed', `${name}: ${JSON.stringify(result.decision)}`);
  }
  const denied = await f.bridge.invokeCapability(task.id, { name: 'file_read', input: { path: '~/.ssh/id_rsa' }, requestId: 'protected-path' });
  assert.equal(denied.allow, false);
  assert.equal(f.inference(), 0);
});

test('Host deterministic acceptance settles with unavailable Ollama and no runtime startup', async t => {
  const f = await isolated(t); f.bridge.config.provider = 'ollama';
  f.bridge.defaultRuntime = 'opencode';
  const created = await f.mcp.call('create_task', { description: 'native acceptance', message: 'Run deterministic acceptance', request_id: 'native-acceptance-create', acceptance_mode: 'incomplete_once', acceptance_criterion: 'runtime:fresh-session-continuation' });
  const task = f.bridge.tasks.get(created.task_id);
  for (let n=0;n<100 && f.bridge.leases.size;n++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(task.executionAgent,'host');
  assert.equal(task.mission.runtimeEvidence.initial.outcome,'incomplete');
  assert.throws(()=>f.bridge.createTask('wrong runtime', { executionAgent:'opencode', acceptanceMode:'incomplete_once', acceptanceCriteria:['runtime:fresh-session-continuation'] }), /requires Airodrom host primitives/);
  assert.equal(f.inference(), 0);
  assert.equal(f.bridge.runtimes.size, 0);
  assert.ok(f.bridge.ledger.listTaskEvents(task.id, { limit: 500 }).events.some(e => e.metadata?.dispatch_path === 'verification_native'));
});
