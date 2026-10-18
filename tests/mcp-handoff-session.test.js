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

test('natural Cursor intake crosses authenticated HTTP MCP; missing grant, session replay and foreign scope fail closed', async t => {
  const f = await fixture(t);
  const server = new (require('../src/control-server'))(f.bridge, { port: 0 });
  await server.start();
  t.after(() => server.close());
  const post = async (route, body, token = server.mcpToken) => {
    const response = await fetch(server.origin + route, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const request_id = randomUUID();
  const objective = 'Use Cursor only in a new disposable workspace to create exactly two files:\nalpha.txt: "alpha\\n"\nbeta.txt: "beta\\n"';
  const args = { request_id, objective };
  assert.equal((await call(server.port, 'invalid', 'prepare_mission', args)).status, 401);
  assert.match((await call(server.port, server.mcpToken, 'prepare_mission', args)).body.error, /Fresh authenticated/);
  const session = (await post('/api/mcp/session', {})).body.session_id;
  const prepared = await call(server.port, server.mcpToken, 'prepare_mission', args, session);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.state, 'PREPARED');
  assert.equal(prepared.body.execution_authorized, false);
  assert.equal(prepared.body.presentation.worker, 'cursor');
  assert.deepEqual(prepared.body.presentation.files, ['alpha.txt', 'beta.txt']);
  assert.equal(prepared.body.presentation.measurable, true);
  assert.deepEqual(prepared.body.blockers, ['scoped_external_disclosure_required', 'BLOCKED_SPEND_AUTHORIZATION']);
  const record = f.bridge.zeroSetupWork.read(request_id);
  t.after(() => fs.rmSync(record.workspace, { recursive: true, force: true }));
  assert.deepEqual(record.work_spec.files, [{ path: 'alpha.txt', content: 'alpha\n' }, { path: 'beta.txt', content: 'beta\n' }]);
  assert.deepEqual(fs.readdirSync(record.workspace).sort(), ['.git', 'TASK.md']);
  const approval = { request_id, confirmed: true, channel: 'control_center',
    subscription_execution: { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 10000 } };
  assert.equal((await post('/api/assistant/zero-setup/approve', approval)).status, 401, 'MCP bearer cannot become owner');
  assert.match((await post('/api/assistant/zero-setup/approve', { request_id, confirmed: true }, server.token)).body.error, /BLOCKED_SPEND_AUTHORIZATION/);
  assert.match((await call(server.port, server.mcpToken, 'prepare_mission', { ...args, subscription_execution: approval.subscription_execution }, session)).body.error, /Unknown tool argument/);
  assert.match((await call(server.port, server.mcpToken, 'prepare_mission', { ...args, objective: objective.replace('beta\\n', 'changed\\n') }, session)).body.error, /replay_mismatch/);
  // Decode and screen literal data too; escaping letters cannot bypass intake's
  // existing private-content gate. This value is synthetic, not a credential.
  const privateArgs = { request_id: randomUUID(), objective: objective.replace('alpha\\n', '\\u006dailbox number 123') };
  assert.match((await call(server.port, server.mcpToken, 'prepare_mission', privateArgs, session)).body.error, /Secrets and private identifiers/);
  assert.equal(f.bridge.zeroSetupWork.read(privateArgs.request_id), null);
  const other = (await post('/api/mcp/session', {})).body.session_id;
  assert.match((await call(server.port, server.mcpToken, 'prepare_mission', args, other)).body.error, /original authenticated/);
  server.mcpSessions.get(session).expires_at = Date.now() - 1;
  assert.match((await call(server.port, server.mcpToken, 'prepare_mission', args, session)).body.error, /Fresh authenticated/);
  server.mcpSessions.clear();
  assert.equal((await post('/api/mcp/session', { session_id: session })).body.session_id, session);
  const replay = await call(server.port, server.mcpToken, 'prepare_mission', args, session);
  assert.equal(replay.body.state, 'WAIT');
  assert.deepEqual(replay.body.blockers, prepared.body.blockers);
  assert.equal(f.bridge.zeroSetupWork.read(request_id).workspace, record.workspace);
  const inspect = await call(server.port, server.mcpToken, 'inspect_mission_proposal', { request_id }, session);
  assert.deepEqual(inspect.body.proposal.files, ['alpha.txt', 'beta.txt']);
  assert.equal(inspect.body.approval.standard_approval_supported, false);
  assert.equal(inspect.body.next_action, 'authorize_cursor_via_authenticated_local_api');
  for (const table of ['cp_missions', 'cp_mission_approvals', 'cp_subscription_invocations', 'cp_dispatches'])
    assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM ' + table).get().n, 0, table);
});

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
