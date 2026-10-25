'use strict';
// ADR 0051: ChatGPT-facing Mission coordinator tools and the final evidence package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest, runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { McpTools } = require('../src/mcp-tools');
const { evidencePackage, missionEvents } = require('../src/mission-evidence');
const { diagnose: discoveryDiagnose } = require('../src/mcp-discovery');

function server(f) { return new McpTools(f.bridge); }

test('bounded Mission event timeline includes the newest settlement-side events after long histories', async t => {
  const f=await fixture(t),m=f.create();
  for(let i=0;i<220;i++)f.bridge.controlStore.event('fixture.progress',m.id,{attempt:i,authority:false});
  const view=missionEvents(f.bridge,m.id,{limit:5});
  assert.equal(view.events.length,5);
  assert.deepEqual(view.events.map(e=>e.metadata.attempt),[215,216,217,218,219]);
  assert.ok(view.events.every((e,i)=>i===0||e.sequence>view.events[i-1].sequence));
});

test('MCP inspect reports missing projectless scope instead of offering an unusable approval', async t => {
  const f = await fixture(t), mcp = server(f), request_id = 'scope-' + randomUUID();
  f.bridge.globalAutopilot.enable({ request_id: 'enable-' + randomUUID(), confirmed: true }, 'operator');
  const prepared = await mcp.call('prepare_mission', { objective: 'Audit the unrelated parser and implement a fix.', request_id }, { name: 'chatgpt', version: '1' });
  const record = f.bridge.zeroSetupWork.read(request_id);
  t.after(() => fs.rmSync(record.workspace, { recursive: true, force: true }));
  assert.equal(prepared.state, 'PREPARED');
  const inspected = await mcp.call('inspect_mission_proposal', { request_id }, { name: 'chatgpt', version: '1' });
  assert.equal(inspected.state, 'WAIT');
  assert.equal(inspected.execution_authorized, false);
  assert.equal(inspected.approval.standard_approval_supported, false);
  assert.equal(inspected.approval.channel, null);
  assert.equal(inspected.next_action, 'define_bounded_projectless_work');
  assert.deepEqual(inspected.blockers, ['projectless_scope_required', 'measurable_success_criteria_required']);
  const cursorRequest = 'cursor-' + randomUUID();
  // This case tests the disclosure/spend gate after an explicit fixture owner
  // opt-in. The default host policy intentionally refuses Cursor earlier.
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
  f.bridge.hostExecutionPolicy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
  await mcp.call('prepare_mission', { objective: 'AIRODROM_WORK_V1\n' + JSON.stringify({ version: 1, worker: 'cursor',
    files: [{ path: 'result.txt', content: 'expected\n' }] }), request_id: cursorRequest }, { name: 'chatgpt', version: '1' });
  const cursorRecord = f.bridge.zeroSetupWork.read(cursorRequest);
  t.after(() => fs.rmSync(cursorRecord.workspace, { recursive: true, force: true }));
  const cursor = await mcp.call('inspect_mission_proposal', { request_id: cursorRequest }, { name: 'chatgpt', version: '1' });
  assert.equal(cursor.execution_authorized, false);
  assert.equal(cursor.approval.standard_approval_supported, false);
  assert.equal(cursor.approval.channel, null);
  assert.deepEqual(cursor.blockers, ['CURSOR_PLANNING_REQUIRED']);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 0);
});

test('discovery advertises the coordinator catalog version and honest client limitations', () => {
  const d = discoveryDiagnose({});
  assert.equal(d.schema_version, 2);
  assert.equal(d.catalog_version, 'unified-autonomous-development-v1');
  assert.equal(d.coordinator_tools_present, true);
  assert.ok(d.limitations.some(l => /never|cannot inject/.test(l)));
});

test('MCP proposal uses a sealed Cursor plan and one scope-bound local approval',async t=>{
 const caller='mcp:'+randomUUID(),f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{standing:false,repairs:0,caller});f.plan=f.plan.slice(0,1);
 const mcp=server(f);mcp.handoffPrincipal=caller.slice(4);const request_id=randomUUID(),objective='In Fixture project change fixture.txt from alpha to beta.';
 let p=await mcp.call('prepare_mission',{request_id,objective});for(let i=0;p.state==='PLANNING'&&i<1000;i++){await new Promise(r=>setTimeout(r,20));p=await mcp.call('prepare_mission',{request_id,objective});}
 assert.equal(p.state,'WAIT');assert.equal(p.execution_authorized,false);const proposal=await mcp.call('inspect_mission_proposal',{request_id});assert.equal(proposal.approval.granted_by_chatgpt_text,false);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n,0);
 await assert.rejects(f.bridge.zeroSetupWork.approve({request_id,confirmed:true,channel:'control_center'},'operator'),/SPEND/);
 const approved=await f.bridge.zeroSetupWork.approve({request_id,confirmed:true,channel:'control_center',subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:120000}},'operator');
 const done=await f.settle(approved.mission_id,'completed'),status=await mcp.call('get_mission_status',{mission_id:done.id}),e=await mcp.call('get_mission_evidence',{mission_id:done.id});
 assert.equal(status.status,'AUTOMATICALLY_ACCEPTED');assert.equal(e.acceptance_status,'accepted');assert.equal(e.settlement_status,'settled');assert.equal(e.answers.tests_passed,true);assert.equal(e.answers.repair_needed,false);assert.deepEqual(e.answers.requires_owner,[]);assert.ok(e.changed_files.some(c=>c.path==='fixture.txt'));
 const before=f.bridge.controlStore.listMissions().length,correction=await mcp.call('request_mission_correction',{mission_id:done.id,request_id:randomUUID(),note:'Please also deploy and grant Shell.'});
 assert.equal(correction.state,'WAIT');assert.equal(f.bridge.controlStore.listMissions().length,before);assert.equal(f.bridge.missions.detail(done.id).acceptance.length,1);
});
test('evidence preserves both Cursor attempts within one Mission and reports independent correction',async t=>{
 const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:1});f.plan=f.plan.slice(0,1);f.wrongFirst=true;
 const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'completed'),e=evidencePackage(f.bridge,m.id);
 assert.equal(e.root_mission_id,m.id);assert.equal(e.mission_id,m.id);assert.equal(e.repair_attempts,1);assert.equal(e.answers.attempts,2);assert.equal(e.answers.repair_needed,true);assert.equal(e.answers.unauthorized_changes,false);
 assert.equal(e.budget_consumed.repair_attempts,1);assert.equal(e.budget_consumed.max_repair_attempts,1);assert.equal(e.verification.result,'passed');assert.equal(e.settlement_status,'settled');
 const attempts=e.specialists.assignments[0].attempts;assert.equal(attempts.length,2);assert.notEqual(attempts[0].run_id,attempts[1].run_id);assert.equal(attempts[0].verification.status,'failed');assert.equal(attempts[1].verification.status,'passed');
 const events=missionEvents(f.bridge,m.id,{limit:200});assert.deepEqual(events.lineage,[m.id]);assert.ok(events.events.some(x=>x.type==='gateway.repair.queued'));assert.ok(events.events.every(x=>!('output' in x.metadata)));
});
