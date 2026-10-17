'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { RiskAcceptance } = require('../src/risk-acceptance');
const identity = require('../src/memory-identity');

const registry = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../config/memory-retention-fields.json'), 'utf8'
));

function fixture(t, { modern = false, existing = false } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  if (modern) {
    db.exec(`CREATE TABLE cp_risk_acceptance_preference (
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL,
      privacy TEXT NOT NULL,
      data_class TEXT NOT NULL,
      workers TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      owner_set INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE cp_trusted_autonomy_origins (
      origin TEXT PRIMARY KEY,
      approved_at INTEGER NOT NULL,
      approved_by TEXT NOT NULL,
      source TEXT NOT NULL,
      revoked_at INTEGER
    );`);
    if (existing) {
      db.prepare(`INSERT INTO cp_risk_acceptance_preference
        (id,enabled,privacy,data_class,workers,updated_at,updated_by,owner_set)
        VALUES (1,0,'local_only','public','["opencode"]',123,'operator',1)`).run();
      db.prepare(`INSERT INTO cp_trusted_autonomy_origins
        (origin,approved_at,approved_by,source,revoked_at)
        VALUES ('https://example.invalid',456,'operator','owner_authorization',789)`).run();
    }
  }
  return db;
}

test('retention registry explicitly classifies both live-schema additions', () => {
  assert.deepEqual(registry.cp_trusted_autonomy_origins, {
    fields: ['origin', 'approved_at', 'approved_by', 'source', 'revoked_at'],
    source: 'src/risk-acceptance.js',
    classification: {
      origin: 'B', approved_at: 'A', approved_by: 'B',
      source: 'B', revoked_at: 'A'
    }
  });
  assert.deepEqual(registry.cp_risk_acceptance_preference.fields, [
    'id', 'enabled', 'privacy', 'data_class', 'workers',
    'updated_at', 'updated_by', 'owner_set'
  ]);
  assert.equal(registry.cp_risk_acceptance_preference.classification.owner_set, 'A');
});

test('legacy seven-column risk preference stays default-off and identity-readable', t => {
  const db = fixture(t);
  const acceptance = new RiskAcceptance({ bridge: {}, store: { db } });
  assert.equal(acceptance.preference().enabled, false);
  assert.equal(db.prepare('PRAGMA table_info(cp_risk_acceptance_preference)').all().length, 7);
  assert.doesNotThrow(() => identity.assertReadable(db));
});

test('existing eight-column preference and historical origin survive startup unchanged', t => {
  const db = fixture(t, { modern: true, existing: true });
  const beforePreference = db.prepare('SELECT * FROM cp_risk_acceptance_preference WHERE id=1').get();
  const beforeOrigins = db.prepare('SELECT * FROM cp_trusted_autonomy_origins').all();
  const acceptance = new RiskAcceptance({ bridge: {}, store: { db } });
  assert.equal(acceptance.preference().enabled, false);
  assert.deepEqual(db.prepare('SELECT * FROM cp_risk_acceptance_preference WHERE id=1').get(), beforePreference);
  assert.deepEqual(db.prepare('SELECT * FROM cp_trusted_autonomy_origins').all(), beforeOrigins);
  assert.doesNotThrow(() => identity.assertReadable(db));
});

test('eight-column table on first startup retains default-off and default owner_set zero', t => {
  const db = fixture(t, { modern: true });
  const acceptance = new RiskAcceptance({ bridge: {}, store: { db } });
  assert.equal(acceptance.preference().enabled, false);
  const row = db.prepare('SELECT enabled,owner_set FROM cp_risk_acceptance_preference WHERE id=1').get();
  assert.equal(row.enabled, 0);
  assert.equal(row.owner_set, 0);
  assert.doesNotThrow(() => identity.assertReadable(db));
});

test('unknown extra field still fails closed on identity validation', t => {
  const db = fixture(t, { modern: true, existing: true });
  new RiskAcceptance({ bridge: {}, store: { db } });
  identity.assertReadable(db);
  db.exec('ALTER TABLE cp_risk_acceptance_preference ADD COLUMN unexpected_identity_field TEXT');
  assert.throws(() => identity.assertReadable(db), /unclassified field/);
});

test('unknown store still fails closed on identity validation', t => {
  const db = fixture(t, { modern: true, existing: true });
  new RiskAcceptance({ bridge: {}, store: { db } });
  identity.assertReadable(db);
  db.exec('CREATE TABLE unexpected_identity_store (id TEXT)');
  assert.throws(() => identity.assertReadable(db), /unclassified store/);
});

function preferenceService(db, events = []) {
  return {
    bridge: {},
    store: {
      db,
      event(...args) { events.push(args); }
    }
  };
}

test('eight-column explicit disable stamps owner_set so rollback cannot re-enable', t => {
  const events = [];
  const db = fixture(t, { modern: true });
  db.prepare(`INSERT INTO cp_risk_acceptance_preference
    (id,enabled,privacy,data_class,workers,updated_at,updated_by,owner_set)
    VALUES (1,1,'local_only','public','["opencode"]',111,'system',0)`).run();
  const acceptance = new RiskAcceptance(preferenceService(db, events));
  assert.equal(acceptance.preference().enabled, true);
  assert.equal(db.prepare('SELECT owner_set FROM cp_risk_acceptance_preference WHERE id=1').get().owner_set, 0);

  acceptance.setPreference({ enabled: false, confirmed: true }, 'operator');
  const after = db.prepare('SELECT enabled,owner_set,updated_by FROM cp_risk_acceptance_preference WHERE id=1').get();
  assert.equal(after.enabled, 0);
  assert.equal(after.owner_set, 1);
  assert.equal(after.updated_by, 'operator');
  assert.equal(acceptance.preference().enabled, false);
  assert.equal(events.at(-1)[2].owner_set, true);

  // Reopen against the same persisted row; owner intent remains disabled+owned.
  const reopened = new RiskAcceptance(preferenceService(db));
  assert.equal(reopened.preference().enabled, false);
  assert.deepEqual(
    db.prepare('SELECT enabled,owner_set,updated_by FROM cp_risk_acceptance_preference WHERE id=1').get(),
    after
  );
});

test('seven-column setPreference stays compatible without owner_set', t => {
  const events = [];
  const db = fixture(t);
  const acceptance = new RiskAcceptance(preferenceService(db, events));
  assert.equal(db.prepare('PRAGMA table_info(cp_risk_acceptance_preference)').all().length, 7);
  acceptance.setPreference({ enabled: true, confirmed: true }, 'operator');
  const row = db.prepare('SELECT enabled,updated_by FROM cp_risk_acceptance_preference WHERE id=1').get();
  assert.equal(row.enabled, 1);
  assert.equal(row.updated_by, 'operator');
  assert.equal('owner_set' in row, false);
  assert.equal(events.at(-1)[2].owner_set, undefined);
  acceptance.setPreference({ enabled: false, confirmed: true }, 'operator');
  assert.equal(acceptance.preference().enabled, false);
});

test('setPreference denies non-operator and unconfirmed writes', t => {
  const db = fixture(t, { modern: true, existing: true });
  const before = db.prepare('SELECT * FROM cp_risk_acceptance_preference WHERE id=1').get();
  const acceptance = new RiskAcceptance(preferenceService(db));
  assert.throws(() => acceptance.setPreference({ enabled: false, confirmed: true }, 'mcp'), /Only operator/);
  assert.throws(() => acceptance.setPreference({ enabled: false }, 'operator'), /confirmation/);
  assert.throws(() => acceptance.setPreference({ enabled: false, confirmed: false }, 'operator'), /confirmation/);
  assert.deepEqual(db.prepare('SELECT * FROM cp_risk_acceptance_preference WHERE id=1').get(), before);
});

test('retention registry classifies expanded autonomy stores', () => {
  assert.deepEqual(registry.cp_expanded_autonomy.fields, [
    'id', 'mode', 'flags', 'authorized_at', 'expires_at',
    'emergency_stop', 'emergency_stop_at', 'emergency_stop_by',
    'emergency_request_id', 'updated_at', 'updated_by', 'request_id'
  ]);
  assert.equal(registry.cp_expanded_autonomy.source, 'src/expanded-autonomy.js');
  assert.equal(registry.cp_expanded_autonomy.classification.emergency_stop, 'A');
  assert.equal(registry.cp_expanded_autonomy.classification.flags, 'B');
  assert.deepEqual(registry.cp_expanded_autonomy_audit.fields, [
    'id', 'at', 'kind', 'actor', 'request_id', 'detail'
  ]);
  assert.deepEqual(registry.cp_expanded_autonomy_policies.fields, [
    'id', 'domain', 'policy', 'policy_hash', 'active', 'qualified',
    'created_at', 'expires_at', 'revoked_at', 'created_by', 'request_id'
  ]);
  assert.equal(registry.cp_expanded_autonomy_policies.classification.policy_hash, 'D');
  assert.equal(registry.cp_expanded_autonomy_policies.classification.policy, 'B');
});

test('expanded autonomy schema remains identity-readable after ensure', t => {
  const { ExpandedAutonomy } = require('../src/expanded-autonomy');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const autonomy = new ExpandedAutonomy({ controlStore: { db } });
  assert.ok(autonomy.row());
  assert.doesNotThrow(() => identity.assertReadable(db));
  const before = db.prepare('SELECT mode, emergency_stop FROM cp_expanded_autonomy WHERE id=1').get();
  assert.equal(before.mode, 'manual');
  assert.equal(before.emergency_stop, 0);
  assert.deepEqual(
    db.prepare('SELECT mode, emergency_stop FROM cp_expanded_autonomy WHERE id=1').get(),
    before
  );
});
