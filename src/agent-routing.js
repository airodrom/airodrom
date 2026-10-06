'use strict';
// Deterministic advice, separate from execution authority. No invented scores.
const PROVIDERS={pi:null,opencode:'local',claude_code:'anthropic_subscription',codex:'codex_openai',cursor:'cursor_runtime'};
function legacyOrder(taskType){return ['local_diagnostics','local_files','tests','git'].includes(taskType)?['pi']:taskType==='ide_diagnostics'?['cursor','claude_code']:['broad_investigation','large_multi_file_coding'].includes(taskType)?['codex','claude_code']:['claude_code','codex'];}
function routeTask(input,agents){
 const types=['local_diagnostics','local_files','tests','git','focused_refactor','broad_investigation','large_multi_file_coding','ide_diagnostics'];
 if(!types.includes(input.task_type))return{selected:null,reason:'unknown_task_type',rejected:[],execution:'not_dispatched'};
 const deterministic=['local_diagnostics','local_files','tests','git'].includes(input.task_type);
 const order=input.candidate_order|| (deterministic?['pi']:[require('./default-runtime').DEFAULT_RUNTIME]);
 if(!Array.isArray(order)||order.some(id=>!['pi','opencode','claude_code','codex','cursor'].includes(id)))return{selected:null,reason:'invalid_agent_policy',rejected:[],execution:'not_dispatched'};
 const rejected=[];
 const required=input.required_capabilities||[];
 const wait=reason=>({selected:null,selected_agent:null,provider:null,selected_provider:null,reason,wait_reason:reason,rejected,fallback_plan:[],state:'WAIT',execution:'not_dispatched'});
 if(!Array.isArray(required))return wait('invalid_required_capabilities');if(input.writer_conflict)return wait('workspace_writer');
 if(input.unknown_side_effects)return wait('reconcile_unknown_side_effects');
 for(const id of order){const a=agents[id],profile=a?.runtime_profile,provider=PROVIDERS[id];let reason=null;
  const state=profile?.availability||a?.availability||a?.state;
  const handoff=id==='codex'&&input.allow_handoff===true&&a?.implemented===true&&(!profile||profile.handoff_only===true)&&!['busy','auth_required','quota_limited','unknown','degraded'].includes(state);
  const available=a?.available===true&&(!profile||profile.direct_dispatch===true&&profile.available===true)&&(!state||state==='available');
  if(id==='cursor')reason='cursor_execution_unqualified';
  else if(input.allowed_agents&&!input.allowed_agents.includes(id))reason='agent_policy';
  else if(input.allowed_providers&&!input.allowed_providers.includes(provider||'local'))reason='provider_policy';
  else if(input.allowed_cost_classes&&!input.allowed_cost_classes.includes(profile?.cost_class|| (id==='pi'?'local':'subscription')))reason='cost_policy';
  else if(required.some(c=>!a?.capabilities?.includes(c)))reason='required_capability';
  else if(a?.operational?.circuit?.state==='open'&&a.operational.availability==='unavailable')reason='circuit_open';
  else if(input.privacy==='local_only'&&!deterministic&&id!=='opencode')reason='local_reasoning_transport_required';
  else if(input.required_provider&&provider!==input.required_provider)reason='provider_policy';
  else if(input.failed_agents?.includes(id))reason='prior_failure_requires_review';
  else if(input.unavailable_providers?.includes(provider))reason='provider_unavailable';
  else if(!available&&!handoff)reason=['busy','auth_required','quota_limited','unknown','degraded'].includes(state)?state:a?.reason||'agent_unavailable';
  if(reason){rejected.push({agent:id,reason});continue;}
  return{selected:id,selected_agent:id,provider,selected_provider:provider,transport:id==='codex'?'handoff':'native',external_cycle_required:id==='codex',wait_reason:null,state:'selected',reason:deterministic?'deterministic_provider_independent':rejected.length?'compatible_fallback':'task_taxonomy',classification_mode:'deterministic',rejected,fallback_plan:order.filter(x=>x!==id),execution:'not_dispatched'};
 }
 return wait('no_compatible_available_agent');
}
// Composition is advisory. A provider never substitutes for Work/CLI transport.
function routeTaskAndProvider(input,agents,providerRouter){
 const agent=routeTask(input,agents);
 const deterministic=agent.reason==='deterministic_provider_independent';
 const provider=deterministic?providerRouter.plan({...input.provider_request,selected_agent:agent.selected,deterministic:true}):
  input.generic_reasoning===true&&agent.selected?providerRouter.plan({...input.provider_request,selected_agent:agent.selected}):
  {status:agent.selected?'agent_runtime':'waiting',selected_agent:agent.selected,selected_provider:agent.provider||null,provider_rationale:'preserve_agent_transport',execution_authority:false};
 return {agent,provider,execution:'not_dispatched'};
}
module.exports={routeTask,routeTaskAndProvider,legacyOrder};
