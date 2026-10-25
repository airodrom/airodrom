'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setup } = require('./fixtures/cursor-autonomy-fixture.cjs');

test('requested stages cannot raise the enrolled assignment ceiling or start preparation', async t => {
  const f = await setup(t, { repairs: 1 });
  let preparations = 0;
  const prepare = f.bridge.developerAutonomy.prepareWorkspaceAsync.bind(f.bridge.developerAutonomy);
  f.bridge.developerAutonomy.prepareWorkspaceAsync = (...args) => { preparations++; return prepare(...args); };
  const request = { request_id: randomUUID(), instruction: 'In Fixture project, use Cursor. Task A: Read fixture.txt. Task B: Read fixture.txt. Task C: Edit fixture.txt from alpha to beta. Task D: Read fixture.txt.' };
  let result = await f.bridge.zeroSetupWork.ask(request, 'operator');
  for (let i = 0; i < 300 && result.state === 'PLANNING'; i++) {
    await new Promise(r => setTimeout(r, 20));
    result = await f.bridge.zeroSetupWork.ask(request, 'operator');
  }
  assert.equal(result.state, 'BLOCKED', JSON.stringify(result));
  assert.ok(result.blockers.includes('cognitive_assignment_limit'), JSON.stringify(result));
  assert.equal(preparations, 0);
  assert.equal(f.calls.length, 0);
  const record = f.bridge.zeroSetupWork.read(request.request_id);
  assert.equal(record.cognitive.envelope, undefined);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_runs').get().n, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_subscription_invocations').get().n, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT missions_used n FROM cp_standing_cursor_development WHERE id=?').get(f.grant.id).n, 0);
  assert.equal(f.bridge.developerAutonomy.inspect(f.policy.policy_id).cognitive.max_assignments, 3);
});

test('historical envelopes above enrollment cannot acquire approval or dispatch', async t => {
  const f = await setup(t, { repairs: 0, standing: false });
  const result = await f.ask();
  assert.equal(result.state, 'WAIT', JSON.stringify(result));
  const record = f.bridge.zeroSetupWork.read(result.request_id);
  assert.equal(record.cognitive.envelope.limits.execution_attempts, 3);
  const C = require('../src/cognitive-contracts');
  record.cognitive.envelope = C.seal({ ...record.cognitive.envelope, limits: { ...record.cognitive.envelope.limits, execution_attempts: 4 } });
  record.cognitive.proposal.envelope_hash = record.cognitive.envelope.hash;
  f.bridge.zeroSetupWork.write(record.request_id, record.principal, record, 'awaiting_approval');
  await assert.rejects(f.bridge.zeroSetupWork.approve({ request_id: result.request_id, confirmed: true, channel: 'control_center', subscription_execution: { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 120000 } }, 'operator'), /cognitive_assignment_limit/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_subscription_invocations').get().n, 0);
  assert.equal(f.bridge.zeroSetupWork.read(result.request_id).mission_id, null);
});

test('explicit four-assignment enrollment retains four distinct ordered Cursor stages', async t => {
  const f = await setup(t, { assignments: 4, repairs: 1, standing: false });
  f.plan = ['read', 'read', 'edit', 'read'].map((operation, i) => ({
    id: 'stage_' + i, worker: 'cursor', role: operation === 'edit' ? 'implementation' : 'analysis',
    operation, paths: ['fixture.txt'], description: 'Perform authorized stage ' + i,
    depends_on: i ? ['stage_' + (i - 1)] : [], verification: [],
  }));
  const request = { request_id: randomUUID(), instruction: 'In Fixture project, use Cursor. Task A: Read fixture.txt. Task B: Read fixture.txt. Task C: Edit fixture.txt from alpha to beta. Task D: Read fixture.txt.' };
  let result = await f.bridge.zeroSetupWork.ask(request, 'operator');
  for (let i = 0; i < 300 && result.state === 'PLANNING'; i++) {
    await new Promise(r => setTimeout(r, 20));
    result = await f.bridge.zeroSetupWork.ask(request, 'operator');
  }
  assert.equal(result.state, 'WAIT', JSON.stringify(result));
  const c = f.bridge.zeroSetupWork.read(request.request_id).cognitive;
  assert.equal(c.envelope.limits.execution_attempts, 4);
  assert.equal(c.envelope.limits.repair_attempts, 1);
  assert.deepEqual(c.proposal.tasks.map(t => t.id), f.plan.map(t => t.id));
  assert.deepEqual(c.proposal.tasks.map(t => t.depends_on), [[], ['stage_0'], ['stage_1'], ['stage_2']]);
  assert.deepEqual(c.proposal.tasks.map(t => t.worker), ['cursor', 'cursor', 'cursor', 'cursor']);
  assert.deepEqual(c.proposal.tasks.map(t => t.operation), ['read', 'read', 'edit', 'read']);
  assert.equal(f.calls.length, 0);
});
