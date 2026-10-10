'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const { ServiceLifecycle } = require('../src/service-lifecycle');

test('orphaned durable stopping is replaced by booting on new writer ownership', t => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE project_missions(mission_id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER)');
  const store = new ControlPlaneStore({ db, ledger: new EventLedger(db) });
  const bridge = { controlStore: store, leases: { size: 0 } };
  const first = new ServiceLifecycle(bridge); store.lifecycle = first; bridge.lifecycle = first;
  first.finishRecovery(); first.resume(first.epoch);
  first.drain(); first.prepareStop();
  assert.equal(first.state(), 'stopping');
  const priorEpoch = first.epoch;
  // Simulate a package that never loaded lifecycle leaving the durable row untouched,
  // then a corrected package taking writer ownership.
  const next = new ServiceLifecycle(bridge); store.lifecycle = next; bridge.lifecycle = next;
  assert.equal(next.priorState, 'stopping');
  assert.equal(next.priorEpoch, priorEpoch);
  assert.equal(next.state(), 'booting');
  assert.notEqual(next.epoch, priorEpoch);
  store.recover(); next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.equal(next.resume(next.epoch).state, 'open');
  assert.equal(db.prepare('SELECT state FROM cp_service_lifecycle WHERE id=1').get().state, 'open');
  db.close();
});

test('canonical package allowlist includes lifecycle runtime modules', () => {
  const allow = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '../release-files.json'), 'utf8')));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  for (const file of ['src/service-lifecycle.js', 'src/run-settlement.js']) {
    assert.ok(allow.has(file), file + ' missing from release-files.json');
    assert.ok(pkg.files.includes(file), file + ' missing from package.json files');
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file + ' missing from tree');
  }
});

test('required lifecycle runtime imports resolve from package allowlist graph', () => {
  assert.equal(typeof require('../src/service-lifecycle').ServiceLifecycle, 'function');
  assert.equal(typeof require('../src/run-settlement').unresolvedRuns, 'function');
  assert.ok(require('../src/run-settlement').UNRESOLVED_RUNS_SQL.includes('cp_runs'));
});
