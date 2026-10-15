'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const local = require('../src/local-bootstrap');
const { interactive, waitConversation } = require('../src/interactive-cli');
const render = require('../src/assistant-render');

function fixture(t, request) {
  const calls = [], output = new PassThrough();
  let text = ''; output.on('data', chunk => text += chunk);
  t.mock.method(local, 'start', async () => ({ default_runtime: 'opencode' }));
  t.mock.method(local, 'attach', async () => ({ default_runtime: 'opencode', healthy: true, protocol: 'airodrom-local-v1' }));
  t.mock.method(local, 'request', async (home, route, body, options) => {
    calls.push({ route, body, options });
    return request(route, body, options);
  });
  return { calls, output, text: () => text };
}

test('TTY bracketed multiline paste keeps ordinary chat intact with a separate admission budget', async t => {
  const previousTerm = process.env.TERM; process.env.TERM = 'xterm';
  t.after(() => { if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm; });
  const f = fixture(t, (route, body) => {
    if (route === '/api/interactive/memory?query=name') return { items: [] };
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'session' };
    if (route === '/api/assistant/input') {
      assert.equal(body.message, 'Line one\nLine two\nLine three');
      return { kind: 'chat', conversation_id: 'session', turn_id: 'turn' };
    }
    return { state: 'completed', summary: 'Multiline received.' };
  });
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = v => { input.isRaw = v; };
  f.output.isTTY = true;
  const wait = needle => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.output.off('data', check); reject(Error('Expected synthetic output unavailable')); }, 3000);
    const check = () => { if (f.text().includes(needle)) { clearTimeout(timer); f.output.off('data', check); resolve(); } };
    f.output.on('data', check); check();
  });
  const running = interactive('synthetic', { input, output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  await wait('You › ');
  input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  input.write('\x1b[200~Line one\nLine two\nLine three\x1b[201~');
  await wait('Paste · 3 lines · Enter to send');
  assert.equal(f.calls.filter(c => c.route === '/api/assistant/input').length, 0);
  input.write('\r');
  await wait('Multiline received.');
  await new Promise(resolve => setImmediate(resolve));
  input.write('/quit\r');
  await running;
  const chat = f.calls.filter(c => c.route === '/api/assistant/input');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].body.message, 'Line one\nLine two\nLine three');
  assert.equal(chat[0].options.timeoutMs, 15000);
  assert.equal(input.listenerCount('data'), 0);
});

test('coalesced multiline paste without bracketed mode still admits ordinary chat', async t => {
  const previousTerm = process.env.TERM; process.env.TERM = 'xterm';
  t.after(() => { if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm; });
  const f = fixture(t, (route, body) => {
    if (route === '/api/interactive/memory?query=name') return { items: [] };
    if (route === '/api/assistant/conversation/session') return { conversation_id: 'session' };
    if (route === '/api/assistant/input') {
      assert.equal(body.message, 'alpha\nbeta');
      return { kind: 'chat', conversation_id: 'session', turn_id: 't' };
    }
    return { state: 'completed', summary: 'ok' };
  });
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = v => { input.isRaw = v; };
  f.output.isTTY = true;
  const wait = needle => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.output.off('data', check); reject(Error('Expected synthetic output unavailable')); }, 3000);
    const check = () => { if (f.text().includes(needle)) { clearTimeout(timer); f.output.off('data', check); resolve(); } };
    f.output.on('data', check); check();
  });
  const running = interactive('synthetic', { input, output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  await wait('You › ');
  input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  input.write('alpha\nbeta\n');
  await wait('Paste · 2 lines · Enter to send');
  assert.equal(f.calls.filter(c => c.route === '/api/assistant/input').length, 0);
  input.write('\r');
  await wait('ok');
  await new Promise(resolve => setImmediate(resolve));
  input.write('/quit\r');
  await running;
  assert.equal(f.calls.filter(c => c.route === '/api/assistant/input')[0].body.message, 'alpha\nbeta');
});

test('secure first-line paste still drops follow-up text before detached guide', async t => {
  const f = fixture(t, route => {
    if (route === '/api/interactive/memory?query=name') return { items: [] };
    throw Error('Private data must not reach service');
  });
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = v => { input.isRaw = v; };
  f.output.isTTY = true;
  let seen = false;
  t.mock.method(require('../src/personal-storage-guide'), 'guide', async options => {
    assert.equal(options.message, 'Hi Airo, save my mailbox number 818');
    assert.equal(input.listenerCount('data'), 0);
    seen = true;
    setImmediate(() => input.write('/quit\n'));
    return { state: 'cancelled' };
  });
  const running = interactive('synthetic', { input, output: f.output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  setImmediate(() => input.write('\x1b[200~Hi Airo, save my mailbox number 818\npasted-private-canary\n\x1b[201~'));
  await running;
  assert.equal(seen, true);
  assert.equal(f.calls.filter(c => c.route === '/api/assistant/input').length, 0);
  assert.doesNotMatch(f.text(), /pasted-private-canary/);
});

test('conversation timeout message keeps the CLI open and cancels the turn', async t => {
  const f = fixture(t, route => {
    if (route.includes('?')) return { state: 'running' };
    assert.equal(route, '/api/assistant/conversation/cancel');
    return { state: 'cancelled' };
  });
  const original = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = original; });
  const pending = waitConversation('synthetic', { conversation_id: 'c', turn_id: 't' });
  now += 130_001;
  await assert.rejects(pending, /timed out while waiting for the local model.*CLI is still open/);
  assert.equal(f.calls.at(-1).route, '/api/assistant/conversation/cancel');
});

test('waiting label becomes honest after a sustained local-model delay', () => {
  assert.match(render.waitingFrame({ elapsed: 1000, columns: 80, reduced: true }), /Thinking/);
  assert.match(render.waitingFrame({ elapsed: 21000, columns: 80, reduced: true }), /Still thinking/);
  assert.match(render.waitingFrame({ elapsed: 46000, columns: 80, reduced: true }), /Waiting on local model/);
});
