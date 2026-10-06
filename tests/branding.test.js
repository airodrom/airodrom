'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const BRANDING = require('../src/branding');
const { McpStdio } = require('../src/mcp-stdio');

test('browser identity loads under CSP and updates text and accessible names from shared metadata', () => {
  const title = { dataset: { brand: 'controlCenter' }, textContent: '' };
  const link = { dataset: { brandLabel: 'controlCenter' }, setAttribute(key, value) { this[key] = value; } };
  const context = { document: { readyState: 'complete', querySelectorAll: selector => selector === '[data-brand]' ? [title] : [link] } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/branding'), 'utf8'), context);
  assert.equal(context.AirodromBranding.name, BRANDING.name);
  assert.equal(title.textContent, 'Airodrom Control Center');
  assert.equal(link['aria-label'], title.textContent);
  assert(Object.isFrozen(context.AirodromBranding));
});

test('rebrand retains package entry points and immutable legacy MCP identity', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.name, 'airodrom');
  assert.equal(pkg.main, 'src/bridge-controller.js');
  assert.equal(require('airodrom/branding'), BRANDING);
  assert.equal(require('airodrom/sdk'), require('../src/sdk'));
  assert(Object.isFrozen(BRANDING));
  assert.equal(BRANDING.legacyMcpName, 'pi-chatgpt-bridge');
});

test('MCP initialization displays Airodrom without changing its stable client identity', async () => {
  const transport = new McpStdio({ tools: [], callTool: async () => { throw Error('unexpected dispatch'); } });
  const result = await transport.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'branding-fixture', version: '1' }
  } });
  assert.equal(result.result.serverInfo.name, 'pi-chatgpt-bridge');
  assert.equal(result.result.serverInfo.title, 'Airodrom');
});

test('CLI help/version and invalid commands do not start a service', () => {
  const { spawnSync } = require('node:child_process');
  const cli = require.resolve('../scripts/airodrom.cjs');
  for (const args of [['--help'], ['--version'], ['unknown']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, args[0] === 'unknown' ? 2 : 0);
    assert.match(result.stdout + result.stderr, /Airodrom/);
    if (args[0] === '--help') assert.match(result.stdout, /https:\/\/airodrom.io/);
  }
});
