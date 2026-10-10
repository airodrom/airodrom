'use strict';
// Host-owned runtime security classifications. Worker self-reports never
// establish VERIFIED. Missing evidence remains UNVERIFIED.
const CONFIG=require('../config/runtime-security-conformance-v1.json');
const {agentRuntimeProfile}=require('./agent-runtime-profile');
const {stamp,assertAssignmentSecurity}=require('./core-contracts');

function unverified(reason){return {state:'UNVERIFIED',reason,host_evidence:false,worker_self_report:false};}
function verified(reason,extra={}){return {state:'VERIFIED',reason,host_evidence:true,worker_self_report:false,...extra};}
function unsupported(reason){return {state:'UNSUPPORTED',reason,host_evidence:true,worker_self_report:false};}

function classifyOpenCode(bridge){
 const profile=agentRuntimeProfile('opencode',{available:true,availability:'available'});
 const tools=profile.tool_runtime_style?verified('host_mediated_'+profile.tool_runtime_style):unverified('tool_mediation_unproven');
 const cancel=profile.hard_cancel?verified('hard_cancel_supported'):unverified('cancellation_unproven');
 const publish=profile.result_publication?verified('result_publication_supported'):unverified('result_publication_unproven');
 const recovery=profile.lifecycle_observation?verified('lifecycle_observation'):unverified('recovery_unproven');
 const credentials=unverified('credential_isolation_requires_fresh_host_probe');
 // Qualification config is host evidence of a prior confined probe, not a live claim.
 let qualified=false;
 try{
  const q=require('../config/agent-runtime-qualification-v1.json').opencode;
  qualified=q?.execution_qualified===true&&typeof q.executable_sha256==='string';
 }catch{qualified=false;}
 const workspace=qualified?verified('qualified_artifact_and_scoped_profile'):(profile.workspace_write&&profile.tool_runtime_style==='disposable_scoped_files'?verified('profile_disposable_scoped_files'):unverified('workspace_confinement_unproven'));
 return summary('opencode',{workspace_confinement:workspace,tool_mediation:tools,credential_isolation:credentials,cancellation:cancel,result_publication:publish,recovery_support:recovery},{qualification_config:qualified,bridge_present:!!bridge});
}

function classifyHost(){
 const profile=agentRuntimeProfile('host',{available:true,availability:'available'});
 return summary('host',{
  workspace_confinement:verified('native_capability_broker'),
  tool_mediation:verified('typed_native_tools'),
  credential_isolation:verified('vault_and_broker_boundaries'),
  cancellation:unsupported('host_hard_cancel_not_claimed'),
  result_publication:verified('control_plane_results'),
  recovery_support:verified('control_plane_recovery')
 },{profile:profile.transport});
}

function classifyOllama(){
 return summary('ollama',{
  workspace_confinement:unsupported('model_provider_has_no_workspace'),
  tool_mediation:unsupported('model_provider_has_no_tools'),
  credential_isolation:verified('loopback_local_only_policy'),
  cancellation:verified('abort_signal_supported'),
  result_publication:verified('bounded_visible_text'),
  recovery_support:unsupported('stateless_inference')
 },{kind:'model_provider'});
}

function classifyProfile(id,observation={}){
 const profile=agentRuntimeProfile(id,observation);
 const map={
  workspace_confinement:profile.workspace_write?unverified('workspace_write_declared_not_host_proven'):unsupported('no_workspace_write'),
  tool_mediation:profile.tool_runtime_style?unverified('tool_style_'+profile.tool_runtime_style):unverified('tool_mediation_unknown'),
  credential_isolation:unverified('credential_isolation_unproven'),
  cancellation:profile.hard_cancel?verified('hard_cancel_declared'):unverified('cancellation_unproven'),
  result_publication:profile.result_publication?verified('result_publication_declared'):unverified('result_publication_unproven'),
  recovery_support:profile.lifecycle_observation?unverified('lifecycle_observation_declared'):unverified('recovery_unproven')
 };
 if(id==='cursor')map.workspace_confinement=unsupported('cursor_execution_unqualified');
 if(id==='codex'){map.result_publication=verified('handoff_artifact_publication');map.cancellation=unverified('external_cycle_cancel');}
 return summary(id,map,{kind:'agent_runtime',availability:profile.availability});
}

function summary(adapter,properties,extra={}){
 const states=Object.fromEntries(CONFIG.properties.map(p=>[p,properties[p]||unverified('missing')]));
 return {adapter,kind:CONFIG.adapters[adapter]?.kind||extra.kind||'unknown',schema_version:CONFIG.schema_version,properties:states,extra,authority:false};
}

function evaluate(bridge,{adapters=['opencode','host','ollama','claude_code','codex','cursor']}={}){
 const items=[];
 for(const id of adapters){
  if(id==='opencode')items.push(classifyOpenCode(bridge));
  else if(id==='host')items.push(classifyHost());
  else if(id==='ollama')items.push(classifyOllama());
  else items.push(classifyProfile(id));
 }
 return {schema_version:CONFIG.schema_version,family:CONFIG.family,policy:CONFIG.policy,items,observed_at:Date.now(),authority:false};
}

function assignmentFromConformance(mission_id,worker,model,conformanceItem,{required=[]}={}){
 const security=Object.fromEntries(CONFIG.properties.map(p=>[p,conformanceItem.properties[p]?.state||'UNVERIFIED']));
 const assignment=stamp('WorkerAssignment',{mission_id,worker,model,security});
 if(required.length)assertAssignmentSecurity(assignment,{required});
 else assertAssignmentSecurity(assignment);
 return assignment;
}

function failClosed(conformanceItem,required=[]){
 for(const property of required){
  if(conformanceItem.properties[property]?.state!=='VERIFIED'){
   return {allowed:false,reason:'unproven_security_property',property,state:conformanceItem.properties[property]?.state||'missing'};
  }
 }
 return {allowed:true,reason:null};
}

module.exports={CONFIG,evaluate,classifyOpenCode,classifyHost,classifyOllama,classifyProfile,assignmentFromConformance,failClosed,verified,unverified,unsupported};
