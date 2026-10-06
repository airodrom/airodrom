'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SafetyPolicy = require('../src/safety-policy');
const { MissionAuthority } = require('../src/mission-authority');
const BridgeController = require('./fixtures/test-bridge.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mission-grant-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const authority = new MissionAuthority({ fixtureOnly: true });
  const mission = { id: 'mission-fixture-0001', objective: 'Inspect and edit one fixture file', criteria: ['fixture evidence recorded'], workspace, scope: { workspace } };
  return { root, workspace, authority, mission };
}

test('live mission grants are inert; fixture authority is test-only and local', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-live-grant-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const disabled = new MissionAuthority();
  const mission = { id: 'mission-live-0001', objective: 'No live authorization', criteria: [], workspace: root, scope: { workspace: root }, grantId: 'forged' };
  assert.equal(disabled.verify(mission, 'edit').allow, false);
  assert.equal(disabled.snapshot(mission).liveEnabled, false);
  assert.throws(() => disabled.issueFixtureGrant(mission), /unavailable outside isolated tests/);
});

test('fixture grant issuance cannot be enabled outside an isolated test environment', t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const authority = new MissionAuthority({ fixtureOnly: true });
    assert.equal(authority.snapshot({}).enabled, false);
    assert.throws(() => authority.issueFixtureGrant({}), /unavailable outside isolated tests/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test('fixture grants bind mission identity, canonical scope, capability, expiry, action budget, and revocation', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  let now = Date.now();
  const authority = new MissionAuthority({ fixtureOnly: true, now: () => now });
  const grant = authority.issueFixtureGrant(f.mission, { capabilities: ['read', 'edit'], ttlMs: 1000, maxActions: 2, maxRuntimeMs: 500, maxRetries: 1 });
  const bound = { ...f.mission, grantId: grant.id };
  assert.equal(authority.verify(bound, 'edit', { consumeAction: true }).allow, true);
  assert.equal(authority.verify(bound, 'build').allow, false);
  assert.equal(authority.verify({ ...bound, id: 'other-mission-0001' }, 'read').allow, false);
  assert.equal(authority.verify({ ...bound, objective: 'Changed objective' }, 'read').allow, false);
  assert.equal(authority.verify({ ...bound, networkPolicy: { webFetch: true } }, 'read').allow, false, 'egress policy is part of the signed mission scope');
  assert.equal(authority.consumeRetry(bound).allow, true);
  assert.equal(authority.consumeRetry(bound).reason, 'Mission retry budget exhausted');
  assert.equal(authority.consumeRuntime(bound, 250).allow, true);
  assert.equal(authority.consumeRuntime(bound, 300).reason, 'Mission runtime budget exhausted');
  assert.equal(authority.verify(bound, 'read', { consumeAction: true }).allow, true);
  assert.equal(authority.verify(bound, 'read').reason, 'Mission action budget exhausted');
  assert.equal(authority.revoke(bound.id), true);
  assert.equal(authority.verify(bound, 'read').allow, false);
  const expired = authority.issueFixtureGrant(f.mission, { ttlMs: 1000 });
  now += 1001;
  assert.equal(authority.verify({ ...f.mission, grantId: expired.id }, 'read').reason, 'Mission grant expired');
});

test('trusted issuer, enforcement, runtime configuration, and credentials are worker-protected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-trusted-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = fs.realpathSync(path.resolve(__dirname, '..'));
  const policy = new SafetyPolicy();
  policy.registerTask({ id: 'trusted-file-task', sessionId: 'trusted-file-session', workspace });
  const protectedFiles = [
    'src', 'scripts', 'macos', 'config',
    'src/safety-policy.js', 'src/mission-authority.js', 'src/mission-coordinator.js',
    'src/bridge-controller.js', 'src/control-server.js', 'src/config.js',
    'src/safety-policy.js', 'src/host-worker-adapter.js', 'src/mission-supervisor.js',
    'src/mcp-tools.js', 'src/chatgpt-events.js', 'src/chatgpt-events.js',
    'scripts/run.cjs', 'scripts/macos/control.cjs', 'macos', 'package.json', 'package-lock.json',
    '.runtime/control-credential.json', '.runtime/settings.json', '.pi/auth.json'
  ];
  for (const file of protectedFiles) {
    const decision = policy.check('trusted-file-task', { toolName: 'write', input: { path: file, content: 'mutation fixture' } });
    assert.equal(decision.allow, false, file);
    assert.equal(decision.approvalId, undefined, file);
  }
});

test('fixture mission grant reaches the actual policy gate and cannot run unpinned commands or egress', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.mission.requireGrant = true;
  f.mission.objectiveSet = true;
  f.mission.grantId = f.authority.issueFixtureGrant(f.mission, { capabilities: ['read', 'edit'], maxActions: 4 }).id;
  fs.writeFileSync(path.join(f.workspace, 'fixture.txt'), 'before');
  const policy = new SafetyPolicy({ missionAuthority: f.authority });
  policy.registerTask({ id: 'mission-authorized-task', sessionId: 'mission-session-0001', workspace: f.workspace, mission: f.mission });
  assert.equal(policy.check('mission-authorized-task', { toolName: 'read', input: { path: 'fixture.txt' } }).allow, true);
  assert.equal(policy.check('mission-authorized-task', { toolName: 'write', input: { path: 'fixture.txt', content: 'after' } }).allow, true);
  policy.registerTask({ id: 'mission-authorized-task', sessionId: 'mission-session-fresh-0001', workspace: f.workspace, mission: f.mission });
  assert.equal(policy.check('mission-authorized-task', { toolName: 'read', input: { path: 'fixture.txt' } }).allow, true, 'fresh worker must revalidate the same mission grant');
  const unpinned = policy.check('mission-authorized-task', { toolName: 'bash', input: { command: 'node tests/unreviewed.test.js' } });
  assert.equal(unpinned.allow, false);
  assert.equal(unpinned.approvalId, undefined);
  const egress = policy.check('mission-authorized-task', { toolName: 'web_fetch', input: { url: 'https://example.invalid' } });
  assert.equal(egress.allow, false);
  assert.equal(egress.approvalId, undefined);
});

test('a safety stop survives policy checks and clears only through explicit host resolution', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stop-latch-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = new SafetyPolicy();
  policy.registerTask({ id: 'stop-task-0001', sessionId: 'session-0001', workspace });
  const stop = policy.latchSafetyStop('stop-task-0001', 'Protected path denied', { toolName: 'write' });
  assert.equal(stop.reason, 'Protected path denied');
  assert.equal(policy.check('stop-task-0001', { toolName: 'read', input: { path: '.' } }).allow, false);
  policy.registerTask({ id: 'stop-task-0001', sessionId: 'fresh-session-0001', workspace });
  assert.equal(policy.check('stop-task-0001', { toolName: 'read', input: { path: '.' } }).allow, false);
  assert.throws(() => policy.resolveSafetyStop('stop-task-0001', ''), /rationale/);
  assert.equal(policy.resolveSafetyStop('stop-task-0001', 'Reviewed the denied operation').resolvedBy, 'authenticated-local-operator');
  assert.equal(policy.safetyStops.has('stop-task-0001'), false);
});

test('controller latches a genuine tool denial across fresh sessions until operator resolution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-controller-stop-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'safe.txt'), 'safe');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = new BridgeController({ defaultRuntime: 'host', dataDir: path.join(root, 'runtime') });
  bridge.ledger = { record: input => input }; // Isolated HTTP-policy fixture records classification.
  const task = { id: 'controller-stop-task', sessionId: 'controller-session-001', workspace: fs.realpathSync(workspace), status: 'thinking', safetyLoaded: true, events: [], mission: { id: 'controller-stop-mission', objective: 'Read one fixture file', objectiveSet: true, criteria: [], scope: { workspace }, budget: { maxRuntimeMs: 60_000, maxActions: 20, maxRetries: 0, maxSpendMicros: 0 }, used: { runtimeMs: 0, actions: 0, retries: 0 }, requireGrant: false } };
  bridge.tasks = { get: id => { if (id !== task.id) throw new Error('missing task'); return task; }, save() {} };
  bridge.tokens.set('fixture-token', task.id); bridge.runtimes.set(task.id, {}); bridge.inFlight.add(task.id);
  bridge.policy.registerTask(task);
  const check = async (input, url = '/check') => {
    const req = { url, method: 'POST', headers: { authorization: 'Bearer fixture-token' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(input)); } };
    const response = { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await bridge.handlePolicy(req, response); return response;
  };
  const denied = await check({ toolName: 'read', input: { path: '../outside.txt' }, toolCallId: 'denied-path-call' });
  assert.equal(denied.body.allow, false);
  assert.equal(denied.body.kind, 'safety_denial');
  assert.equal(task.failureKind, 'safety_denial');
  assert.equal(task.safetyStop.latched, true);
  task.sessionId = 'controller-session-fresh-001';
  bridge.policy.registerTask(task);
  const stillDenied = await check({ toolName: 'read', input: { path: 'safe.txt' }, toolCallId: 'fresh-session-call' });
  assert.equal(stillDenied.body.allow, false);
  assert.match(stillDenied.body.reason, /Safety stop is latched/);
  bridge.resolveSafetyStop(task.id, 'Reviewed the out-of-scope path and reset the boundary');
  const resolved = await check({ toolName: 'read', input: { path: 'safe.txt' }, toolCallId: 'operator-resolved-call' });
  assert.equal(resolved.body.allow, true);
  assert.equal(task.safetyStop.latched, false);
  const diagnosticDenied = await check({ toolName: 'read', input: { path: '../outside.txt' }, toolCallId: 'denied-diagnostic-call' }, '/diagnostics');
  assert.equal(diagnosticDenied.body.allow, false);
  assert.equal(task.safetyStop.latched, true, 'diagnostic-path safety denial must also latch');
});
