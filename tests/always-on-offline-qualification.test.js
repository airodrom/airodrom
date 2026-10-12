'use strict';
/**
 * Offline always-on qualification. Does not touch the installed production service.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const { ServiceLifecycle } = require('../src/service-lifecycle');

function disposableLifecycle(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE project_missions(mission_id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER)');
  const store = new ControlPlaneStore({ db, ledger: new EventLedger(db) });
  const bridge = { controlStore: store, leases: { size: 0 } };
  const gate = new ServiceLifecycle(bridge);
  bridge.lifecycle = gate;
  store.lifecycle = gate;
  t.after(() => db.close());
  gate.finishRecovery();
  gate.resume(gate.epoch);
  return { store, bridge, gate };
}

test('managed startup stays closed until current-epoch resume', (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE project_missions(mission_id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER)');
  const store = new ControlPlaneStore({ db, ledger: new EventLedger(db) });
  const bridge = { controlStore: store, leases: { size: 0 } };
  const gate = new ServiceLifecycle(bridge);
  bridge.lifecycle = gate;
  store.lifecycle = gate;
  t.after(() => db.close());
  assert.equal(gate.state(), 'booting');
  assert.throws(() => store.startRun({ id: 'r', taskId: 't' }), /admission/);
  gate.finishRecovery();
  assert.equal(gate.resume(gate.epoch).state, 'open');
});

test('drain, crash recovery, and fresh epoch prevent duplicate admission', (t) => {
  const { store, bridge, gate } = disposableLifecycle(t);
  store.startRun({ id: 'r1', taskId: 't1' });
  gate.drain();
  assert.throws(() => store.startRun({ id: 'r2', taskId: 't2' }), /admission/);
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.throws(() => next.resume(gate.epoch), /epoch/);
  assert.throws(() => next.resume(next.epoch), /unresolved/);
  assert.equal(store.run('r1').process_state, 'unknown');
});

test('clean shutdown path leaves idle blockers and requires fresh resume', (t) => {
  const { store, bridge, gate } = disposableLifecycle(t);
  gate.drain();
  assert.equal(gate.prepareStop().idle, true);
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.throws(() => next.resume(gate.epoch));
  assert.equal(next.resume(next.epoch).state, 'open');
});

test('no production cutover markers in offline qualification artifacts', () => {
  const launch = fs.readFileSync(path.join(__dirname, '../src/local-bootstrap.js'), 'utf8');
  assert.match(launch, /desktop-login|LaunchAgent|bootstrap/i);
  // Offline suite must not invoke product-control cutover helpers as a side effect.
  assert.equal(process.env.AIRODROM_FORCE_CUTOVER, undefined);
});
