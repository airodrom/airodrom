'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),{randomUUID}=require('node:crypto');
const worker=require('../src/bounded-worker'),synthetic=require('./fixtures/bounded-worker-fixture.cjs'),{fixture}=require('./fixtures/mission-fixture.cjs');
const root=t=>{const r=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-qualification-')));t.after(()=>fs.rmSync(r,{recursive:true,force:true}));return r;};
test('only the exact disabled Code Mode notice is accepted; tool activity and changed notices fail closed',()=>{
 const result={status:'completed',summary:'Public proposal',changes:[]},stream=notice=>[notice,{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}},{type:'turn.completed'}].map(e=>JSON.stringify(e)).join('\n');
 const notice={type:'item.completed',item:{type:'error',message:worker.CODEX_DISABLED_HOST_NOTICE}};
 assert.deepEqual(worker.parse('codex',stream(notice),[]).result,result);
 for(const bad of [{...notice,type:'item.started'},{...notice,item:{...notice.item,message:notice.item.message+' Run a tool.'}},{...notice,item:{type:'command_execution',message:notice.item.message}}])assert.throws(()=>worker.parse('codex',stream(bad),[]),/worker_tool_use_denied/);
});
test('Codex transport disables the actual host feature and avoids deprecated startup notices',t=>{
 const r=root(t),args=worker.args('codex',r,'public-model');assert.ok(args.includes('features.code_mode_host=false'));assert.ok(args.includes('features.shell_tool=false'));assert.ok(args.includes('web_search="disabled"'));assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('--ignore-rules'));assert.ok(args.includes('--ephemeral'));assert.ok(args.includes('--output-schema'));assert.ok(!args.some(s=>/web_search_cached|web_search_request|bypass/.test(s)));
});
test('signed bundle snapshot runs under unchanged no-fork sandbox; altered metadata cannot be snapshotted', {skip:process.platform!=='darwin'||!fs.existsSync(worker.SPECS.codex.candidates()[0])},t=>{
 const r=root(t),o=worker.inspect('codex'),exe=worker.snapshotExecutable(o,r,'codex');assert.equal(worker.HASH(fs.readFileSync(exe)),o.sha256);fs.mkdirSync(path.join(r,'state'));const version=cp.spawnSync('/usr/bin/sandbox-exec',['-p',worker.sandbox(r,exe,'codex',9),exe,'--version'],{env:{HOME:path.join(r,'state'),CODEX_HOME:path.join(r,'state'),TMPDIR:path.join(r,'state'),PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});assert.equal(version.status,0);assert.match(version.stdout,/codex-cli 0\.160\.1/);
 const metadata=path.resolve(exe,'../../Info.plist');fs.chmodSync(metadata,0o600);fs.appendFileSync(metadata,'\ninvalid');assert.throws(()=>worker.snapshotExecutable({...o,executable:exe},root(t),'codex'),/worker_snapshot_signature_invalid/);
 const roots=worker.publicTLSRoots();assert.ok(roots.content.length>1000);assert.doesNotMatch(roots.content.toString(),/PRIVATE KEY|Certificate:|Data:/);assert.equal(roots.sha256,o.tls_roots_sha256);
});
test('public TLS identity drift denies execution and forged provenance before host writes',async t=>{
 const opts=synthetic.options(root(t)),f=await fixture(t,{workers:{codex:opts}}),b=f.bridge;b.missionAuthority.initializeOperatorKey();await b.workers.qualify('codex',{confirmed:true,model:'fixture-model',request_id:randomUUID()});
 const observed=b.workers.get('codex').inspect();await assert.rejects(b.workers.get('codex').execute({workspace:f.repo,files:['fixture.txt'],writable:['fixture.txt'],objective:'Public fixture',model:'fixture-model',expectedPin:{...observed,tls_roots_sha256:'0'.repeat(64)}}),/worker_qualified_pin_changed/);
 assert.doesNotMatch(JSON.stringify(b.workers.catalog()),/executable|sha256|\/Users\//);
 const q=b.workers.qualification('codex'),record={...q,pin:{...q.pin,tls_roots_sha256:'0'.repeat(64)}};const hash=require('../src/control-plane-store').fingerprint(record),seal=b.missionAuthority.sealManifest({mission_id:q.id,manifest_hash:hash});b.controlStore.db.prepare('UPDATE cp_worker_qualifications SET record=?,record_hash=?,seal=? WHERE id=?').run(JSON.stringify(record),hash,JSON.stringify(seal),q.id);assert.equal(b.workers.current('codex',true).qualification,'stale');assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
});
test('manual worker selection reports the concrete denial while auto keeps OpenCode available',()=>{
 const router=require('../src/model-worker-router'),catalog={models:[{id:'local',locality:'local',workers:['opencode'],qualification:'qualified',available:true,expires_at:Date.now()+100000,data_classes:['public'],tasks:['WORK']}],workers:[{id:'codex',qualification:'unqualified',available:false,reason:'worker_workspace_routing_failed'},{id:'opencode',qualification:'qualified',available:true,locality:'local',capabilities:['coding']}]};
 assert.equal(router.select(catalog,{mission_class:'WORK',data_class:'public',privacy:'approved_external',worker:'codex'}).reason,'worker_workspace_routing_failed');assert.equal(router.select(catalog,{mission_class:'WORK',data_class:'public',worker:'auto'}).worker,'opencode');
});
test('failure classification emits only fixed classes, never vendor credentials or request text',()=>{
 for(const [text,expected] of [['workspace routing discovery failed','workspace_routing_failed'],['failed to spawn code-mode host','child_process_denied'],['authentication required','owner_login_required'],['rate limit','quota_limited'],['arbitrary vendor response with authorization: synthetic-secret','process_failed']])assert.equal(worker.failureClass(text),expected);
});
test('authenticated local MCP transport applies one scoped fixture and returns verification and explicit Settlement',async t=>{
 const opts=synthetic.options(root(t)),f=await fixture(t,{workers:{codex:opts}}),b=f.bridge;b.missionAuthority.initializeOperatorKey();await b.workers.qualify('codex',{confirmed:true,model:'fixture-model',request_id:randomUUID()});
 const grant={level:'development',permissions:{network:['internet']},filesystem:{read:[f.repo],write:[f.repo]},expiresAt:Date.now()+600000};
 // Choose a future numeric timestamp that the text scanner classifies as a card.
 while(!require('../src/personal-memory').containsSecret(String(grant.expiresAt)))grant.expiresAt++;
 const manifest=synthetic.manifest(f.repo);
 const base=f.create({manifest,preferred_agent:'codex',model:'codex:fixture-model',dispatch_policy:{privacy:'cloud_allowed',providers:['codex_openai'],billing_classes:['subscription'],max_attempts:1},authority:grant}),m=b.missions.require(base.id);
 const template={manifest,privacy:'approved_external',data_class:'public',workers:['codex'],project_id:m.project_id,goal_id:m.goal_id,workspace:f.repo,allowed_files:['fixture.txt'],criteria:m.envelope.criteria,verification:m.envelope.verification,capability_scopes:['repo','developer_environment'],authority:grant};
 assert.throws(()=>b.workers.registerTemplate({project:'synthetic',workspace_alias:'public',confirmed:true,template:{...template,constraints:'Public text 4111 1111 1111 1111'}}),/Sensitive/);
 b.workers.registerTemplate({project:'synthetic',workspace_alias:'public',confirmed:true,template});
 const server=new(require('../src/control-server'))(b,{port:0});await server.start();t.after(()=>server.close());fs.chmodSync(path.join(f.root,'data'),0o700);require('../src/local-bootstrap').writePrivate(path.join(f.root,'data/mcp.json'),{port:server.port,token:server.mcpToken,pid:process.pid});
 const client=require('../src/mcp-client').createClient({dataDir:path.join(f.root,'data')}),packet={version:2,request_id:randomUUID(),objective:'Public synthetic fixture change to beta newline',mission_class:'WORK',data_class:'public',privacy:'approved_external',project:'synthetic',workspace:'public',worker:'codex',model:'codex:fixture-model'};
 const receipt=await client('submit_mission',{packet});assert.ok(receipt.mission_id);assert.equal((await client('submit_mission',{packet})).mission_id,receipt.mission_id);const done=await f.settle(receipt.mission_id);assert.equal(done.acceptance.length,0);assert.equal((await client('get_mission_handoff',{mission_id:receipt.mission_id})).state,'awaiting_acceptance');assert.throws(()=>b.missions.program.settle(receipt.mission_id,'accept'),/Settlement requires/);b.missions.accept(receipt.mission_id,{request_id:randomUUID(),verification_id:done.verifications[0].id,decision:'accept',rationale:'Independent synthetic checks passed'});assert.equal((await client('get_mission_handoff',{mission_id:receipt.mission_id})).state,'completed');assert.equal(b.missions.detail(receipt.mission_id).program_contract.settlement.state,'settled');
});
test('late completed output after Mission cancellation cannot write, accept, settle or retain its lease',async t=>{
 const opts=synthetic.options(root(t)),f=await fixture(t,{workers:{codex:opts}}),b=f.bridge;b.missionAuthority.initializeOperatorKey();await b.workers.qualify('codex',{confirmed:true,model:'fixture-model',request_id:randomUUID()});
 const adapter=b.workers.get('codex'),execute=adapter.execute.bind(adapter);let release,ready;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);adapter.execute=async input=>{const output=await execute(input);ready();await gate;return output;};
 const m=f.create({manifest:synthetic.manifest(f.repo),preferred_agent:'codex',model:'codex:fixture-model',dispatch_policy:{privacy:'cloud_allowed',providers:['codex_openai'],billing_classes:['subscription'],max_attempts:1},authority:{level:'development',permissions:{network:['internet']},filesystem:{read:[f.repo],write:[f.repo]},expiresAt:Date.now()+600000}});
 b.missions.dispatch(m.id,{request_id:randomUUID()});await started;b.missions.cancel(m.id,{request_id:randomUUID()});release();
 for(let n=0;n<150;n++){await b.missions.tick();if(!adapter.active.size&&b.missions.detail(m.id).runs.every(r=>r.state==='cancelled'&&r.termination_verified))break;await new Promise(r=>setTimeout(r,20));}
 const done=b.missions.detail(m.id);assert.equal(done.state,'cancelled');assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');assert.equal(done.acceptance.length,0);assert.equal(done.program_contract.settlement?.state==='settled',false);assert.equal(b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE state IN ('held','quarantined')").get().n,0);assert.equal(done.runs[0].termination_verified,1);
});
