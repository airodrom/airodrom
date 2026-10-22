'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { McpTools } = require('../src/mcp-tools');

async function setup(t) {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  return f;
}

test('MCP enable/disable waits without owner delegation and never enrolls from chat', async t => {
  const f = await setup(t);
  const tools = new McpTools(f.bridge, { origin: () => 'test', authenticatedConnection: () => ({}) });
  tools.handoffPrincipal = randomUUID();
  const wait = await tools.call('enable_cursor_execution', { request_id: 'enroll_gate_' + randomUUID().slice(0, 8) });
  assert.equal(wait.state, 'WAIT');
  assert.equal(wait.code, 'MCP_HOST_EXECUTION_DELEGATION_REQUIRED');
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
  assert.equal(wait.cursor_execution_disabled, true);
});

test('owner-enrolled MCP delegation enables and disables without repeated Terminal confirms', async t => {
  const f = await setup(t);
  const policy = f.bridge.hostExecutionPolicy;
  assert.equal(policy.cursorDisabled(), true);
  const enrolled = policy.enrollMcpDelegation({ confirmed: true, request_id: randomUUID() }, 'operator');
  assert.equal(enrolled.mcp_delegation.enrolled, true);
  const again = policy.enrollMcpDelegation({ confirmed: true, request_id: randomUUID() }, 'operator');
  assert.equal(again.duplicate, true);
  assert.equal(again.mcp_delegation.id, enrolled.mcp_delegation.id);

  const tools = new McpTools(f.bridge, { origin: () => 'test', authenticatedConnection: () => ({}) });
  tools.handoffPrincipal = randomUUID();
  const enabled = await tools.call('enable_cursor_execution', { request_id: 'mcp_enable_' + randomUUID().slice(0, 8) });
  assert.equal(enabled.cursor_execution_disabled, false);
  assert.equal(policy.cursorDisabled(), false);
  const status = await tools.call('get_host_execution_policy', {});
  assert.equal(status.cursor_execution_disabled, false);
  assert.equal(status.mcp_delegation.enrolled, true);

  const disabled = await tools.call('disable_cursor_execution', { request_id: 'mcp_disable_' + randomUUID().slice(0, 8) });
  assert.equal(disabled.cursor_execution_disabled, true);
  assert.equal(policy.cursorDisabled(), true);

  const reenabled = await tools.call('enable_cursor_execution', { request_id: 'mcp_reenable_' + randomUUID().slice(0, 8) });
  assert.equal(reenabled.cursor_execution_disabled, false);

  policy.revokeMcpDelegation({ confirmed: true, request_id: randomUUID() }, 'operator');
  const blocked = await tools.call('disable_cursor_execution', { request_id: 'mcp_after_revoke_' + randomUUID().slice(0, 8) });
  assert.equal(blocked.state, 'WAIT');
  assert.equal(policy.cursorDisabled(), false);
});

test('chat text still cannot enroll delegation; operator path unchanged', async t => {
  const f = await setup(t);
  const policy = f.bridge.hostExecutionPolicy;
  assert.throws(
    () => policy.enrollMcpDelegation({ confirmed: true, request_id: randomUUID() }, 'mcp:' + randomUUID()),
    /authenticated local owner/
  );
  assert.throws(
    () => policy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'mcp:' + randomUUID()),
    /delegation required/
  );
  const enabled = policy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
  assert.equal(enabled.cursor_execution_disabled, false);
});
