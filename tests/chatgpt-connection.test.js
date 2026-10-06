'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chatgptConnection } = require('../src/chatgpt-connection');

test('authoritative tunnel states and safe discovery boundaries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tunnel-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const healthFile = path.join(dir, 'health.url');
  fs.writeFileSync(healthFile, 'http://127.0.0.1:12345\n', { mode: 0o600 });
  const probe = (channels, live = true) => async url => url.endsWith('/healthz')
    ? { ok: live, text: async () => 'live' }
    : { ok: true, json: async () => ({ channels, details: 'PRIVATE' }) };
  assert.deepEqual(await chatgptConnection({ healthFile, request: probe([{ name: 'main', enabled: true, probe_status: 'ok' }]) }),
    { state: 'connected', connected: true, tunnelHealthy: true, mcpProbe: 'ok' });
  for (const channels of [[], [{ name: 'main', enabled: false, probe_status: 'ok' }], [{ name: 'main', enabled: true, probe_status: 'error' }]]) {
    assert.equal((await chatgptConnection({ healthFile, request: probe(channels) })).state, 'degraded');
  }
  assert.equal((await chatgptConnection({ healthFile, request: probe([], false) })).state, 'not_connected');
  assert.equal((await chatgptConnection({ healthFile, request: async () => { throw Error('private'); } })).state, 'not_connected');
  assert.equal((await chatgptConnection({ healthFile, request: async url => {
    if (url.endsWith('/healthz')) return { ok: true, text: async () => 'live' };
    throw Error('private');
  } })).state, 'degraded');
  for (const address of ['https://example.com/', 'http://127.0.0.1:12345/?secret=x', 'http://user:pass@127.0.0.1:12345/']) {
    fs.writeFileSync(healthFile, address);
    assert.equal((await chatgptConnection({ healthFile, request: () => assert.fail('must not fetch') })).state, 'not_connected');
  }
  fs.unlinkSync(healthFile);
  assert.equal((await chatgptConnection({ healthFile })).state, 'not_connected');
});

test('actual UI renderer maps all tunnel states to badges', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const renderer = source.slice(source.indexOf('  function render() {'), source.indexOf('  async function poll()'));
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const [state, label] of [['connected', 'Connected'], ['degraded', 'Degraded'], ['not_connected', 'Not connected']]) {
    const labels = {}, elements = {};
    const context = { AirodromBranding: require('../src/branding'), state: { bridge: { healthy: true, chatgptConnection: { state } } }, online: true,
      text: (id, value) => { labels[id] = value; }, $: id => elements[id] ||= {}, time: () => '', bytes: () => '',
      renderTasks() {}, renderTask() {}, renderWeb() {}, renderControls() {} };
    vm.runInNewContext(renderer + '\nrender();', context);
    assert.equal(labels['chatgpt-status'], label);
    assert.equal(labels['chatgpt-badge'], `ChatGPT · ${label}`);
    for (const id of ['chatgpt-status', 'chatgpt-badge', 'chatgpt-description']) assert(html.includes(`id="${id}"`));
  }
});
