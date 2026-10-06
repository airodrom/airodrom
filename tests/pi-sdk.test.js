'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSDK } = require('../src/sdk');
const { AppRegistry, supports } = require('../src/sdk/app-registry');
const { createAppSDK } = require('../src/kernel/sdk-host');

test('SDK fails closed on missing, denied, unavailable and revoked host grants', async () => {
  assert.throws(() => createSDK({ appId: 'demo' }), /authorization/);
  let allowed = false, calls = 0;
  const sdk = createSDK({ appId: 'demo', ports: { 'mission.inspect': () => { calls++; return {}; } }, authorize: () => allowed });
  await assert.rejects(sdk.mission.inspect('m'), /denied/);
  allowed = true; await sdk.mission.inspect('m');
  await assert.rejects(sdk.settlement.accept('m', {}), /unavailable/);
  allowed = false; await assert.rejects(sdk.mission.inspect('m'), /denied/);
  assert.equal(calls, 1);
  assert.equal(sdk.bridge, undefined); assert.ok(Object.isFrozen(sdk.mission));
});

test('SDK snapshots input before asynchronous authorization and isolates policy mutations and returned state', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const state = { value: 'original' }; let received;
  const ports = { 'mission.create': input => { received = input; return state; } };
  const sdk = createSDK({ appId: 'demo', ports, authorize: async request => {
    request.args[0].value = 'policy'; entered(); await gate; return true;
  } });
  const input = { value: 'original' }, pending = sdk.mission.create(input);
  await ready; input.value = 'caller'; ports['mission.create'] = () => { throw Error('replaced'); }; release();
  const output = await pending; output.value = 'changed';
  assert.equal(received.value, 'original'); assert.equal(state.value, 'original');
});

test('registry rejects incompatible versions and duplicate capability ownership atomically', () => {
  const registry = new AppRegistry(), definition = { validate: v => v, perform: () => {} };
  registry.register({ manifest: { id: 'first', version: '1.0.0', sdk: '^1.0.0' }, capabilities: { git_read: definition } });
  assert.throws(() => registry.register({ manifest: { id: 'second', version: '1.0.0', sdk: '^1.0.0' }, capabilities: { fresh_read: definition, git_read: definition } }), /duplicate/);
  assert.equal(registry.definitions().fresh_read, undefined);
  assert.throws(() => registry.register({ manifest: { id: 'next', version: '1.0.0', sdk: '^2.0.0' } }), /incompatible/);
  assert.equal(supports('^1.1.0'), false); assert.equal(supports('1.0.0'), true);
  assert.equal(supports('^0.1.0', '0.2.0'), false);
  assert.equal(supports('^0.0.1', '0.0.2'), false);
  assert.equal(supports('*'), false); assert.equal(supports('^1.0.0'), true);
  assert.deepEqual(registry.list().map(a => a.id), ['first']);
});

test('host SDK keeps owner binding, context policy, review and Acceptance in existing kernel', async () => {
  const calls = [], denied = () => { throw Error('stale evidence'); };
  const bridge = {
    missions: {
      require: (id, owner) => { calls.push(['require', id, owner]); if (id === 'foreign') throw Error('owner mismatch'); return { id }; },
      detail: (id, owner) => ({ id, owner }), accept: denied, reverify: (id, input, owner) => ({ id, input, owner }),
      assertAuthority: () => { throw Error('expired authority'); }
    },
    controlContext: { build: m => ({ mission: m.id, refs: [] }) },
    providerGateway: { execute: () => ({ status: 'failed', error_class: 'reasoning_admission_denied' }) },
    controlStore: { event: (...args) => calls.push(args) }
  };
  const sdk = createAppSDK(bridge, { appId: 'observer', authorize: () => true });
  assert.deepEqual(await sdk.mission.inspect('m'), { id: 'm', owner: 'mcp' });
  assert.deepEqual(await sdk.memory.retrieve('m'), { mission: 'm', refs: [] });
  await assert.rejects(sdk.memory.retrieve('foreign'), /owner mismatch/);
  await assert.rejects(sdk.settlement.accept('m', {}), /stale evidence/);
  await assert.rejects(sdk.authority.check('m'), /expired authority/);
  assert.equal((await sdk.review.request('m', {})).owner, 'mcp');
  assert.equal((await sdk.provider.execute({})).error_class, 'reasoning_admission_denied');
  await sdk.events.publish('m', 'completed', { password: 'private' });
  const event = calls.find(c => c[0] === 'app.observer.completed');
  assert.deepEqual(event[2], { password: '[omitted]' });
  await sdk.events.publish('m', 'mission.accepted');
  assert.ok(calls.some(c => c[0] === 'app.observer.mission.accepted'));
  await assert.rejects(sdk.events.publish('m', 'invalid event'), /Invalid/);
});

test('built-in capability apps preserve the legacy matrix and compatibility identities', () => {
  const registry = require('../src/apps').capabilityApps();
  const git = require('../src/capability-git').gitCapabilities();
  const connectors = require('../src/capability-connectors');
  const legacy = { ...git, ...connectors.connectorCapabilities(), ...connectors.databaseCapabilities(), ...connectors.agentCapabilities() };
  assert.deepEqual(Object.keys(registry.definitions()).sort(), Object.keys(legacy).sort());
  for (const module of ['capability-git', 'slack-runtime', 'codex-adapter', 'openai-compatible-provider', 'project-memory-v2-adapter']) {
    assert.equal(require(`../src/${module}`), require(`../src/apps/${module}`));
  }
  assert.equal(require('../src/kernel').MissionService, require('../src/mission-service').MissionService);
});

test('nested app and SDK changes invalidate the runtime source fingerprint', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { sourceFingerprint } = require('../src/runtime-fingerprint');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-fingerprint-'));
  try {
    fs.mkdirSync(path.join(root, 'src/apps'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}'); fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const app = path.join(root, 'src/apps/demo.js'); fs.writeFileSync(app, 'first');
    const before = sourceFingerprint(root).source_sha256; fs.writeFileSync(app, 'second');
    assert.notEqual(sourceFingerprint(root).source_sha256, before);
    fs.symlinkSync(app, path.join(root, 'src/linked.js'));
    assert.throws(() => sourceFingerprint(root), /symlinks/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
