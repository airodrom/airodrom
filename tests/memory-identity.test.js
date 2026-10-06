'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { AuthorityStore, json } = require('../src/authority-store');
const { AuthorityMemory } = require('../src/authority-memory');
const { AuthorityRouter } = require('../src/authority-router');
const { EventLedger } = require('../src/event-ledger');
const { canonicalHash, genesisHash, ledgerEnvelope, verifyLedgerChain } = require('../src/authority-hash');
const { transaction } = require('../src/control-transaction');
const erasure = require('../src/memory-erasure');
const identity = require('../src/memory-identity');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DENIED = /identity|migration|legacy|unavailable|incomplete|scope|corrupt|reference/i;
const CANARY = 'personal identity canary violet';
// Legacy algorithms live only in this test fixture. No production compatibility
// API gets a content-to-identity implementation.
const legacy = value => 'sha256:' + canonicalHash(value);
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
const quote = value => '"' + value.replaceAll('"', '""') + '"';
function replace(value, replacements) {
  if (typeof value === 'string') return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map(item => replace(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [replacements.get(key) || key, replace(item, replacements)]));
  return value;
}
function fixtureEdit(db, callback) {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  transaction(db, () => {
    db.exec('PRAGMA defer_foreign_keys=ON');
    for (const trigger of triggers) db.exec('DROP TRIGGER ' + quote(trigger.name));
    callback();
    for (const trigger of triggers) db.exec(trigger.sql);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
}
function rechain(db) {
  const heads = new Map();
  for (const row of db.prepare('SELECT * FROM authority_ledger_entries ORDER BY project_id,sequence').all()) {
    row.previous_hash = heads.get(row.project_id) || genesisHash(row.project_id);
    row.entry_hash = canonicalHash(ledgerEnvelope(row));
    db.prepare('UPDATE authority_ledger_entries SET previous_hash=?,entry_hash=? WHERE entry_id=?').run(row.previous_hash, row.entry_hash, row.entry_id);
    heads.set(row.project_id, row.entry_hash);
  }
  for (const [project, hash] of heads) db.prepare('UPDATE authority_ledger_heads SET entry_hash=? WHERE project_id=?').run(hash, project);
}
function convertToLegacy(db, replacements) {
  fixtureEdit(db, () => {
    for (const table of tables(db)) {
      const columns = db.prepare('PRAGMA table_info(' + quote(table) + ')').all().map(column => column.name);
      for (const row of db.prepare('SELECT rowid AS fixture_rowid,* FROM ' + quote(table)).all()) {
        const changes = {};
        for (const column of columns) {
          const old = row[column]; if (typeof old !== 'string') continue;
          let next = replacements.get(old) || old;
          try { next = JSON.stringify(replace(JSON.parse(old), replacements)); } catch {}
          if (next !== old) changes[column] = next;
        }
        const keys = Object.keys(changes);
        if (keys.length) db.prepare('UPDATE ' + quote(table) + ' SET ' + keys.map(key => quote(key) + '=?').join(',') + ' WHERE rowid=?').run(...keys.map(key => changes[key]), row.fixture_rowid);
      }
    }
    rechain(db);
  });
}
function strings(db) {
  const values = [];
  for (const table of tables(db)) for (const row of db.prepare('SELECT * FROM ' + quote(table)).all()) for (const value of Object.values(row)) if (typeof value === 'string') values.push(value);
  for (const row of db.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL').all()) values.push(row.sql);
  return values;
}
function absent(db, forbidden) {
  const retained = strings(db);
  for (const value of forbidden) for (const output of new Set([value, value.replace(/^sha256:/, '')])) assert.equal(retained.some(text => text.includes(output)), false, 'A reconstructive legacy identifier remains retained');
}
function chain(db) { return verifyLedgerChain(db.prepare('SELECT * FROM authority_ledger_entries ORDER BY project_id,sequence').all()); }
function migrate(f, options = {}) { const result = identity.migrate(f.db, { now: 2000, ...options }); identity.assertReadable(f.db); return result; }
function fixture(t, { rich = false, state = 'active', file = ':memory:' } = {}) {
  const db = new DatabaseSync(file), store = new AuthorityStore(db, { now: () => 1000 }), memory = new AuthorityMemory(store), ledger = new EventLedger(db, { now: () => 1000 });
  t.after(() => db.close());
  const input = { kind: 'personal_preference', operator_id: store.operatorId, scope: 'global', subject_key: 'workflow.micro_prompts', value: 'forbidden', source_hash: canonicalHash(CANARY), source_refs: [], metadata: { note: CANARY } };
  const candidate = memory.propose(input, store.operator), approved = memory.promote(candidate.id, {}, store.operator);
  const pack = memory.build({ operator_id: store.operatorId, include_personal: true });
  const replacements = new Map(), old = {};
  old.candidate = legacy(['memory-candidate-v1', input]); replacements.set(candidate.id, old.candidate);
  old.memory = legacy(['approved-memory-v1', old.candidate]); replacements.set(approved.id, old.memory);
  old.pack = legacy(['context-pack-v1', null, null, pack.context_hash]); replacements.set(pack.id, old.pack);
  if (rich) {
    const empty = memory.build({ operator_id: store.operatorId, include_personal: false });
    const diff = memory.diff(pack.id, empty.id, store.operator);
    old.empty = legacy(['context-pack-v1', null, null, empty.context_hash]); replacements.set(empty.id, old.empty);
    old.diff = legacy(['context-diff-v1', old.pack, old.empty]); replacements.set(diff.id, old.diff);
    const secondInput = { ...input, value: 'allowed', source_hash: canonicalHash('second fixture source'), metadata: { fixture: 'independent conflict' } };
    const second = memory.propose(secondInput, store.operator);
    const conflict = memory.promote(second.id, {}, store.operator);
    old.second = legacy(['memory-candidate-v1', secondInput]); replacements.set(second.id, old.second);
    old.conflict = legacy(['memory-conflict-v1', old.memory, old.second]); replacements.set(conflict.conflict_id, old.conflict);
    const mission = store.createMission({ envelope: { objective: 'Independent fixture evidence', criteria: [] } });
    const run = store.startRun({ mission_id: mission.id, mission_revision: 1, agent_id: 'pi' });
    const result = store.recordResult({ mission_id: mission.id, mission_revision: 1, run_id: run.id, status: 'completed', summary: 'fixture evidence' });
    const evidence = { description: CANARY, candidate_id: candidate.id, context_pack_id: pack.id };
    const verification = store.verifyResult({ mission_id: mission.id, mission_revision: 1, result_id: result.id, status: 'passed', verifier_id: 'independent-fixture', evidence: [evidence] });
    const evidenceRow = db.prepare('SELECT id FROM authority_evidence_records WHERE mission_id=?').get(mission.id);
    old.evidence = legacy(['verification-evidence-v1', verification.id, canonicalHash(evidence)]); replacements.set(evidenceRow.id, old.evidence);
    store.setState(mission.id, 'awaiting_acceptance');
    store.accept({ mission_id: mission.id, mission_revision: 1, verification_id: verification.id, reason: 'Fixture Acceptance', review_evidence: [{ candidate_id: candidate.id, context_pack_id: pack.id }] });
    const router = new AuthorityRouter(store, memory); db.exec("UPDATE authority_activation SET router_state='qualifying'");
    const route = router.plan({ context_pack_id: empty.id, task_class: 'local_files', required_capabilities: ['local_tools'], privacy: 'internal' }, [{ agent_id: 'pi', runtime_id: 'native-fixture', enabled: true, capabilities: ['local_tools'], assurance: 2, locality: 'local', isolation_verified: true, availability: 'available', observed_at: 1000, auth_state: 'observed', quota_state: 'unknown', circuit_state: 'closed', cost_class: 'local' }], store.host, { fixture: true });
    const routeRow = db.prepare('SELECT input_json,decision_json FROM authority_routing_decisions WHERE id=?').get(route.id);
    old.route = legacy(['routing-decision-v2', JSON.parse(routeRow.input_json), JSON.parse(routeRow.decision_json)]); replacements.set(route.id, old.route);
    for (const observation of db.prepare('SELECT id FROM authority_runtime_capability_observations WHERE evidence_ref=?').all(route.id)) {
      const value = legacy([old.route, 'pi:native-fixture::', 'local_tools']); replacements.set(observation.id, value); old.routeObservation = value;
    }
  }
  if (state === 'forgotten') memory.forget(approved.id, store.operator);
  if (state === 'erased') memory.erase(approved.id, store.operator);
  convertToLegacy(db, replacements);
  assert.equal(chain(db).valid, true);
  return { db, store, memory, ledger, input, candidate, approved, pack, old, forbidden: [...new Set(Object.values(old))] };
}

test('legacy candidate identities migrate to cryptographically opaque UUIDs', t => {
  const f = fixture(t); migrate(f);
  const row = f.db.prepare('SELECT id FROM authority_memory_candidates').get(); assert.match(row.id, UUID); assert.notEqual(row.id, f.old.candidate); absent(f.db, f.forbidden);
});
test('legacy ContextPack identity and item foreign keys migrate together', t => {
  const f = fixture(t); migrate(f);
  const pack = f.db.prepare('SELECT id FROM authority_context_pack_manifests').get(); assert.match(pack.id, UUID);
  assert.equal(f.db.prepare('SELECT context_pack_id FROM authority_context_pack_items').get().context_pack_id, pack.id); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('approved memory and content-derived descendants receive opaque identities', t => {
  const f = fixture(t, { rich: true }); migrate(f);
  for (const table of ['authority_memories', 'authority_memory_candidates', 'authority_context_pack_manifests', 'authority_context_pack_diffs', 'authority_memory_conflicts', 'authority_evidence_records', 'authority_routing_decisions']) {
    for (const row of f.db.prepare('SELECT id FROM ' + table).all()) assert.match(row.id, UUID);
  }
  absent(f.db, f.forbidden); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('same permitted content in separate fixtures never produces the same opaque identity', t => {
  const a = fixture(t), b = fixture(t); migrate(a); migrate(b);
  for (const table of ['authority_memory_candidates', 'authority_memories', 'authority_context_pack_manifests']) assert.notEqual(a.db.prepare('SELECT id FROM ' + table).get().id, b.db.prepare('SELECT id FROM ' + table).get().id);
});
test('dictionary recomputation cannot match migrated IDs or any retained alias', t => {
  const f = fixture(t, { rich: true, state: 'erased' }); migrate(f);
  const guesses = ['forbidden', 'allowed', 'continue', CANARY].map(value => legacy(['memory-candidate-v1', { ...f.input, value }]));
  guesses.push(...f.forbidden); absent(f.db, guesses);
  assert.equal(strings(f.db).some(value => value.includes(CANARY)), false);
});
test('new candidate and ContextPack normal APIs issue UUIDs without a derivation compatibility API', t => {
  const f = fixture(t); migrate(f);
  const c = f.memory.propose({ ...f.input, subject_key: 'workflow.auto_continue_safe_steps', value: true }, f.store.operator);
  const m = f.memory.promote(c.id, {}, f.store.operator), p = f.memory.build({ operator_id: f.store.operatorId, include_personal: true });
  assert.match(c.id, UUID); assert.match(m.id, UUID); assert.match(p.id, UUID);
  for (const key of Object.keys(identity)) assert.equal(/derive.*content|legacyHash|contentId/i.test(key), false);
});
test('the deprecated hash-derived identity helper cannot generate application IDs', () => {
  assert.throws(() => require('../src/authority-store').hashId(['memory-candidate-v1', { value: CANARY }]), /deprecated|forbidden|opaque|identity/i);
});
test('nested values, arrays and JSON object keys rewrite every permitted reference', t => {
  const f = fixture(t);
  fixtureEdit(f.db, () => f.db.prepare('UPDATE authority_memory_candidates SET metadata_json=?').run(json({ parent: { [f.old.candidate]: [f.old.pack, { memory_id: f.old.memory }] } })));
  migrate(f);
  const metadata = JSON.parse(f.db.prepare('SELECT metadata_json FROM authority_memory_candidates').get().metadata_json);
  assert.match(Object.keys(metadata.parent)[0], UUID); absent(f.db, f.forbidden);
});
test('digest-bearing event idempotency references are rekeyed without retaining original output', t => {
  const f = fixture(t), digest = canonicalHash('event-only key payload'), oldKey = 'instruction:' + randomUUID() + ':' + digest;
  f.db.prepare('INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,agent,direction,metadata) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), oldKey, canonicalHash({ key: oldKey }), 'agent.instruction.sent', '1970-01-01T00:00:01.000Z', 1000, 'pi', 'outgoing', json({ context_pack_id: f.old.pack }));
  migrate(f); absent(f.db, [...f.forbidden, digest, oldKey]);
  const event = f.db.prepare("SELECT idempotency_key FROM event_ledger_events WHERE event_type='agent.instruction.sent'").get(); assert.ok(event.idempotency_key === null || !event.idempotency_key.includes(digest));
});
test('audit identity, timestamp, sequence and outcomes survive an immutable migration transition', t => {
  const f = fixture(t), before = f.db.prepare('SELECT entry_id,project_id,sequence,kind,actor_type,actor_id,timestamp FROM authority_ledger_entries ORDER BY project_id,sequence').all();
  migrate(f); const after = f.db.prepare('SELECT entry_id,project_id,sequence,kind,actor_type,actor_id,timestamp FROM authority_ledger_entries ORDER BY project_id,sequence').all();
  for (const row of before) assert.deepEqual(after.find(value => value.entry_id === row.entry_id), row);
  assert.equal(chain(f.db).valid, true);
  assert.throws(() => f.db.exec("UPDATE authority_ledger_entries SET timestamp=0"), /Immutable|identity/i);
});
test('provenance continuity preserves the approved candidate relation after rewrite', t => {
  const f = fixture(t); migrate(f);
  const c = f.db.prepare('SELECT id,promoted_memory_id FROM authority_memory_candidates').get(), m = f.db.prepare('SELECT id,candidate_id FROM authority_memories').get();
  assert.equal(c.promoted_memory_id, m.id); assert.equal(m.candidate_id, c.id); assert.equal(f.memory.provenance(m.id, f.store.operator).candidate.id, c.id);
});
test('inactive rejected candidate state survives identifier migration', t => {
  const f = fixture(t); migrate(f); const c = f.memory.propose({ ...f.input, subject_key: 'fixture.inactive', value: 'inactive' }, f.store.operator); f.memory.reject(c.id, f.store.operator);
  const old = legacy(['memory-candidate-v1', { ...f.input, subject_key: 'fixture.inactive', value: 'inactive' }]); convertToLegacy(f.db, new Map([[c.id, old]])); migrate(f);
  assert.equal(f.db.prepare("SELECT status FROM authority_memory_candidates WHERE subject_key='fixture.inactive'").get().status, 'rejected'); absent(f.db, [old]);
});
test('forgotten state and erasure marker references remain suppressed after identity migration', t => {
  const f = fixture(t, { state: 'forgotten' }); migrate(f);
  const row = f.db.prepare('SELECT id,status FROM authority_memories').get(); assert.equal(row.status, 'forgotten');
  assert.equal(f.db.prepare("SELECT identity FROM memory_erasure_markers WHERE store='governed'").get().identity, row.id);
  assert.equal(f.memory.build({ operator_id: f.store.operatorId, include_personal: true }).items.length, 0); absent(f.db, f.forbidden);
});
test('erased primary payload, retired composite row keys and generation survive rewrite', t => {
  const f = fixture(t, { state: 'erased' }), generation = f.db.prepare('SELECT generation FROM memory_erasure_markers').get().generation;
  migrate(f); const row = f.db.prepare('SELECT id,value_json FROM authority_memories').get();
  assert.equal(JSON.parse(row.value_json).content_state, 'erased'); assert.equal(f.db.prepare('SELECT generation FROM memory_erasure_markers').get().generation, generation);
  assert.equal(f.db.prepare('SELECT identity FROM memory_erasure_content_progress').get().identity, row.id); absent(f.db, f.forbidden);
  const keys = f.db.prepare('SELECT row_key FROM memory_erasure_content_rows').all().map(value => value.row_key); assert.ok(keys.some(value => value.includes(row.id)));
});
test('migration is idempotent with stable IDs and no duplicate audit evidence', t => {
  const f = fixture(t, { rich: true }); migrate(f); const first = strings(f.db); migrate(f); assert.equal(JSON.stringify(strings(f.db)) === JSON.stringify(first), true, 'Retained state changes on a duplicate migration'); assert.equal(chain(f.db).valid, true);
});
test('crash after opaque allocation fails closed and resumes without a retained old alias', t => {
  const f = fixture(t);
  assert.throws(() => migrate(f, { beforeRewrite: () => { throw Error('private crash ' + CANARY); } }), DENIED);
  assert.throws(() => identity.assertReadable(f.db), DENIED); assert.equal(JSON.stringify(identity.qualification(f.db)).includes(CANARY), false);
  migrate(f); absent(f.db, f.forbidden);
});
test('crash mid-reference rewrite rolls back canonical rows and retries safely', t => {
  const f = fixture(t); f.db.exec("CREATE TRIGGER fixture_identity_crash BEFORE UPDATE ON authority_context_pack_items BEGIN SELECT RAISE(ABORT,'private mid-rewrite diagnostic'); END");
  assert.throws(() => migrate(f), DENIED); assert.throws(() => identity.assertReadable(f.db), DENIED);
  f.db.exec('DROP TRIGGER fixture_identity_crash'); migrate(f); absent(f.db, f.forbidden); assert.equal(chain(f.db).valid, true);
});
test('partial rewrite discovered after the transaction work never earns a complete receipt', t => {
  const f = fixture(t);
  assert.throws(() => migrate(f, { afterRewrite: () => f.db.prepare('UPDATE authority_memory_candidates SET metadata_json=?').run(json({ stale_reference: f.old.pack })) }), DENIED);
  assert.throws(() => identity.assertReadable(f.db), DENIED); migrate(f); absent(f.db, f.forbidden);
});
test('legacy external packet references are denied after migration', t => {
  const f = fixture(t); migrate(f);
  for (const packet of [{ id: f.old.pack }, { context_pack_id: f.old.pack }, { candidate_id: f.old.candidate }, { items: [{ memory_id: f.old.memory }] }, { context_pack: { records: [{ source_refs: [{ ref: f.old.candidate }] }] } }]) {
    assert.equal(identity.packetUsable(f.db, packet), false); assert.equal(identity.hasLegacyIdentifiers(packet), true);
  }
});
test('normal memory and ContextPack APIs cannot resolve retired legacy aliases', t => {
  const f = fixture(t); migrate(f);
  assert.equal(f.memory.candidate(f.old.candidate), null); assert.equal(f.memory.get(f.old.memory), null);
  assert.deepEqual(f.memory.items(f.old.pack), []); assert.equal(f.memory.validatePack(f.old.pack, { operator_id: f.store.operatorId, project_id: null }).valid, false);
});
test('cross-operator candidate binding is rejected rather than silently rewritten', t => {
  const f = fixture(t);
  fixtureEdit(f.db, () => f.db.prepare("UPDATE authority_memory_candidates SET operator_id='foreign-operator'").run());
  assert.throws(() => migrate(f), DENIED); assert.throws(() => identity.assertReadable(f.db), DENIED);
});
function backupFixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-restore-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, { file: path.join(dir, 'current.sqlite'), ...options });
  const copy = path.join(dir, 'pre-migration.sqlite'); f.db.prepare('VACUUM INTO ?').run(copy);
  const restored = new DatabaseSync(copy); t.after(() => restored.close()); return { ...f, restored, dir };
}
test('pre-migration backup references match authoritative opaque identities before exposure', t => {
  const f = backupFixture(t); migrate(f);
  assert.throws(() => identity.assertReadable(f.restored), DENIED);
  identity.migrate(f.restored, { sourceDb: f.db, now: 3000 }); identity.assertReadable(f.restored);
  for (const table of ['authority_memory_candidates', 'authority_memories', 'authority_context_pack_manifests']) assert.equal(f.restored.prepare('SELECT id FROM ' + table).get().id, f.db.prepare('SELECT id FROM ' + table).get().id);
  absent(f.restored, f.forbidden); assert.deepEqual(f.restored.prepare('PRAGMA foreign_key_check').all(), []);
});
test('authoritative erasure newer than an alias-free source migration prevents backup resurrection', t => {
  const f = backupFixture(t); migrate(f); const id = f.db.prepare('SELECT id FROM authority_memories').get().id; f.memory.erase(id, f.store.operator);
  absent(f.db, f.forbidden); identity.migrate(f.restored, { sourceDb: f.db, now: 3000 });
  const restoredStore = new AuthorityStore(f.restored, { restoreFromBackup: true, erasureSourceDb: f.db }), restoredMemory = new AuthorityMemory(restoredStore);
  assert.equal(restoredMemory.get(id).erased, true); assert.equal(restoredMemory.build({ operator_id: restoredStore.operatorId, include_personal: true }).items.length, 0);
  absent(f.restored, [...f.forbidden, CANARY]);
});
test('missing historical audit anchor keeps pre-migration recovery quarantined', t => {
  const f = backupFixture(t); migrate(f);
  fixtureEdit(f.restored, () => {
    for (const row of f.restored.prepare("SELECT entry_id,payload_json FROM authority_ledger_entries WHERE json_extract(payload_json,'$.reference_id')=?").all(f.old.candidate)) f.restored.prepare('UPDATE authority_ledger_entries SET payload_json=? WHERE entry_id=?').run(json({ ...JSON.parse(row.payload_json), reference_id: randomUUID() }), row.entry_id);
    rechain(f.restored);
  });
  assert.throws(() => identity.migrate(f.restored, { sourceDb: f.db }), DENIED); assert.throws(() => identity.assertReadable(f.restored), DENIED);
});
test('a pending authoritative migration cannot authorize backup promotion', t => {
  const f = backupFixture(t);
  assert.throws(() => migrate(f, { beforeApply: () => { throw Error('fixture allocation crash'); } }), DENIED);
  assert.throws(() => identity.migrate(f.restored, { sourceDb: f.db }), DENIED); assert.throws(() => identity.assertReadable(f.restored), DENIED);
});
test('normal replay cannot re-persist retired candidate or ContextPack identifiers', t => {
  const f = fixture(t); migrate(f);
  const candidate = f.db.prepare('SELECT * FROM authority_memory_candidates').get(), keys = Object.keys(candidate); candidate.id = f.old.candidate;
  assert.throws(() => f.db.prepare('INSERT INTO authority_memory_candidates(' + keys.join(',') + ') VALUES(' + keys.map(() => '?').join(',') + ')').run(...keys.map(key => candidate[key])), DENIED);
  assert.throws(() => f.db.prepare('UPDATE authority_context_pack_manifests SET id=?').run(f.old.pack), /identity|legacy|Immutable/i);
});
test('normal reviewed proposals cannot persist retired identities in nested source references', t => {
  const f = fixture(t); migrate(f);
  assert.throws(() => f.memory.propose({ ...f.input, subject_key: 'fixture.stale_reference', source_refs: [{ candidate_id: f.old.candidate, context_pack_id: f.old.pack }] }, f.store.operator), DENIED);
  assert.equal(f.db.prepare("SELECT count(*) n FROM authority_memory_candidates WHERE subject_key='fixture.stale_reference'").get().n, 0);
});
test('a copied COMPLETE generation with a stale nested reference is unavailable', t => {
  const f = fixture(t); migrate(f);
  fixtureEdit(f.db, () => f.db.prepare('UPDATE authority_memory_candidates SET source_refs_json=?').run(json([{ candidate_id: f.old.candidate }])));
  assert.throws(() => identity.assertReadable(f.db), DENIED); assert.equal(identity.packetUsable(f.db, { records: [] }), false);
});
test('a newly introduced unclassified identity store invalidates a completed read barrier', t => {
  const f = fixture(t); migrate(f); f.db.exec('CREATE TABLE fixture_new_identity_cache(id TEXT PRIMARY KEY,metadata TEXT)');
  assert.throws(() => identity.assertReadable(f.db), DENIED);
});
test('ContextPack rebuild and APIs emit current UUIDs with current references', t => {
  const f = fixture(t); migrate(f);
  const pack = f.memory.build({ operator_id: f.store.operatorId, include_personal: true }); assert.match(pack.id, UUID);
  assert.ok(f.memory.items(pack.id).every(item => UUID.test(item.memory_id))); assert.equal(identity.hasLegacyIdentifiers(pack), false);
});
test('a migrated active ContextPack validates against its migrated approved memory', t => {
  const f = fixture(t); migrate(f);
  const pack = f.db.prepare('SELECT id FROM authority_context_pack_manifests').get();
  assert.equal(f.memory.validatePack(pack.id, { operator_id: f.store.operatorId, project_id: null }).valid, true);
  assert.match(f.memory.items(pack.id)[0].memory_id, UUID);
});
test('governed memory retrieval and provenance return opaque identity only', t => {
  const f = fixture(t); migrate(f);
  const pack = f.memory.build({ operator_id: f.store.operatorId, include_personal: true }), id = pack.items[0].memory_id;
  assert.match(f.memory.get(id).id, UUID); assert.match(f.memory.candidate(f.memory.get(id).candidate_id).id, UUID);
  assert.equal(identity.hasLegacyIdentifiers(f.memory.provenance(id, f.store.operator)), false);
});
test('Pi actual packet boundary rejects legacy identity before downstream dispatch', async t => {
  const f = fixture(t); migrate(f); const { PiAdapter } = require('../src/pi-adapter'); let prompts = 0;
  const adapter = new PiAdapter({ bridge: { _ensurePiRuntime: () => {}, controlStore: { db: f.db } } });
  assert.throws(() => adapter.contextPacket({ id: f.old.pack, records: [] }), /identity|legacy|unavailable/i);
  assert.throws(() => identity.migrate(f.db, { beforeApply: () => { throw Error('forced pending'); } }), DENIED);
  await assert.rejects(() => adapter.dispatch({ runtime: { rpc: { sendCommand: () => { prompts++; } } }, message: 'fixture' }), DENIED); assert.equal(prompts, 0);
});
test('Work actual transport barrier denies pending migration with zero launch calls', async t => {
  const f = fixture(t); const { WorkExecutionAdapter } = require('../src/apps/work-execution-adapter'); let launches = 0;
  const bridge = { controlStore: { db: f.db, now: () => 2000 }, agentDispatch: {}, options: { allowFixtureWorker: true } };
  const adapter = new WorkExecutionAdapter(bridge, { surface: { launch: () => { launches++; } } });
  assert.throws(() => adapter.requireSurface(), DENIED); await assert.rejects(() => adapter.dispatch('fixture-run'), DENIED); assert.equal(launches, 0);
});
test('Claude Code actual dispatch rejects a legacy task ContextPack before capability invocation', async t => {
  const f = fixture(t); migrate(f); const { ClaudeCodeAdapter } = require('../src/apps/claude-code-adapter'); let calls = 0;
  const adapter = new ClaudeCodeAdapter({ controlStore: { db: f.db, requireMission: () => ({ task_id: 'task', envelope: { workspace: 'fixture' } }) }, invokeCapability: () => { calls++; } });
  await assert.rejects(() => adapter.dispatch({ task: { id: 'task', controlPlaneMissionId: 'mission', contextPackId: f.old.pack }, repo: 'fixture', prompt: 'fixture' }), DENIED); assert.equal(calls, 0);
});
test('Cursor packet serialization denies legacy identities and execution remains unavailable', async t => {
  const f = fixture(t); migrate(f); const { CursorAdapter } = require('../src/apps/cursor-adapter'), adapter = new CursorAdapter();
  assert.throws(() => adapter.contextPacket({ id: f.old.pack, records: [] }), DENIED); await assert.rejects(() => adapter.dispatch(), /unqualified|unavailable/i);
});
test('unsupported generic Cloud has no transport even with migrated identifiers', t => {
  const f = fixture(t); migrate(f); const { AgentRouter } = require('../src/agent-adapter'), router = new AgentRouter();
  assert.throws(() => router.resolve('cloud'), /unavailable/i);
});
test('migration logs and reports never expose personal content or reconstructive legacy values', t => {
  const f = fixture(t, { state: 'erased' }); const result = migrate(f), report = JSON.stringify({ result, qualification: identity.qualification(f.db) });
  for (const forbidden of [...f.forbidden, CANARY]) assert.equal(report.includes(forbidden), false);
  const events = f.db.prepare("SELECT metadata,payload FROM event_ledger_events WHERE event_type LIKE '%identity%'").all();
  for (const forbidden of [...f.forbidden, CANARY]) assert.equal(JSON.stringify(events).includes(forbidden), false);
});
test('unknown legacy store schema fails closed without exposing diagnostic payload', t => {
  const f = fixture(t); f.db.exec('CREATE TABLE fixture_unknown_vectors(id TEXT PRIMARY KEY,embedding BLOB)');
  assert.throws(() => migrate(f), DENIED); assert.throws(() => identity.assertReadable(f.db), DENIED); assert.equal(JSON.stringify(identity.qualification(f.db)).includes(CANARY), false);
});
test('unknown legacy serialized ContextPack shape cannot be silently retained', t => {
  const f = fixture(t); fixtureEdit(f.db, () => f.db.prepare('UPDATE authority_context_pack_manifests SET manifest_json=?').run(json({ version: 999, unknown_replay: 'legacy-prefix:' + f.old.candidate })));
  assert.throws(() => migrate(f), DENIED); assert.throws(() => identity.assertReadable(f.db), DENIED);
});
test('audit-store failure leaves migration blocked until canonical evidence can be committed', t => {
  const f = fixture(t); f.db.exec("CREATE TRIGGER fixture_identity_audit_failure BEFORE INSERT ON event_ledger_events WHEN new.event_type LIKE '%identity%' BEGIN SELECT RAISE(ABORT,'private audit diagnostic'); END");
  assert.throws(() => migrate(f), DENIED); assert.throws(() => identity.assertReadable(f.db), DENIED); f.db.exec('DROP TRIGGER fixture_identity_audit_failure'); migrate(f); absent(f.db, f.forbidden);
});
test('host file/index propagation failure remains retryable and unavailable', t => {
  const f = fixture(t); identity.attach(f.db, 'files', () => { throw Error('private stale index ' + CANARY); });
  assert.throws(() => migrate(f), DENIED); assert.throws(() => identity.assertReadable(f.db), DENIED); assert.equal(JSON.stringify(identity.qualification(f.db)).includes(CANARY), false);
  identity.attach(f.db, 'files', () => {}); migrate(f); absent(f.db, f.forbidden);
});
test('a corrupted opaque lineage allocation prevents supported reads and migration', t => {
  const f = fixture(t); migrate(f);
  fixtureEdit(f.db, () => f.db.prepare('UPDATE memory_identity_lineage SET identity=? WHERE rowid=(SELECT min(rowid) FROM memory_identity_lineage)').run(f.old.candidate));
  assert.throws(() => identity.assertReadable(f.db), DENIED); assert.throws(() => identity.migrate(f.db), DENIED);
});
test('concurrent read at allocation boundary cannot observe a partially migrated record', t => {
  const f = fixture(t); let observed = false;
  migrate(f, { beforeRewrite: () => { observed = true; assert.throws(() => identity.assertReadable(f.db), DENIED); assert.equal(identity.packetUsable(f.db, { id: f.old.pack }), false); } });
  assert.equal(observed, true); absent(f.db, f.forbidden);
});
test('a second connection cannot serve legacy identities while the writer migrates', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reader-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.sqlite'), f = fixture(t, { file }), reader = new DatabaseSync(file); t.after(() => reader.close()); identity.install(reader);
  let checks = 0;
  migrate(f, { beforeRewrite: () => { checks++; assert.throws(() => identity.assertReadable(reader), DENIED); assert.equal(identity.packetUsable(reader, { id: f.old.pack }), false); } });
  assert.ok(checks > 0); identity.assertReadable(reader); absent(f.db, f.forbidden);
});
test('authoritative erasure changing during restore invalidates recovery before promotion', t => {
  const f = backupFixture(t); migrate(f); const id = f.db.prepare('SELECT id FROM authority_memories').get().id;
  assert.throws(() => identity.migrate(f.restored, { sourceDb: f.db, beforeRewrite: () => f.memory.erase(id, f.store.operator) }), DENIED);
  assert.throws(() => identity.assertReadable(f.restored), DENIED);
});
