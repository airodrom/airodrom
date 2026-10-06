'use strict';
// V1 product scope, never execution authority or observed availability.
const TIERS = Object.freeze(['REQUIRED','SUPPORTED','OPTIONAL','EXPERIMENTAL','UNSUPPORTED']);
const SUPPORT = Object.freeze({
  host: Object.freeze({tier:'REQUIRED',reason:'control_plane_primitives',agent_role:'HOST PRIMITIVES',agent_runtime:false}),
  claude_code: Object.freeze({tier:'SUPPORTED',reason:'qualified_optional_subscription_coding',agent_role:'OPTIONAL FALLBACK'}),
  opencode: Object.freeze({tier:'SUPPORTED',reason:'qualified_bounded_local_execution',agent_role:'DEFAULT / PRIMARY'}),
  codex: Object.freeze({tier:'OPTIONAL',reason:'external_work_platform_dependency',runtime_id:'work'}),
  cursor: Object.freeze({tier:'EXPERIMENTAL',reason:'governed_acp_execution_unqualified'}),
  cloud: Object.freeze({tier:'UNSUPPORTED',reason:'no_concrete_generic_cloud_runtime'})
});
function support(id){if(!SUPPORT[id])throw Error('Unknown runtime');return{...SUPPORT[id],required_for_private:SUPPORT[id].tier==='REQUIRED',authority:false};}
function cloudStatus(){return{agent_id:'cloud',kind:'agent_runtime',...support('cloud'),implemented:false,installed:false,available:false,auth_state:'not_applicable',transport:'unsupported',direct_dispatch:false,workspace_write:false,continuation:false,result_publication:false,lifecycle_observation:false,external_cycle_required:false,live_qualified:false,execution_authority:false};}
function denyCloudDispatch(){throw Error('Generic Cloud runtime intentionally unsupported');}
module.exports={TIERS,SUPPORT,support,cloudStatus,denyCloudDispatch};
