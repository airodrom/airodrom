'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PersonalMemory } = require('../src/personal-memory');
const erasure = require('../src/memory-erasure');

test('erasure layers distinguish suppression, retention, logical purge and unclaimed physical wipe', () => {
  const forget = erasure.classifyAction('forget');
  assert.equal(forget.physicalErasure, false);
  assert.ok(forget.layers.includes('retrieval_suppression'));
  assert.ok(forget.layers.includes('logical_purge'));
  assert.equal(forget.layers.includes('physical_deletion'), false);

  const op = erasure.classifyAction('operator_erasure');
  assert.ok(op.layers.includes('retention'));
  assert.equal(op.physicalErasure, false);

  const status = erasure.layerStatus();
  assert.equal(status.physical_deletion.claimed, false);
  assert.equal(status.logical_purge.claimed, true);
  assert.equal(status.physicalErasure, false);
});

test('synthetic forget suppresses retrieval without claiming physical deletion', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erasure-layers-'));
  const db = new DatabaseSync(path.join(dir, 'mem.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const memory = new PersonalMemory({ db });
  const item = memory.remember({
    domain: 'project',
    projectId: 'synthetic-project',
    type: 'fact',
    subject: 'layer-canary',
    content: 'Synthetic erasure layer canary violet',
    source: 'user_explicit'
  });
  const forgotten = memory.forget(item.memoryId);
  assert.equal(forgotten.contentRemoved, true);
  assert.equal(memory.get(item.memoryId), null);
  assert.equal(memory.search('violet', { projectId: 'synthetic-project' }).items.length, 0);
  const marker = erasure.marker(db, 'personal', item.memoryId);
  assert.equal(erasure.classifyAction(marker.action).physicalErasure, false);
  assert.equal(memory.retryErasure().physicalErasure, false);
});

test('stale context pack rejects erased identity after forget', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erasure-pack-'));
  const db = new DatabaseSync(path.join(dir, 'mem.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const memory = new PersonalMemory({ db });
  const item = memory.remember({
    domain: 'project',
    projectId: 'synthetic-project',
    type: 'fact',
    subject: 'pack-canary',
    content: 'Synthetic pack canary indigo',
    source: 'user_explicit'
  });
  const stale = { context_pack: { retrieved_memory_ids: [item.memoryId], refs: [{ memory_id: item.memoryId }] } };
  assert.equal(erasure.packetUsable(db, stale), true);
  memory.forget(item.memoryId);
  assert.equal(erasure.packetUsable(db, stale), false);
});
