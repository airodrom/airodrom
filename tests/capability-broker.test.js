'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SafetyPolicy = require('../src/safety-policy');
const { MissionAuthority } = require('../src/mission-authority');
const { SafeDiagnostics } = require('../src/safe-diagnostics');
const { CapabilityBroker } = require('../src/capability-broker');

function fixture(t, { capabilities = ['read', 'edit', 'test'], maxActions = 8, webFetch, runner, protectFixtureFile = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-capability-broker-'));
  const workspacePath = path.join(root, 'workspace'); fs.mkdirSync(workspacePath);
  const workspace = fs.realpathSync(workspacePath);
  const authority = new MissionAuthority({ fixtureOnly: true });
  const identity = { id: 'mission-capability-fixture-001', objective: 'Use bounded broker capabilities on fixture files', criteria: ['A fixture read and edit are mediated'], scope: { workspace }, workspace };
  const grant = authority.issueFixtureGrant(identity, { capabilities, maxActions, maxRuntimeMs: 60_000, maxRetries: 0, egress: 'local-only' });
  const mission = { ...identity, grantId: grant.id, requireGrant: true, status: 'active', used: { runtimeMs: 0, actions: 0, retries: 0 }, budget: { maxRuntimeMs: 60_000, maxActions, maxRetries: 0, maxSpendMicros: 0 } };
  const task = { id: 'task-capability-fixture-001', sessionId: 'session-capability-fixture-001', workspace, mission, status: 'thinking', safetyLoaded: true, events: [] };
  const protectedFile = path.join(workspace, 'trusted-fixture.txt');
  const policy = new SafetyPolicy({ missionAuthority: authority, protectedPaths: protectFixtureFile ? [protectedFile] : [] });
  policy.registerTask(task);
  const diagnostics = new SafeDiagnostics(policy);
  const runnerImpl = runner || { describeJob: name => ({ name, kind: 'test', manifestSha256: 'a'.repeat(64) }), async run(name, options) { return { name, kind: 'test', exitCode: 0, signal: null, timedOut: false, inputHashes: [], output: `SIMULATED JOB ${name} ${options.expectedManifestSha256}` }; } };
  const broker = new CapabilityBroker({
    policy, diagnostics, getTask: id => id === task.id ? task : null, runner: runnerImpl,
    onAuthorized: current => { current.mission.used.actions++; },
    ...(webFetch ? { webFetch, networkEnabled: () => true } : {}),
    publishEvent: async (_task, input) => ({ accepted: true, eventId: input.event.event_id })
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, protectedFile, authority, identity, grant, mission, task, policy, diagnostics, broker, runner: runnerImpl };
}

test('fixture-labeled host broker mediates workspace reads, writes, exact edits, budgets, and redacted audit', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'note.txt'), 'status: old\n');

  const write = await f.broker.execute(f.task.id, { toolName: 'write', toolCallId: 'write-fixture-001', input: { path: 'note.txt', content: 'PRIVATE_FIXTURE_TEXT\n' } });
  assert.equal(write.allow, true);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'note.txt'), 'utf8'), 'PRIVATE_FIXTURE_TEXT\n');
  const edit = await f.broker.execute(f.task.id, { toolName: 'edit', toolCallId: 'edit-fixture-001', input: { path: 'note.txt', edits: [{ oldText: 'PRIVATE_FIXTURE', newText: 'BROKERED_FIXTURE' }] } });
  assert.equal(edit.allow, true);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'note.txt'), 'utf8'), 'BROKERED_FIXTURE_TEXT\n');
  const read = await f.broker.execute(f.task.id, { toolName: 'read', toolCallId: 'read-fixture-001', input: { path: 'note.txt' } });
  assert.equal(read.allow, true, JSON.stringify(read));
  assert.match(read.output, /BROKERED_FIXTURE_TEXT/);
  assert.equal(f.task.mission.used.actions, 3);
  assert.equal(f.authority.snapshot(f.mission).used.actions, 3);
  const logs = JSON.stringify({ policy: f.policy.audit, broker: f.broker.audit });
  assert.equal(logs.includes('PRIVATE_FIXTURE_TEXT'), false);
  assert.match(logs, /contentSha256/);
});

test('canonical path and protected resource denials latch and remain denied after session replacement', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.txt'); fs.writeFileSync(outside, 'outside');
  const escape = path.join(f.workspace, 'escape.txt');
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function(file, ...args) {
    if (path.resolve(file) === escape) return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    return originalLstat.call(this, file, ...args);
  };
  let denied;
  try { denied = await f.broker.execute(f.task.id, { toolName: 'write', toolCallId: 'escape-write-001', input: { path: 'escape.txt', content: 'never' } }); }
  finally { fs.lstatSync = originalLstat; }
  assert.equal(denied.allow, false);
  assert.equal(denied.decision.kind, 'safety_denial');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.equal(f.policy.safetyStops.has(f.task.id), true);
  f.task.sessionId = 'session-capability-fresh-001';
  f.policy.registerTask(f.task);
  const second = await f.broker.execute(f.task.id, { toolName: 'read', toolCallId: 'fresh-session-read-001', input: { path: 'escape.txt' } });
  assert.equal(second.allow, false);
  assert.match(second.decision.reason, /Safety stop is latched/);
});

test('worker cannot mutate a broker-protected host resource', async t => {
  const f = fixture(t, { protectFixtureFile: true });
  fs.writeFileSync(f.protectedFile, 'trusted value');
  const denied = await f.broker.execute(f.task.id, { toolName: 'write', toolCallId: 'protected-write-001', input: { path: 'trusted-fixture.txt', content: 'worker overwrite' } });
  assert.equal(denied.allow, false);
  assert.match(denied.decision.reason, /protected/i);
  assert.equal(fs.readFileSync(f.protectedFile, 'utf8'), 'trusted value');
  assert.equal(f.policy.safetyStops.has(f.task.id), true);
});

test('worker shell, default network, and event egress outside a grant are denied by the broker', async t => {
  const f = fixture(t);
  const shell = await f.broker.execute(f.task.id, { toolName: 'bash', toolCallId: 'shell-attempt-001', input: { command: 'touch escaped' } });
  assert.equal(shell.allow, false);
  assert.match(shell.decision.reason, /broker capability schema/);
  assert.equal(fs.existsSync(path.join(f.workspace, 'escaped')), false);
  assert.equal(f.policy.safetyStops.has(f.task.id), true);

  const fresh = fixture(t);
  const network = await fresh.broker.execute(fresh.task.id, { toolName: 'web_fetch', toolCallId: 'network-attempt-001', input: { url: 'https://example.com/' } });
  assert.equal(network.allow, false);
  assert.match(network.decision.reason, /Network capability is disabled by default/);
  assert.equal(fresh.policy.safetyStops.has(fresh.task.id), true);

  const eventFixture = fixture(t);
  const event = await eventFixture.broker.execute(eventFixture.task.id, { toolName: 'chatgpt_notify', toolCallId: 'event-attempt-001', input: { session_id: eventFixture.task.sessionId, request_id: 'request-fixture-001', event: { event_id: 'event-fixture-001', event_type: 'progress', summary: 'fixture event' } } });
  assert.equal(event.allow, false);
  assert.match(event.decision.reason, /active, correlated MCP task/);
  assert.equal(eventFixture.policy.safetyStops.has(eventFixture.task.id), true);
});

test('broker refuses calls for a different or exhausted mission scope', async t => {
  const f = fixture(t, { maxActions: 1 });
  fs.writeFileSync(path.join(f.workspace, 'one.txt'), 'one');
  const first = await f.broker.execute(f.task.id, { toolName: 'read', toolCallId: 'budget-read-001', input: { path: 'one.txt' } });
  assert.equal(first.allow, true);
  const exhausted = await f.broker.execute(f.task.id, { toolName: 'read', toolCallId: 'budget-read-002', input: { path: 'one.txt' } });
  assert.equal(exhausted.allow, false);
  assert.match(exhausted.decision.reason, /action budget exhausted/);
  const crossMission = await f.broker.execute('task-other-mission', { toolName: 'read', toolCallId: 'cross-mission-read-001', input: { path: 'one.txt' } });
  assert.equal(crossMission.allow, false);
});

test('named test jobs use the brokered pinned runner interface and bind authorization to its manifest', async t => {
  let runCalls = 0;
  const runner = {
    describeJob: name => ({ name, kind: 'test', manifestSha256: 'b'.repeat(64) }),
    async run(name, options) { runCalls++; assert.equal(options.expectedManifestSha256, 'b'.repeat(64)); return { name, kind: 'test', exitCode: 0, signal: null, timedOut: false, inputHashes: [{ path: 'fixture.js', sha256: 'c'.repeat(64) }], output: 'SIMULATION ONLY: pinned fixture job' }; }
  };
  const f = fixture(t, { runner });
  const result = await f.broker.execute(f.task.id, { toolName: 'run_job', toolCallId: 'job-fixture-001', input: { jobName: 'fixture-test' } });
  assert.equal(result.allow, true, JSON.stringify(result));
  assert.match(result.output, /SIMULATION ONLY/);
  assert.equal(runCalls, 1);
});

test('a modified or unpinned job input fails closed before any runner launch', async t => {
  let runCalls = 0;
  const f = fixture(t, { runner: { describeJob() { throw new Error('Pinned input hash mismatch'); }, async run() { runCalls++; } } });
  const result = await f.broker.execute(f.task.id, { toolName: 'run_job', toolCallId: 'unpinned-job-fixture-001', input: { jobName: 'changed-test' } });
  assert.equal(result.allow, false);
  assert.match(result.decision.reason, /Pinned job verification failed/);
  assert.equal(runCalls, 0);
  assert.equal(f.policy.safetyStops.has(f.task.id), true);
});
