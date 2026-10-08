'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {fixture,wait}=require('./fixtures/mission-fixture.cjs');
const {fingerprint}=require('../src/control-plane-store');
const hash=v=>createHash('sha256').update(v).digest('hex');
async function researchFixture(t,{block=false,uncertain=false,account=false,manualGate=false,provenanceDigits=false}={}){
 const f=await fixture(t),b=f.bridge,actions=[],browsers=[],resolved=[];
 class Browser{
  constructor(options){Object.assign(this,options);fs.mkdirSync(this.evidenceDir,{recursive:true,mode:0o700});this.url=null;this.closed=false;this.viewport={width:1280,height:800};browsers.push(this);}
  async qualify(){return{available:true,synthetic:true};}
  async execute(action){actions.push(action);if(action.type==='navigate'){this.url=action.url;if(block||manualGate)await new Promise((resolve,reject)=>{this.releaseNavigation=resolve;this.signal.addEventListener('abort',()=>reject(Error('fixture cancelled')),{once:true});});if(account&&!this.authenticated){const id=randomUUID(),row={id,state:'authentication_required',classification:'inaccessible',private_context:true,url:'https://public.example/',title:'',text:'',content:'',sha256:hash(''),login_forms:[{id:randomUUID(),fields:[{id:randomUUID(),type:'username'},{id:randomUUID(),type:'password'}]}],untrusted:true,authority:false};return this.receipt(row);}return{state:'navigated',url:this.url,authority:false};}
   if(action.type==='authenticate'){assert.equal(await this.approve({action}),true);const a=this.accountAuthorization,grant={id:a.id,origin:a.origin,purpose:'account_login',submission_url:a.login_url,form_id:action.form_id,approval_id:a.id,username_reference:a.username_reference,password_reference:a.password_reference};const username=await this.resolveCredential(a.username_reference,grant),password=await this.resolveCredential(a.password_reference,grant);username.fill(0);password.fill(0);this.authenticated=true;return{state:'authenticated',private_context:true,screenshots_disabled:true,authority:false};}
   if(action.type==='viewport'){this.viewport={width:action.width,height:action.height};return{state:'viewport',...this.viewport,authority:false};}
   if(action.type==='download'){assert.equal(await this.approve({action}),true);const id=randomUUID(),value='feature,status\npublic,observed\n',buffer=Buffer.from(value),file=path.join(this.evidenceDir,id+'.download');fs.writeFileSync(file,buffer,{mode:0o600});return this.receipt({id,state:'downloaded',url:action.url,title:'Public text download',text:value,content:value,sha256:hash(value),classification:'observed',untrusted:true,authority:false,links:[],forms:[],download_ref:{id,path:file,sha256:hash(buffer),mimeType:'text/csv'}});}
   const id=provenanceDigits&&action.type==='screenshot'&&!this.provenanceCanaryCaptured?(this.provenanceCanaryCaptured=true,'41111111-1111-4111-8112-111111111111'):randomUUID(),row={id,url:this.url,title:'Public fixture',text:'Observed public fixture pricing and features.',content:'Observed public fixture pricing and features.',classification:'observed',untrusted:true,authority:false,links:[],forms:[],viewport:this.viewport};row.sha256=hash(row.text);
   if(action.type==='screenshot'){const file=path.join(this.evidenceDir,id+'.png'),buffer=Buffer.from('synthetic PNG evidence');fs.writeFileSync(file,buffer,{mode:0o600});row.screenshot_ref={id,path:file,sha256:hash(buffer),mimeType:'image/png'};}
   return this.receipt(row);
  }
  receipt(row){const file=path.join(this.evidenceDir,row.id+'.json'),bytes=Buffer.from(JSON.stringify(row));fs.writeFileSync(file,bytes,{mode:0o600});row.evidence_ref={id:row.id,path:file,sha256:hash(bytes)};return row;}
  verify(row){return verify(row);}
  async close(){this.closed=true;if(uncertain)throw Error('fixture termination uncertain');return{closed:true,termination_verified:true,owned_process_termination:'verified'};}
 }
 function verify(row){try{return hash(fs.readFileSync(row.evidence_ref.path))===row.evidence_ref.sha256&&(!row.screenshot_ref||hash(fs.readFileSync(row.screenshot_ref.path))===row.screenshot_ref.sha256)&&(!row.download_ref||hash(fs.readFileSync(row.download_ref.path))===row.download_ref.sha256);}catch{return false;}}
 b.options.researchMission={workspace:f.repo,synthetic:true,maxPages:2,maxActions:20,timeoutMs:30000,baselineFiles:['docs/README.md'],browserFactory:o=>new Browser(o),verifyEvidence:verify,reportFactory:({evidenceStore})=>({build:async({evidence})=>{for(const row of evidence)assert.equal(evidenceStore.verify(row),true);return{markdown:'Public fixture research. The Arecibo feature is unknown. Owner review required.',screenshots:evidence.filter(r=>r.screenshot_ref).map(r=>({id:r.id,viewport:r.viewport})),authority:false};}}),credentialsFactory:()=>({validateReferences:()=>true,authorized:(m,action)=>{const a=m.envelope.manifest.account_authorization;assert.ok(a);assert.equal(action.username_reference,a.username_reference);assert.equal(action.password_reference,a.password_reference);return a;},consumedApproval:(m,action)=>[...b.policy.approvals.values()].find(p=>p.status==='consumed'&&p.taskId===m.task_id&&fingerprint(p.input)===fingerprint({name:'browser_research',input:{mission_id:m.id,action}})),resolve:(ref,grant)=>{assert.equal(b.controlStore.getMission(grant.mission_id).state,'running');resolved.push(ref);return Buffer.from('Synthetic private fixture value');}})};
 f.host.researchAssess=(task,input)=>b.missions.research.assess(task,input);f.host.researchExecute=(task,input,signal)=>b.missions.research.perform(task,input,signal);
 const create=extra=>b.missions.createResearch({request_id:randomUUID(),objective:'Audit public fixture and compare with Arecibo.',entry_url:'https://public.example/',...extra});
 return{...f,b,create,actions,browsers,resolved};
}
test('exact Monarch research strings and bare URL follow-up dispatch synthetic canonical browser Missions',async t=>{
 const f=await researchFixture(t),service=require('../src/assistant-service');
 const engine=new(require('../src/conversation-engine').ConversationEngine)(f.b,{qualify:async()=>{throw Error('No model allowed');}}),session=engine.session({new:true}).conversation_id;
 const server={bridge:f.b,conversationEngine:engine};
 const submit=message=>service.submit(server,{message,conversation_id:session,request_id:randomUUID()});
 for(const message of ['https://app.monarch.com','Research https://app.monarch.com and compare it with Arecibo.','Andrew: Research https://app.monarch.com and compare it with Arecibo.']){
  const receipt=await submit(message);assert.equal(receipt.browser_research_available,true);
  const m=f.b.missions.require(receipt.mission_id);assert.equal(m.envelope.kind,'browser_research');assert.deepEqual(m.envelope.capability_scopes,['web_read']);assert.equal(m.envelope.manifest.entry_url,'https://app.monarch.com/');
  const done=await f.settle(m.id);assert.equal(done.state,'awaiting_acceptance');assert.equal(done.acceptance.length,0);assert.equal(f.browsers.at(-1).closed,true);
 }
 assert.equal((await submit('Research the Monarch Money website and compare its features with Arecibo.')).pending_research,'public');
 const follow=await submit('https://app.monarch.com');assert.equal(follow.browser_research_available,true);assert.equal(server.pendingResearch.size,0);await f.settle(follow.mission_id);
 assert.equal(f.inference(),0);assert.equal(f.calls(),0);assert.equal(f.resolved.length,0);
 assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n,4);
});
test('opaque research request digits cannot become secret-like mission prose',async t=>{
 const f=await researchFixture(t),request_id='41111111-1111-4111-8112-111111111111';
 assert.equal(require('../src/personal-memory').containsSecret(request_id),true);
 const first=f.create({request_id}),second=f.create({request_id:'41111111-1111-4111-8112-111111111112'});
 assert.notEqual(first.mission_id,second.mission_id);
 assert.equal(f.create({request_id}).mission_id,first.mission_id);
 assert.throws(()=>f.create({objective:'Audit public fixture. password is synthetic-test-value'}),/sensitive|credentials/);
});
test('raw credential-shaped and normalization-laundered research requests never persist or dispatch',async t=>{
 const f=await researchFixture(t),service=require('../src/assistant-service'),server={bridge:f.b,conversationEngine:{start(){throw Error('No model allowed');}}};
 const paths=['/token/synthetic/../../about','/%61uth/synthetic/../../about','/secret_syntheticcanary','/cookie/syntheticcanary'];
 const before=f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n;
 const requestsBefore=f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_requests').get().n;
 for(const path of paths){const url='https://www.example.com'+path;
  for(const message of [url,'Research '+url,'Research '+url+' after I log in manually']){const r=await service.submit(server,{message,request_id:randomUUID()});assert.ok(['clarify','secret'].includes(r.kind));assert.equal(r.entry_url,undefined);assert.doesNotMatch(JSON.stringify(r),/synthetic/);}
  assert.throws(()=>f.create({entry_url:url}),/credentials|sensitive|private/);
  assert.throws(()=>f.create({objective:'Research '+url}),/credentials|sensitive/);
 }
 assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n,before);
 assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n,0);
 assert.equal(f.browsers.length,0);assert.equal(f.inference(),0);assert.equal(f.calls(),0);
 assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_requests').get().n,requestsBefore);
});
test('explicitly confirmed session Missions preserve fixed credential-free auth login endpoints',async t=>{
 const f=await researchFixture(t);
 for(const path of ['/auth/login','/api/auth/login']){
  assert.throws(()=>f.create({entry_url:'https://public.example'+path}),/credentials|sensitive|private/);
  const r=f.create({entry_url:'https://public.example'+path,session_authorization:{mode:'dedicated_manual',confirmed:true}}),m=f.b.missions.require(r.mission_id);
  assert.equal(m.envelope.manifest.session_authorization.login_url,'https://public.example'+path);
  assert.doesNotThrow(()=>f.b.missions.research.assertContract(m));
 }
 assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n,0);
});
test('research follows canonical native invocation, Verification, owner Acceptance and Settlement without writes or inference',async t=>{
 const f=await researchFixture(t,{provenanceDigits:true});delete f.b.options.researchMission.reportFactory;const denied=[path.join(f.repo,'.env'),path.join(f.repo,'private-export.json')];for(const file of denied)fs.writeFileSync(file,'Synthetic denied-file read canary\n');const originalRead=fs.readFileSync,originalOpen=fs.openSync,originalProjectSnapshot=f.b._projectMemoryRepositorySnapshot;let deniedReads=0,legacySnapshots=0;f.b._projectMemoryRepositorySnapshot=()=>{legacySnapshots++;throw Error('Research called broad legacy repository metadata');};const guard=file=>{if(typeof file==='string'&&denied.includes(path.resolve(file))){deniedReads++;throw Error('Research opened denied private content');}};fs.readFileSync=function(file,...args){guard(file);return originalRead.call(this,file,...args);};fs.openSync=function(file,...args){guard(file);return originalOpen.call(this,file,...args);};t.after(()=>{fs.readFileSync=originalRead;fs.openSync=originalOpen;f.b._projectMemoryRepositorySnapshot=originalProjectSnapshot;});
 const r=f.create(),before=fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),m=f.b.controlStore.getMission(r.mission_id),task=f.b.tasks.get(r.task_id);
 assert.equal(m.envelope.kind,'browser_research');assert.deepEqual(m.envelope.authority.permissions,{repository:['read'],runtime:[],network:['internet'],secrets:[],data:['read']});assert.deepEqual(m.envelope.allowed_files,[]);assert.deepEqual(task.capabilityScopes,['web_read']);
 f.b.missions.dispatch(m.id,{request_id:randomUUID()});const done=await f.settle(m.id);assert.equal(done.state,'awaiting_acceptance');assert.equal(done.acceptance.length,0);assert.equal(f.inference(),0);assert.equal(f.calls(),0);assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),before);assert.equal(f.browsers[0].closed,true);
 const run=done.runs.find(r=>r.result?.research_evidence);assert.equal(run.agent_id,'host');assert.equal(run.termination_verified,1);assert.equal(run.result.native_execution_evidence.completed_invocations,f.actions.length);assert.equal(f.b.missions.research.artifact(f.b.controlStore.getMission(m.id),run).receipts.length,f.actions.length);assert.equal(done.verifications[0].result,'operator_review');assert.equal(done.verifications[0].evidence.some(e=>e.status==='failed'),false);
 assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state='held'").get(m.id).n,0);assert.equal(f.b.controlStore.db.prepare('SELECT state FROM cp_mission_settlements WHERE mission_id=?').get(m.id).state,'waiting_acceptance');
 const report=await f.b.missions.research.report(m.id);assert.match(report.markdown,/unknown|[Nn]ot established/);assert.ok(report.markdown.includes('41111111-1111-4111-8112-111111111111'));assert.equal(require('../src/personal-memory').containsSecret(report.markdown),true);assert.equal(require('../src/personal-memory').containsSecret(f.b.resultInbox.latest({mission:m.id,agent:'host'}).result.summary),false);assert.equal(report.report.automatic_implementation,false);assert.equal(report.accepted,false);const shot=f.b.missions.research.artifact(f.b.controlStore.getMission(m.id),run).rows.find(r=>r.screenshot_ref);assert.equal((await f.b.missions.research.evidence(m.id,shot.id)).mime,'image/png');
 assert.equal(f.b.missions.research.progress(f.b.controlStore.getMission(m.id)).report_available,true);
 f.b.missions.accept(m.id,{request_id:randomUUID(),verification_id:done.verifications[0].id,decision:'accept',rationale:'Synthetic report reviewed',evidence:'Synthetic screenshots and unknown baseline claim inspected'});assert.equal(f.b.controlStore.getMission(m.id).state,'completed');assert.equal(f.b.controlStore.db.prepare('SELECT state FROM cp_mission_settlements WHERE mission_id=?').get(m.id).state,'settled');assert.equal(deniedReads,0);assert.equal(legacySnapshots,0);
});
test('research fails closed on caller, origin, Task capability and signed scope changes',async t=>{
 const f=await researchFixture(t);assert.throws(()=>f.b.missions.createResearch({request_id:randomUUID(),objective:'Public audit',entry_url:'https://public.example/'},'mcp'),/operator/);assert.throws(()=>f.create({entry_url:'https://127.0.0.1/'}),/public/);assert.throws(()=>f.create({entry_url:'https://public.example/?token=x'}),/query|sensitive/);assert.throws(()=>f.create({entry_url:'https://public.example/#section'}),/fragments/);
 const r=f.create(),task=f.b.tasks.get(r.task_id);assert.throws(()=>f.b.missions.research.assess(task,{mission_id:r.mission_id,action:{type:'snapshot'}}),/Active canonical/);task.capabilityScopes.push('repo');f.b.tasks.save(task);assert.throws(()=>f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()}),/binding/);assert.equal(f.actions.length,0);
});
test('research cancellation stops the owned browser and releases only after verified termination',async t=>{
 const f=await researchFixture(t,{block:true}),r=f.create();f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()});for(let i=0;i<100&&!f.actions.length;i++)await wait(5);assert.equal(f.actions[0]?.type,'navigate');assert.equal(f.b.tasks.isErasureActive(r.task_id),true);const writer=randomUUID();f.b.controlStore.startRun({id:writer,taskId:r.task_id,missionId:r.mission_id,agentId:'host',role:'verifier'});assert.throws(()=>f.b.controlStore.acquireLease({resource:f.repo,runId:writer,missionId:r.mission_id,mode:'write'}),/lease/);f.b.controlStore.updateRun(writer,{state:'failed',processState:'not_started',verified:true});f.b.missions.cancel(r.mission_id,{request_id:randomUUID()});for(let i=0;i<100&&f.b.missions.research.active.size;i++)await wait(5);
 assert.equal(f.b.controlStore.getMission(r.mission_id).state,'cancelled');assert.equal(f.browsers[0].closed,true);const run=f.b.controlStore.db.prepare('SELECT id FROM cp_runs WHERE mission_id=?').get(r.mission_id);assert.equal(f.b.controlStore.run(run.id).termination_verified,1);assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(r.mission_id).n,0);
});
test('uncertain owned browser termination quarantines the lease and cannot produce Acceptance',async t=>{
 const f=await researchFixture(t,{uncertain:true}),r=f.create();f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()});for(let i=0;i<150&&f.b.controlStore.getMission(r.mission_id).state!=='blocked';i++)await wait(5);assert.equal(f.b.controlStore.getMission(r.mission_id).state,'blocked');assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(r.mission_id).n,1);assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances WHERE mission_id=?').get(r.mission_id).n,0);assert.throws(()=>f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()}),/one run/);f.b.controlStore.recover();assert.doesNotThrow(()=>f.b.missions.research.recover(f.b.controlStore.getMission(r.mission_id)));assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(r.mission_id).n,1);
});
test('independent research verification rejects tampered evidence and changed baseline',async t=>{
 const f=await researchFixture(t),r=f.create();f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()});const done=await f.settle(r.mission_id),run=done.runs.find(r=>r.result?.research_evidence);fs.appendFileSync(f.b.missions.research.artifact(f.b.controlStore.getMission(r.mission_id),run).rows[0].evidence_ref.path,'tamper');assert.equal((await f.b.missions.research.verify(f.b.controlStore.getMission(r.mission_id),run)).status,'failed');await assert.rejects(f.b.missions.research.report(r.mission_id),/integrity/);
 const another=f.create();fs.mkdirSync(path.join(f.repo,'docs'),{recursive:true});fs.writeFileSync(path.join(f.repo,'docs/README.md'),'Operator approved source changed\n');assert.throws(()=>f.b.missions.dispatch(another.mission_id,{request_id:randomUUID()}),/baseline/);assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(another.mission_id).n,0);
});
test('account research forwards only sealed operator purpose through a real one-shot broker approval',async t=>{
 const f=await researchFixture(t,{account:true}),username=randomUUID(),password=randomUUID(),r=f.create({entry_url:'https://public.example/login',account_authorization:{username_reference:username,password_reference:password,confirmed:true}}),m=f.b.controlStore.getMission(r.mission_id);
 assert.equal(m.envelope.authority.level,'infrastructure');assert.deepEqual(m.envelope.authority.permissions,{repository:['read'],runtime:[],network:['internet'],secrets:['use'],data:['read']});assert.equal(m.envelope.manifest.account_authorization.login_url,'https://public.example/login');assert.equal(m.envelope.manifest.scope.useVault,true);
 f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()});const done=await f.settle(r.mission_id);assert.equal(done.state,'awaiting_acceptance');assert.deepEqual(f.resolved,[username,password]);const approvals=f.b.policy.list(r.task_id);assert.equal(approvals.length,1);assert.equal(approvals[0].status,'consumed');assert.equal(f.actions.filter(a=>a.type==='authenticate').length,1);assert.equal(f.actions.some(a=>a.type==='screenshot'),false);
 const run=done.runs.find(r=>r.result?.research_evidence);assert.equal(run.result.native_execution_evidence.completed_invocations,3);assert.equal(f.b.missions.research.artifact(f.b.controlStore.getMission(m.id),run).receipts.length,3);assert.equal(JSON.stringify(done).includes('Synthetic private fixture value'),false);assert.equal(JSON.stringify(f.b.missions.research.artifact(f.b.controlStore.getMission(m.id),run)).includes('Synthetic private fixture value'),false);assert.equal(f.b.missions.research.progress(f.b.controlStore.getMission(m.id)).steps.find(s=>s.id==='responsive').state,'attention');
});
test('operator download admission returns immediately and waits exact approval before report and termination',async t=>{
 const f=await researchFixture(t,{manualGate:true}),r=f.create();f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()});for(let i=0;i<100&&!f.actions.length;i++)await wait(5);assert.equal(f.actions[0]?.type,'navigate');
 const input={request_id:randomUUID(),url:'https://public.example/public.csv'},receipt=f.b.missions.research.download(r.mission_id,input);assert.equal(receipt.kind,'download_request');assert.equal(receipt.state,'queued');assert.equal(receipt.then,undefined);assert.equal(f.b.missions.research.download(r.mission_id,input).duplicate,true);assert.throws(()=>f.b.missions.research.download(r.mission_id,{...input,url:'https://public.example/other.csv'}),/Idempotency/);assert.equal(f.b.policy.list(r.task_id).length,0);f.browsers[0].releaseNavigation();
 for(let i=0;i<150&&!f.b.policy.list(r.task_id).length;i++)await wait(5);const approval=f.b.policy.list(r.task_id)[0];assert.equal(approval.status,'pending');assert.equal(f.b.controlStore.getMission(r.mission_id).state,'waiting_for_operator');assert.equal(f.b.tasks.isErasureActive(r.task_id),true);assert.equal(f.browsers[0].closed,false);assert.equal(f.actions.some(a=>a.type==='download'),false);assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_run_results WHERE mission_id=?').get(r.mission_id).n,0);
 f.b.approve(approval.id);const done=await f.settle(r.mission_id),run=done.runs.find(r=>r.result?.research_evidence),artifact=f.b.missions.research.artifact(f.b.controlStore.getMission(r.mission_id),run);assert.equal(done.state,'awaiting_acceptance');assert.equal(f.b.policy.list(r.task_id)[0].status,'consumed');assert.equal(f.actions.filter(a=>a.type==='download').length,1);assert.equal(artifact.rows.filter(row=>row.download_ref).length,1);assert.equal(run.result.native_execution_evidence.completed_invocations,artifact.receipts.length);assert.equal(f.browsers[0].closed,true);assert.throws(()=>f.b.missions.research.download(r.mission_id,{request_id:randomUUID(),url:input.url}),/Active public/);
});
test('legacy HTTP and direct Task controls keep research cancellation canonical and forbid pause/resume',async t=>{
 const f=await researchFixture(t,{block:true}),ui=new(require('../src/control-server'))(f.b,{port:0});await ui.start();
 const post=async(id,action)=>fetch(ui.origin+'/api/tasks/'+id+'/'+action,{method:'POST',headers:{authorization:'Bearer '+ui.token,'content-type':'application/json'},body:'{}'});
 try{for(const mode of ['http','bridge']){const r=f.create();f.b.missions.dispatch(r.mission_id,{request_id:randomUUID()});const previous=f.actions.length;for(let i=0;i<150&&f.actions.length===previous;i++)await wait(5);const active=f.b.missions.research.active.get(r.mission_id);assert.ok(active);assert.equal(active.controller.signal.aborted,false);
   await assert.rejects(f.b.pause(r.task_id),/legacy pause\/resume/);await assert.rejects(f.b.resume(r.task_id),/legacy pause\/resume/);assert.equal((await post(r.task_id,'pause')).status,400);assert.equal((await post(r.task_id,'resume')).status,400);assert.equal(f.inference(),0);
   if(mode==='http')assert.equal((await post(r.task_id,'cancel')).status,200);else await f.b.cancel(r.task_id);assert.equal(active.controller.signal.aborted,true);for(let i=0;i<150&&f.b.missions.research.active.has(r.mission_id);i++)await wait(5);assert.equal(f.b.controlStore.getMission(r.mission_id).state,'cancelled');assert.equal(f.b.missions.research.active.has(r.mission_id),false);assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_runs WHERE mission_id=? AND termination_verified=0").get(r.mission_id).n,0);assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(r.mission_id).n,0);
  }}finally{await ui.close();}
});
