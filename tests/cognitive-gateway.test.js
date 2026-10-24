'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setup: cursorFixture } = require('./fixtures/cursor-autonomy-fixture.cjs');
const G = require('../src/opencode-gateway');
const evidence = (f,id) => require('../src/mission-evidence').evidencePackage(f.bridge,id);
const worker = m => m.specialists.assignments[0].attempts.at(-1).run_id;
async function setup(t, options = {}) {
 const f = await cursorFixture(t, { repairs: 0, manual: true, ...options });
 f.plan = f.plan.slice(0,1);
 const ask=f.ask; f.ask=()=>ask({review:false});
 return f;
}
test('Cursor result returns to read-only OpenCode before handoff and survives reconnect',async t=>{
 const f=await setup(t),p=await f.ask();assert.ok(p.mission_id,JSON.stringify(p));const m=await f.settle(p.mission_id);
 assert.equal(f.evaluations.length,1);assert.equal(f.evaluations[0].worker.agent,'cursor');assert.ok(f.evaluations[0].worker.summary);
 const e=evidence(f,m.id);assert.equal(e.cognitive.counts.execution,1);assert.equal(e.gateway.evaluations[0].recommendation,'ready');assert.equal(e.gateway.evaluations[0].termination_verified,true);assert.equal(e.gateway.evaluations[0].provenance.sandbox,'fixture');
 const events=f.bridge.ledger.list({missionId:m.id,limit:200}).events.map(e=>e.event_type);assert.ok(events.indexOf('gateway.result_received')<events.indexOf('gateway.evaluated'));assert.ok(events.indexOf('gateway.evaluated')<events.indexOf('verification.completed'));
 assert.doesNotThrow(()=>G.assertAcceptance(f.bridge,f.bridge.controlStore.getMission(m.id),m.verifications[0]));await f.reopen();assert.deepEqual(evidence(f,m.id).gateway,e.gateway);
});
test('OpenCode cannot add authority to evaluation',async t=>{
 const f=await setup(t);f.evaluate=async o=>({...o.coordination.result_contract,authorization:'approved'});const p=await f.ask(),m=await f.settle(p.mission_id,'blocked');
 assert.equal(m.acceptance.length,0);assert.equal(G.receipt(f.bridge,m.id,worker(m)).state,'failed');assert.equal(f.calls.length,1);
});
test('Acceptance rejects a changed Cursor worker result',async t=>{
 const f=await setup(t),p=await f.ask(),m=await f.settle(p.mission_id),v=m.verifications[0];f.bridge.controlStore.db.prepare('UPDATE cp_run_results SET normalized=? WHERE run_id=?').run(JSON.stringify({summary:'forged replacement'}),v.run_id);
 assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:randomUUID(),verification_id:v.id,decision:'accept',rationale:'Reviewed',evidence:'Fixture only'}),/gateway_acceptance|gateway_.*changed/);
});
test('unavailable evaluation preserves Cursor result and reservation without worker replay after restart', async t => {
 const f=await setup(t);f.evaluate=async()=>{throw Error('evaluator unavailable');};const p=await f.ask(),m=await f.settle(p.mission_id,'blocked');
 const run=worker(m),receipt=G.receipt(f.bridge,m.id,run);assert.equal(receipt.state,'failed');assert.equal(f.evaluations.length,1);
 assert.equal(fs.readFileSync(path.join(m.envelope.workspace,'fixture.txt'),'utf8'),'beta\n');
 await f.reopen({beforeResume:()=>f.bindAdapter()});await f.bridge.missions.tick();
 assert.equal(G.receipt(f.bridge,m.id,run).id,receipt.id);assert.equal(f.calls.length,1);assert.equal(f.evaluations.length,1);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT missions_used n FROM cp_standing_cursor_development WHERE id=?').get(f.grant.id).n,1);
 assert.equal(f.bridge.missions.detail(m.id).acceptance.length,0);
});
test('sealed repair ceiling authorizes a distinct Cursor attempt with fresh host verification',async t=>{
 const f=await setup(t,{repairs:1});f.wrongFirst=true;const p=await f.ask(),m=await f.settle(p.mission_id),attempts=m.specialists.assignments[0].attempts;
 assert.equal(attempts.length,2);assert.notEqual(attempts[0].run_id,attempts[1].run_id);assert.equal(attempts[0].verification.status,'failed');assert.equal(attempts[1].verification.status,'passed');
 assert.equal(m.specialists.repair_attempts,1);assert.deepEqual(f.calls.map(c=>c.worker),['cursor','cursor']);assert.equal(f.evaluations.length,2);assert.equal(fs.readFileSync(path.join(m.envelope.workspace,'fixture.txt'),'utf8'),'beta\n');
 await f.bridge.missions.tick();assert.equal(f.calls.length,2);assert.equal(f.bridge.controlStore.listMissions().length,1);assert.equal(m.acceptance.length,0);
});
test('read-only worker choice cannot authorize edits',()=>{
 const R=require('../src/cognitive-router');for(const worker of ['opencode','cursor'])assert.throws(()=>R.route({requested_worker:worker,eligible_workers:[worker]},{files:['fixture.txt'],tasks:[{operation:'read'}]},[worker]),/readonly_worker_unsupported/);
});
test('governed Cursor fixture needs scoped approval when standing authority is absent; revocation blocks Acceptance',async t=>{
 const f=await setup(t,{standing:false}),p=await f.ask();assert.equal(p.state,'WAIT');
 await assert.rejects(f.bridge.zeroSetupWork.approve({request_id:p.request_id,confirmed:true,channel:'control_center'},'operator'),/SPEND/);
 const a=await f.bridge.zeroSetupWork.approve({request_id:p.request_id,confirmed:true,channel:'control_center',subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:120000}},'operator');const m=await f.settle(a.mission_id),v=m.verifications[0];
 assert.equal(f.evaluations[0].worker.agent,'cursor');f.bridge.developerAutonomy.revoke({policy_id:f.policy.policy_id,policy_hash:f.policy.policy_hash,confirmed:true},'operator');
 assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:randomUUID(),verification_id:v.id,decision:'accept',rationale:'Reviewed',evidence:'Fixture only'}),/revoked/);
});
test('non-ready evaluation prevents Acceptance while retaining passed host checks',async t=>{
 const f=await setup(t);f.evaluate=async o=>({...o.coordination.result_contract,recommendation:'blocked',summary:'An expected requirement is missing.'});const p=await f.ask(),m=await f.settle(p.mission_id,'needs_rework');
 assert.equal(m.specialists.assignments[0].attempts[0].verification.status,'passed');assert.equal(m.acceptance.length,0);assert.equal(f.calls.length,1);
});
test('uncertain evaluator retains quarantine without repeating Cursor execution',async t=>{
 const f=await setup(t);const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>child.kill('SIGKILL'));
 f.evaluate=async()=>{throw Error('uncertain evaluator');};const execute=f.bridge.opencodeAdapter.execute.bind(f.bridge.opencodeAdapter);f.bridge.opencodeAdapter.execute=async o=>{if(o.coordination)o.onStart({pid:child.pid});return execute(o);};const p=await f.ask(),m=await f.settle(p.mission_id,'blocked');
 assert.equal(m.runs.find(r=>r.result?.gateway).state,'termination_unverified');assert.ok(f.bridge.controlStore.db.prepare("SELECT 1 FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(m.id));assert.throws(()=>f.bridge.missions.queue(m.id));assert.equal(f.calls.length,1);
});
test('named unsupported specialists never silently fall back',()=>{
 for(const name of ['Codex','Claude Code'])assert.throws(()=>require('../src/cognitive-router').requestedWorker('Use '+name+' for this change'),/named_worker_unavailable/);
});
test('unavailable host verification remains on the attempt after failed evaluation and reconnect',async t=>{
 const f=await setup(t),verify=f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);f.bridge.missions.verifier.verify=async(...args)=>({...await verify(...args),status:'unavailable'});f.evaluate=async()=>{throw Error('evaluator unavailable');};
 const p=await f.ask(),m=await f.settle(p.mission_id,'blocked');assert.equal(m.specialists.assignments[0].attempts[0].verification.status,'unavailable');assert.equal(G.receipt(f.bridge,m.id,worker(m)).state,'failed');assert.equal(m.acceptance.length,0);
 await f.reopen();assert.equal(f.bridge.missions.detail(m.id).specialists.assignments[0].attempts[0].verification.status,'unavailable');
});
test('correction keeps its sealed root and root cancellation aborts the corrective Cursor worker', {timeout:90000}, async t=>{
 const f=await setup(t,{repairs:1}),b=f.bridge;f.wrongFirst=true;f.cursorMode='hang';let correctionSignal;
 const execute=b.cursorWorker.execute.bind(b.cursorWorker);b.cursorWorker.execute=o=>{if(f.calls.length===1)correctionSignal=o.signal;return execute(o);};
 const p=await f.ask();assert.ok(p.mission_id,JSON.stringify(p));for(let i=0;i<1800&&!correctionSignal;i++)await new Promise(r=>setTimeout(r,25));assert.ok(correctionSignal,'corrective worker started');
 const m=b.missions.detail(p.mission_id),attempts=m.specialists.assignments[0].attempts;assert.equal(attempts.length,2);assert.notEqual(attempts[0].run_id,attempts[1].run_id);assert.equal(attempts[0].verification.status,'failed');
 const R=require('../src/cognitive-router');assert.doesNotThrow(()=>R.assertBound(b,b.controlStore.requireMission(m.id)));
 for(const change of [x=>{x.envelope.cognitive.sealed.hash='0'.repeat(64);},x=>{x.envelope.cognitive.proposal.tasks[0].paths=['outside.txt'];},x=>{x.envelope.cognitive.repair_baseline={};}]){const altered=structuredClone(b.controlStore.requireMission(m.id));change(altered);assert.throws(()=>R.assertBound(b,altered));}
 b.missions.cancel(m.id,{request_id:randomUUID()},'operator');for(let i=0;i<200&&!correctionSignal.aborted;i++)await new Promise(r=>setTimeout(r,25));assert.equal(correctionSignal.aborted,true);
 await b.missions.tick();assert.equal(b.controlStore.requireMission(m.id).state,'cancelled');assert.equal(f.calls.length,2);assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n,0);
});
