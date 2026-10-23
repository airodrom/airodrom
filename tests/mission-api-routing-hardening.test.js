'use strict';
// Mission API integration: MCP catalog registration, chat→research fail-closed, conversation timeout class.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { TOOLS, McpTools } = require('../src/mcp-tools');
const { diagnose, advertisedCatalog } = require('../src/mcp-discovery');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { ConversationEngine } = require('../src/conversation-engine');
const router = require('../src/model-worker-router');

const COORDINATOR = [
  'prepare_mission', 'inspect_mission_proposal', 'get_mission_status', 'get_mission_events',
  'get_mission_evidence', 'request_mission_correction', 'cancel_mission', 'ask_airodrom', 'get_ask_status',
];

test('MCP catalog registers 53 tools including Mission coordinator surface', async () => {
  assert.equal(TOOLS.length, 53);
  const names = TOOLS.map(t => t.name);
  for (const name of COORDINATOR) assert.ok(names.includes(name), name);
  const d = diagnose({});
  assert.equal(d.catalog_version, 'unified-autonomous-development-v1');
  assert.equal(d.coordinator_tools_present, true);
  assert.equal(d.list_changed, true);
  const advertised = await advertisedCatalog();
  assert.equal(advertised.length, 53);
  assert.ok(advertised.some(t => t.name === 'prepare_mission'));
  assert.ok(advertised.some(t => t.name === 'get_mission_evidence'));
});

test('ask_airodrom rejects ordinary chat and public-research phrasing without preparing WORK', async t => {
  const f = await fixture(t);
  qualifyCanonical(f.bridge);
  const mcp = new McpTools(f.bridge);
  const chat = await mcp.call('ask_airodrom', { instruction: 'Hello, how are you?', request_id: 'req-' + randomUUID().replace(/-/g, '').slice(0, 20) }, { name: 'chatgpt', version: '1' });
  assert.equal(chat.state, 'CLARIFY');
  assert.equal(chat.execution_authorized, false);
  assert.match(chat.message, /conversation|Terminal|Control Center/i);
  const research = await mcp.call('prepare_mission', { objective: 'search the web for Canadian fintech competitors', request_id: 'req-' + randomUUID().replace(/-/g, '').slice(0, 20) }, { name: 'chatgpt', version: '1' });
  assert.equal(research.state, 'CLARIFY');
  assert.equal(research.execution_authorized, false);
  assert.match(research.message, /research|Terminal|WORK only/i);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
});

test('ConversationEngine refuses public-web offers and records provider_timeout distinctly', async t => {
  const f = await fixture(t);
  const packets = [];
  const engine = new ConversationEngine(f.bridge, {
    qualify: async () => ({ state: 'READY', model: router.MODEL }),
    request: async (_url, o) => {
      packets.push(JSON.parse(o.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello.' } }] }));
    },
  });
  t.after(() => engine.close());
  await assert.rejects(() => engine.start({ message: 'search the web for Canadian fintech competitors', request_id: randomUUID() }), /deterministic host workflow/);
  assert.equal(packets.length, 0);
  const OpenAI = require('../src/apps/openai-compatible-provider');
  const original = OpenAI.OpenAICompatibleProvider.prototype.execute;
  OpenAI.OpenAICompatibleProvider.prototype.execute = async () => ({
    status: 'failed', error_class: 'temporary_failure', code: 'timeout', text: null, tool_requests: [],
  });
  t.after(() => { OpenAI.OpenAICompatibleProvider.prototype.execute = original; });
  const turn = await engine.start({ message: 'Hi', request_id: randomUUID() });
  await engine.active.get(turn.turn_id)?.promise;
  const result = engine.result({ conversation_id: turn.conversation_id, turn_id: turn.turn_id });
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /timed out/i);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT safe_error_class FROM cp_conversation_turns WHERE id=?').get(turn.turn_id).safe_error_class, 'provider_timeout');
});
