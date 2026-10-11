'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Bridge = require('./fixtures/test-bridge.cjs');
const { McpTools, TOOLS } = require('../src/mcp-tools');

async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/airo-mcp-personal-memory-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new Bridge({
    defaultRuntime: 'host',
    dataDir: path.join(root, 'data'),
    sourceProfile: profile,
    executable: path.join(__dirname, 'fixtures/host-worker.cjs'),
    allowFixtureWorker: true
  }).initialize();
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const mcp = new McpTools(bridge, { origin: () => 'http://127.0.0.1:9', authenticatedConnection: () => ({ epoch: bridge.lifecycle.epoch, authenticatedAt: Date.now() }) });
  return { bridge, mcp };
}

test('MCP surface exposes read-only personal memory tools without write tools', () => {
  const names = TOOLS.map(tool => tool.name);
  assert.ok(names.includes('personal_memory_search'));
  assert.ok(names.includes('personal_memory_get'));
  assert.equal(names.includes('personal_memory_remember'), false);
  assert.equal(names.includes('personal_memory_forget'), false);
  assert.equal(TOOLS.find(t => t.name === 'personal_memory_search').annotations.readOnlyHint, true);
});

test('authenticated MCP personal memory search and get return ordinary items only', async t => {
  const { bridge, mcp } = await fixture(t);
  const remembered = bridge.personalMemory.remember({
    domain: 'personal', type: 'fact', subject: 'favorite tea', content: 'jasmine green', source: 'user_explicit'
  });
  bridge.personalMemory.remember({
    domain: 'personal', type: 'secret', subject: 'vault hint', content: 'do-not-expose', source: 'user_explicit', sensitivity: 'sensitive'
  });
  const search = await mcp.call('personal_memory_search', { query: 'tea' }, { name: 'fixture', version: '1' });
  assert.equal(search.authority, false);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].subject, 'favorite tea');
  assert.equal(search.items[0].content, 'jasmine green');
  assert.equal(search.items.some(i => /do-not-expose|vault/.test(JSON.stringify(i))), false);
  const got = await mcp.call('personal_memory_get', { memory_id: remembered.memoryId }, { name: 'fixture', version: '1' });
  assert.equal(got.item.memory_id, remembered.memoryId);
  assert.equal(got.authority, false);
  await assert.rejects(
    () => mcp.call('personal_memory_get', { memory_id: randomUUID() }, { name: 'fixture', version: '1' }),
    /unavailable/
  );
});
