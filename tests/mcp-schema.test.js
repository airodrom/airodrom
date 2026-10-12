'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TOOLS, validate } = require('../src/mcp-tools');

function exchange(method, params) {
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'schema-regression', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method, params },
  ];
  const child = spawnSync(process.execPath, [path.join(__dirname, '../src/mcp.js')], {
    input: frames.map(frame => JSON.stringify(frame)).join('\n') + '\n',
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error || ''));
  const response = child.stdout.trim().split('\n').map(JSON.parse).find(frame => frame.id === 2);
  assert(response, 'Actual stdio server returned the requested response');
  assert.equal(response.error, undefined);
  return response.result;
}

test('actual stdio tools/list exposes the canonical tool catalog including zero-setup ask_airodrom', () => {
  const { tools } = exchange('tools/list', {});
  assert.deepEqual(tools.map(tool => tool.name), TOOLS.map(tool => tool.name));
  assert.ok(tools.some(tool => tool.name === 'ask_airodrom'));
  assert.ok(tools.some(tool => tool.name === 'list_authorized_scopes'));
  assert.equal(tools.length, 36);
  assert.deepEqual(tools, TOOLS);
  const schema = tools[0].inputSchema;
  assert.deepEqual(schema.required, ['description', 'message', 'request_id']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.acceptance_criterion.type, 'string');
  assert.equal(schema.properties.acceptance_criterion.maxLength, 500);
  assert.deepEqual(schema.properties.acceptance_mode.enum, ['incomplete_once']);
  assert.deepEqual(schema.properties.mission_mode.enum, ['orchestrator', 'reasoning_only']);
  assert.equal(schema.properties.capability_scopes.type, 'array');
  assert.deepEqual(schema.properties.capability_scopes.items.enum, ['repo', 'developer_environment', 'personal', 'mac_local', 'communications', 'calendar', 'system_readonly', 'web_read']);
  const args = { description: 'Schema validation', message: 'Validate the schema.', request_id: 'schema-validation' };
  assert.doesNotThrow(() => validate('create_task', args));
  assert.doesNotThrow(() => validate('create_task', { ...args, workspace: 'isolated', acceptance_mode: 'incomplete_once', acceptance_criterion: 'runtime:fresh-session-continuation' }));
  assert.throws(() => validate('create_task', { ...args, mission_mode: 'active_chat_local_smoke', workspace: 'isolated' }), /Invalid mission_mode/);
});

test('live create_task rejects an invalid acceptance pairing before creating task data', { skip: process.env.AIRODROM_MCP_VALIDATE_LIVE !== '1' }, () => {
  // Explicit opt-in: the running bridge validates this request but cannot create a task.
  const result = exchange('tools/call', { name: 'create_task', arguments: {
    description: 'Schema validation only', message: 'Validate only.', request_id: 'schema-validation-invalid-pair',
    workspace: 'isolated', acceptance_mode: 'incomplete_once', acceptance_criterion: 'invalid-fixture-criterion',
  } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, 'incomplete_once requires isolated workspace and acceptance_criterion runtime:fresh-session-continuation');
});
