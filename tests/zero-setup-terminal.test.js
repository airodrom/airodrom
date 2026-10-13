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
const { guide, preview, poll, rememberActive, readActive, clearActive, resumeActive, isTransportError, resultText } = require('../src/zero-setup-terminal');

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

test('leading workspace phrasing still routes to WORK; ordinary questions stay conversational', () => {
  assert.equal(parse('In the prepared self-repair test workspace, change fixture.txt from alpha to beta.').kind, 'work');
  assert.equal(parse('Change fixture.txt from alpha to beta.').kind, 'work');
  assert.equal(parse('What is a Git repository?').kind, 'conversation');
  assert.equal(parse('How does automatic repair work?').kind, 'conversation');
  assert.equal(parse('Explain why verification can fail.').kind, 'conversation');
});

test('status transport failures reconnect to the same request_id without approving again', async t => {
  const requestId = randomUUID();
  let statusCalls = 0;
  let approveCalls = 0;
  const views = [
    Object.assign(new Error('fetch failed'), { name: 'TypeError' }),
    Object.assign(new Error('Local discovery ownership not healthy'), { name: 'Error' }),
    {
      kind: 'zero_setup',
      state: 'AWAITING_ACCEPTANCE',
      outcome: { mission_state: 'awaiting_acceptance', verification: { result: 'passed' } },
      presentation: { files: ['fixture.txt'], status: 'Repair completed' },
      technical: { request_id: requestId, mission_id: 'mission-repair', repair_of: 'mission-parent' },
      authority: false,
    },
  ];
  const done = await poll('/tmp/unused-home', requestId, {
    sleep: async () => {},
    request: async (_home, route) => {
      assert.match(route, new RegExp(encodeURIComponent(requestId)));
      statusCalls += 1;
      const next = views.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  assert.equal(statusCalls, 3);
  assert.equal(approveCalls, 0);
  assert.equal(done.technical.request_id, requestId);
  assert.equal(done.technical.repair_of, 'mission-parent');
  assert.match(resultText(done), /Repair completed/);
  assert.equal(isTransportError(Object.assign(new Error('fetch failed'), { name: 'TypeError' })), true);
});

test('remembered request identity resumes observation without creating a duplicate Mission', async t => {
  const f = await setup(t);
  const requestId = randomUUID();
  rememberActive(f.root, requestId);
  assert.equal(readActive(f.root).request_id, requestId);
  const output = new PassThrough();
  output.isTTY = true;
  let text = '';
  output.on('data', chunk => { text += chunk.toString('utf8'); });
  let statusCalls = 0;
  const resumed = await resumeActive(f.root, {
    input: new PassThrough(),
    output,
    request: async (_home, route) => {
      statusCalls += 1;
      assert.match(route, new RegExp(encodeURIComponent(requestId)));
      return {
        kind: 'zero_setup',
        state: 'AWAITING_ACCEPTANCE',
        outcome: { mission_state: 'awaiting_acceptance', verification: { result: 'passed' } },
        presentation: { files: ['fixture.txt'], status: 'Verified' },
        technical: { request_id: requestId, mission_id: 'mission-1' },
        authority: false,
      };
    },
  });
  assert.equal(statusCalls, 1);
  assert.equal(resumed.technical.request_id, requestId);
  assert.equal(readActive(f.root), null);
  assert.match(text, /Resuming observation of the same authorized task/);
  assert.match(text, /Verification passed/);
  clearActive(f.root);
});

test('poll keeps observing the same request_id through needs_rework until repair finishes or is blocked', async t => {
  const requestId = randomUUID();
  const views = [
    {
      kind: 'zero_setup',
      state: 'RUNNING',
      outcome: { mission_state: 'needs_rework', verification: { result: 'failed' } },
      presentation: { status: 'Verification failed; preparing automatic repair', files: ['fixture.txt'] },
      technical: { request_id: requestId, mission_id: 'parent-1' },
      authority: false,
    },
    {
      kind: 'zero_setup',
      state: 'RUNNING',
      outcome: { mission_state: 'running', verification: { result: 'failed' } },
      presentation: { status: 'Repairing failed verification', files: ['fixture.txt'] },
      technical: { request_id: requestId, mission_id: 'repair-1', repair_of: 'parent-1' },
      authority: false,
    },
    {
      kind: 'zero_setup',
      state: 'AWAITING_ACCEPTANCE',
      outcome: { mission_state: 'awaiting_acceptance', verification: { result: 'passed' } },
      presentation: { status: 'Repair completed. Verification passed', files: ['fixture.txt'] },
      technical: { request_id: requestId, mission_id: 'repair-1', repair_of: 'parent-1' },
      authority: false,
    },
  ];
  const done = await poll('/tmp/unused-home', requestId, {
    sleep: async () => {},
    request: async (_home, route) => {
      assert.match(route, new RegExp(encodeURIComponent(requestId)));
      return views.shift();
    },
  });
  assert.equal(views.length, 0);
  assert.equal(done.state, 'AWAITING_ACCEPTANCE');
  assert.equal(done.technical.repair_of, 'parent-1');
  assert.match(resultText(done), /Repair completed/);

  const blocked = await poll('/tmp/unused-home', requestId, {
    sleep: async () => {},
    request: async () => ({
      kind: 'zero_setup',
      state: 'BLOCKED',
      outcome: { mission_state: 'needs_rework', verification: { result: 'failed' } },
      presentation: { status: 'Automatic repair blocked (repair_budget)' },
      technical: { request_id: requestId, mission_id: 'parent-2', repair_blocked_reason: 'repair_budget' },
      authority: false,
    }),
  });
  assert.equal(blocked.state, 'BLOCKED');
  assert.match(resultText(blocked), /repair_budget/);
});


test('Terminal shows completion without requesting an extra Acceptance after preauthorization', () => {
  const view = {
    state: 'VERIFIED',
    outcome: { mission_state: 'completed', verification: { result: 'passed' } },
    presentation: { files: ['fixture.txt'], completion_policy: 'Preauthorized exact file' },
  };
  const shown = resultText(view);
  assert.match(shown, /completed under your earlier scoped approval/i);
  assert.doesNotMatch(shown, /Awaiting owner Acceptance/);
  const pending = resultText({
    ...view, state: 'AWAITING_ACCEPTANCE',
    outcome: { mission_state: 'awaiting_acceptance', verification: { result: 'operator_review' } },
  });
  assert.match(pending, /Awaiting owner Acceptance/);
});
