'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize, assertTransition, project, ALIASES, TRANSITIONS } = require('../src/mission-lifecycle');
const { fixture } = require('./fixtures/mission-fixture.cjs');

test('historical aliases canonicalize to one authoritative vocabulary', () => {
  assert.equal(canonicalize('verification'), 'verifying');
  assert.equal(canonicalize('awaiting_orchestrator_acceptance'), 'awaiting_acceptance');
  assert.equal(canonicalize('waiting_for_agent'), 'waiting_for_operator');
  assert.equal(project('verification').state, 'verifying');
  assert.equal(project('verification').aliased, true);
  for (const alias of Object.keys(ALIASES)) assert.ok(TRANSITIONS[canonicalize(alias)]);
});

test('assertTransition accepts alias endpoints and rejects illegal moves', () => {
  assert.deepEqual(assertTransition('running', 'verification'), { from: 'running', to: 'verifying' });
  assert.deepEqual(assertTransition('verification', 'awaiting_orchestrator_acceptance'), {
    from: 'verifying',
    to: 'awaiting_acceptance'
  });
  assert.throws(() => assertTransition('completed', 'running'));
  assert.throws(() => assertTransition('cancelled', 'ready'));
});

test('control-plane store persists canonical state for aliased writes', async (t) => {
  const f = await fixture(t);
  const m = f.create();
  f.bridge.controlStore.state(m.id, 'dispatching');
  f.bridge.controlStore.state(m.id, 'running');
  const paused = f.bridge.controlStore.state(m.id, 'paused', 'operator pause fixture');
  assert.equal(paused.state, 'paused');
  f.bridge.controlStore.state(m.id, 'ready');
  f.bridge.controlStore.state(m.id, 'dispatching');
  f.bridge.controlStore.state(m.id, 'running');
  const verifying = f.bridge.controlStore.state(m.id, 'verification');
  assert.equal(verifying.state, 'verifying');
  assert.equal(verifying.state_raw, 'verifying');
  const row = f.bridge.controlStore.db.prepare('SELECT state FROM cp_missions WHERE id=?').get(m.id);
  assert.equal(row.state, 'verifying');
});
