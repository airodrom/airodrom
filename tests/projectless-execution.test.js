'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { CursorWorker } = require('../src/cursor-worker');
const sandbox = require('../src/projectless-sandbox');

test('projectless implementation lacks a sealed plan even under Expanded Auto',async t=>{
 const f=await fixture(t,{opencode:runtime(t).options});
 f.bridge.expandedAutonomy.setMode({mode:'expanded_auto',confirmed:true,request_id:randomUUID()},'operator');
 const request_id=randomUUID(),before=f.bridge.projects.listProjects().length;
 const asked=await f.bridge.zeroSetupWork.ask({request_id,instruction:'In a projectless task sandbox, change fixture.txt from alpha to beta.'},'operator');
 const record=f.bridge.zeroSetupWork.read(request_id);t.after(()=>fs.rmSync(record.workspace,{recursive:true,force:true}));
 assert.equal(asked.state,'BLOCKED');assert.equal(asked.code,'CURSOR_PLANNING_REQUIRED');assert.equal(asked.execution_authorized,false);
 assert.equal(f.bridge.projects.listProjects().length,before);assert.equal(f.bridge.controlStore.listMissions().length,0);
 assert.equal(fs.existsSync(path.join(record.workspace,'fixture.txt')),false);
});

test('historical failed projectless verification is not accepted', async t => {
  const rt = runtime(t);
  const f = await fixture(t, { opencode: rt.options, defaultRuntime: 'opencode' });
  const allocated = sandbox.allocate();
  sandbox.seedExactFixture(allocated.workspace);
  t.after(() => fs.rmSync(allocated.workspace, { recursive: true, force: true }));
  const input = sandbox.exactMissionInput(allocated.workspace, randomUUID());
  input.criteria = [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'wrong\n' }];
  const mission = f.bridge.missions.create(input, 'operator');
  await require('./fixtures/historical-opencode-fixture.cjs').completeHistoricalOpenCode(f,mission);
  const done = await f.settle(mission.id, 'needs_rework');
  assert.equal(done.acceptance.length, 0);
  assert.equal(done.verifications[0].result, 'failed');
});

test('cursor live execution stays blocked without spend authorization', async t => {
  const worker = new CursorWorker({});
  worker.readiness = async () => ({ ready: true, spend: 'UNKNOWN_SUBSCRIPTION' });
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/cursor-spend-'));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'alpha\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    worker.execute({ workspace: root, files: ['fixture.txt'], writable: ['fixture.txt'], objective: 'change fixture' }),
    /BLOCKED_SPEND_AUTHORIZATION/
  );
});
