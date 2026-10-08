'use strict';
// Explicit opt-in only: real vendor CLI, disposable public repo/state, real host
// broker/verifier/Acceptance. Never run by the ordinary fixture test glob.
if(process.env.AIRODROM_CODEX_LIVE!=='1'||process.env.NODE_ENV==='test')throw Error('Explicit live qualification outside fixture discovery required');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs'),ControlServer=require('../src/control-server'),worker=require('../src/bounded-worker');
const model='gpt-6.1-sol';
test('LIVE Codex proposal, scoped MCP Mission, independent verification, explicit Acceptance/Settlement and cancellation',async t=>{
 const f=await fixture(t,{workers:{codex:{}},settleTimeoutMs:120000}),b=f.bridge;b.missionAuthority.initializeOperatorKey();const canonical=require('./fixtures/opencode-fixture.cjs').qualifyCanonical(b);
 const q=await b.workers.qualify('codex',{confirmed:true,model,request_id:randomUUID()});assert.equal(q.state,'qualified');assert.equal(b.workers.current('codex').live_qualified,true);
 const a=b.workers.get('codex'),read=await a.execute({workspace:f.repo,files:['fixture.txt'],writable:[],objective:'Public synthetic conversation. Return status completed, summary exactly ready, and changes []. Use no tools.',model});
 assert.equal(read.result.summary,'ready');assert.equal(read.changes.length,0);assert.equal(read.provenance.synthetic_only,false);assert.equal(read.provenance.tool_access,false);assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
 const grant={level:'development',permissions:{network:['internet']},filesystem:{read:[f.repo],write:[f.repo]},expiresAt:Date.now()+600000};
 const manifest=require('./fixtures/bounded-worker-fixture.cjs').manifest(f.repo);
 const base=f.create({manifest,preferred_agent:'codex',model:'codex:'+model,dispatch_policy:{privacy:'cloud_allowed',providers:['codex_openai'],billing_classes:['subscription'],max_attempts:1},authority:grant}),m=b.missions.require(base.id);
 b.workers.registerTemplate({project:'synthetic',workspace_alias:'public',confirmed:true,template:{manifest,privacy:'approved_external',data_class:'public',workers:['codex'],project_id:m.project_id,goal_id:m.goal_id,workspace:f.repo,allowed_files:['fixture.txt'],criteria:m.envelope.criteria,verification:m.envelope.verification,capability_scopes:['repo','developer_environment'],authority:grant}});
 const server=new ControlServer(b,{port:0});await server.start();fs.chmodSync(path.join(f.root,'data'),0o700);require('../src/local-bootstrap').writePrivate(path.join(f.root,'data/mcp.json'),{port:server.port,token:server.mcpToken,pid:process.pid});t.after(()=>server.close());
 const client=require('../src/mcp-client').createClient({dataDir:path.join(f.root,'data')}),info={name:'airodrom-live-qualification',version:'1'};
 const call=async(name,args)=>{return client(name,args,info);};
 const packet={version:2,request_id:randomUUID(),objective:'Public synthetic coding Mission. Propose changing fixture.txt to exactly beta followed by one newline. No tools. The host runs tests.',mission_class:'WORK',data_class:'public',privacy:'approved_external',project:'synthetic',workspace:'public',worker:'codex',model:'codex:'+model};
 const receipt=await call('submit_mission',{packet});assert.ok(receipt.mission_id);assert.equal((await call('submit_mission',{packet})).mission_id,receipt.mission_id);
 const done=await f.settle(receipt.mission_id);assert.equal(done.state,'awaiting_acceptance');assert.equal(done.acceptance.length,0);assert.equal(done.verifications[0].result,'passed');assert.equal(done.runs[0].agent_id,'codex');assert.equal(done.runs[0].result.worker_provenance.synthetic_only,false);b.workers.assertEvidence(done.runs[0]);
 const progress=await call('get_mission_handoff',{mission_id:receipt.mission_id});assert.equal(progress.state,'awaiting_acceptance');assert.equal(progress.authority,false);
 assert.throws(()=>b.missions.program.settle(receipt.mission_id,'accept'),/Settlement requires/);
 b.missions.accept(receipt.mission_id,{request_id:randomUUID(),verification_id:done.verifications[0].id,decision:'accept',rationale:'Explicit synthetic qualification Acceptance: independent exact-file and registered Node test evidence passed.'});
 const accepted=b.missions.detail(receipt.mission_id);assert.equal(accepted.state,'completed');assert.equal(accepted.program_contract.settlement.state,'settled');
 const final=await call('get_mission_handoff',{mission_id:receipt.mission_id});assert.equal(final.state,'completed');
 const c=new AbortController();await assert.rejects(a.execute({workspace:f.repo,files:['fixture.txt'],writable:[],objective:'Public cancellation probe. Return no changes.',model,signal:c.signal,onEvent:e=>{if(e.type==='worker.execution_started')c.abort();}}),/worker_cancelled/);
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'beta\n');
 assert.equal(b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE state IN ('held','quarantined')").get().n,0);
 const report={worker:'codex',runtime_version:read.provenance.runtime_version,model,policy:worker.POLICY,executable_sha256:read.provenance.executable_sha256,tls_roots_sha256:read.provenance.tls_roots_sha256,live_qualified:true,fixture_worker:false,disposable_state:true,no_tools_conversation:true,scoped_host_edit:true,registered_test:true,independent_verification:true,explicit_acceptance:true,settlement:true,cancellation:true,leases_released:true,canonical_router_v2:canonical.routing,local_authenticated_mcp:true,mcp_idempotent:true,mcp_progress_result:true,mission_id:receipt.mission_id,verification_id:done.verifications[0].id,chatgpt_connector_end_to_end:false,private_memory_access:false,real_arecibo_access:false};
 console.log(JSON.stringify(report));if(process.env.AIRODROM_CODEX_REPORT)fs.writeFileSync(process.env.AIRODROM_CODEX_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
});
