'use strict';
process.env.NODE_ENV = 'test';
/** Real bounded Mission through create → dispatch → independent verify → host Acceptance. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { assertTransition } = require('../src/mission-lifecycle');

test('bounded Mission completes with independent verification and host-owned Acceptance', async (t) => {
  const f = await fixture(t);
  const m = f.create({
    criteria: [{ id: 'design', type: 'review', description: 'Operator reviews suitability' }]
  });
  assert.equal(m.state, 'ready');
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const done = await f.settle(m.id);
  assert.equal(done.state, 'awaiting_acceptance');
  assert.ok(done.verifications.length >= 1);
  assert.equal(done.verifications[0].result, 'operator_review');
  // Acceptance requires operator evidence; agents cannot self-accept.
  assert.throws(
    () => f.bridge.missions.accept(m.id, {
      request_id: randomUUID(),
      verification_id: done.verifications[0].id,
      decision: 'accept',
      rationale: 'Looks good'
    }),
    /evidence/
  );
  const accepted = f.bridge.missions.accept(m.id, {
    request_id: randomUUID(),
    verification_id: done.verifications[0].id,
    decision: 'accept',
    rationale: 'Reviewed exact fixture diff',
    evidence: 'Operator inspected fixture.txt and test receipt'
  });
  assert.equal(accepted.state, 'completed');
  assert.equal(f.bridge.controlStore.getMission(m.id).state, 'completed');
  assert.throws(() => assertTransition('completed', 'running'));
});

test('restart recovery preserves awaiting_acceptance Mission projection', async (t) => {
  const f = await fixture(t);
  const m = f.create({
    criteria: [{ id: 'design', type: 'review', description: 'Operator reviews suitability' }]
  });
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const done = await f.settle(m.id);
  assert.equal(done.state, 'awaiting_acceptance');
  await f.reopen();
  assert.equal(f.bridge.missions.detail(m.id).state, 'awaiting_acceptance');
  assert.equal(f.bridge.controlStore.getMission(m.id).state, 'awaiting_acceptance');
});
