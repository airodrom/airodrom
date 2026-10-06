'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const identity = require('../src/memory-identity');
const SCRIPT = path.resolve(__dirname, '../scripts/memory-identity-plan.cjs');
const CANARY = 'fixture-personal-plan-canary';
const OLD = createHash('sha256').update(CANARY).digest('hex');
const sum = value => createHash('sha256').update(value).digest('hex');
const ALLOWED = new Set(['version', 'mode', 'legacy_content_identifiers', 'unanchored_request_records', 'migration_required', 'state', 'safe_error_class', 'authority']);

function file(t, build) {
  const root = fs.mkdtempSync('/private/tmp/pi-identity-plan-'), database = path.join(root, CANARY + '.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(database);
  try { build(db); } finally { db.close(); }
  return { root, database };
}
function legacy(db) {
  db.exec('CREATE TABLE cp_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(owner,request_id))');
  db.prepare("INSERT INTO cp_requests VALUES(?,?,?,'settled',?)").run('operator', OLD, sum(CANARY), JSON.stringify({ note: CANARY }));
}
function safe(output, forbidden = []) {
  for (const value of [CANARY, OLD, 'sha256:' + OLD, ...forbidden]) assert.equal((output.stdout + output.stderr).includes(value), false, 'preview output must contain no payload, external labels, paths or legacy identifiers');
  const lines = output.stdout.trim().split('\n'); assert.equal(lines.length, 1, 'preview emits one machine-readable safe result');
  const result = JSON.parse(lines[0]);
  assert.equal(Object.keys(result).every(key => ALLOWED.has(key)), true, 'preview reports only counts and fixed safe status fields');
  assert.equal(result.version, 1); assert.equal(result.mode, 'read_only_plan'); assert.equal(result.authority, false);
  if (Object.hasOwn(result, 'legacy_content_identifiers')) assert.equal(result.legacy_content_identifiers === null || Number.isSafeInteger(result.legacy_content_identifiers), true);
  if (Object.hasOwn(result, 'unanchored_request_records')) assert.equal(Number.isSafeInteger(result.unanchored_request_records), true);
  if (Object.hasOwn(result, 'migration_required')) assert.equal(typeof result.migration_required, 'boolean');
  return result;
}
function plan(f, args = ['--database', f.database], forbidden = []) {
  const before = sum(fs.readFileSync(f.database)), filesBefore = fs.readdirSync(f.root).sort();
  const output = spawnSync(process.execPath, ['--experimental-sqlite', SCRIPT, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(output.error, undefined, 'preview command completes within its bound');
  assert.equal(sum(fs.readFileSync(f.database)), before, 'read-only preview must not mutate database bytes');
  assert.deepEqual(fs.readdirSync(f.root).sort(), filesBefore, 'preview creates no sidecar, migration, backup or alias files');
  return { output, result: safe(output, [f.database, ...forbidden]) };
}

test('legacy preview is read-only and reports counts without content or reconstructive identifiers', t => {
  const f = file(t, legacy), { output, result } = plan(f);
  assert.equal(output.status, 0); assert.equal(result.state, 'unmigrated');
  assert.equal(result.legacy_content_identifiers, 1); assert.equal(result.unanchored_request_records, 1); assert.equal(result.migration_required, true);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA table_info(cp_requests)').all().some(column => column.name === 'record_id'), false, 'preview does not even prepare the host migration schema');
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'memory_identity_%'").get().n, 0);
  } finally { db.close(); }
});

test('completed preview reports only disposition and safe counts without opaque origin values', t => {
  const f = file(t, db => { legacy(db); identity.migrate(db); });
  const db = new DatabaseSync(f.database, { readOnly: true }); let ids;
  try { ids = db.prepare('SELECT record_id,request_id FROM cp_requests').all().flatMap(row => [row.record_id, row.request_id]); } finally { db.close(); }
  const { output, result } = plan(f, undefined, ids);
  assert.equal(output.status, 0); assert.equal(result.state, 'complete'); assert.equal(result.legacy_content_identifiers, 0);
  assert.equal(result.unanchored_request_records, 0); assert.equal(result.migration_required, false);
});

test('unknown store schema fails safely without disclosing its name or payload', t => {
  const table = 'unknown_' + CANARY.replaceAll('-', '_');
  const f = file(t, db => { legacy(db); db.exec(`CREATE TABLE "${table}"(id TEXT PRIMARY KEY,content TEXT)`); db.prepare(`INSERT INTO "${table}" VALUES(?,?)`).run(OLD, CANARY); });
  const { output, result } = plan(f, undefined, [table]);
  assert.equal(output.status, 1); assert.equal(result.state, 'failed'); assert.equal(result.safe_error_class, 'unknown_identity_schema'); assert.equal(result.migration_required, true);
});

test('unknown field schema fails safely without disclosing its label or retained content', t => {
  const field = 'copy_' + CANARY.replaceAll('-', '_');
  const f = file(t, db => { legacy(db); db.exec(`ALTER TABLE cp_requests ADD COLUMN "${field}" TEXT`); db.prepare(`UPDATE cp_requests SET "${field}"=?`).run(CANARY); });
  const { output, result } = plan(f, undefined, [field]);
  assert.equal(output.status, 1); assert.equal(result.state, 'failed'); assert.equal(result.migration_required, true);
});

test('malformed recognized JSON fails safely rather than printing source data', t => {
  const f = file(t, db => { db.exec('CREATE TABLE cp_candidates(id TEXT PRIMARY KEY,record TEXT NOT NULL)'); db.prepare('INSERT INTO cp_candidates VALUES(?,?)').run('sha256:' + OLD, CANARY + '{invalid'); });
  const { output, result } = plan(f);
  assert.equal(output.status, 1); assert.equal(result.state, 'failed'); assert.equal(result.safe_error_class, 'unknown_identity_schema');
});

test('unsupported identity schema version cannot produce a successful complete preview', t => {
  const f = file(t, db => { identity.install(db); db.prepare('UPDATE memory_identity_meta SET version=999 WHERE id=1').run(); });
  const { output, result } = plan(f);
  assert.equal(output.status, 1); assert.equal(result.state, 'failed'); assert.equal(result.migration_required, true);
});

test('unclassified fields on migration metadata are not exempted from safe schema failure', t => {
  const f = file(t, db => { identity.install(db); db.exec('ALTER TABLE memory_identity_meta ADD COLUMN personal_snapshot TEXT'); db.prepare('UPDATE memory_identity_meta SET personal_snapshot=?').run(CANARY); });
  const { output, result } = plan(f);
  assert.equal(output.status, 1); assert.equal(result.state, 'failed'); assert.equal(result.migration_required, true);
});

test('invalid CLI arguments and unavailable database paths are safe and create no files', t => {
  const f = file(t, legacy);
  for (const args of [[], ['--database', f.database, '--apply', CANARY], ['--database', path.join(f.root, CANARY + '-absent.sqlite')]]) {
    const { output, result } = plan(f, args);
    assert.equal(output.status, 1); assert.equal(result.state, 'failed'); assert.equal(result.safe_error_class, 'identity_plan_unavailable');
  }
});

test('corrupt lineage is denied without printing origin metadata or allocating replacement identity', t => {
  const origin = randomUUID();
  const f = file(t, db => { identity.install(db); db.prepare('INSERT INTO memory_identity_lineage VALUES(?,?,?,?,?,?)').run('fixture', 'opaque:' + origin, OLD, null, null, 1); });
  const { output, result } = plan(f, undefined, [origin]);
  assert.equal(output.status, 1); assert.equal(result.state, 'failed'); assert.equal(result.migration_required, true);
});
