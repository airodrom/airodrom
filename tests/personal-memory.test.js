'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { PersonalMemory, SCHEMA_VERSION, MAX_CONTENT_BYTES } = require('../src/personal-memory');

function fixture(t, { record = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-personal-memory-'));
  const filename = path.join(directory, 'memory.sqlite');
  const db = new DatabaseSync(filename); db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2500;');
  let now = 1_790_000_000_000;
  const memory = new PersonalMemory({ db, now: () => now, record });
  t.after(() => { try { db.close(); } catch { /* A restart test may already close it. */ } fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, filename, db, memory, tick: (ms = 1) => { now += ms; return now; } };
}
function input(overrides = {}) {
  return { domain: 'personal', type: 'preference', subject: 'editor', content: 'Andrew prefers concise review summaries.', source: 'user_explicit', confidence: 95, sensitivity: 'normal', ...overrides };
}

test('fresh initialization migrates an existing database without altering existing tables', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-personal-memory-migration-'));
  const filename = path.join(directory, 'memory.sqlite');
  const db = new DatabaseSync(filename); db.exec('CREATE TABLE preserved_state (id TEXT PRIMARY KEY, body TEXT NOT NULL); INSERT INTO preserved_state VALUES (\'existing\', \'{}\');');
  const memory = new PersonalMemory({ db });
  assert.equal(memory.stats().schemaVersion, SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT count(*) AS count FROM preserved_state').get().count, 1);
  assert.equal(db.prepare("SELECT value FROM personal_memory_meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('remember, get, search, recent, and restart preserve bounded durable memory', t => {
  const { memory, filename, db } = fixture(t);
  const saved = memory.remember(input());
  assert.equal(saved.deduplicated, false);
  assert.equal(memory.get(saved.memoryId).content, input().content);
  assert.equal(memory.search('concise summaries', { domain: 'personal' }).items[0].memoryId, saved.memoryId);
  assert.equal(memory.recent({ domain: 'personal' }).items[0].source, 'user_explicit');
  db.close();
  const reopenedDb = new DatabaseSync(filename); const reopened = new PersonalMemory({ db: reopenedDb });
  assert.equal(reopened.get(saved.memoryId).content, input().content);
  reopenedDb.close();
});

test('personal, project, and session domains remain isolated and sensitivity is opt-in for retrieval', t => {
  const { memory } = fixture(t);
  const personal = memory.remember(input({ content: 'Personal editor preference is concise.' }));
  const project = memory.remember(input({ domain: 'project', projectId: 'project-a', subject: 'deployment-region', content: 'Project A deployment region is west.' }));
  const session = memory.remember(input({ domain: 'session', taskId: 'task-a', sessionId: 'session-a', subject: 'working-note', content: 'Session A uses the small fixture.' }));
  const privateMemory = memory.remember(input({ subject: 'private-note', content: 'Private preference should stay operator scoped.', sensitivity: 'private' }));
  assert.deepEqual(memory.search('preference', { domain: 'personal' }).items.map(item => item.memoryId), [personal.memoryId]);
  assert.deepEqual(memory.search('deployment', { domain: 'project', projectId: 'project-a' }).items.map(item => item.memoryId), [project.memoryId]);
  assert.deepEqual(memory.search('fixture', { domain: 'session', taskId: 'task-a', sessionId: 'session-a' }).items.map(item => item.memoryId), [session.memoryId]);
  assert.equal(memory.search('operator scoped', { domain: 'personal' }).items.length, 0);
  assert.equal(memory.search('operator scoped', { domain: 'personal', includeSensitive: true }).items[0].memoryId, privateMemory.memoryId);
  assert.equal(memory.get(privateMemory.memoryId, { includeSensitive: false }), null);
  assert.equal(memory.recent({ domain: 'personal', includeSensitive: false }).items.some(item => item.memoryId === privateMemory.memoryId), false);
});

test('multiline search queries are normalized before FTS retrieval', t => {
  const { memory } = fixture(t);
  const saved = memory.remember(input({ content: 'Personal memory supports concise multiline retrieval queries.' }));
  const result = memory.search('Personal memory\nretrieval queries', { domain: 'personal' });
  assert.equal(result.items[0].memoryId, saved.memoryId);
  assert.throws(() => memory.search('\u0000'), /Invalid memory query/);
});

test('explicit correction supersedes the prior active value and removes it from current retrieval', t => {
  const { memory, tick } = fixture(t);
  const old = memory.remember(input({ content: 'Preferred review format is detailed.' })); tick();
  const current = memory.update(old.memoryId, { content: 'Preferred review format is concise.' });
  assert.equal(memory.get(old.memoryId), null);
  assert.equal(memory.get(old.memoryId, { includeInactive: true }).status, 'superseded');
  assert.equal(memory.get(old.memoryId, { includeInactive: true }).supersededBy, current.memoryId);
  assert.equal(memory.search('review format', { domain: 'personal' }).items.length, 1);
  assert.equal(memory.search('review format', { domain: 'personal' }).items[0].content, 'Preferred review format is concise.');
});

test('forget removes content from normal retrieval while retaining content-free audit evidence', t => {
  const events = []; const { memory, db } = fixture(t, { record: event => events.push(event) });
  const saved = memory.remember(input({ content: 'Forgettable personal preference is green tea.' }));
  const forgotten = memory.forget(saved.memoryId);
  assert.equal(forgotten.status, 'forgotten'); assert.equal(forgotten.content, undefined); assert.equal(forgotten.contentRemoved, true);
  assert.equal(memory.get(saved.memoryId), null);
  assert.equal(memory.search('green tea', { domain: 'personal' }).items.length, 0);
  const row = db.prepare('SELECT content, content_hash, status FROM personal_memories WHERE memory_id = ?').get(saved.memoryId);
  assert.equal(row.content, null); assert.equal(row.status, 'forgotten'); assert.match(row.content_hash, /^[a-f0-9]{64}$/);
  assert.ok(events.some(event => event.eventType === 'memory.forget'));
  assert.doesNotMatch(JSON.stringify(events), /green tea/);
});

test('secret-like content, malformed fields, and oversized values are rejected before persistence', t => {
  const { memory } = fixture(t);
  for (const content of ['Authorization: Bearer abcdefghijklmnop', 'api_key=super-secret-value', '-----BEGIN PRIVATE KEY-----', 'ghp_abcdefghijklmnopqrstuvwxyz', '4111 1111 1111 1111']) {
    assert.throws(() => memory.remember(input({ content })), /Secret-like/);
  }
  assert.throws(() => memory.remember(input({ domain: 'unknown' })), /domain/);
  assert.throws(() => memory.remember(input({ domain: 'project' })), /projectId/);
  assert.throws(() => memory.remember(input({ domain: 'session' })), /taskId or sessionId/);
  assert.throws(() => memory.remember(input({ source: 'model' })), /source/);
  assert.throws(() => memory.remember(input({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) })), /content/);
  assert.throws(() => memory.search('query', { domain: 'personal', limit: -1 }), /limit/);
  assert.equal(memory.stats().count, 0);
});

test('query bounds, expiration, and shared SQLite writers stay deterministic', t => {
  const { memory, filename, tick } = fixture(t);
  for (let index = 0; index < 30; index++) memory.remember(input({ subject: `note-${index}`, content: `bounded retrieval token ${index} ${'x'.repeat(500)}` }));
  const bounded = memory.search('bounded retrieval token', { domain: 'personal', limit: 1000, maxChars: 100000 });
  assert.ok(bounded.items.length <= 20); assert.ok(bounded.usedChars <= 8000); assert.equal(bounded.truncated, true);
  const expiring = memory.remember(input({ subject: 'expiry', content: 'This value expires quickly.', expiresAt: tick(10) + 1 })); tick(2);
  assert.equal(memory.get(expiring.memoryId), null);
  assert.equal(memory.get(expiring.memoryId, { includeInactive: true }).status, 'expired');
  const otherDb = new DatabaseSync(filename); otherDb.exec('PRAGMA busy_timeout = 2500;'); const other = new PersonalMemory({ db: otherDb });
  const writes = Array.from({ length: 12 }, (_, index) => Promise.resolve().then(() => (index % 2 ? memory : other).remember(input({ subject: `concurrent-${index}`, content: `concurrent durable value ${index}` }))));
  return Promise.all(writes).then(rows => {
    assert.equal(new Set(rows.map(row => row.memoryId)).size, 12);
    assert.equal(other.recent({ domain: 'personal', limit: 100 }).items.filter(row => row.subject.startsWith('concurrent-')).length, 12);
    otherDb.close();
  });
});

test('ledger recorder receives safe, non-recursive memory events', t => {
  const events = []; const { memory } = fixture(t, { record: event => events.push(event) });
  const saved = memory.remember(input({ content: 'Arecibo credentials are stored in Secret Manager.' }));
  memory.get(saved.memoryId); memory.update(saved.memoryId, { content: 'Arecibo deployment credentials are stored in Secret Manager.' });
  assert.deepEqual(events.map(event => event.eventType), ['memory.write', 'memory.read', 'memory.write', 'memory.superseded']);
  assert.ok(events.every(event => !Object.hasOwn(event, 'payload')));
  assert.doesNotMatch(JSON.stringify(events), /Secret Manager/);
});

test('same-content correction applies privacy, provenance and expiration changes', t => {
  const { memory, tick } = fixture(t);
  const first = memory.remember(input());
  const revised = memory.update(first.memoryId, { content: input().content, sensitivity: 'private', sourceEventId: 'operator-correction', expiresAt: tick() + 100 });
  assert.notEqual(revised.memoryId, first.memoryId);
  assert.equal(memory.get(first.memoryId), null);
  assert.equal(memory.search('concise').items.length, 0);
  assert.equal(memory.get(revised.memoryId).sourceEventId, 'operator-correction');
  tick(101);
  assert.equal(memory.get(revised.memoryId), null);
  const fresh = memory.remember(input());
  assert.notEqual(fresh.memoryId, revised.memoryId);
  assert.equal(fresh.status, 'active');
});

test('replacement cannot mutate scope or return a different active identity as a no-op', t => {
  const { memory } = fixture(t);
  const first = memory.remember(input({ domain: 'project', projectId: 'a' }));
  assert.throws(() => memory.update(first.memoryId, { content: input().content, projectId: 'b' }), /scope cannot change/);
  assert.equal(memory.get(first.memoryId).projectId, 'a');
  const target = memory.remember(input({ domain: 'project', projectId: 'a', subject: 'another', content: 'other preference' }));
  const updated = memory.update(first.memoryId, { subject: 'another', content: target.content });
  assert.equal(memory.get(first.memoryId), null);
  assert.equal(memory.get(target.memoryId), null);
  assert.equal(memory.get(updated.memoryId).status, 'active');
});

test('forget is idempotent for superseded and expired records across restart', t => {
  const { memory, db, filename, tick } = fixture(t);
  const old = memory.remember(input());
  memory.update(old.memoryId, { content: 'New review preference.' });
  const expiring = memory.remember(input({ subject: 'temporary', expiresAt: tick() + 1 }));
  tick(2); memory.get(expiring.memoryId);
  for (const id of [old.memoryId, expiring.memoryId]) {
    assert.equal(memory.forget(id).contentRemoved, true);
    assert.equal(memory.forget(id).status, 'forgotten');
  }
  db.close();
  const reopenedDb = new DatabaseSync(filename); const reopened = new PersonalMemory({ db: reopenedDb });
  for (const id of [old.memoryId, expiring.memoryId]) assert.equal(reopened.get(id, { includeInactive: true }).contentRemoved, true);
  assert.equal(reopened.search('concise').items.length, 0);
  reopenedDb.close();
});

test('future or malformed schema versions fail before altering durable schema', () => {
  for (const version of ['999', 'invalid']) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE personal_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO personal_memory_meta VALUES (?,?)').run('schema_version', version);
    const before = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    assert.throws(() => new PersonalMemory({ db }), /newer.*invalid version/);
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), before);
    db.close();
  }
});
