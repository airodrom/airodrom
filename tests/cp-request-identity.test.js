'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ControlPlaneStore, prepareRequestIdentitySchema, prepareLegacyRequestIdentities, fingerprint } = require('../src/control-plane-store');
const { EventLedger } = require('../src/event-ledger');
const { PersonalMemory } = require('../src/personal-memory');
const identity = require('../src/memory-identity');
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const ledger = new EventLedger(db), store = new ControlPlaneStore({ db, ledger });
  return { db, store, ledger };
}
function legacy(db, rows = ['legacy-first', 'legacy-second']) {
  db.exec('CREATE TABLE cp_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(owner,request_id))');
  for (const label of rows) db.prepare("INSERT INTO cp_requests(owner,request_id,fingerprint,state,result) VALUES(?,?,?,'settled',?)")
    .run('operator', digest(label), fingerprint({ fixture: label }), JSON.stringify({ fixture: true }));
}
function withoutLiterals(db, values) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    assert.equal(rows.some(row => Object.values(row).some(value => typeof value === 'string' && values.some(old => value.includes(old)))), false,
      'old correlation labels and durable aliases must be absent');
  }
}

test('new requests allocate opaque host identities and replay through persisted request relationship', t => {
  const f = fixture(t); let calls = 0;
  const operation = () => { calls++; return { receipt: 'fixture' }; };
  f.store.request('operator', 'external-request', { action: 'fixture' }, operation);
  const first = f.db.prepare('SELECT record_id FROM cp_requests WHERE owner=? AND request_id=?').get('operator', 'external-request').record_id;
  assert.match(first, UUID4); assert.equal(calls, 1);
  assert.equal(f.store.request('operator', 'external-request', { action: 'fixture' }, operation).duplicate, true);
  assert.equal(calls, 1); assert.equal(f.db.prepare('SELECT record_id FROM cp_requests').get().record_id, first);
  const reopened = new ControlPlaneStore({ db: f.db, ledger: f.ledger });
  assert.equal(reopened.request('operator', 'external-request', { action: 'fixture' }, operation).duplicate, true);
  assert.equal(f.db.prepare('SELECT record_id FROM cp_requests').get().record_id, first); assert.equal(calls, 1);
  assert.throws(() => reopened.request('operator', 'external-request', { action: 'changed' }, operation), /conflict/i);
  assert.equal(calls, 1);
});

test('request host identities are unique across owner scope and external labels', t => {
  const f = fixture(t);
  for (const [owner, label] of [['operator', 'same-request'], ['mcp', 'same-request'], ['operator', 'other-request']]) f.store.request(owner, label, {}, () => ({ ok: true }));
  const ids = f.db.prepare('SELECT record_id FROM cp_requests').all().map(row => row.record_id);
  assert.equal(new Set(ids).size, 3); for (const id of ids) assert.match(id, UUID4);
  assert.throws(() => f.db.prepare('UPDATE cp_requests SET record_id=? WHERE request_id=?').run(ids[0], 'other-request'), /unique/i);
});

test('schema preparation leaves legacy records and payloads untouched and does not invent origins', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); legacy(db);
  const before = db.prepare('SELECT owner,request_id,fingerprint,state,result FROM cp_requests ORDER BY request_id').all();
  prepareRequestIdentitySchema(db); prepareRequestIdentitySchema(db);
  assert.deepEqual(db.prepare('SELECT owner,request_id,fingerprint,state,result FROM cp_requests ORDER BY request_id').all(), before);
  assert.equal(db.prepare('SELECT count(*) n FROM cp_requests WHERE record_id IS NULL').get().n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='cp_request_record_identity'").get().n, 1);
  assert.throws(() => identity.assertReadable(db), /legacy|origin|identity|migration|unavailable/i);
});

test('explicit source preparation assigns UUID origins once with no events, aliases or content changes', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); legacy(db);
  const before = db.prepare('SELECT owner,request_id,fingerprint,state,result FROM cp_requests ORDER BY request_id').all();
  assert.equal(prepareLegacyRequestIdentities(db).assigned_records, 2);
  const ids = db.prepare('SELECT record_id FROM cp_requests ORDER BY request_id').all().map(row => row.record_id);
  assert.equal(new Set(ids).size, 2); for (const id of ids) assert.match(id, UUID4);
  assert.deepEqual(db.prepare('SELECT owner,request_id,fingerprint,state,result FROM cp_requests ORDER BY request_id').all(), before);
  assert.equal(prepareLegacyRequestIdentities(db).assigned_records, 0);
  assert.deepEqual(db.prepare('SELECT record_id FROM cp_requests ORDER BY request_id').all().map(row => row.record_id), ids);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 1);
});

test('interrupted source preparation rolls back missing allocations and preserves committed UUID origins', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); legacy(db); prepareRequestIdentitySchema(db);
  const rows = db.prepare('SELECT request_id FROM cp_requests ORDER BY request_id').all(), prior = randomUUID();
  db.prepare('UPDATE cp_requests SET record_id=? WHERE request_id=?').run(prior, rows[0].request_id);
  db.exec("CREATE TRIGGER fixture_request_identity_failure BEFORE UPDATE ON cp_requests WHEN new.record_id IS NOT NULL AND old.record_id IS NULL BEGIN SELECT RAISE(ABORT,'fixture interrupted'); END");
  assert.throws(() => prepareLegacyRequestIdentities(db), /interrupted/);
  assert.equal(db.prepare('SELECT record_id FROM cp_requests WHERE request_id=?').get(rows[0].request_id).record_id, prior);
  assert.equal(db.prepare('SELECT count(*) n FROM cp_requests WHERE record_id IS NULL').get().n, 1);
  db.exec('DROP TRIGGER fixture_request_identity_failure');
  assert.equal(prepareLegacyRequestIdentities(db).assigned_records, 1);
  const stable = db.prepare('SELECT record_id FROM cp_requests ORDER BY request_id').all().map(row => row.record_id);
  assert.equal(prepareLegacyRequestIdentities(db).assigned_records, 0);
  assert.deepEqual(db.prepare('SELECT record_id FROM cp_requests ORDER BY request_id').all().map(row => row.record_id), stable);
});

test('request operation failure leaves no host allocation or replay record', t => {
  const f = fixture(t);
  assert.throws(() => f.store.request('operator', 'retry-request', {}, () => { throw new Error('fixture interrupted'); }), /interrupted/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM cp_requests').get().n, 0);
  f.store.request('operator', 'retry-request', {}, () => ({ ok: true }));
  assert.match(f.db.prepare('SELECT record_id FROM cp_requests').get().record_id, UUID4);
});

test('erasing multiple request rows preserves unique host origins and removes external correlation labels', t => {
  const f = fixture(t), memory = new PersonalMemory({ db: f.db });
  const item = memory.remember({ domain: 'personal', type: 'fact', subject: 'fixture', content: 'fixture request personal canary', source: 'user_explicit' });
  const labels = ['personal-request-alpha', 'personal-request-beta'];
  for (const label of labels) f.store.request('operator', label, { memory_id: item.memoryId }, () => ({ memory_id: item.memoryId, note: 'fixture request personal canary' }));
  const ids = f.db.prepare('SELECT record_id FROM cp_requests ORDER BY record_id').all().map(row => row.record_id);
  memory.erase(item.memoryId);
  const rows = f.db.prepare('SELECT owner,request_id,record_id,result FROM cp_requests ORDER BY record_id').all();
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.record_id), ids);
  for (const row of rows) { assert.equal(row.request_id, row.record_id); assert.equal(JSON.parse(row.result).content_state, 'erased'); }
  withoutLiterals(f.db, [...labels, 'fixture request personal canary']);
  memory.erase(item.memoryId);
  assert.deepEqual(f.db.prepare('SELECT record_id FROM cp_requests ORDER BY record_id').all().map(row => row.record_id), ids);
});

test('explicit legacy migration retains assigned origins through failure and reuses them on retry', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); legacy(db);
  prepareLegacyRequestIdentities(db);
  const ids = db.prepare('SELECT record_id FROM cp_requests ORDER BY record_id').all().map(row => row.record_id);
  assert.throws(() => identity.migrate(db, { beforeApply: () => { throw new Error('fixture interrupted'); } }), /identity|migration|incomplete/i);
  assert.deepEqual(db.prepare('SELECT record_id FROM cp_requests ORDER BY record_id').all().map(row => row.record_id), ids);
  identity.migrate(db); identity.assertReadable(db);
  assert.deepEqual(db.prepare('SELECT record_id FROM cp_requests ORDER BY record_id').all().map(row => row.record_id), ids);
  withoutLiterals(db, [digest('legacy-first'), digest('legacy-second')]);
});

test('pre-anchor backup recovery fails closed instead of matching erasable request labels', t => {
  const root = fs.mkdtempSync('/private/tmp/pi-request-origin-');
  const source = new DatabaseSync(path.join(root, 'current.sqlite')); legacy(source);
  const copy = path.join(root, 'pre-anchor.sqlite'); source.prepare('VACUUM INTO ?').run(copy);
  const recovery = new DatabaseSync(copy); t.after(() => { recovery.close(); source.close(); fs.rmSync(root, { recursive: true, force: true }); });
  identity.migrate(source); identity.assertReadable(source);
  assert.throws(() => identity.migrate(recovery, { sourceDb: source }), /origin|identity|migration|incomplete/i);
  assert.equal(recovery.prepare('SELECT count(*) n FROM cp_requests WHERE record_id IS NULL').get().n, 2);
  assert.throws(() => identity.assertReadable(recovery), /identity|migration|incomplete|legacy/i);
});

test('invalid existing source origins fail closed without allocating replacement aliases', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); legacy(db); prepareRequestIdentitySchema(db);
  db.prepare('UPDATE cp_requests SET record_id=? WHERE request_id=?').run(digest('invalid-origin'), digest('legacy-first'));
  assert.throws(() => prepareLegacyRequestIdentities(db), /origin/i);
  assert.equal(db.prepare('SELECT count(*) n FROM cp_requests WHERE record_id IS NULL').get().n, 1);
});

test('opaque-looking legacy labels cannot substitute for missing host origins during read or restore', t => {
  const root = fs.mkdtempSync('/private/tmp/pi-request-label-'), source = new DatabaseSync(path.join(root, 'source.sqlite'));
  legacy(source, []);
  source.prepare("INSERT INTO cp_requests(owner,request_id,fingerprint,state,result) VALUES(?,?,?,'settled',?)")
    .run('operator', 'opaque-looking-request', fingerprint({ fixture: true }), JSON.stringify({ fixture: true }));
  const copy = path.join(root, 'recovery.sqlite'); source.prepare('VACUUM INTO ?').run(copy);
  const recovery = new DatabaseSync(copy); t.after(() => { recovery.close(); source.close(); fs.rmSync(root, { recursive: true, force: true }); });
  prepareRequestIdentitySchema(recovery);
  assert.throws(() => identity.assertReadable(recovery), /origin|identity|migration|unavailable|legacy/i);
  identity.migrate(source); identity.assertReadable(source);
  assert.throws(() => identity.migrate(recovery, { sourceDb: source }), /origin|identity|migration|incomplete/i);
  assert.equal(recovery.prepare('SELECT record_id FROM cp_requests').get().record_id, null);
});

test('anchored recovery rejects a changed active caller owner instead of crossing request scope', t => {
  const root = fs.mkdtempSync('/private/tmp/pi-request-owner-'), source = new DatabaseSync(path.join(root, 'source.sqlite'));
  legacy(source); prepareLegacyRequestIdentities(source);
  const copy = path.join(root, 'recovery.sqlite'); source.prepare('VACUUM INTO ?').run(copy);
  const recovery = new DatabaseSync(copy); t.after(() => { recovery.close(); source.close(); fs.rmSync(root, { recursive: true, force: true }); });
  recovery.prepare('UPDATE cp_requests SET owner=?').run('another-caller');
  identity.migrate(source);
  assert.throws(() => identity.migrate(recovery, { sourceDb: source }), /scope|origin|identity|migration|incomplete/i);
  assert.throws(() => identity.assertReadable(recovery), /identity|migration|incomplete/i);
});

test('anchored pre-delete recovery adopts newer erased request disposition before exposing content', t => {
  const root = fs.mkdtempSync('/private/tmp/pi-request-erased-'), source = new DatabaseSync(path.join(root, 'source.sqlite'));
  const ledger = new EventLedger(source), store = new ControlPlaneStore({ db: source, ledger }), memory = new PersonalMemory({ db: source });
  const item = memory.remember({ domain: 'personal', type: 'fact', subject: 'fixture', content: 'fixture erased request recovery canary', source: 'user_explicit' });
  const labels = ['private-caller-request-one', 'private-caller-request-two'], owner = 'private-caller-owner';
  for (const label of labels) store.request(owner, label, { memory_id: item.memoryId }, () => ({ memory_id: item.memoryId, note: 'fixture erased request recovery canary' }));
  identity.migrate(source);
  const ids = source.prepare('SELECT record_id FROM cp_requests ORDER BY record_id').all().map(row => row.record_id);
  const copy = path.join(root, 'recovery.sqlite'); source.prepare('VACUUM INTO ?').run(copy);
  const recovery = new DatabaseSync(copy); t.after(() => { recovery.close(); source.close(); fs.rmSync(root, { recursive: true, force: true }); });
  memory.erase(item.memoryId);
  identity.migrate(recovery, { sourceDb: source });
  const requests = recovery.prepare('SELECT record_id,owner,request_id,result FROM cp_requests ORDER BY record_id').all();
  assert.deepEqual(requests.map(row => row.record_id), ids);
  for (const row of requests) { assert.equal(row.owner, '[erased]'); assert.equal(row.request_id, row.record_id); assert.equal(JSON.parse(row.result).content_state, 'erased'); }
  const restored = new PersonalMemory({ db: recovery, restoreFromBackup: true, erasureSourceDb: source });
  assert.equal(restored.get(item.memoryId), null); assert.equal(restored.search('recovery canary').items.length, 0);
  withoutLiterals(recovery, [...labels, owner, 'fixture erased request recovery canary']);
  identity.migrate(recovery, { sourceDb: source });
  assert.deepEqual(recovery.prepare('SELECT record_id FROM cp_requests ORDER BY record_id').all().map(row => row.record_id), ids);
});
