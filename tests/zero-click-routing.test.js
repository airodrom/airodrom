'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ProviderGateway}=require('../src/provider-gateway');
const {evaluateRouting}=require('../src/authority-router');
function fixture(){const g=new ProviderGateway({config:{ollama:{enabled:true}},authorize:()=>true});
 const a=g.registry.get('anthropic_subscription');a.enabled=true;a.adapter={health:()=>({configured:true,state:'available'}),execute:async()=>({status:'completed',text:'fixture',provider_id:a.profile.id})};
 g.registry.observe('ollama','available');return g;}
const input=(extra={})=>({run_id:'fixture-run',request_id:'fixture-request',selected_agent:'host',messages:[{role:'user',content:'Report fixture version'}],data_class:'internal',privacy:'project_policy',project_policy:{approved_external:{internal:['anthropic_subscription']}},max_output:64,...extra});
test('zero-click provider matrix records evaluated routing, local preference, fallback and privacy WAIT',()=>{
 const g=fixture();let r=g.plan(input());assert.equal(r.evaluated,true);assert.equal(r.selected_provider,'ollama');
 g.registry.observe('ollama','unavailable');r=g.plan(input());assert.equal(r.selected_provider,'anthropic_subscription');assert.equal(r.automatic_switch,true);assert.equal(r.provider_rejection_reasons.ollama,'provider_unavailable');
 r=g.plan(input({privacy:'local_only'}));assert.equal(r.evaluated,true);assert.equal(r.selected_provider,null);assert.equal(r.provider_rejection_reasons.anthropic_subscription,'privacy_denied');
 g.registry.get('anthropic_subscription').adapter.health=()=>({configured:false,state:'auth_required'});r=g.plan(input());assert.equal(r.status,'waiting');assert.equal(r.provider_rejection_reasons.anthropic_subscription,'auth_required');
});
test('zero-click taxonomy distinguishes healthy incapable model and context limit',()=>{const g=fixture();let r=g.plan(input({requirements:['telepathy']}));assert.equal(r.provider_rejection_reasons.ollama,'model_ineligible');r=g.plan(input({context_tokens:1e9}));assert.equal(r.provider_rejection_reasons.ollama,'context_window_insufficient');});
test('zero-click unknown effects never call any provider and deterministic Pi bypasses providers',async()=>{const g=fixture();assert.equal((await g.execute(input({unknown_side_effects:true}))).wait_reason,'reconcile_unknown_side_effects');const r=g.plan(input({deterministic:true}));assert.equal(r.selected_provider,null);assert.equal(r.evaluated,true);});
test('zero-click memory and lease conflicts exclude all agents before execution',()=>{const c={agent_id:'host',runtime_id:'host',enabled:true,capabilities:['local_tools'],assurance:2,locality:'local',isolation_verified:true,availability:'available',observed_at:1};const i={memory_state:'ready',context_current:true,required_capabilities:['local_tools']};for(const e of [{memory_state:'WAIT',memory_reason:'MEMORY_CONFLICT'},{writer_conflict:true}])assert.equal(evaluateRouting({...i,...e},[c],1).state,'WAIT');});
