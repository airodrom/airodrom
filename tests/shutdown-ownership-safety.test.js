'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const { ServiceLifecycle } = require('../src/service-lifecycle');
const { unresolvedRuns, durableBlockers } = require('../src/run-settlement');
const Bridge = require('../src/bridge-controller');
const TestBridge = require('./fixtures/test-bridge.cjs');
const { SYNTHETIC_FIXTURE_DISPOSE } = TestBridge;

function gateFixture(t) {
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
  return { db, store, bridge, gate };
}

function refuseStop(gate) {
  gate.drain();
  assert.throws(() => gate.prepareStop(), /not idle|unresolved|Drain is not idle/i);
  assert.equal(gate.state(), 'draining');
}

test('production BridgeController has no synthetic fixture dispose path', () => {
  assert.equal(typeof Bridge.prototype.disposeFixtureOwnership, 'undefined');
  assert.equal(typeof Bridge.prototype.shutdownForFixtureRestart, 'undefined');
  assert.equal(typeof Bridge.prototype.productionShutdown, 'undefined');
  assert.equal(typeof TestBridge.prototype.disposeFixtureOwnership, 'function');
  assert.equal(SYNTHETIC_FIXTURE_DISPOSE, 'synthetic_fixture_dispose');
});

test('1 active worker with unverified termination refuses stop and keeps admission closed', t => {
  const { store, gate, db } = gateFixture(t);
  store.startRun({ id: 'alive', taskId: 't' });
  store.updateRun('alive', { state: 'running', processState: 'alive', verified: false });
  assert.equal(unresolvedRuns(db), 1);
  refuseStop(gate);
  assert.throws(() => gate.resume(gate.epoch), /unresolved/);
});

test('2 unknown process state refuses stop', t => {
  const { store, gate, db } = gateFixture(t);
  store.startRun({ id: 'unk', taskId: 't' });
  store.updateRun('unk', { state: 'interrupted', processState: 'unknown', verified: false });
  assert.equal(unresolvedRuns(db), 1);
  refuseStop(gate);
});

test('3 active writer lease refuses stop', t => {
  const { store, gate, db } = gateFixture(t);
  const dir = fs.mkdtempSync('/private/tmp/airo-lease-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.startRun({ id: 'writer', taskId: 't' });
  store.updateRun('writer', { state: 'running', processState: 'alive', verified: false });
  store.acquireLease({ resource: dir, runId: 'writer' });
  assert.equal(durableBlockers(db).leases, 1);
  refuseStop(gate);
});

test('4 quarantined execution refuses stop and recovery resume', t => {
  const { store, bridge, gate, db } = gateFixture(t);
  const dir = fs.mkdtempSync('/private/tmp/airo-q-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.startRun({ id: 'q', taskId: 't' });
  store.updateRun('q', { state: 'termination_unverified', processState: 'unknown', verified: false });
  store.acquireLease({ resource: dir, runId: 'q' });
  db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id='q'").run();
  refuseStop(gate);
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.throws(() => next.resume(next.epoch), /unresolved/);
});

test('5 unknown external side effect (delivery_unknown) refuses stop', t => {
  const { gate, db } = gateFixture(t);
  db.exec("CREATE TABLE IF NOT EXISTS cp_effect_outbox(id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,destination_type TEXT NOT NULL,destination_ref TEXT NOT NULL,event_type TEXT NOT NULL,correlation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,sent_at INTEGER,error_class TEXT,receipt TEXT,claim TEXT)");
  const now = Date.now();
  db.prepare("INSERT INTO cp_effect_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    'e1', 'k1', 'slack', 'ref', 'mission.event', '{}', '{}', 'delivery_unknown', 1, now, now, now, null, null, null, null
  );
  assert.equal(gate.status().blockers.effects, 1);
  refuseStop(gate);
});

test('6 terminal run without independently verified termination refuses stop', t => {
  const { store, gate, db } = gateFixture(t);
  store.startRun({ id: 'tv', taskId: 't' });
  store.updateRun('tv', { state: 'completed', processState: 'exited', verified: false });
  assert.equal(unresolvedRuns(db), 1);
  refuseStop(gate);
});

test('7 durable wait with verified termination and no live process allows stop', t => {
  const { store, gate, db } = gateFixture(t);
  store.startRun({ id: 'wait', taskId: 't' });
  store.updateRun('wait', {
    state: 'waiting_for_operator',
    processState: 'not_started',
    verified: true,
    resolution: 'decision_required'
  });
  assert.equal(unresolvedRuns(db), 0);
  gate.drain();
  assert.equal(gate.prepareStop().state, 'stopping');
});

test('8 durable wait with active lease remains blocked', t => {
  const { store, gate, db } = gateFixture(t);
  const dir = fs.mkdtempSync('/private/tmp/airo-dw-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.startRun({ id: 'wait-lease', taskId: 't' });
  store.updateRun('wait-lease', {
    state: 'waiting_for_operator',
    processState: 'not_started',
    verified: true,
    resolution: 'decision_required'
  });
  store.acquireLease({ resource: dir, runId: 'wait-lease' });
  db.prepare("UPDATE cp_leases SET state='held' WHERE run_id='wait-lease'").run();
  assert.equal(unresolvedRuns(db), 1);
  refuseStop(gate);
});

test('9 recovery after simulated process restart preserves uncertain state and closed admission', t => {
  const { store, bridge, gate } = gateFixture(t);
  store.startRun({ id: 'crash', taskId: 't' });
  store.updateRun('crash', { state: 'running', processState: 'alive', verified: false, pid: 424242 });
  gate.drain();
  assert.throws(() => gate.prepareStop());
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.throws(() => next.resume(next.epoch), /unresolved/);
  const run = store.run('crash');
  assert.equal(run.state, 'interrupted');
  assert.equal(run.process_state, 'unknown');
  assert.equal(run.termination_verified, 0);
});

test('10 synthetic fixture dispose is not real termination and cannot grant Acceptance', async t => {
  const dir = fs.mkdtempSync('/private/tmp/airo-dispose-');
  const data = path.join(dir, 'data');
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  const bridge = await new TestBridge({
    dataDir: data,
    sourceProfile: profile,
    webEnabled: false,
    slack: { env: {} },
    allowFixtureWorker: true
  }).initialize();
  t.after(async () => {
    try { await bridge.shutdown(); } catch { /* teardown */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Seed an unresolved worker that would block production shutdown.
  bridge.lifecycle.resume(bridge.lifecycle.epoch);
  bridge.controlStore.startRun({ id: 'synthetic-alive', taskId: 'fixture-task', agentId: 'host' });
  bridge.controlStore.updateRun('synthetic-alive', { state: 'running', processState: 'alive', verified: false });
  assert.equal(bridge.lifecycle.status().idle, false);

  await assert.rejects(() => bridge.productionShutdown(), /Shutdown termination is unverified|writer lock retained/i);
  assert.ok(fs.existsSync(bridge.lockFile), 'production refusal retains writer lock');
  bridge.shutdownPromise = null;
  bridge.closed = false;
  if (bridge.lifecycle.state() === 'draining') {
    // productionShutdown drained; reopen only after synthetic clear would be wrong —
    // leave drained for dispose proof.
  }

  const receipt = bridge.disposeFixtureOwnership();
  assert.equal(receipt.classification, 'synthetic_fixture_disposal');
  assert.equal(receipt.real_termination_verified, false);
  assert.equal(receipt.resolution, SYNTHETIC_FIXTURE_DISPOSE);
  const run = bridge.controlStore.run('synthetic-alive');
  assert.equal(run.resolution, SYNTHETIC_FIXTURE_DISPOSE);
  assert.equal(run.state, 'cancelled');
  assert.notEqual(run.state, 'completed');
  assert.equal(bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n, 0);

  // Default fixture shutdown releases the writer without claiming production idle proof.
  await bridge.shutdown();
  assert.equal(bridge.lockFd, null);
  assert.equal(fs.existsSync(bridge.lockFile), false);
});

test('mission tick does not enter busy gate while admission is closed', async t => {
  const { bridge, gate } = gateFixture(t);
  let entered = false;
  bridge.missions = {
    busy: false,
    stopped: false,
    async tick() {
      if (this.busy || this.stopped || bridge.closed || bridge.lifecycle && bridge.lifecycle.state() !== 'open') return;
      this.busy = true;
      entered = true;
      this.busy = false;
    }
  };
  gate.drain();
  await bridge.missions.tick();
  assert.equal(entered, false);
  assert.equal(gate.status().blockers.mission_tick, 0);
});

test('verified idle recovery can reopen admission; uncertain execution cannot', t => {
  const { store, bridge } = gateFixture(t);
  store.startRun({ id: 'ok', taskId: 't' });
  store.updateRun('ok', { state: 'completed', processState: 'exited', verified: true });
  // Crash while open and idle: prior open + idle => finishRecovery auto-opens.
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  assert.equal(next.finishRecovery().state, 'open');

  store.startRun({ id: 'bad', taskId: 't2' });
  store.updateRun('bad', { state: 'running', processState: 'alive', verified: false });
  const blocked = new ServiceLifecycle(bridge);
  store.lifecycle = blocked;
  store.recover();
  blocked.finishRecovery();
  assert.equal(blocked.state(), 'booting');
  assert.throws(() => blocked.resume(blocked.epoch), /unresolved/);
});

test('cancelled work cannot silently restart after recovery', t => {
  const { store, bridge, gate } = gateFixture(t);
  store.startRun({ id: 'cancel', taskId: 't' });
  store.updateRun('cancel', { state: 'cancelled', processState: 'exited', verified: true });
  gate.drain();
  gate.prepareStop();
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(store.run('cancel').state, 'cancelled');
  assert.equal(store.run('cancel').termination_verified, 1);
});
