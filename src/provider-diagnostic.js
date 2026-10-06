'use strict';
// Live-safe outage proof: isolated in-memory state and synthetic transports only.
// Never mutates the live registry, reads a credential, or sends network traffic.
const {ProviderGateway,ProviderRegistry}=require('./provider-gateway');
const {model}=require('./provider-profiles');
async function providerDiagnostic(){
 const rows=[];
 for(const scenario of ['temporary','circuit_open','auth_required','quota_limited','local_only_outage','external_allowed','sensitive_external','unknown']){
  let calls=0;const used=[];const g=new ProviderGateway({authorize:()=>true});
  const profiles=['fixture_local','fixture_external'].map(id=>({id,implemented:true,protocol:'openai_compatible',locality:id==='fixture_local'?'local':'external',auth_required:false,models:[model('fixture',{},{max_context:32000,cost_class:id==='fixture_local'?'free/local':'high'})]}));
  const request=async url=>{calls++;const local=new URL(url).hostname==='127.0.0.1';used.push(local?'local':'external');if(local&&scenario==='temporary')return new Response('{}',{status:503});return new Response(JSON.stringify({choices:[{message:{content:'synthetic_ok'},finish_reason:'stop'}]}),{status:200});};
  g.registry=new ProviderRegistry({profiles,config:{fixture_local:{enabled:true,base_url:'http://127.0.0.1:11434/v1'},fixture_external:{enabled:true,base_url:'https://fixture.invalid/v1'}},request});g.router.registry=g.registry;
  for(const id of ['fixture_local','fixture_external'])g.registry.observe(id,'available');
  if(scenario==='circuit_open')g.reliability.failure('fixture_local:fixture',{state:'quota_limited',error_class:'quota_limited'});
  if(['auth_required','quota_limited','unknown'].includes(scenario))g.registry.observe('fixture_local',scenario);
  if(['local_only_outage','external_allowed','sensitive_external'].includes(scenario))g.registry.observe('fixture_local','unavailable');
  const allowExternal=['temporary','circuit_open','external_allowed'].includes(scenario);
  const input={request_id:'diagnostic-'+scenario,run_id:'diagnostic-'+scenario,allowed_providers:['fixture_local','fixture_external'],messages:[{role:'user',content:'Synthetic public diagnostic'}],data_class:scenario==='sensitive_external'?'financial':'public',privacy:allowExternal||scenario==='sensitive_external'?'project_policy':'local_only',project_policy:{approved_external:{public:allowExternal?['fixture_external']:[]}},max_output:128,cost_preference:'low'};
  const result=await g.execute(input);const expected=allowExternal?'completed':'waiting';
  rows.push({scenario,status:result.status,expected,passed:result.status===expected&&(!allowExternal?calls===0:true)&&(scenario!=='temporary'||used.join(',')==='local,local,external'),calls,synthetic_transports:used,selected_provider:result.provider_id||result.selected_provider||null,wait_reason:result.wait_reason||null,rejected:result.rejected||[],execution_authority:false,accepted:false});
 }
 return{fixture_only:true,network_calls:0,credential_reads:0,live_registry_mutations:0,passed:rows.every(r=>r.passed),items:rows};
}
module.exports={providerDiagnostic};
