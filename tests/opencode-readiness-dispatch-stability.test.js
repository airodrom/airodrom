'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenCodeAdapter } = require('../src/apps/opencode-adapter');
const { probeQualifiedShow, resetShowProbeForTests } = require('../src/local-ollama-show-probe');
const { agentRuntimeProfile } = require('../src/agent-runtime-profile');
const { routeTask } = require('../src/agent-routing');
const capability = require('../src/local-model-capability');
const evidence = require('../config/local-model-capability-v1.json').models.find(m => m.model === 'qwen3-coder:30b');
const { fixture } = require('./fixtures/mission-fixture.cjs');

function liveFromRecord(overrides = {}) {
  return {
    available: true,
    digest: evidence.digest,
    templateHash: evidence.template_hash,
    capabilities: ['completion', 'tools'],
    ...overrides
  };
}

test('healthy qualified model probe admits OpenCode dispatch selection', async t => {
  resetShowProbeForTests();
  t.after(resetShowProbeForTests);
  let calls = 0;
  const transport = async () => { calls++; return { allow: true, probe_class: 'ready' }; };
  const probe = await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport });
  assert.equal(probe.allow, true);
  assert.equal(calls, 1);
  const ready = {
    agentId: 'opencode', kind: 'agent', implemented: true, installed: true, version: '2.0.25',
    ready: true, available: true, availability: 'available', reason: null, capabilities: ['coding']
  };
  ready.runtime_profile = agentRuntimeProfile('opencode', ready);
  assert.equal(routeTask({
    task_type: 'focused_refactor', candidate_order: ['opencode'], privacy: 'local_only', required_capabilities: ['coding']
  }, { opencode: ready }).selected, 'opencode');
});

test('transient /api/show timeout recovers with exactly one recheck', async () => {
  resetShowProbeForTests();
  let calls = 0;
  const transport = async () => {
    calls++;
    if (calls === 1) return { allow: false, reason: 'opencode_local_provider_timeout', probe_class: 'timeout' };
    return { allow: true, probe_class: 'ready' };
  };
  const result = await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport });
  assert.equal(result.allow, true);
  assert.equal(calls, 2);
});

test('repeated timeout remains unavailable and fail-closed', async () => {
  resetShowProbeForTests();
  let calls = 0;
  const transport = async () => {
    calls++;
    return { allow: false, reason: 'opencode_local_provider_timeout', probe_class: 'timeout' };
  };
  const result = await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport });
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'opencode_local_provider_timeout');
  assert.equal(calls, 2);
});

test('digest mismatch denies dispatch admission without rewriting evidence', async () => {
  resetShowProbeForTests();
  const transport = async () => {
    const live = liveFromRecord({ digest: 'sha256:' + 'a'.repeat(64) });
    const assess = capability.assessQualification(evidence, live);
    assert.equal(assess.allow, false);
    assert.equal(assess.reason, 'model_digest_changed');
    return { allow: false, reason: assess.reason, probe_class: 'denied' };
  };
  const result = await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport });
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'model_digest_changed');
  assert.equal(require('../config/local-model-capability-v1.json').models.find(m => m.model === 'qwen3-coder:30b').digest, evidence.digest);
});

test('concurrent show probes coalesce; cached success cannot bypass launch digest check', async t => {
  resetShowProbeForTests();
  t.after(resetShowProbeForTests);
  let calls = 0;
  const transport = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 20));
    return { allow: true, probe_class: 'ready' };
  };
  const [a, b, c] = await Promise.all([
    probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport }),
    probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport }),
    probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport })
  ]);
  assert.equal(calls, 1);
  assert.equal(a.allow && b.allow && c.allow, true);
  const again = await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport });
  assert.equal(calls, 1, 'success cache suppresses probe storm');
  assert.equal(again.allow, true);

  const adapter = new OpenCodeAdapter(null, {
    enabled: true,
    model: 'ollama/qwen3-coder:30b',
    executable: process.execPath
  });
  adapter._readinessCache = { at: Date.now(), ttl: 5000, value: { ready: true, available: true, reason: null } };
  assert.equal((await adapter.readiness()).ready, true, 'stale success cache may still report ready');
  assert.throws(() => adapter.verifyArtifact('/tmp/not-a-qualified-opencode-binary-' + Date.now()), /opencode_runtime_pins_changed|opencode_unavailable/);
  // Launch digest verification is independent of the readiness cache — cache cannot authorize execution.
});

test('OpenCode availability is preserved so routing reports the specific provider reason', () => {
  const observation = {
    agentId: 'opencode', kind: 'agent', implemented: true, installed: true, version: '2.0.25',
    ready: false, available: false, availability: 'unavailable',
    reason: 'opencode_local_provider_timeout', capabilities: ['coding']
  };
  // Simulate the fixed mission-agents preservation rule.
  observation.availability = observation.available ? 'available' : (observation.availability === 'busy' ? 'busy' : 'unavailable');
  observation.runtime_profile = agentRuntimeProfile('opencode', observation);
  assert.equal(observation.runtime_profile.availability, 'unavailable');
  const route = routeTask({
    task_type: 'focused_refactor',
    candidate_order: ['opencode'],
    privacy: 'local_only',
    required_capabilities: ['coding']
  }, { opencode: observation });
  assert.equal(route.selected, null);
  assert.equal(route.reason, 'no_compatible_available_agent');
  assert.equal(route.rejected[0].reason, 'opencode_local_provider_timeout');
});

test('unavailable OpenCode produces no worker invocation and no repair Mission', async t => {
  const f = await fixture(t);
  const b = f.bridge;
  b.opencodeAdapter.readiness = async () => ({
    agentId: 'opencode', implemented: true, installed: true, version: '2.0.25',
    ready: false, available: false, availability: 'unavailable',
    reason: 'opencode_local_provider_unavailable', capabilities: ['coding', 'bounded_file_work']
  });
  const m = f.create({
    preferred_agent: 'opencode',
    fallback_agents: [],
    dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'focused_coding' }
  });
  f.bridge.missions.dispatch(m.id, { request_id: 'readiness-unavailable-' + Date.now() });
  const blocked = await f.settle(m.id, 'blocked');
  assert.equal(blocked.reason, 'no_compatible_available_agent');
  assert.equal(blocked.dispatches[0].route.rejected[0].reason, 'opencode_local_provider_unavailable');
  assert.equal(f.calls(), 0);
  assert.equal((blocked.dispatches || []).every(d => !d.run_id), true);
  const repairs = b.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(m.id).n;
  assert.equal(repairs, 0);
  assert.equal(blocked.acceptance?.length || 0, 0);
});

test('conversation Ready does not mark OpenCode worker available for WORK', async t => {
  const f = await fixture(t);
  const router = require('../src/model-worker-router');
  f.bridge.opencodeAdapter.readiness = async () => ({
    agentId: 'opencode', ready: false, available: false, reason: 'opencode_local_provider_unavailable'
  });
  const catalog = await router.inspect(f.bridge, {
    conversation: async () => ({ state: 'READY', model: router.MODEL, provider: 'ollama', locality: 'local', worker: null, authority: false })
  });
  const local = catalog.models.find(m => m.id === router.MODEL);
  const worker = catalog.workers.find(w => w.id === 'opencode');
  assert.equal(local.conversation.available, true);
  assert.equal(worker.available, false);
  assert.equal(router.select(catalog, { mission_class: 'WORK' }).state, 'WAIT');
});

test('different model identities never share cached success', async () => {
  resetShowProbeForTests();
  const seen = [];
  const transport = async ({ model }) => {
    seen.push(model);
    return { allow: true, probe_class: 'ready' };
  };
  const a = await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport });
  const otherRecord = { ...evidence, model: 'other-model:1b', digest: 'sha256:' + 'b'.repeat(64) };
  const b = await probeQualifiedShow({ model: 'other-model:1b', record: otherRecord, transport });
  assert.equal(a.allow && b.allow, true);
  assert.deepEqual(seen, ['qwen3-coder:30b', 'other-model:1b']);
  await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport });
  assert.deepEqual(seen, ['qwen3-coder:30b', 'other-model:1b'], 'first model still cached separately');
});

test('changed qualification evidence invalidates cache', async () => {
  resetShowProbeForTests();
  let calls = 0;
  const transport = async () => { calls++; return { allow: true, probe_class: 'ready' }; };
  assert.equal((await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport })).allow, true);
  assert.equal(calls, 1);
  const changed = { ...evidence, digest: 'sha256:' + 'c'.repeat(64) };
  assert.equal((await probeQualifiedShow({ model: 'qwen3-coder:30b', record: changed, transport })).allow, true);
  assert.equal(calls, 2, 'digest change must not reuse prior success');
  assert.equal((await probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport })).allow, true);
  assert.equal(calls, 2, 'original evidence remains cached under its own key');
  assert.equal((await probeQualifiedShow({ model: 'qwen3-coder:30b', record: changed, transport })).allow, true);
  assert.equal(calls, 2, 'changed evidence remains isolated and cached');
});

test('different concurrent probe identities remain separate; identical requests single-flight', async () => {
  resetShowProbeForTests();
  const counts = { a: 0, b: 0 };
  const transportA = async () => {
    counts.a++;
    await new Promise(r => setTimeout(r, 30));
    return { allow: true, probe_class: 'ready' };
  };
  const transportB = async () => {
    counts.b++;
    await new Promise(r => setTimeout(r, 30));
    return { allow: false, reason: 'opencode_local_provider_timeout', probe_class: 'timeout' };
  };
  const started = Date.now();
  const [same1, same2, other] = await Promise.all([
    probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport: transportA }),
    probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport: transportA }),
    probeQualifiedShow({ model: 'qwen3-coder:30b', record: evidence, transport: transportB })
  ]);
  assert.ok(Date.now() - started < 200, 'concurrent distinct probes must not serialize unboundedly');
  assert.equal(counts.a, 1, 'identical requests coalesce');
  assert.equal(same1.allow && same2.allow, true);
  assert.equal(counts.b, 2, 'other transport times out with one recheck');
  assert.equal(other.allow, false);
  assert.equal(other.reason, 'opencode_local_provider_timeout');
});
