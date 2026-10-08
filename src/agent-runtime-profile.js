'use strict';
// Runtime claims come from bridge-owned observations, never task/Decision/memory text.
const STATES=new Set(['available','busy','unavailable','auth_required','quota_limited','degraded','handoff_only','unknown']);
const DEFINITIONS=Object.freeze({
 opencode:{transport:'local_standalone_cli',implemented:true,workspace_write:true,tool_runtime_style:'disposable_scoped_files',continuation:false,hard_cancel:true,result_publication:true,direct_dispatch:true,handoff_only:false,lifecycle_observation:true,external_cycle_required:false,cost_class:'local',latency_class:'agentic'},
 host:{transport:'native_capability_broker',implemented:true,workspace_write:true,tool_runtime_style:'typed_native',continuation:true,hard_cancel:false,result_publication:true,direct_dispatch:true,handoff_only:false,lifecycle_observation:true,external_cycle_required:false,cost_class:'local',latency_class:'local'},
 claude_code:{transport:'subscription_cli',implemented:true,workspace_write:true,tool_runtime_style:'bounded_cli_tools',continuation:true,hard_cancel:false,result_publication:true,direct_dispatch:true,handoff_only:false,lifecycle_observation:true,external_cycle_required:false,cost_class:'subscription',latency_class:'agentic'},
 codex:{transport:'handoff',implemented:true,workspace_write:true,tool_runtime_style:'external_work',continuation:true,hard_cancel:false,result_publication:true,direct_dispatch:false,handoff_only:true,lifecycle_observation:false,external_cycle_required:true,cost_class:'subscription',latency_class:'external_cycle'},
 cursor:{transport:'acp_stdio',implemented:true,workspace_write:false,tool_runtime_style:'acp_unqualified',continuation:false,hard_cancel:false,result_publication:false,direct_dispatch:false,handoff_only:false,lifecycle_observation:false,external_cycle_required:false,cost_class:'subscription',latency_class:'unknown'}
});
function agentRuntimeProfile(id,observation={}){
 if(observation.bounded_worker)return {agent_id:id,kind:'agent_runtime',transport:'bounded_local_cli',direct_dispatch:true,hard_cancel:true,result_publication:true,lifecycle_observation:true,external_cycle_required:false,execution_authority:false,locality:'external',isolation_verified:true,availability:observation.availability,available:observation.available,auth_state:observation.authenticated?'session_observed':'auth_required',quota_state:'unknown',circuit_state:'not_observed',cost_class:'subscription',qualification:observation.qualification,reason:observation.reason,model:observation.model};
 if(id==='cloud')return require('./runtime-support').cloudStatus();
 const definition=DEFINITIONS[id];if(!definition)throw Error('Unknown agent runtime');
 let availability=observation.availability||observation.state||(observation.available===true?'available':'unknown');
 if(id==='codex')availability=observation.operational?.availability==='busy'?'busy':['auth_required','quota_limited'].includes(observation.operational?.availability)?observation.operational.availability:observation.operational?.circuit?.state==='open'&&observation.operational?.availability==='unavailable'?'unavailable':'handoff_only';
 if(id==='cursor')availability=['auth_required','quota_limited'].includes(observation.runtime?.availability)?observation.runtime.availability:'unavailable';
 if(!STATES.has(availability))availability='unknown';
 if(observation.implemented===false)availability='unavailable';
 const auth_state=availability==='auth_required'?'auth_required':id==='opencode'?observation.auth_state||'unknown':id==='host'?'not_required':id==='claude_code'?observation.auth_mode==='subscription'?'session_observed':'unknown':id==='cursor'?observation.runtime?.auth_state||'unknown':'external_unknown';
 return{agent_id:id,kind:id==='host'?'control_plane_capability':'agent_runtime',support_tier:require('./runtime-support').support(id).tier,required_for_private:require('./runtime-support').support(id).required_for_private,memory_access_model:'canonical_authorized_context_only',...(id==='codex'?{runtime_id:'work',work_execution:observation.work_execution||null}:{}),...(['codex','cursor'].includes(id)?{external_execution_qualified:false,qualification:id==='codex'?'local_handoff_only':'execution_unqualified',qualification_provenance:'bridge_owned_runtime_definition'}:{}),...definition,implemented:definition.implemented&&observation.implemented!==false,availability,auth_state,quota_state:availability==='quota_limited'?'quota_limited':'unknown',lease_required:true,workspace_required:true,execution_authority:false,available:availability==='available'&&definition.direct_dispatch,active_run:observation.active_run||null,last_success:observation.last_success||null,last_safe_error_class:typeof observation.last_safe_error_class==='string'&&/^[a-z_]{1,80}$/.test(observation.last_safe_error_class)?observation.last_safe_error_class:null,circuit_state:observation.operational?.circuit?.state||'not_observed',result_relay_state:observation.relay?.state||'not_observed',reason:id==='cursor'?observation.runtime?.reason||'cursor_execution_unqualified':observation.reason||null};
}
function codexTransportState(health){
 const status=health.operational?.active_status||health.active_run?.state;
 if(health.relay?.state==='result_waiting'||['completion_waiting'].includes(status))return'result_waiting';
 if(status==='settled'||health.last_result&&!health.active_run)return'completion_known';
 if(['dispatching','accepted','running_unknown','cancellation_requested','termination_unverified'].includes(status))return'running_unknown';
 if(health.active_run)return'waiting_external_dispatch';
 if(['auth_required','quota_limited','unavailable'].includes(health.operational?.availability))return'transport_unavailable';
 return'available_handoff';
}
module.exports={agentRuntimeProfile,codexTransportState,STATES};
