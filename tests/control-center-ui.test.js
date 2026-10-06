'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function screen(taskOverrides = {}) {
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.listeners = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(type, fn) { this.listeners[type] = fn; }
  }
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const current = { id: 'fixture-task', description: 'UI fixture', status: 'idle', events: [], ...taskOverrides };
  const snapshot = { bridge: { healthy: true, chatgptConnection: { state: 'connected' } }, tasks: [current], approvals: [] };
  const requests = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), {
    AirodromBranding: require('../src/branding'),
    document: { getElementById: id => { assert(elements[id], `missing element ${id}`); return elements[id]; }, createElement: () => new Element(), createTextNode: text => ({ textContent: text }), addEventListener() {} },
    window: { location: { hash: '', pathname: '/', search: '' }, addEventListener() {} },
    sessionStorage: { getItem: key => key === 'piBridgeToken' ? 'a'.repeat(64) : current.id, setItem() {} },
    URLSearchParams, AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    fetch: async (route, options) => { requests.push({ route, method: options.method }); return { ok: true, text: async () => JSON.stringify(snapshot) }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['bridge-status'].textContent, 'Airodrom is healthy');
  assert.equal(elements['chatgpt-badge'].textContent, 'ChatGPT · Connected');
  return { elements, requests };
}

test('failed and provider-waiting tasks show honest status and suppress stale successful responses', async () => {
  for (const [status, label] of [['failed', 'Needs attention'], ['waiting_for_provider', 'Waiting for provider'], ['cancelled', 'Cancelled']]) {
    const { elements, requests } = await screen({ status, lastResult: 'OLD SUCCESS', error: 'Fixture failure' });
    assert.equal(elements['task-status'].textContent, label);
    assert(!elements['last-response'].textContent.includes('OLD SUCCESS'));
    assert(!elements['last-response'].textContent.includes('Send a message'));
    assert(requests.every(r => r.method === 'GET'));
  }
});

test('safety stop prevents prompt submission while keeping explicit review available', async () => {
  const { elements, requests } = await screen({ status: 'failed', safetyStop: { latched: true, reason: 'Fixture protected edit' } });
  assert.equal(elements['send-prompt'].disabled, true);
  assert.equal(elements['resolve-stop'].hidden, false);
  assert.equal(elements['resolve-stop'].disabled, false);
  assert.match(elements['last-response'].textContent, /safety boundary/);
  assert.match(elements['task-status'].className, /error/);
  assert(requests.every(r => r.method === 'GET'));
});

test('active turn shows current activity instead of its previous result; completed turn shows its response', async () => {
  const running = await screen({ status: 'thinking', busy: true, lastResult: 'OLD SUCCESS', events: [{ type: 'tool_execution_start', toolName: 'read', at: Date.now() }] });
  assert.match(running.elements['last-response'].textContent, /runtime is working/);
  assert.equal(running.elements['activity-list'].children.length, 1);
  assert.equal(running.elements['activity-list'].children[0].children[0].textContent, 'Action started · read');
  const completed = await screen({ status: 'completed', lastResult: 'CURRENT RESPONSE' });
  assert.equal(completed.elements['last-response'].textContent, 'CURRENT RESPONSE');
  assert.equal(completed.elements['send-prompt'].disabled, false);
});

 test('Task Health displays status, score and objective runtime facts', async () => {
 const {elements}=await screen({health:{status:'Possibly Stalled',score:60,processState:'alive',leaseState:'held',elapsedMs:90000,budgetMs:300000,reasons:['no_recent_progress'],active:true}});
 assert.equal(elements['heartbeat-value'].textContent,'Possibly Stalled · 60%');
 assert.match(elements['heartbeat-detail'].textContent,/Process: alive · Lease: held/);
 });
