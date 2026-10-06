'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const { ProviderGateway, prepareProviderRequestIdentitySchema, prepareLegacyProviderRequestIdentities } = require('../src/provider-gateway');
const { MissionProgram, prepareBudgetIdentitySchema, prepareLegacyBudgetIdentities } = require('../src/mission-program');
const { ControlPlaneStore } = require('../src/control-plane-store'), { EventLedger } = require('../src/event-ledger');
const identity = require('../src/memory-identity'), erasure = require('../src/memory-erasure'), content = require('../src/memory-content-erasure');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DENIED = /origin|identity|migration|unavailable|incomplete|erased|propagation|scope/i;
const digest = s => createHash('sha256').update(s).digest('hex');
function dbFixture(t, db = new DatabaseSync(':memory:')) { t.after(() => db.close()); return db; }
function provider(db, extra = {}) {
  const g = new ProviderGateway({ db, authorize: () => true, config: { ollama: { enabled: true } }, ...extra });
  let calls = 0; g.registry.observe('ollama', 'available'); g.registry.get('ollama').adapter.execute = async () => { calls++; return { status: 'completed', text: 'fixture result', accepted: false }; };
  return { g, calls: () => calls };
}
function request(run, label) { return { run_id: run, request_id: label, messages: [{ role: 'user', content: 'fixture prompt' }], data_class: 'public', max_output: 16 }; }
function budget(db) {
  const store = new ControlPlaneStore({ db, ledger: new EventLedger(db), now: () => 10 });
  const p = new MissionProgram({ db, store, bridge: {} });
  p.contract = () => ({ manifest: { expires_at: 1000, budget: { max_commits: 20, max_external_reasoning_calls: 20, max_memory_injections: 20 } } });
  return p;
}
function absent(db, literals) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) for (const row of db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()) for (const value of Object.values(row)) if (typeof value === 'string') assert.equal(literals.some(l => value.includes(l)), false, `Forbidden fixture value retained in ${name}`);
}
const stores = [
  { table: 'cp_provider_requests', schema: prepareProviderRequestIdentitySchema, prepare: prepareLegacyProviderRequestIdentities, scope: 'run_id', create(db, scope) { db.exec('CREATE TABLE cp_provider_requests(run_id TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(run_id,request_id))'); for (const label of ['legacy-provider-first', 'legacy-provider-second']) db.prepare("INSERT INTO cp_provider_requests VALUES(?,?,'settled')").run(scope, digest(label)); } },
  { table: 'cp_mission_budget_usage', schema: prepareBudgetIdentitySchema, prepare: prepareLegacyBudgetIdentities, scope: 'mission_id', create(db, scope) { db.exec('CREATE TABLE cp_mission_budget_usage(mission_id TEXT NOT NULL,kind TEXT NOT NULL,request_id TEXT NOT NULL,amount INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(mission_id,kind,request_id))'); for (const label of ['legacy-budget-first', 'legacy-budget-second']) db.prepare("INSERT INTO cp_mission_budget_usage VALUES(?,'external_reasoning',?,1,?)").run(scope, digest(label), digest('fixture input:' + label)); } }
];
test('provider Run admits multiple legitimate requests with separate opaque records and durable active dedupe', async t => {
  const db = dbFixture(t), f = provider(db), run = randomUUID();
  for (const label of ['private-provider-label-one', 'private-provider-label-two']) assert.equal((await f.g.execute(request(run, label))).status, 'completed');
  const ids = db.prepare('SELECT record_id FROM cp_provider_requests ORDER BY record_id').all().map(r => r.record_id);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2); assert.ok(ids.every(id => UUID.test(id)));
  assert.equal((await f.g.execute(request(run, 'private-provider-label-one'))).wait_reason, 'request_replay_or_reconcile'); assert.equal(f.calls(), 2);
  const restarted = provider(db); assert.equal((await restarted.g.execute(request(run, 'private-provider-label-one'))).wait_reason, 'request_replay_or_reconcile'); assert.equal(restarted.calls(), 0);
  assert.deepEqual(db.prepare('SELECT record_id FROM cp_provider_requests ORDER BY record_id').all().map(r => r.record_id), ids);
});
test('provider beforeInference receives independent host origin for every retry', async t => {
  const db = dbFixture(t), f = provider(db), seen = [], run = randomUUID();
  f.g.beforeInference = (_input, _provider, _attempt, _profile, origin) => seen.push(origin);
  let attempts = 0; f.g.registry.get('ollama').adapter.execute = async () => ++attempts === 1 ? { status: 'failed', error_class: 'temporary_failure', state: 'unavailable', retryable: true } : { status: 'completed', text: 'fixture result' };
  assert.equal((await f.g.execute(request(run, 'private-provider-retry-label'))).status, 'completed');
  assert.equal(seen.length, 2); assert.ok(UUID.test(seen[0])); assert.equal(seen[0], seen[1]); assert.equal(seen[0], db.prepare('SELECT record_id FROM cp_provider_requests').get().record_id);
});
test('budget records allocate independent opaque identity and preserve active request conflict/dedupe', t => {
  const db = dbFixture(t), p = budget(db), mission = randomUUID();
  p.reserve(mission, 'external_reasoning', 'private-budget-label-one', 1, { input: 'fixture personal input' });
  p.reserve(mission, 'external_reasoning', 'private-budget-label-one', 1, { input: 'fixture personal input' });
  p.reserve(mission, 'external_reasoning', 'private-budget-label-two', 1, {});
  assert.throws(() => p.reserve(mission, 'external_reasoning', 'private-budget-label-one', 2, {}), /conflict/);
  const rows = db.prepare('SELECT record_id FROM cp_mission_budget_usage').all(); assert.equal(rows.length, 2); assert.ok(rows.every(r => UUID.test(r.record_id))); assert.equal(new Set(rows.map(r => r.record_id)).size, 2); assert.equal(p.used(mission, 'external_reasoning'), 2);
});
for (const s of stores) {
  test(`${s.table} schema preparation does not invent legacy backup origins`, t => {
    const db = dbFixture(t), scope = randomUUID(); s.create(db, scope);
    const prior = db.prepare(`SELECT * FROM ${s.table}`).all().map(r => ({ ...r })); s.schema(db);
    assert.deepEqual(db.prepare(`SELECT * FROM ${s.table}`).all().map(({ record_id, ...r }) => r), prior); assert.equal(db.prepare(`SELECT count(*) n FROM ${s.table} WHERE record_id IS NULL`).get().n, 2);
    assert.throws(() => identity.assertReadable(db), DENIED);
  });
  test(`${s.table} explicit source preparation is idempotent, payload-preserving and interruption-safe`, t => {
    const db = dbFixture(t); s.create(db, randomUUID()); s.schema(db);
    const old = db.prepare(`SELECT * FROM ${s.table}`).all().map(({ record_id, ...r }) => r), committed = randomUUID();
    db.prepare(`UPDATE ${s.table} SET record_id=? WHERE request_id=(SELECT min(request_id) FROM ${s.table})`).run(committed);
    db.exec(`CREATE TRIGGER fixture_origin_failure BEFORE UPDATE ON ${s.table} WHEN old.record_id IS NULL BEGIN SELECT RAISE(ABORT,'fixture interruption');END`);
    assert.throws(() => s.prepare(db), /fixture interruption/); assert.equal(db.prepare(`SELECT count(*) n FROM ${s.table} WHERE record_id IS NULL`).get().n, 1); assert.equal(db.prepare(`SELECT count(*) n FROM ${s.table} WHERE record_id=?`).get(committed).n, 1);
    db.exec('DROP TRIGGER fixture_origin_failure'); assert.deepEqual(s.prepare(db), { assigned_records: 1, authority: false });
    const ids = db.prepare(`SELECT record_id FROM ${s.table} ORDER BY record_id`).all().map(r => r.record_id); assert.ok(ids.every(id => UUID.test(id))); assert.equal(s.prepare(db).assigned_records, 0);
    assert.deepEqual(db.prepare(`SELECT record_id FROM ${s.table} ORDER BY record_id`).all().map(r => r.record_id), ids); assert.deepEqual(db.prepare(`SELECT * FROM ${s.table}`).all().map(({ record_id, ...r }) => r), old);
  });
  test(`${s.table} pre-origin archive recovery is denied while explicit current source migration remains supported`, t => {
    const dir = fs.mkdtempSync('/private/tmp/pi-provider-budget-'), source = new DatabaseSync(path.join(dir, 'source.sqlite')); s.create(source, randomUUID());
    const file = path.join(dir, 'recovery.sqlite'); source.prepare('VACUUM INTO ?').run(file); const recovery = new DatabaseSync(file); t.after(() => { recovery.close(); source.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    identity.migrate(source); assert.throws(() => identity.migrate(recovery, { sourceDb: source }), DENIED); assert.throws(() => identity.assertReadable(recovery), DENIED); assert.equal(recovery.prepare(`SELECT count(*) n FROM ${s.table} WHERE record_id IS NULL`).get().n, 2);
  });
  test(`${s.table} copied host origin cannot cross its protected scope`, t => {
    const dir = fs.mkdtempSync('/private/tmp/pi-provider-budget-scope-'), source = new DatabaseSync(path.join(dir, 'source.sqlite')); s.create(source, randomUUID()); s.prepare(source);
    const file = path.join(dir, 'recovery.sqlite'); source.prepare('VACUUM INTO ?').run(file); const recovery = new DatabaseSync(file); t.after(() => { recovery.close(); source.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    recovery.prepare(`UPDATE ${s.table} SET ${s.scope}=?`).run(randomUUID()); identity.migrate(source); assert.throws(() => identity.migrate(recovery, { sourceDb: source }), DENIED); assert.throws(() => identity.assertReadable(recovery), DENIED);
  });
}
test('erasure removes provider/budget personal labels and input digests while opaque replay identities survive', async t => {
  const db = dbFixture(t), p = budget(db), f = provider(db), mission = randomUUID(), run = randomUUID(), task = randomUUID();
  db.prepare("INSERT INTO cp_runs(id,mission_id,task_id,agent_id,generation,state,process_state,liveness_state,created_at,updated_at) VALUES(?,?,?,'pi',1,'starting','not_started','unknown',1,1)").run(run, mission, task);
  const labels = ['private-provider-erasure-one', 'private-provider-erasure-two', 'private-budget-erasure-one', digest('private-budget-source')];
  for (const label of labels.slice(0, 2)) await f.g.execute(request(run, label));
  for (const label of labels.slice(2)) p.reserve(mission, 'external_reasoning', label, 1, { input: 'fixture erased budget input' });
  const fingerprint = db.prepare('SELECT fingerprint FROM cp_mission_budget_usage').get().fingerprint;
  const ids = ['cp_provider_requests', 'cp_mission_budget_usage'].map(table => db.prepare(`SELECT record_id FROM ${table} ORDER BY record_id`).all().map(r => r.record_id));
  identity.migrate(db); const marker = erasure.mark(db, { store: 'project_v2', identity: mission, scope_hash: erasure.scopeHash([task]), action: 'operator_erasure' }); content.propagate(db, marker);
  for (let i = 0; i < 2; i++) { const table = ['cp_provider_requests', 'cp_mission_budget_usage'][i]; assert.deepEqual(db.prepare(`SELECT record_id FROM ${table} ORDER BY record_id`).all().map(r => r.record_id), ids[i]); for (const r of db.prepare(`SELECT * FROM ${table}`).all()) assert.equal(r.request_id, r.record_id); }
  absent(db, [...labels, fingerprint, 'fixture erased budget input']); assert.equal(f.g.decisions.length, 0); assert.equal(f.g.consumed.size, 0);
  assert.throws(() => f.g.plan(request(run, labels[0])), DENIED); await assert.rejects(f.g.execute(request(run, labels[0])), DENIED); await assert.rejects(f.g.execute(request(run, 'new-private-provider-label')), DENIED);
  assert.throws(() => p.reserve(mission, 'external_reasoning', labels[2], 1, {}), DENIED); assert.throws(() => p.reserve(mission, 'external_reasoning', 'new-private-budget-label', 1, {}), DENIED);
  content.propagate(db, marker); absent(db, [...labels, fingerprint]);
});
test('erasure during async provider admission denies inference and request-label persistence', async t => {
  const db = dbFixture(t), run = randomUUID(); let calls = 0;
  const f = provider(db, { authorize: async () => { erasure.mark(db, { store: 'project_v2', identity: randomUUID(), scope_hash: erasure.scopeHash([]), action: 'operator_erasure' }); return true; } });
  f.g.registry.get('ollama').adapter.execute = async () => { calls++; return { status: 'completed' }; };
  await assert.rejects(f.g.execute(request(run, 'private-provider-admission-label')), DENIED); assert.equal(calls, 0); assert.equal(db.prepare('SELECT count(*) n FROM cp_provider_requests').get().n, 0); absent(db, ['private-provider-admission-label']);
});
test('erasure while inference awaits prevents old result delivery and stale label/state replay', async t => {
  const db = dbFixture(t), f = provider(db), run = randomUUID(); identity.migrate(db);
  let origin;
  f.g.beforeInference = (_input, _provider, _attempt, _profile, recordId) => { origin = recordId; };
  f.g.registry.get('ollama').adapter.execute = async () => {
    const marker = erasure.mark(db, { store: 'project_v2', identity: run, scope_hash: erasure.scopeHash([]), action: 'operator_erasure' }); content.propagate(db, marker);
    return { status: 'completed', text: 'fixture erased provider response canary' };
  };
  await assert.rejects(f.g.execute(request(run, 'private-provider-response-label')), DENIED);
  const row = db.prepare('SELECT record_id,request_id,state FROM cp_provider_requests').get(); assert.equal(row.record_id, origin); assert.equal(row.request_id, origin); assert.equal(row.state, 'consumed');
  absent(db, ['private-provider-response-label', 'fixture erased provider response canary']); assert.equal(f.g.decisions.length, 0);
});
