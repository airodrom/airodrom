'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ProjectMemoryV2Adapter } = require('../src/project-memory-v2-adapter');
const { AuthorityStore } = require('../src/authority-store');
const { AuthorityMemory } = require('../src/authority-memory');
const { controlPlaneWrite } = require('../src/control-plane-api');

test('V2 forgetting is an authenticated operator control; MCP cannot invoke it', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const adapter = new ProjectMemoryV2Adapter({ db });
  adapter.initializeMission({ missionId: 'privacy-fixture', taskId: 'task-fixture', objective: 'Harmless memory fixture', workspace: '/private/tmp/privacy-fixture', scope: {} });
  const bridge = { projectMemoryV2: adapter, conversationEngine: { close: async () => {}, start: () => { throw Error('Privacy fixture cannot call inference'); } } };
  const ControlServer = require('../src/control-server');
  const server = new ControlServer(bridge, { port: 0, token: 'operator-dummy', mcpToken: 'mcp-dummy' });
  await server.start(); t.after(() => server.close());
  const post = (body, token) => fetch(server.origin + '/api/control-v2/project-memory-forget', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ mission_id: 'privacy-fixture' }, 'mcp-dummy')).status, 401);
  assert.ok(adapter.memory.latest('privacy-fixture'));
  assert.equal((await post({ mission_id: 'privacy-fixture', scope: 'all' }, 'operator-dummy')).status, 400);
  assert.equal((await post({ mission_id: 'privacy-fixture' }, 'operator-dummy')).status, 200);
  assert.equal((await post({ mission_id: 'privacy-fixture' }, 'operator-dummy')).status, 200);
  assert.equal(adapter.prepareForRecovery({ missionId: 'privacy-fixture' }).failureClass, 'fail_closed');
  assert.throws(() => controlPlaneWrite({}, 'project-memory-forget', { mission_id: 'privacy-fixture' }), /unavailable/);
});

test('governed forget revokes current packs but retains historical provenance without resurrection', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new AuthorityStore(db), memory = new AuthorityMemory(store);
  const candidate = memory.ingest({ session_id: 'dummy-session', chunk_id: 'dummy-chunk', timestamp: 1, speaker: 'operator', claim: 'No micro-prompts.', kind: 'personal_preference', subject_key: 'workflow.micro_prompts', value: 'forbidden' }, store.operator);
  const saved = memory.promote(candidate.id, {}, store.operator);
  const input = { operator_id: store.operatorId, include_personal: true };
  const pack = memory.build(input);
  assert.equal(pack.items.length, 1);
  memory.forget(saved.id, store.operator);
  assert.equal(memory.build(input).items.length, 0);
  assert.equal(memory.validatePack(pack.id, input).valid, false);
  assert.equal(memory.promote(candidate.id, {}, store.operator).status, 'forgotten');
  assert.equal(memory.ingest({ session_id: 'dummy-session', chunk_id: 'dummy-chunk', timestamp: 1, speaker: 'operator', claim: 'No micro-prompts.', kind: 'personal_preference', subject_key: 'workflow.micro_prompts', value: 'forbidden' }, store.operator).id, candidate.id);
  assert.equal(memory.build(input).items.length, 0);
  // Existing immutable history is explicit: forget is revocation, not erasure.
  assert.equal(memory.items(pack.id)[0].value, 'forbidden');
  assert.equal(memory.provenance(saved.id, store.operator).memory.status, 'forgotten');
  assert.equal(store.integrity().ok, true);
});
