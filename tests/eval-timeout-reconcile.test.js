'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { reconcileBlockedEvaluation } = require('../src/opencode-gateway');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE cp_runs(id TEXT, mission_id TEXT, agent_id TEXT, state TEXT, termination_verified INTEGER, resolution TEXT, pid INTEGER);
    CREATE TABLE cp_leases(id TEXT, run_id TEXT, mission_id TEXT, resource TEXT, state TEXT);`);
  const mission = '11111111-1111-4111-8111-111111111111';
  const run = '22222222-2222-4222-8222-222222222222';
  db.prepare('INSERT INTO cp_runs VALUES(?,?,?,?,?,?,?)').run(run, mission, 'opencode', 'termination_unverified', 0, 'gateway_evaluation_reconciliation_required', 4242);
  db.prepare('INSERT INTO cp_leases VALUES(?,?,?,?,?)').run('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', mission, '/tmp/eval-reconcile-fixture', 'quarantined');
  const updates = [], events = [];
  const bridge = { controlStore: { db, updateRun(id, patch) { updates.push({ id, patch }); }, event(...args) { events.push(args); } } };
  return { db, bridge, mission: { id: mission, state: 'blocked' }, updates, events };
}

test('a dead timed-out evaluator releases quarantine and does not accept the Mission', () => {
  const { db, bridge, mission, updates, events } = fixture();
  const ok = reconcileBlockedEvaluation(bridge, mission, () => ({ writer_alive: false, workspace_holders: 0, method: 'test' }));
  assert.equal(ok, true);
  assert.equal(mission.state, 'blocked');
  assert.equal(updates[0].patch.state, 'failed');
  assert.equal(updates[0].patch.verified, true);
  assert.equal(updates[0].patch.result.accepted, false);
  assert.equal(db.prepare('SELECT state FROM cp_leases').get().state, 'released');
  assert.equal(events[0][0], 'gateway.evaluation_reconciled');
});

test('a live evaluator keeps the quarantined lease', () => {
  const { db, bridge, mission, updates } = fixture();
  const ok = reconcileBlockedEvaluation(bridge, mission, () => { const error = Error('writer_still_alive'); error.code = 'writer_still_alive'; throw error; });
  assert.equal(ok, false);
  assert.equal(updates.length, 0);
  assert.equal(db.prepare('SELECT state FROM cp_leases').get().state, 'quarantined');
});
