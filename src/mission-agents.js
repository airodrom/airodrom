'use strict';
class MissionAgents {
  constructor(bridge,store){this.bridge=bridge;this.store=store;}
  async refresh(){
    const detected=await this.bridge.capabilityHost.agentStatus();
    const claude=detected.claude_code||{},cursor=detected.cursor||{};
    const observations={
      opencode:{...(await this.bridge.opencodeAdapter.readiness()),kind:'agent',capabilities:this.bridge.opencodeAdapter.capabilities(),boundary:'disposable scoped workspace; canonical broker applies changes'},
      codex:this.bridge.codexAdapter?.health()||{kind:'agent',implemented:false,available:false,reason:'adapter_unavailable'},
      host:{kind:'control_plane_capability',implemented:true,available:!this.bridge.closed,capabilities:['verification','local_tools'],boundary:'bridge typed capabilities',reason:this.bridge.closed?'stopped':null},
      claude_code:{kind:'agent',version:claude.version||null,authenticated:claude.authenticated===true,running_jobs:claude.running_jobs||0,jobs:claude.jobs||[],implemented:true,installed:claude.installed===true,available:claude.availability==='available'&&claude.auth_mode==='subscription'&&!claude.api_key_overrides_subscription&&!(claude.running_jobs>0),auth_mode:claude.auth_mode,subscription:claude.subscription||'unknown',capabilities:['coding'],boundary:'local Claude CLI; not an OS sandbox',reason:claude.running_jobs>0?'busy':claude.availability==='available'?(claude.auth_mode==='subscription'?null:'subscription_required'):claude.availability,concurrency:1},
      cursor:{kind:'agent',installed:cursor.installed===true,implemented:true,available:false,capabilities:[],editor_available:cursor.installed===true,runtime:cursor.runtime||null,reason:cursor.runtime?.reason||'cursor_execution_unqualified'},
      chatgpt:{kind:'orchestrator',implemented:true,available:null,reason:'remote client connection not probed'}
    };
    for(const [id,observation]of Object.entries(observations)){
      if(id!=='chatgpt'){
        const active=this.store.db.prepare("SELECT id,state FROM cp_runs WHERE agent_id=? AND state NOT IN ('completed','failed','cancelled','interrupted') ORDER BY created_at DESC LIMIT 1").get(id);
        const last=this.store.db.prepare("SELECT id,ended_at FROM cp_runs WHERE agent_id=? AND state='completed' ORDER BY ended_at DESC LIMIT 1").get(id);
        const lastFailure=this.store.db.prepare("SELECT state FROM cp_runs WHERE agent_id=? AND state IN ('failed','interrupted','cancelled') ORDER BY updated_at DESC LIMIT 1").get(id);
        observation.last_safe_error_class=observation.operational?.last_safe_error_class||(id==='cursor'?['quota_limited','auth_required'].includes(cursor.runtime?.availability)?cursor.runtime.availability:null:lastFailure?.state==='failed'?'agent_run_failed':lastFailure?.state==='interrupted'?'termination_unverified':lastFailure?.state==='cancelled'?'cancelled':null);
        observation.active_run=active||observation.active_run||null;observation.last_success=last||null;
        observation.availability=id==='claude_code'?(observation.available?'available':observation.reason==='busy'?'busy':!claude.installed?'unavailable':claude.availability==='needs_login'?'auth_required':'unavailable'):id==='host'?(observation.available?'available':'unavailable'):undefined;
        observation.runtime_profile=require('./agent-runtime-profile').agentRuntimeProfile(id,observation);
      }
      this.store.observeAgent(id,observation.kind,observation);
    }
    // Agent occupancy does not determine reasoning provider session health.
    this.bridge.providerGateway?.registry.observeRuntime('codex_openai',{configured:observations.codex.implemented===true,state:'unknown'});
    return observations;
  }
  async select(envelope){
    if(envelope.kind!=='coding')throw Error('Unsupported Mission task kind');
    if(!envelope.capability_scopes.includes('repo')||(envelope.task_type!=='local_files'&&!envelope.capability_scopes.includes('developer_environment')))throw Error('Mission scopes do not permit Claude coding');
    const fixture=process.env.NODE_ENV==='test'&&this.bridge.options.allowFixtureWorker===true;
    if(!fixture&&[envelope.preferred_agent,...envelope.fallback_agents].some(w=>['codex','claude_code','cursor'].includes(w)))throw Error('worker_execution_unqualified');
    const observations=await this.refresh(),p=envelope.dispatch_policy;
    if(this.bridge.authorityRuntime?.routing){const row=this.store.db.prepare('SELECT id FROM cp_missions WHERE envelope=?').get(JSON.stringify(envelope));if(!row)throw Error('Routing requires a persisted Mission');return this.bridge.authorityRuntime.route(this.store.getMission(row.id),observations);}
    const automatic=envelope.route_mode==='automatic';
    const handoff=!!p&&p.privacy==='cloud_allowed'&&p.billing_classes.includes('subscription')&&p.providers.includes('codex_openai');
    const writerConflict=!!this.store.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined')").get(envelope.workspace);
    if(!automatic&&envelope.preferred_agent==='codex'&&p&&!writerConflict)return{selected:'codex',selected_agent:'codex',provider:'codex_openai',selected_provider:'codex_openai',transport:'handoff',external_cycle_required:true,reason:'durable_external_dispatch_intent',rejected:[],skipped:[],fallback_plan:envelope.fallback_agents,wait_reason:null,checked_at:Date.now()};
    const route=require('./agent-routing').routeTask({writer_conflict:writerConflict,task_type:envelope.task_type||'focused_refactor',candidate_order:envelope.route_mode==='default'?[envelope.preferred_agent]:automatic?require('./agent-routing').legacyOrder(envelope.task_type):[envelope.preferred_agent,...envelope.fallback_agents],allow_handoff:handoff,privacy:p?.privacy,allowed_providers:p?.providers?.length?p.providers:undefined,allowed_cost_classes:p?.billing_classes?.length?p.billing_classes:undefined,required_capabilities:envelope.task_type==='local_files'?undefined:['coding']},observations);
    return {...route,skipped:route.rejected,checked_at:Date.now()};
  }
}
module.exports={MissionAgents};
