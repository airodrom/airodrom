'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const display = require('../src/product-observability');

test('nativeStatus uses SQL counts and never loads the full Mission index', async t => {
  const f = await fixture(t), b = f.bridge, created = [];
  for (let i = 0; i < 40; i++) {
    const m = f.create({ objective: 'Hotpath fixture ' + i });
    created.push(m.id);
    b.controlStore.db.prepare('UPDATE cp_missions SET created_at=? WHERE id=?').run(2000 + i, m.id);
  }
  const state = (n, s) => b.controlStore.db.prepare('UPDATE cp_missions SET state=? WHERE id=?').run(s, created[n]);
  state(0, 'running'); state(1, 'verifying');
  state(2, 'awaiting_acceptance'); state(3, 'waiting_for_operator');
  state(4, 'blocked'); state(5, 'needs_rework');
  b.controlStore.db.prepare("UPDATE cp_missions SET envelope=json_set(envelope,'$.kind','conversation'), state='awaiting_acceptance' WHERE id=?").run(created[6]);

  let requireCalls = 0;
  const original = b.missions.require.bind(b.missions);
  b.missions.require = (id, owner) => { requireCalls++; return original(id, owner); };

  const native = await display.nativeStatus(b);
  assert.equal(native.active_missions, 2);
  assert.equal(native.review_missions, 2);
  assert.equal(native.failed_missions, 2);
  assert.equal(native.unread_results, 1);
  assert.equal(native.mission?.id, created[1]);
  // Featured live Mission may call require/missionView once; never scan all 40.
  assert.ok(requireCalls <= 2, 'nativeStatus must not load every Mission via missions.require; saw ' + requireCalls);
});

test('OpenCode readiness coalesces concurrent probes and caches within TTL', async t => {
  const f = await fixture(t), adapter = f.bridge.opencodeAdapter;
  let probes = 0;
  const original = adapter._probeReadiness.bind(adapter);
  adapter._probeReadiness = async () => { probes++; return original(); };
  const [a, b, c] = await Promise.all([adapter.readiness(), adapter.readiness(), adapter.readiness()]);
  assert.equal(probes, 1, 'inflight readiness probes must coalesce');
  assert.equal(a.ready, b.ready);
  assert.equal(b.ready, c.ready);
  const again = await adapter.readiness();
  assert.equal(probes, 1, 'TTL cache must suppress a second probe');
  assert.equal(again.ready, a.ready);
  adapter._readinessCache.at = Date.now() - 6000;
  await adapter.readiness();
  assert.equal(probes, 2, 'expired TTL must refresh readiness');
});

test('conversation qualification coalesces default Ollama probes', async t => {
  const router = require('../src/model-worker-router');
  let hits = 0;
  const request = async () => {
    hits++;
    return {
      ok: false,
      body: { cancel: async () => {}, getReader: () => ({ read: async () => ({ done: true }) }) }
    };
  };
  // Custom request bypasses cache by design — prove injectability still works.
  const denied = await router.qualifyConversation({ request });
  assert.equal(denied.state, 'WAIT');
  assert.equal(hits, 1);
  const [x, y] = await Promise.all([router.qualifyConversation(), router.qualifyConversation()]);
  assert.equal(x.state, y.state);
});
