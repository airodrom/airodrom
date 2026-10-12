'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { parse } = require('../src/assistant-intent');
const { submit } = require('../src/assistant-service');
const { guide, preview } = require('../src/zero-setup-terminal');

function terminal(lines) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  Object.defineProperty(input, 'isRaw', { get: () => true });
  const output = new PassThrough();
  output.isTTY = true;
  let text = '';
  output.on('data', chunk => { text += chunk.toString('utf8'); });
  setImmediate(() => { for (const line of lines) input.write(line); });
  return { input, output, text: () => text };
}

async function setup(t) {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  const project = f.bridge.projects.createProject({ name: 'Human Acceptance Exact File', repositories: [f.repo], privacyPolicy: 'local_only' });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const server = { bridge: f.bridge, conversationEngine: null, pendingResearch: new Map(), rememberInteractive() {}, interactiveMemory() { return { items: [] }; } };
  return { ...f, server };
}

test('natural-language change/verify intent routes to WORK without Mission draft forms', () => {
  const parsed = parse('Change the test file from alpha to beta, verify the result, and tell me when you\'re finished.');
  assert.equal(parsed.kind, 'work');
});

test('assistant submit prepares zero_setup WAIT and never creates a draft work_request Mission', async t => {
  const f = await setup(t);
  const request_id = randomUUID();
  const receipt = await submit(f.server, {
    message: 'Change the test file from alpha to beta, verify the result, and tell me when you\'re finished.',
    request_id,
    include_memory: true,
  });
  assert.equal(receipt.kind, 'zero_setup');
  assert.equal(receipt.state, 'WAIT');
  assert.equal(receipt.execution_authorized, false);
  assert.match(preview(receipt.presentation), /Human Acceptance Exact File/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
  const drafts = f.bridge.controlStore.listMissions({ owner: 'operator', limit: 50 }).filter(m => m.envelope?.kind === 'work_request');
  assert.equal(drafts.length, 0);
});

test('terminal y/N consent authorizes once; n cancels without writes', async t => {
  const f = await setup(t);
  const request_id = randomUUID();
  const prepared = await f.bridge.zeroSetupWork.ask({
    instruction: 'Change the test file from alpha to beta, verify the result, and tell me when finished.',
    request_id,
  }, 'operator');
  assert.equal(prepared.state, 'WAIT');
  const cancel = terminal(['n\r']);
  const cancelled = await guide({
    receipt: { kind: 'zero_setup', ...prepared },
    input: cancel.input,
    output: cancel.output,
    home: f.root,
    request: async (_home, route, body) => {
      if (route.endsWith('/reject')) return f.bridge.zeroSetupWork.reject(body, 'operator');
      throw Error('unexpected ' + route);
    },
  });
  assert.equal(cancelled.state, 'REJECTED');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');

  const request2 = randomUUID();
  const prepared2 = await f.bridge.zeroSetupWork.ask({
    instruction: 'Change the test file from alpha to beta, verify the result, and tell me when finished.',
    request_id: request2,
  }, 'operator');
  const yes = terminal(['y\r']);
  const calls = [];
  const done = await guide({
    receipt: { kind: 'zero_setup', ...prepared2 },
    input: yes.input,
    output: yes.output,
    home: f.root,
    request: async (_home, route, body) => {
      calls.push(route);
      if (route.endsWith('/approve')) {
        const approved = await f.bridge.zeroSetupWork.approve(body, 'operator');
        await f.settle(approved.technical.mission_id);
        return approved;
      }
      if (route.includes('/status')) return f.bridge.zeroSetupWork.refreshState(request2);
      throw Error('unexpected ' + route);
    },
  });
  assert.ok(calls.some(r => r.endsWith('/approve')));
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  assert.match(yes.text(), /Verification passed/);
  assert.match(yes.text(), /Working/);
  const missionId = done.technical.mission_id;
  assert.ok(missionId);
  assert.equal(f.bridge.missions.detail(missionId).acceptance.length, 0);
});

test('non-TTY cannot authorize bounded work', async t => {
  const f = await setup(t);
  const request_id = randomUUID();
  const prepared = await f.bridge.zeroSetupWork.ask({
    instruction: 'Change the test file from alpha to beta and verify it.',
    request_id,
  }, 'operator');
  const input = new PassThrough();
  const output = new PassThrough();
  await assert.rejects(guide({
    receipt: { kind: 'zero_setup', ...prepared },
    input,
    output,
    home: f.root,
    request: async () => { throw Error('must not approve'); },
  }), /interactive owner terminal/i);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
});
