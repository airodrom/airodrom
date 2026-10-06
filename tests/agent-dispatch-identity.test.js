'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const { AgentDispatch } = require('../src/agent-dispatch');
const { CodexAdapter } = require('../src/codex-adapter');
const identity = require('../src/memory-identity'), erasure = require('../src/memory-erasure');
const DENIED = /identity|migration|incomplete|propagation|stale|unavailable|erased/i;
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new ControlPlaneStore({ db, ledger: new EventLedger(db) });
  const bridge = { controlStore: store, closed: false, options: { allowFixtureWorker: true }, resultInbox: { latest: () => null } };
  const d = new AgentDispatch(bridge); bridge.agentDispatch = d; bridge.codexAdapter = new CodexAdapter(bridge);
  const r = { dispatch_id: randomUUID(), run_id: randomUUID(), mission_id: randomUUID(), task_id: randomUUID(), request_id: randomUUID(),
    policy_ref: randomUUID(), status: 'failed', no_side_effects: true, fallback_policy: { native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'fixture retained dispatch canary' }] },
    fallback_dispatch_id: randomUUID(), next_attempt_at: 0, updated_at: 1 };
  db.prepare('INSERT INTO cp_agent_dispatch_intents VALUES(?,?,?,?,?,?,?)').run(r.dispatch_id, r.run_id, r.mission_id, r.status, 0, JSON.stringify(r), 1);
  return { db, d, r };
}
for (const state of ['pending', 'failed']) test(`dispatch ${state} identity state denies raw reads and existing intent replay`, async t => {
  const f = fixture(t); identity.install(f.db); f.db.prepare('UPDATE memory_identity_progress SET state=? WHERE id=1').run(state);
  for (const read of [() => f.d.get(f.r.dispatch_id), () => f.d.get(f.r.run_id), () => f.d.list(), () => f.d.views(), () => f.d.availability(),
    () => f.d.fallbackFor(f.r.fallback_dispatch_id), () => f.d.register(f.r), () => f.d.claim({ dispatch_id: f.r.dispatch_id }),
    () => f.d.report({ dispatch_id: f.r.dispatch_id, attempt_id: randomUUID(), outcome: { accepted: true } }), () => f.d.save({ ...f.r })]) assert.throws(read, DENIED);
  let launches = 0; f.d.transport = async () => { launches++; return { accepted: true }; };
  await assert.rejects(f.d.reconcile(), DENIED); assert.equal(launches, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM cp_agent_dispatch_attempts').get().n, 0);
  assert.equal(f.db.prepare('SELECT status FROM cp_agent_dispatch_intents').get().status, 'failed');
});
test('pending content propagation denies retained dispatch reads and transport independently of opaque IDs', async t => {
  const f = fixture(t);
  erasure.mark(f.db, { store: 'personal', identity: randomUUID(), scope_hash: erasure.scopeHash(['fixture']), action: 'operator_erasure' });
  assert.throws(() => f.d.get(f.r.dispatch_id), DENIED); assert.throws(() => f.d.claim({ dispatch_id: f.r.dispatch_id }), DENIED);
  let launches = 0; f.d.transport = async () => { launches++; return { accepted: true }; };
  await assert.rejects(f.d.reconcile(), DENIED); assert.equal(launches, 0);
});
test('stale authoritative disposition invalidates restored dispatch reads and existing claims', async t => {
  const f = fixture(t), source = new DatabaseSync(':memory:'); t.after(() => source.close());
  identity.migrate(source); identity.migrate(f.db, { sourceDb: source });
  assert.equal(f.d.get(f.r.dispatch_id).dispatch_id, f.r.dispatch_id);
  erasure.mark(source, { store: 'personal', identity: randomUUID(), scope_hash: erasure.scopeHash(['fixture']), action: 'forget' });
  assert.throws(() => f.d.get(f.r.dispatch_id), DENIED); assert.throws(() => f.d.list(), DENIED);
  assert.throws(() => f.d.claim({ dispatch_id: f.r.dispatch_id }), DENIED);
  let launches = 0; f.d.transport = async () => { launches++; return { accepted: true }; };
  await assert.rejects(f.d.reconcile(), DENIED); assert.equal(launches, 0);
});
