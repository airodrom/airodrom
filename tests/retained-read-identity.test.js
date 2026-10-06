'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite'), { randomUUID } = require('node:crypto');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore, fingerprint } = require('../src/control-plane-store');
const { HostReasoningAdmission } = require('../src/host-reasoning-admission');
const { MissionProgram } = require('../src/mission-program');
const { CodexAdapter } = require('../src/codex-adapter');
const identity = require('../src/memory-identity'), erasure = require('../src/memory-erasure');
const DENIED = /identity|migration|incomplete|propagation|stale|unavailable|erased/i;
function fixture(t, db = new DatabaseSync(':memory:')) {
  t.after(() => db.close());
  const store = new ControlPlaneStore({ db, ledger: new EventLedger(db) });
  const bridge = { controlStore: store, memory: { db } }, admission = new HostReasoningAdmission(bridge);
  const program = new MissionProgram({ db, store, bridge }), codex = new CodexAdapter(bridge);
  const missionId = randomUUID(), programId = randomUUID(), runId = randomUUID();
  const manifest = { version: 1, objective: 'fixture retained manifest canary' };
  store.requireMission = () => ({ envelope: { manifest } }); store.run = () => ({ mission_id: missionId });
  db.prepare('INSERT INTO host_reasoning_admissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), randomUUID(), missionId, randomUUID(), randomUUID(), randomUUID(), fingerprint({ fixture: true }), JSON.stringify({ context: 'fixture retained admission canary' }), 100, 'settled');
  db.prepare('INSERT INTO cp_mission_contracts VALUES(?,?,?,?,?)').run(missionId, JSON.stringify(manifest), fingerprint(manifest), null, 1);
  db.prepare('INSERT INTO cp_mission_programs VALUES(?,?,?,?,?,?,?,?)').run(programId, 'operator', JSON.stringify([{ id: randomUUID(), depends_on: [], objective: 'fixture retained graph canary' }]), fingerprint({ fixture: true }), 'waiting_acceptance', 1, 100, randomUUID());
  db.prepare('INSERT INTO cp_codex_handoffs VALUES(?,?,?,?,?,?)').run(runId, randomUUID(), JSON.stringify({ protocol: 'codex-handoff-v2', run_id: runId, objective: 'fixture retained handoff canary', context_pack: { records: [], refs: [], authority: false } }), 'awaiting_handoff', 1, 1);
  const reads = [() => admission.views(), () => program.contract(missionId), () => program.inspect(programId), () => codex.getTask(runId)];
  return { db, reads };
}
test('read surfaces expose fixture content only while its canonical generation is readable', t => {
  const f = fixture(t);
  assert.match(JSON.stringify(f.reads[0]()), /fixture retained admission canary/);
  assert.match(JSON.stringify(f.reads[1]()), /fixture retained manifest canary/);
  assert.match(JSON.stringify(f.reads[2]()), /fixture retained graph canary/);
  assert.match(JSON.stringify(f.reads[3]()), /fixture retained handoff canary/);
});
for (const state of ['pending', 'failed']) test(`retained admission, graph, manifest and handoff reads deny ${state} identity state`, t => {
  const f = fixture(t); identity.install(f.db); f.db.prepare('UPDATE memory_identity_progress SET state=? WHERE id=1').run(state);
  for (const read of f.reads) assert.throws(read, DENIED);
});
test('retained public reads deny pending content propagation even when all record IDs are opaque', t => {
  const f = fixture(t);
  erasure.mark(f.db, { store: 'personal', identity: randomUUID(), scope_hash: erasure.scopeHash(['fixture']), action: 'operator_erasure' });
  for (const read of f.reads) assert.throws(read, DENIED);
});
test('retained public reads reject an isolated recovery after its authoritative erasure generation advances', t => {
  const source = new DatabaseSync(':memory:'), recovery = new DatabaseSync(':memory:'); t.after(() => source.close());
  identity.migrate(source); identity.migrate(recovery, { sourceDb: source }); const f = fixture(t, recovery);
  for (const read of f.reads) assert.doesNotThrow(read);
  erasure.mark(source, { store: 'personal', identity: randomUUID(), scope_hash: erasure.scopeHash(['fixture']), action: 'forget' });
  for (const read of f.reads) assert.throws(read, DENIED);
});
