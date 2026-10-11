'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PersonalMemory } = require('../src/personal-memory');
const correction = require('../src/memory-correction');
const ControlServer = require('../src/control-server');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { conversationOptions } = require('./fixtures/direct-conversation-fixture.cjs');

function memoryFixture(t) {
  let now = 1_700_000_000_000;
  const db = new DatabaseSync(':memory:');
  const memory = new PersonalMemory({ db, now: () => now });
  t.after(() => db.close());
  return { db, memory, tick(ms = 1) { now += ms; return now; } };
}

function rememberServer(memory) {
  const server = Object.create(ControlServer.prototype);
  server.bridge = {
    personalMemory: memory,
    rememberPersonalMemory: input => memory.remember(input),
    updatePersonalMemory: (id, patch) => memory.update(id, patch)
  };
  return server;
}

async function liveServer(t) {
  const r = runtime(t);
  const f = await fixture(t, { opencode: r.options });
  const server = new ControlServer(f.bridge, { port: 0, conversationOptions: conversationOptions() });
  await server.start();
  t.after(() => server.close());
  return { ...f, server };
}

test('subjectFor strips correction preamble and normalizes is-now facts', () => {
  assert.equal(correction.subjectFor('My favorite test planet is Kepler-42.'), 'favorite test planet');
  assert.equal(
    correction.subjectFor('Correction: My favorite test planet is now Proxima-77, not Kepler-42.'),
    'favorite test planet'
  );
  assert.equal(
    correction.canonicalFactContent('Correction: My favorite test planet is now Proxima-77, not Kepler-42.'),
    'My favorite test planet is Proxima-77.'
  );
});

test('explicit Correction remember supersedes prior Kepler fact on synthetic store', t => {
  const f = memoryFixture(t);
  const server = rememberServer(f.memory);
  const first = server.rememberInteractive('My favorite test planet is Kepler-42.');
  f.tick();
  const second = server.rememberInteractive('Correction: My favorite test planet is now Proxima-77, not Kepler-42.');
  assert.equal(f.memory.get(first.memoryId, { includeInactive: true }).status, 'superseded');
  assert.equal(f.memory.get(first.memoryId, { includeInactive: true }).supersededBy, second.memoryId);
  assert.equal(f.memory.get(second.memoryId).status, 'active');
  assert.match(f.memory.get(second.memoryId).content, /Proxima-77/);
  assert.doesNotMatch(f.memory.get(second.memoryId).content, /Kepler-42/);
  const listed = f.memory.search('favorite test planet', { domain: 'personal', limit: 10 }).items;
  assert.equal(listed.length, 1);
  assert.match(listed[0].content, /Proxima-77/);
  assert.doesNotMatch(JSON.stringify(listed), /Kepler-42/);
});

test('legacy dual-active conflict collapses for current retrieval and dry-run reconcile', t => {
  const f = memoryFixture(t);
  const old = f.memory.remember({
    domain: 'personal', type: 'fact', subject: 'favorite test planet',
    content: 'My favorite test planet is Kepler-42.', source: 'user_explicit', sensitivity: 'normal'
  });
  f.tick();
  const bad = f.memory.remember({
    domain: 'personal', type: 'fact',
    subject: 'correction: my favorite test planet is now proxima-77, not kepler-42.',
    content: 'Correction: My favorite test planet is now Proxima-77, not Kepler-42.',
    source: 'user_explicit', sensitivity: 'normal'
  });
  assert.equal(f.memory.recent({ domain: 'personal' }).items.length, 2);
  const current = correction.presentCurrentItems(f.memory.search('favorite test planet', { domain: 'personal', limit: 10 }).items);
  assert.equal(current.length, 1);
  assert.equal(current[0].memoryId, bad.memoryId);
  assert.match(current[0].content, /Proxima-77/);
  assert.doesNotMatch(current[0].content, /Kepler-42/);

  const dry = correction.reconcileActiveConflicts(f.memory, { dryRun: true });
  assert.equal(dry.applied, false);
  assert.equal(dry.conflictCount, 1);
  assert.equal(f.memory.get(old.memoryId).status, 'active');

  const applied = correction.reconcileActiveConflicts(f.memory, { dryRun: false, confirmApply: true });
  assert.equal(applied.applied, true);
  assert.equal(f.memory.get(old.memoryId, { includeInactive: true }).status, 'superseded');
  assert.equal(f.memory.get(old.memoryId, { includeInactive: true }).supersededBy, bad.memoryId);
  assert.equal(f.memory.get(bad.memoryId).status, 'active');
  assert.match(f.memory.get(old.memoryId, { includeInactive: true }).content, /Kepler-42/);
});

test('repeated corrections keep only the newest current fact', t => {
  const f = memoryFixture(t);
  const server = rememberServer(f.memory);
  server.rememberInteractive('My favorite test planet is Kepler-42.');
  f.tick();
  server.rememberInteractive('Correction: My favorite test planet is now Proxima-77, not Kepler-42.');
  f.tick();
  const third = server.rememberInteractive('Correction: My favorite test planet is now Terra-9, not Proxima-77.');
  const active = f.memory.recent({ domain: 'personal', limit: 20 }).items;
  assert.equal(active.length, 1);
  assert.equal(active[0].memoryId, third.memoryId);
  assert.match(active[0].content, /Terra-9/);
  assert.doesNotMatch(JSON.stringify(active), /Kepler-42|Proxima-77/);
});

test('forgetting current fact removes it from search and currentItems', t => {
  const f = memoryFixture(t);
  const server = rememberServer(f.memory);
  const item = server.rememberInteractive('My favorite test planet is Proxima-77.');
  f.memory.forget(item.memoryId);
  assert.equal(f.memory.search('favorite test planet', { domain: 'personal' }).items.length, 0);
  assert.deepEqual(correction.currentItems(f.memory.recent({ domain: 'personal', limit: 20 }).items), []);
});

test('ordinary conversational memory path excludes superseded Kepler fact', async t => {
  const f = await liveServer(t);
  f.server.rememberInteractive('My favorite test planet is Kepler-42.');
  f.server.rememberInteractive('Correction: My favorite test planet is now Proxima-77, not Kepler-42.');
  const listed = f.server.interactiveMemory('favorite test planet').items;
  assert.equal(listed.length, 1);
  assert.match(listed[0].content, /Proxima-77/);
  assert.doesNotMatch(JSON.stringify(listed), /Kepler-42/);

  const ctx = f.server.conversationEngine.memory('What is my favorite test planet?');
  assert.ok(ctx.length >= 1);
  assert.match(JSON.stringify(ctx), /Proxima-77/);
  assert.doesNotMatch(JSON.stringify(ctx), /Kepler-42/);

  const created = f.bridge.missions.createConversation({
    request_id: crypto.randomUUID(),
    message: 'What is my favorite test planet?',
    include_memory: true
  });
  const pack = f.bridge.controlContext.build(f.bridge.missions.require(created.mission_id));
  assert.equal(pack.reference_data.length, 1);
  assert.match(pack.reference_data[0].content, /Proxima-77/);
  assert.doesNotMatch(JSON.stringify(pack.reference_data), /Kepler-42/);
});

test('correction persists across PersonalMemory reopen', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-correction-'));
  const file = path.join(dir, 'memory.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_700_000_000_000;
  const db = new DatabaseSync(file);
  const memory = new PersonalMemory({ db, now: () => now });
  const server = rememberServer(memory);
  server.rememberInteractive('My favorite test planet is Kepler-42.');
  now += 1;
  server.rememberInteractive('Correction: My favorite test planet is now Proxima-77, not Kepler-42.');
  db.close();
  const reopenedDb = new DatabaseSync(file);
  t.after(() => reopenedDb.close());
  const reopened = new PersonalMemory({ db: reopenedDb });
  const items = reopened.search('favorite test planet', { domain: 'personal' }).items;
  assert.equal(items.length, 1);
  assert.match(items[0].content, /Proxima-77/);
  assert.equal(reopened.stats().byStatus.active, 1);
  assert.ok((reopened.stats().byStatus.superseded || 0) >= 1);
});

test('assistant intent routes Correction statements to remember', () => {
  const intent = require('../src/assistant-intent');
  const parsed = intent.parse('Correction: My favorite test planet is now Proxima-77, not Kepler-42.');
  assert.equal(parsed.route, 'MEMORY');
  assert.equal(parsed.kind, 'remember');
});

test('reconcile script dry-run does not mutate fixture database', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reconcile-'));
  const file = path.join(dir, 'fixture.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  const memory = new PersonalMemory({ db, now: () => 1_700_000_000_000 });
  memory.remember({ domain: 'personal', type: 'fact', subject: 'favorite test planet', content: 'My favorite test planet is Kepler-42.', source: 'user_explicit' });
  memory.remember({
    domain: 'personal', type: 'fact',
    subject: 'correction: my favorite test planet is now proxima-77, not kepler-42.',
    content: 'Correction: My favorite test planet is now Proxima-77, not Kepler-42.',
    source: 'user_explicit'
  });
  db.close();
  const { main } = require('../scripts/reconcile-memory-corrections.cjs');
  assert.equal(main(['--db', file]), 0);
  const checkDb = new DatabaseSync(file);
  t.after(() => checkDb.close());
  const check = new PersonalMemory({ db: checkDb });
  assert.equal(check.recent({ domain: 'personal' }).items.length, 2);
});
