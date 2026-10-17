'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { createClient } = require('../src/mcp-client');

async function call(port, token, name, args, session) {
  const response = await fetch('http://127.0.0.1:' + port + '/api/mcp/call', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(session ? { 'x-airodrom-session': session } : {}) },
    body: JSON.stringify({ name, args })
  });
  const body = await response.json();
  return { status: response.status, body };
}

test('ChatGPT prepare_mission obtains a fresh handoff session, rejects expiry and replay, and runs projectless OpenCode only under standing Expanded Auto', async t => {
  const f = await fixture(t, { opencode: runtime(t).options, defaultRuntime: 'opencode' });
  const server = new (require('../src/control-server'))(f.bridge, { port: 0 });
  await server.start();
  t.after(() => server.close());
  const data = f.bridge.dataDir;
  require('../src/local-bootstrap').writePrivate(path.join(data, 'mcp.json'), { port: server.port, token: server.mcpToken, pid: process.pid });
  const sessionFile = path.join(data, 'chatgpt-session.json');
  const client = createClient({ dataDir: data, sessionFile });
  const objective = 'In a projectless task sandbox, change fixture.txt from alpha to beta.';
  f.bridge.expandedAutonomy.setMode({ mode: 'manual', confirmed: true, request_id: randomUUID() }, 'operator');
  const missing = await call(server.port, server.mcpToken, 'prepare_mission', { objective, request_id: 'missing' + randomUUID().replace(/-/g, '') });
  assert.match(missing.body.error, /Fresh authenticated handoff session/);
  const held = await client('prepare_mission', { objective, request_id: 'held' + randomUUID().replace(/-/g, '').slice(0, 20) });
  assert.equal(held.execution_authorized, false);
  assert.equal(held.projectless, true);
  assert.equal(server.mcpSessions.size, 1);
  const sessionId = [...server.mcpSessions.keys()][0];
  server.mcpSessions.get(sessionId).expires_at = Date.now() - 1000;
  const expired = await call(server.port, server.mcpToken, 'prepare_mission', { objective, request_id: 'expired' + randomUUID().replace(/-/g, '').slice(0, 18) }, sessionId);
  assert.match(expired.body.error, /Fresh authenticated handoff session/);
  f.bridge.expandedAutonomy.setMode({ mode: 'expanded_auto', confirmed: true, request_id: randomUUID() }, 'operator');
  const request_id = 'run' + randomUUID().replace(/-/g, '').slice(0, 20);
  const refreshed = createClient({ dataDir: data, sessionFile });
  const started = await refreshed('prepare_mission', { objective, request_id });
  assert.equal(started.execution_authorized, true);
  assert.equal(started.projectless, true);
  assert.equal(started.state, 'DISPATCHED');
  t.after(() => fs.rmSync(started.workspace, { recursive: true, force: true }));
  const other = createClient({ dataDir: data });
  await assert.rejects(() => other('prepare_mission', { objective, request_id }), /original authenticated handoff session/);
  server.mcpSessions.clear();
  const resumed = createClient({ dataDir: data, sessionFile });
  const status = await resumed('get_mission_status', { mission_id: started.mission_id });
  assert.equal(status.mission_id, started.mission_id);
  const done = await f.settle(started.mission_id, 'completed');
  assert.equal(done.project_id, null);
  assert.equal(done.runs.some(run => run.agent_id === 'opencode'), true);
  assert.equal(done.verifications[0].result, 'passed');
  assert.equal(done.acceptance[0].decision, 'accept');
  assert.equal(fs.readFileSync(path.join(started.workspace, 'fixture.txt'), 'utf8'), 'beta\n');
});
