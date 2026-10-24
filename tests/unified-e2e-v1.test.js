'use strict';
// Current MCP intake → standing authorization → planned Cursor assignment →
// independent failure → separate correction → evaluation → host settlement.
// Cursor child processes and host checks are real; model responses are synthetic.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {setup}=require('./fixtures/cursor-autonomy-fixture.cjs');
const {McpTools}=require('../src/mcp-tools');
const terminal=require('../src/zero-setup-terminal');
test('MCP end-to-end self-repair uses one standing reservation, separate Cursor correction and durable settlement across reconnect',async t=>{
 const caller='mcp:'+randomUUID(),f=await setup(t,{repairs:1,caller});f.plan=f.plan.slice(0,1);f.wrongFirst=true;
 const mcp=new McpTools(f.bridge);mcp.handoffPrincipal=caller.slice(4);
 const request_id=randomUUID(),objective='In Fixture project change fixture.txt from alpha to beta and verify it.';
 const snapshots=[],evaluate=f.evaluate;
 f.evaluate=async o=>{snapshots.push({bytes:fs.readFileSync(path.join(o.workspace,'fixture.txt')).toString('hex'),checks:o.coordination.host_checks});return evaluate(o);};
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt')).toString('hex'),'616c7068610a');
 let prepared=await mcp.call('prepare_mission',{objective,request_id},{name:'chatgpt',version:'1'});
 for(let n=0;prepared.state==='PLANNING'&&n<2000;n++){await new Promise(r=>setTimeout(r,20));prepared=await mcp.call('prepare_mission',{objective,request_id},{name:'chatgpt',version:'1'});}
 assert.ok(prepared.mission_id,JSON.stringify(prepared));terminal.rememberActive(f.root,request_id);
 const mission=f.bridge.controlStore.requireMission(prepared.mission_id);assert.equal(mission.envelope.preferred_agent,'cursor');assert.deepEqual(mission.envelope.fallback_agents,[]);assert.ok(mission.envelope.cognitive.sealed);
 const replay=await mcp.call('prepare_mission',{objective,request_id});assert.equal(replay.mission_id,mission.id);
 // No polling/answer or second approval is needed while the control plane works.
 await new Promise(r=>setTimeout(r,300));const done=await f.settle(mission.id,'completed');
 const attempts=done.specialists.assignments[0].attempts;assert.equal(attempts.length,2);assert.notEqual(attempts[0].run_id,attempts[1].run_id);
 assert.equal(attempts[0].verification.status,'failed');assert.equal(attempts[1].verification.status,'passed');
 assert.deepEqual(snapshots.map(s=>s.bytes),['67616d6d610a','626574610a']);assert.ok(snapshots[0].checks.some(c=>c.id==='task:fixture-test'&&c.status==='failed'));assert.ok(snapshots[1].checks.every(c=>c.status==='passed'));
 assert.deepEqual(f.calls.map(c=>c.worker),['cursor','cursor']);assert.equal(done.specialists.repair_attempts,1);assert.equal(f.evaluations.length,2);
 const evidence=await mcp.call('get_mission_evidence',{mission_id:mission.id});assert.equal(evidence.acceptance_status,'accepted');assert.equal(evidence.settlement_status,'settled');
 assert.equal(done.acceptance.length,1);assert.equal(f.bridge.controlStore.listMissions().length,1);assert.equal(done.state,'completed');
 const db=f.bridge.controlStore.db;assert.equal(db.prepare('SELECT missions_used n FROM cp_standing_cursor_development WHERE id=?').get(f.grant.id).n,1);
 assert.equal(db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(mission.id).n,0);
 for(const attempt of attempts)for(const runId of [attempt.run_id,attempt.evaluation_run_id])assert.equal(f.bridge.controlStore.run(runId).termination_verified,1);
 assert.ok(done.dispatches.every(d=>d.state==='settled'));
 await f.reopen({beforeResume:()=>f.bindAdapter()});const reconnect=new McpTools(f.bridge);reconnect.handoffPrincipal=caller.slice(4);
 const again=await reconnect.call('prepare_mission',{objective,request_id});assert.equal(again.mission_id,mission.id);assert.equal(f.calls.length,2);assert.equal(f.bridge.missions.detail(mission.id).acceptance.length,1);
});
