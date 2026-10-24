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

test('assistant submit reports unplanned zero_setup work and never creates a draft work_request Mission', async t => {
  const f = await setup(t);
  const request_id = randomUUID();
  const receipt = await submit(f.server, {
    message: 'Change the test file from alpha to beta, verify the result, and tell me when you\'re finished.',
    request_id,
    include_memory: true,
  });
  assert.equal(receipt.kind, 'zero_setup');
  assert.equal(receipt.state, 'BLOCKED');assert.equal(receipt.code,'CURSOR_PLANNING_REQUIRED');
  assert.equal(receipt.execution_authorized, false);
  assert.match(preview(receipt.presentation), /Human Acceptance Exact File/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
  const drafts = f.bridge.controlStore.listMissions({ owner: 'operator', limit: 50 }).filter(m => m.envelope?.kind === 'work_request');
  assert.equal(drafts.length, 0);
});

test('Terminal never requests approval for an unplanned or scope-gated request',async t=>{
 const f=await setup(t),request_id=randomUUID(),prepared=await f.bridge.zeroSetupWork.ask({instruction:'Change fixture.txt from alpha to beta.',request_id},'operator');
 for(const receipt of [{kind:'zero_setup',...prepared},{kind:'zero_setup',state:'WAIT',admission:{standard_approval_supported:false},message:'Scoped authorization required'}]){
  const io=terminal(['y\r']);let calls=0;const view=await guide({receipt,input:io.input,output:io.output,home:f.root,request:async()=>{calls++;throw Error('No approval supported');}});
  assert.equal(calls,0);assert.equal(view,receipt);assert.doesNotMatch(io.text(),/Approve this task/);
 }
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
});
test('non-TTY cannot submit an otherwise supported local confirmation',async t=>{
 const f=await setup(t);await assert.rejects(guide({receipt:{kind:'zero_setup',state:'WAIT',technical:{request_id:randomUUID()},admission:{standard_approval_supported:true}},input:new PassThrough(),output:new PassThrough(),home:f.root,request:async()=>{throw Error('must not approve');}}),/interactive owner terminal/i);
});
test('current cognitive terminal states stop polling and clear remembered requests',async t=>{
 const f=await setup(t),T=require('../src/zero-setup-terminal');
 for(const state of ['ACCEPTED','CANCELLED','NEEDS_REWORK']){
  const request_id=randomUUID(),view={kind:'zero_setup',state,cognitive:{version:3},request_id};rememberActive(f.root,request_id);
  let calls=0;const polled=await poll(f.root,request_id,{request:async()=>{calls++;return view;},sleep:async()=>{throw Error('Terminal state must not wait');}});assert.equal(polled,view);assert.equal(calls,1);assert.equal(T.isTerminalView(view),true);
  const io=terminal([]);await resumeActive(f.root,{input:io.input,output:io.output,request:async()=>view});assert.equal(readActive(f.root),null);
  if(state==='ACCEPTED')assert.match(io.text(),/Acceptance and settlement are recorded/);
 }
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
