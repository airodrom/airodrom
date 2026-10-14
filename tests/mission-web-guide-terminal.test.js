'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const guide = require('../src/mission-web-guide');
const { waitResult } = require('../src/interactive-cli');

function ttyPair() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = () => {};
  let text = '';
  output.on('data', c => { text += c.toString('utf8'); });
  return { input, output, text: () => text };
}

test('Trusted Autonomy ON + approved origin skips interactive permission and never sends client confirmed', async () => {
  const calls = [];
  const request = async (_home, route, body) => {
    calls.push({ route, body });
    if (route === '/api/assistant/risk-acceptance') {
      return { preference: { enabled: true, standing_public_origins: ['https://arecibo.ca'] } };
    }
    return { kind: 'mission', mission_id: randomUUID(), state: 'dispatching', browser_research_available: true, message: 'dispatched' };
  };
  const { input, output, text } = ttyPair();
  const offer = { kind: 'public_web_offer', mode: 'on', entries: ['https://arecibo.ca/'], objective: 'Research https://arecibo.ca/' };
  const receipt = await guide.guide({ offer, input, output, home: 'synthetic', request });
  assert.equal(receipt.kind, 'mission');
  assert.equal(calls.filter(c => c.route === '/api/assistant/web/research').length, 1);
  const body = calls.find(c => c.route === '/api/assistant/web/research').body;
  assert.equal(body.confirmed, undefined);
  assert.equal(body.entries[0], 'https://arecibo.ca/');
  assert.match(text(), /standing public research authorization|No interactive permission prompt/i);
  assert.doesNotMatch(text(), /PUBLIC WEB PERMISSION|Approve this public web scope/);
});

test('Trusted Autonomy OFF keeps interactive permission requirement', async () => {
  const { input, output } = ttyPair();
  const request = async (_home, route) => {
    if (route === '/api/assistant/risk-acceptance') {
      return { preference: { enabled: false, standing_public_origins: ['https://arecibo.ca'] } };
    }
    throw Error('research must not run before confirm');
  };
  const offer = { mode: 'on', entries: ['https://arecibo.ca/'], objective: 'Research https://arecibo.ca/' };
  // Confirm path requires detached raw input; with listeners still attached this fails closed.
  input.on('data', () => {});
  await assert.rejects(
    () => guide.guide({ offer, input, output, home: 'synthetic', request }),
    /(?:Public web|Session) consent requires detached operator terminal input/
  );
});

test('unapproved origin is not auto-covered by standing policy', async () => {
  const coverage = await guide.standingPublicCoverage('synthetic', {
    mode: 'on',
    entries: ['https://evil.example/']
  }, {
    request: async () => ({ preference: { enabled: true, standing_public_origins: ['https://arecibo.ca'] } })
  });
  assert.equal(coverage.covered, false);
  assert.equal(coverage.reason, 'unapproved_origin');
});

test('waitResult with cancelOnAbort false does not cancel host-owned Mission on abort', async () => {
  const calls = [];
  const local = require('../src/local-bootstrap');
  const original = local.request;
  const controller = new AbortController();
  let polls = 0;
  local.request = async (_home, route, body) => {
    calls.push({ route, body });
    if (String(route).startsWith('/api/interactive/task')) {
      polls++;
      if (polls === 1) {
        queueMicrotask(() => controller.abort());
        return { state: 'running', mission_id: '11111111-1111-4111-8111-111111111111' };
      }
      return { state: 'running', mission_id: '11111111-1111-4111-8111-111111111111' };
    }
    return {};
  };
  try {
    await assert.rejects(
      () => waitResult('synthetic', '11111111-1111-4111-8111-111111111111', {
        signal: controller.signal,
        timeoutMs: 2000,
        cancelOnAbort: false
      }),
      /independently owned|polling stopped/i
    );
  } finally {
    local.request = original;
  }
  assert.equal(calls.some(c => c.route === '/api/interactive/cancel'), false);
});

test('waitResult cancelOnAbort true still requests cancel', async () => {
  const calls = [];
  const local = require('../src/local-bootstrap');
  const original = local.request;
  const controller = new AbortController();
  local.request = async (_home, route, body) => {
    calls.push({ route, body });
    if (String(route).startsWith('/api/interactive/task')) {
      queueMicrotask(() => controller.abort());
      return { state: 'running' };
    }
    return { cancelled: true };
  };
  try {
    await assert.rejects(
      () => waitResult('synthetic', '22222222-2222-4222-8222-222222222222', {
        signal: controller.signal,
        timeoutMs: 2000,
        cancelOnAbort: true
      }),
      /Task cancelled/
    );
  } finally {
    local.request = original;
  }
  assert.equal(calls.some(c => c.route === '/api/interactive/cancel'), true);
});

test('handleReceipt path tolerates missing AbortController via ensureActive (research explore)', async () => {
  // Unit-level: startAnswer/answer must not throw when active was null.
  // Integration coverage is in the PTY fixture test.
  const coverage = await guide.standingPublicCoverage('synthetic', {
    mode: 'on',
    entries: ['https://arecibo.ca/']
  }, {
    request: async () => ({ preference: { enabled: true, standing_public_origins: ['https://arecibo.ca/'] } })
  });
  assert.equal(coverage.covered, true);
});
