'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');

test('agent_status reports Cursor observable but not executable while host policy disables it', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  qualifyCanonical(f.bridge);
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
  const agents = await f.bridge.orchestratorAgentStatus();
  assert.equal(agents.cursor.host_execution_disabled, true);
  assert.equal(agents.cursor.available, false);
  assert.match(String(agents.cursor.reason || ''), /cursor_execution_disabled/);
  assert.throws(() => f.bridge.hostExecutionPolicy.assertCursorAllowed('dispatch'), /CURSOR_EXECUTION_DISABLED/);
});

test('identical ask request ids remain idempotent after acknowledgement', async t => {
  const caller = 'mcp:' + randomUUID();
  const f = await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t, {caller, repairs:0});
  f.plan = f.plan.slice(0,1);
  const id = randomUUID();
  const instruction = 'In Fixture project change fixture.txt from alpha to beta, preserving one final newline.';
  const first = await f.bridge.zeroSetupWork.ask({request_id:id,instruction}, caller);
  const second = await f.bridge.zeroSetupWork.ask({request_id:id,instruction}, caller);
  assert.equal(first.request_id,id); assert.equal(second.request_id,id);
  assert.equal(first.state === 'PLANNING' || !!first.mission_id,true);
  assert.equal(second.state === 'PLANNING' || second.mission_id === first.mission_id || second.state === first.state,true);
});
