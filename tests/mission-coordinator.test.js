'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { MissionCoordinator } = require('../src/mission-coordinator');

function fixture(options = {}) {
  const db = new DatabaseSync(':memory:');
  let now = 1000;
  const dispatched = [];
  const coordinator = new MissionCoordinator(db, {
    now: () => now,
    provider: options.provider || null,
    dispatchTaskB: options.dispatchTaskB || (async action => { dispatched.push(action); return { accepted: true, taskId: action.taskId }; })
  });
  return { db, coordinator, dispatched, setNow(value) { now = value; } };
}

test('SIMULATION: Task B waits for a fake-provider decision bound to Task A result', async t => {
  const result = 'Task A found exactly two local fixture files and recorded their hashes.';
  const { db, coordinator, dispatched } = fixture({ provider: {
    kind: 'fixture',
    async decide({ mission, taskA, simulation }) {
      assert.equal(simulation, true);
      assert.match(taskA.result, /exactly two local fixture files/);
      return {
        simulation: true, missionId: mission.missionId, eventId: taskA.eventId,
        taskBId: mission.taskBId, resultHash: taskA.resultHash,
        instructions: taskA.result.includes('exactly two') ? 'Verify both recorded hashes against the fixture files.' : 'Do not dispatch without expected evidence.'
      };
    }
  } });
  t.after(() => db.close());
  coordinator.register({ missionId: 'mission-roundtrip-001', taskAId: 'task-a-0001', taskBId: 'task-b-0001', expiresAt: 20_000 });
  assert.equal(dispatched.length, 0, 'Task B must not be dispatched before a decision');
  const event = coordinator.receiveTaskAResult({ missionId: 'mission-roundtrip-001', taskId: 'task-a-0001', sessionId: 'session-a-0001', eventId: 'event-a-0001', result, authenticated: true });
  await assert.rejects(coordinator.dispatch('decision-not-created'), /not found/);
  const decision = await coordinator.decide(event.eventId);
  assert.equal(decision.simulation, true);
  assert.equal(decision.resultHash, event.resultHash);
  assert.equal(dispatched.length, 0, 'Validation alone does not dispatch Task B');
  const action = await coordinator.dispatch(decision.decisionId);
  assert.equal(action.taskId, 'task-b-0001');
  assert.match(action.instructions, /Verify both recorded hashes/);
  assert.equal(dispatched.length, 1);
  await assert.rejects(coordinator.decide(event.eventId), /Duplicate mission decision/);
  await assert.rejects(coordinator.dispatch(decision.decisionId), /duplicate or already consumed/);
});

test('rejects unauthenticated, duplicate, cross-mission, stale, expired, and cancelled events or decisions', async t => {
  let now = 1000;
  const db = new DatabaseSync(':memory:');
  const coordinator = new MissionCoordinator(db, {
    now: () => now,
    provider: { kind: 'fixture', async decide({ mission, taskA, simulation }) { return { simulation, missionId: mission.missionId, taskBId: mission.taskBId, eventId: taskA.eventId, resultHash: taskA.resultHash, instructions: 'Verify the observed fixture result.' }; } },
    dispatchTaskB: async () => ({ accepted: true })
  });
  t.after(() => db.close());
  coordinator.register({ missionId: 'mission-reject-0001', taskAId: 'task-a-reject1', taskBId: 'task-b-reject1', expiresAt: 10_000 });
  coordinator.register({ missionId: 'mission-reject-0002', taskAId: 'task-a-reject2', taskBId: 'task-b-reject2', expiresAt: 10_000 });
  const base = { missionId: 'mission-reject-0001', taskId: 'task-a-reject1', sessionId: 'session-reject1', result: 'Observed fixture result.' };
  assert.throws(() => coordinator.receiveTaskAResult({ ...base, eventId: 'event-unauth-001', authenticated: false }), /Authenticated/);
  assert.throws(() => coordinator.receiveTaskAResult({ ...base, missionId: 'mission-reject-0002', eventId: 'event-cross-0001', authenticated: true }), /Cross-mission/);
  const first = coordinator.receiveTaskAResult({ ...base, eventId: 'event-stale-0001', authenticated: true });
  coordinator.receiveTaskAResult({ ...base, eventId: 'event-latest-001', authenticated: true });
  await assert.rejects(coordinator.decide(first.eventId), /Stale/);
  assert.throws(() => coordinator.receiveTaskAResult({ ...base, eventId: 'event-latest-001', authenticated: true }), /Duplicate/);
  const current = coordinator.db.prepare('SELECT event_id FROM autonomy_events WHERE event_id=?').get('event-latest-001');
  assert.ok(current);
  const decision = await coordinator.decide('event-latest-001');
  now = decision.expiresAt;
  await assert.rejects(coordinator.dispatch(decision.decisionId), /expired/);
  coordinator.cancel('mission-reject-0001');
  await assert.rejects(coordinator.decide('event-latest-001'), /cancelled/);
  await assert.rejects(coordinator.dispatch(decision.decisionId), /cancelled/);
});

test('rejects a forged provider response whose result hash or mission binding differs', async t => {
  const db = new DatabaseSync(':memory:');
  const coordinator = new MissionCoordinator(db, { provider: { kind: 'fixture', async decide({ mission, taskA, simulation }) { return { simulation, missionId: mission.missionId, taskBId: mission.taskBId, eventId: taskA.eventId, resultHash: 'not-the-result-hash', instructions: 'Forged decision' }; } } });
  t.after(() => db.close());
  coordinator.register({ missionId: 'mission-forge-0001', taskAId: 'task-a-forge1', taskBId: 'task-b-forge1', expiresAt: Date.now() + 60_000 });
  const event = coordinator.receiveTaskAResult({ missionId: 'mission-forge-0001', taskId: 'task-a-forge1', sessionId: 'session-forge1', eventId: 'event-forge-0001', result: 'Trusted local result', authenticated: true });
  await assert.rejects(coordinator.decide(event.eventId), /not bound/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM autonomy_decisions').get().n, 0);
});

test('rejects a cross-mission decision and a provider-reused decision ID', async t => {
  const db = new DatabaseSync(':memory:');
  let forgeMission = false;
  const coordinator = new MissionCoordinator(db, { provider: { kind: 'fixture', async decide({ mission, taskA, simulation }) { return { simulation, missionId: forgeMission ? 'different-mission-0001' : mission.missionId, taskBId: mission.taskBId, eventId: taskA.eventId, resultHash: taskA.resultHash, decisionId: 'fixed-decision-id-0001', instructions: 'Verify the specific observed result.' }; } } });
  t.after(() => db.close());
  coordinator.register({ missionId: 'mission-cross-0001', taskAId: 'task-a-cross001', taskBId: 'task-b-cross001', expiresAt: Date.now() + 60_000 });
  coordinator.register({ missionId: 'mission-cross-0002', taskAId: 'task-a-cross002', taskBId: 'task-b-cross002', expiresAt: Date.now() + 60_000 });
  const a = coordinator.receiveTaskAResult({ missionId: 'mission-cross-0001', taskId: 'task-a-cross001', sessionId: 'session-cross01', eventId: 'event-cross-0001', result: 'Result A', authenticated: true });
  forgeMission = true;
  await assert.rejects(coordinator.decide(a.eventId), /not bound/);
  forgeMission = false;
  const goodA = await coordinator.decide(a.eventId);
  const b = coordinator.receiveTaskAResult({ missionId: 'mission-cross-0002', taskId: 'task-a-cross002', sessionId: 'session-cross02', eventId: 'event-cross-0002', result: 'Result B', authenticated: true });
  await assert.rejects(coordinator.decide(b.eventId), /Duplicate or invalid mission decision/);
  assert.equal(coordinator.db.prepare('SELECT decision_id FROM autonomy_decisions WHERE mission_id=?').get('mission-cross-0001').decision_id, goodA.decisionId);
  assert.equal(coordinator.db.prepare('SELECT count(*) AS n FROM autonomy_decisions WHERE mission_id=?').get('mission-cross-0002').n, 0);
});

test('fixture provider reasoning is unavailable outside test mode', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const coordinator = new MissionCoordinator(db, { provider: { kind: 'fixture', async decide() { throw new Error('must not invoke'); } } });
  coordinator.register({ missionId: 'mission-test-mode-001', taskAId: 'task-a-testmode1', taskBId: 'task-b-testmode1', expiresAt: Date.now() + 60_000 });
  coordinator.receiveTaskAResult({ missionId: 'mission-test-mode-001', taskId: 'task-a-testmode1', sessionId: 'session-testmode1', eventId: 'event-testmode-001', result: 'Fixture evidence.', authenticated: true });
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(coordinator.decide('event-testmode-001'), /restricted to isolated test runs/); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
  assert.equal(db.prepare('SELECT count(*) AS n FROM autonomy_decisions').get().n, 0);
});
