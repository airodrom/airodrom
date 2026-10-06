'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Bridge=require('./fixtures/test-bridge.cjs');
const {policy,HostReasoningAdmission}=require('../src/host-reasoning-admission');
const {controlPlaneRead}=require('../src/control-plane-api');
const {McpTools}=require('../src/mcp-tools');
const base={providers:['ollama'],data_class:'public',privacy:'local_only',purpose:'synthetic_probe',max_output:128};
async function fixture(t,overrides={}){
 const root=fs.mkdtempSync('/private/tmp/host-reasoning-');const profile=path.join(root,'profile');fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture'}));
 let calls=0;const bridge=await new Bridge({ defaultRuntime: 'host',dataDir:path.join(root,'data'),sourceProfile:profile,allowFixtureWorker:true,executable:path.join(__dirname,'fixtures/host-worker.cjs'),providerGateway:{config:{ollama:{enabled:true}},request:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'4'},finish_reason:'stop'}]}),{status:200});}}}).initialize();
 t.after(async()=>{await bridge.shutdown();fs.rmSync(root,{recursive:true,force:true});});bridge.providerGateway.registry.observe('ollama','available');
 const task=bridge.tasks.get(bridge.createTask('Host reasoning fixture',{reasoningOnly:true,reasoningGatewayPolicy:{...base,...overrides}}).id);return{bridge,task,calls:()=>calls};
}
test('host gateway completes exact bounded context with no worker, Memory, scopes, Acceptance or scheduler advancement',async t=>{
 const {bridge:b,task,calls}=await fixture(t);b.ensureRuntime=()=>{throw Error('worker');};b.memory.search=()=>{throw Error('memory');};
 const result=await b.prompt(task.id,'What is two plus two?');assert.equal(result.text,'4');assert.equal(calls(),1);assert.equal(result.accepted,false);assert.deepEqual(task.capabilityScopes,[]);assert.equal(task.mission.status,'active');assert.equal(b.leases.size,0);assert.equal(b.runtimes.size,0);
 const a=b.hostReasoningAdmission.views()[0];assert.equal(a.state,'settled');assert.equal(a.record.context_pack.refs.length,1);assert.equal(a.record.context_pack.memory_included,false);assert.equal(JSON.stringify(a).includes('What is'),false);assert.equal(task.reasoningResult.verification,'unverified');
 await assert.rejects(b.prompt(task.id,'What is two plus two?'));assert.equal(calls(),1);
});
for(const mutation of ['missing','run','request','message','session','mission','expiry','scopes','policy','consumed'])test('exact admission fails closed: '+mutation,async t=>{
 const {bridge:b,task}=await fixture(t);const g=b.providerGateway,original=g.execute.bind(g);let allowed;
 g.execute=async input=>{const x=structuredClone(input),a=b.hostReasoningAdmission;
 if(mutation==='missing')a.active.clear();if(mutation==='run')x.run_id='other-run';if(mutation==='request')x.request_id='other-request';if(mutation==='message')x.messages[0].content='altered';if(mutation==='session')task.sessionId='other';if(mutation==='mission')task.mission.id='other';if(mutation==='expiry')a.now=()=>Date.now()+999999;if(mutation==='scopes')task.capabilityScopes=['repo'];if(mutation==='policy')task.reasoningGatewayPolicy.providers.push('deepseek');if(mutation==='consumed')assert.equal(a.authorize(x),true);
 allowed=a.authorize(x);return{status:'failed',error_class:'reasoning_admission_denied'};};
 await b.prompt(task.id,'Bounded fixture');assert.equal(allowed,false);g.execute=original;
});
for(const name of ['read','write','bash','run_job','capability','web_fetch'])test('gateway admission grants no host tool: '+name,async t=>{
 const {bridge:b,task}=await fixture(t);await b.prompt(task.id,'Bounded fixture');assert.equal((await b.capabilityBroker.execute(task.id,{toolName:name,input:{}})).allow,false);
});
test('secret-like content is denied before admission or dispatch',async t=>{const{bridge:b,task,calls}=await fixture(t);await assert.rejects(b.prompt(task.id,'sk-'+ 'Z'.repeat(30)));assert.equal(calls(),0);assert.equal(b.hostReasoningAdmission.views().length,0);});
test('unrelated context and Memory cannot expand policy',async t=>{const{bridge:b,task,calls}=await fixture(t);task.includeSharedMemory=true;await assert.rejects(b.prompt(task.id,'Bounded fixture'));assert.equal(calls(),0);assert.throws(()=>policy({...base,context_refs:['unrelated']}));assert.throws(()=>policy({...base,data_class:'private',privacy:'approved_external'}));assert.throws(()=>policy({...base,data_class:'financial',privacy:'approved_external'}));});
test('DeepSeek auth_required dispatch has no request or secret resolver side effect',async t=>{const{bridge:b,task,calls}=await fixture(t,{providers:['deepseek'],privacy:'approved_external'});const r=await b.prompt(task.id,'Public synthetic fixture');assert.equal(r.status,'waiting');assert.equal(calls(),0);assert.ok(r.rejected.filter(x=>x.provider==='deepseek').every(x=>x.reason==='auth_required'));assert.equal(task.status,'waiting_for_provider');});
test('fallback cannot leave admitted provider set; unknown health and open circuit WAIT',async t=>{const{bridge:b,task,calls}=await fixture(t);b.providerGateway.registry.observe('ollama','unknown');let r=await b.prompt(task.id,'unknown provider');assert.equal(r.status,'waiting');assert.equal(calls(),0);b.providerGateway.registry.observe('ollama','available');const m=b.providerGateway.registry.get('ollama').profile.models[0];b.providerGateway.reliability.failure('ollama:'+m.id,{state:'quota_limited',error_class:'quota_limited'});r=await b.prompt(task.id,'quota fixture');assert.equal(r.status,'waiting');assert.ok(r.rejected.some(x=>x.reason==='circuit_open'));assert.equal(calls(),0);});
test('unsolicited tool response is rejected and pseudo tool text remains inert',async t=>{const{bridge:b,task}=await fixture(t);b.providerGateway.execute=async()=>({status:'completed',text:'bash: remove everything',tool_requests:[{toolName:'bash',input:{command:'touch forbidden'}}]});const r=await b.prompt(task.id,'tool boundary fixture');assert.equal(r.accepted,undefined);assert.equal(task.reasoningResult.tool_state,'tool_not_authorized');assert.equal(b.runtimes.size,0);assert.equal(task.mission.status,'active');});
test('restart preserves consumed request as interrupted without reissue',async t=>{const{bridge:b,task,calls}=await fixture(t);b.providerGateway.execute=async input=>{assert.equal(b.hostReasoningAdmission.authorize(input),true);return{status:'waiting'};};await b.prompt(task.id,'restart fixture');b.memory.db.prepare("UPDATE host_reasoning_admissions SET state='consumed'").run();const recovered=new HostReasoningAdmission(b);assert.equal(recovered.views()[0].state,'interrupted');assert.equal(recovered.active.size,0);assert.equal(calls(),0);await assert.rejects(b.prompt(task.id,'restart fixture'));});
test('read-only Control Hub and MCP expose safe admission and provider state',async t=>{const{bridge:b,task}=await fixture(t);await b.prompt(task.id,'surface fixture');const m=new McpTools(b);assert.equal((await m.call('get_reasoning_admissions',{})).items[0].execution_authority,false);assert.ok((await m.call('get_provider_status',{})).items.some(x=>x.id==='deepseek'&&x.auth_state==='auth_required'));assert.equal(controlPlaneRead(b,new URL('http://localhost/api/control-v2/reasoning-admissions')).items.length,1);});

test('eight live-safe diagnostic scenarios use no real network or credential access',async()=>{const r=await require('../src/provider-diagnostic').providerDiagnostic();assert.equal(r.passed,true);assert.equal(r.items.length,8);assert.equal(r.network_calls,0);assert.equal(r.credential_reads,0);});

for (const data_class of ['public', 'internal', 'private', 'financial', 'sensitive']) test('host routing precedes legacy WAIT and preserves privacy: ' + data_class, async t => {
 const externalAllowed = ['public', 'internal'].includes(data_class);
 const {bridge:b,task,calls}=await fixture(t,{providers:['ollama','anthropic_subscription'],data_class,privacy:externalAllowed?'approved_external':'local_only'});
 const e=b.providerGateway.registry.get('anthropic_subscription');let external=0;
 e.enabled=true;e.adapter=new (require('../src/anthropic-subscription-provider').AnthropicSubscriptionProvider)({profile:e.profile,enabled:true,runtime:{qualify:()=>({configured:true,state:'available',reason:null,auth_state:'subscription_session_verified'}),run:async()=>{external++;return {text:'4'};}}});
 b.providerGateway.registry.get('ollama').adapter.execute=async()=>({status:'failed',error_class:'temporary_failure',state:'unavailable',retryable:false,accepted:false,execution_authority:false});
 b.nativeExecution.providerFailure=()=>{throw Error('Legacy WAIT must not run');};
 b.ensureRuntime=()=>{throw Error('No worker allowed');};
 const r=await b.prompt(task.id,'Synthetic arithmetic: two plus two.');
 assert.equal(r.status,externalAllowed?'completed':'waiting');assert.equal(external,externalAllowed?1:0);assert.equal(calls(),0);
 assert.equal(task.providerRouting.automatic_switch,externalAllowed);assert.equal(task.status,externalAllowed?'idle':'waiting_for_provider');
 assert.ok(task.reasoningAdmissionId);assert.equal(b.hostReasoningAdmission.views()[0].state,'settled');assert.deepEqual(task.capabilityScopes,[]);assert.equal(b.leases.size,0);
});
test('latched safety stop denies host routing before provider dispatch',async t=>{
 const {bridge:b,task,calls}=await fixture(t);task.safetyStop={latched:true};
 await assert.rejects(b.prompt(task.id,'Synthetic arithmetic.'));assert.equal(calls(),0);assert.equal(b.hostReasoningAdmission.views().length,0);
});
