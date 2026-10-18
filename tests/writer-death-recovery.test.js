'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const recovery = require('../src/writer-death-recovery');
const identity = require('../src/memory-identity');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writer-death-')));
  const db = new DatabaseSync(path.join(dir, 'source.sqlite'));
  const ledger = new EventLedger(db, { now: () => 1000 });
  const store = new ControlPlaneStore({ db, ledger, now: () => 5000 });
  new (require('../src/personal-memory').PersonalMemory)({ db });
  new (require('../src/project-memory-v2').ProjectMemoryV2)({ db });
  new (require('../src/authority-store').AuthorityStore)(db);
  new (require('../src/memory-store').MemoryStore)(':memory:', { db });
  const mission = randomUUID();
  const task = randomUUID();
  const grant = randomUUID();
  db.prepare('INSERT INTO cp_missions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(mission, null, null, task, 'operator', 'blocked', 1, JSON.stringify({ kind: 'coding' }), grant, 1000, 1000, 'Interrupted run requires process reconciliation', 'criteria');
  db.prepare('INSERT INTO cp_grants VALUES(?,?,?,?)').run(grant, mission, '{}', 1000);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, store, mission, task };
}
function interrupt(store, id, mission, task, agent) {
  store.startRun({ id, taskId: task, missionId: mission, agentId: agent });
  store.updateRun(id, { state: 'interrupted', processState: 'unknown', resolution: 'reconcile_process' });
}
const quiet = () => ({ writer_alive: false, workspace_holders: 0, method: 'test_observation' });

test('writer death settles in-process runs and incomplete read-only invocations without acceptance', t => {
  const f = fixture(t);
  const host = randomUUID();
  const bridge = randomUUID();
  const request = 'verify:' + randomUUID() + ':git_diff:' + 'a'.repeat(32);
  interrupt(f.store, host, f.mission, f.task, 'host');
  f.store.acquireLease({ resource: f.dir, runId: host, missionId: f.mission });
  f.db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=?").run(host);
  interrupt(f.store, bridge, f.mission, f.task, 'bridge');
  const invocation = f.store.beginInvocation(f.task, request, 'fingerprint');
  f.db.prepare("UPDATE cp_invocations SET state='unknown' WHERE request_id=?").run(request);
  f.store.event('capability.requested', f.mission, { capability: 'git_diff', request_id: request }, { runId: bridge, taskId: f.task });
  const result = recovery.reconcile(f.store, {
    mission_id: f.mission, request_id: randomUUID(), writer_pid: 999999, termination_verified: true,
    recovery_kind: 'writer_process_death', workspace_resource: f.dir
  }, quiet);
  assert.equal(result.accepted, false);
  assert.equal(result.recovery_not_execution, true);
  assert.equal(result.dispositions.length, 2);
  for (const row of result.dispositions) {
    assert.equal(row.termination_verified, true);
    assert.equal(row.process_state, 'exited');
    assert.equal(row.resolution, 'writer_death_in_process');
    assert.equal(row.accepted, false);
  }
  assert.equal(f.db.prepare("SELECT state FROM cp_leases WHERE run_id=?").get(host).state, 'released');
  const settled = f.store.invocation(request);
  assert.equal(settled.state, 'settled');
  assert.equal(settled.result.outcome, 'incomplete');
  assert.equal(settled.result.accepted, false);
  assert.equal(invocation.origin_event_id.length, 36);
  assert.equal(f.db.prepare("SELECT state FROM cp_missions WHERE id=?").get(f.mission).state, 'blocked');
  assert.equal(f.db.prepare("SELECT count(*) n FROM cp_runs WHERE id IN (?,?)").get(host, bridge).n, 2);
});

test('a live writer, recorded pid, or external run stays unresolved', t => {
  const f = fixture(t);
  const host = randomUUID();
  interrupt(f.store, host, f.mission, f.task, 'host');
  f.store.acquireLease({ resource: f.dir, runId: host, missionId: f.mission });
  assert.throws(() => recovery.reconcile(f.store, {
    mission_id: f.mission, request_id: randomUUID(), writer_pid: process.pid, termination_verified: true,
    recovery_kind: 'writer_process_death', workspace_resource: f.dir
  }, () => { const error = Error('writer_still_alive'); error.code = 'writer_still_alive'; throw error; }), /writer_still_alive/);
  f.db.prepare('UPDATE cp_runs SET pid=42 WHERE id=?').run(host);
  assert.throws(() => recovery.reconcile(f.store, {
    mission_id: f.mission, request_id: randomUUID(), writer_pid: 999999, termination_verified: true,
    recovery_kind: 'writer_process_death', workspace_resource: f.dir
  }, quiet), /recorded_pid/);
  assert.equal(f.store.run(host).termination_verified, 0);
});

test('identity validation stays bounded and still rejects a legacy correlation', t => {
  const f = fixture(t);
  const started = Date.now();
  for (let i = 0; i < 2000; i++) f.store.ledger.record({ eventType: 'run.started', agent: 'bridge', direction: 'internal', taskId: f.task, missionId: f.mission, metadata: { n: i } });
  identity.assertReadable(f.db);
  assert.ok(Date.now() - started < 3000);
  const bad = 'sha256:' + 'ab'.repeat(32);
  f.db.exec('DROP TRIGGER IF EXISTS control_ledger_no_update');
  f.db.prepare('UPDATE event_ledger_events SET request_id=? WHERE seq=(SELECT max(seq) FROM event_ledger_events)').run(bad);
  assert.throws(() => identity.assertReadable(f.db), /Legacy content-derived correlation/);
});
