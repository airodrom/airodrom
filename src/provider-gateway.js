'use strict';
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {transaction}=require('./control-transaction');
const {initialProfiles}=require('./provider-profiles');
const {dataPolicy}=require('./provider-policy');
const {validateRequest}=require('./provider-envelope');
const {ProviderReliability,STATES}=require('./provider-reliability');
const {ProviderSecrets}=require('./provider-secrets');
const {OpenAICompatibleProvider}=require('./openai-compatible-provider');
const {safeValue}=require('./secret-observation');
const {AnthropicSubscriptionProvider}=require('./anthropic-subscription-provider');
const COST=['free/local','low','medium','high','unknown'],LATENCY=['low','medium','high','unknown'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function prepareProviderRequestIdentitySchema(db){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_provider_requests'").get())return;
  if(!db.prepare('PRAGMA table_info(cp_provider_requests)').all().some(c=>c.name==='record_id'))db.exec('ALTER TABLE cp_provider_requests ADD COLUMN record_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cp_provider_request_record_identity ON cp_provider_requests(record_id) WHERE record_id IS NOT NULL');
}
function prepareLegacyProviderRequestIdentities(db){
  return transaction(db,()=>{
    prepareProviderRequestIdentitySchema(db);
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_provider_requests'").get())return{assigned_records:0,authority:false};
    const rows=db.prepare('SELECT run_id,request_id,record_id FROM cp_provider_requests ORDER BY run_id,request_id').all();
    if(rows.some(r=>r.record_id!==null&&!UUID.test(r.record_id)))throw Error('Unsupported provider request identity origin');
    let count=0;
    for(const r of rows)if(r.record_id===null){db.prepare('UPDATE cp_provider_requests SET record_id=? WHERE run_id=? AND request_id=? AND record_id IS NULL').run(randomUUID(),r.run_id,r.request_id);count++;}
    return{assigned_records:count,authority:false};
  });
}
function rejectionClass(reason) {
  if(['local_only','external_not_approved','unknown_data_class','secrets_prohibited'].includes(reason))return 'privacy_denied';
  if(['required_capability_unknown_or_unsupported','reasoning_mode_mismatch'].includes(reason))return 'model_ineligible';
  if(reason==='context_limit_unknown_or_exceeded')return 'context_window_insufficient';
  if(reason==='output_limit_unknown_or_exceeded')return 'capability_mismatch';
  if(reason==='provider_model_requirement')return 'model_unavailable';
  if(reason==='auth_required')return reason;
  if(['circuit_open','half_open_probe_active'].includes(reason))return 'circuit_open';
  if(reason==='admission_provider_not_approved')return 'task_class_ineligible';
  return 'provider_unavailable';
}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function loadConfig(file) {
  if(!file||!fs.existsSync(file))return {};
  const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>64000)throw Error('Unsafe provider configuration');
  const c=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!c||Object.keys(c).some(k=>!['version','providers'].includes(k))||c.version!==1||!c.providers||typeof c.providers!=='object')throw Error('Invalid provider configuration');
  return c.providers;
}
class ProviderRegistry {
  #entries=new Map();
  constructor({config={},secrets=new ProviderSecrets(),request=fetch,profiles=initialProfiles(),now=Date.now}={}) {
    this.now=now;
    for(const original of profiles) {
      const p=structuredClone(original),c=config[p.id]||{};
      if(Object.keys(c).some(k=>!['enabled','base_url','secret_reference','models','cost_class','latency_class'].includes(k)))throw Error('Provider config must contain references only');
      if(c.secret_reference!=null&&(typeof c.secret_reference!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{1,40}[:/][A-Za-z0-9_./-]{1,150}$/.test(c.secret_reference)||require('./provider-policy').secretLike(c.secret_reference)))throw Error('Invalid provider secret reference');
      if(c.models){if(p.id!=='openai_compatible'||!Array.isArray(c.models))throw Error('Model override requires generic profile');p.models=structuredClone(c.models);}
      if(c.models?.some(m=>Object.keys(m).some(k=>!['id','profile_id','capabilities','max_context','max_output','cost_class','latency_class','thinking_mode','quirks'].includes(k)))||c.models&&require('./provider-policy').secretLike(c.models))throw Error('Unsafe model metadata');
      for(const m of p.models){if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(m.id||'')||m.profile_id&&!/^[A-Za-z0-9_.:-]{1,160}$/.test(m.profile_id)||!m.capabilities||Object.values(m.capabilities).some(v=>![true,false,null].includes(v))||m.thinking_mode&&!['enabled','disabled'].includes(m.thinking_mode))throw Error('Invalid model profile');
        for(const k of ['max_context','max_output'])if(m[k]!=null&&(!Number.isSafeInteger(m[k])||m[k]<1))throw Error('Invalid model limits');
        m.cost_class=COST.includes(c.cost_class||m.cost_class)?c.cost_class||m.cost_class:'unknown';m.latency_class=LATENCY.includes(c.latency_class||m.latency_class)?c.latency_class||m.latency_class:'unknown';}
      freeze(p);
      const base=c.base_url||(p.id==='ollama'?'http://127.0.0.1:11434/v1':p.id==='deepseek'?'https://api.deepseek.com':null);
      const adapter=p.id==='anthropic_subscription'?new AnthropicSubscriptionProvider({profile:p,enabled:c.enabled===true}):p.runtime_only||!base?null:new OpenAICompatibleProvider({profile:p,baseUrl:base,secret:secrets.forProvider(p.id),request});
      this.#entries.set(p.id,{profile:p,adapter,enabled:c.enabled===true,observation:{state:'unknown'}});
    }
    if(Object.keys(config).some(id=>!this.#entries.has(id)))throw Error('Unknown configured provider');
  }
  get(id){return this.#entries.get(id)||null;}
  observe(id,state){const e=this.get(id);if(!e||!STATES.has(state))throw Error('Invalid provider observation');e.observation={state,checked_at:this.now()};}
  observeRuntime(id,{configured=false,state='unknown'}={}){const e=this.get(id);if(!e?.profile.runtime_only||!STATES.has(state))throw Error('Invalid runtime observation');e.observation={state,configured:configured===true,checked_at:Date.now()};}
  entries(){return [...this.#entries.values()];}
  views(reliability) {return this.entries().map(e=>{
    const h=e.adapter?.health()||{configured:e.observation.configured===true,state:'unknown'};
    return {id:e.profile.id,kind:'provider',protocol:e.profile.protocol,implemented:e.profile.implemented,configured:h.configured,enabled:e.profile.runtime_only?null:e.enabled,runtime_only:!!e.profile.runtime_only,reason:h.reason||null,transport:h.transport||e.profile.protocol,sandbox_verified:h.sandbox_verified===true,session_health:h.session_health||null,auth_state:e.profile.runtime_only?(h.auth_state||'managed_by_agent_runtime'):h.state==='auth_required'?'auth_required':e.profile.auth_required?'not_verified':'not_required',availability:e.profile.runtime_only?(e.adapter?h.state:e.observation.state):h.state==='auth_required'?'auth_required':!e.enabled?'unavailable':e.observation.state,locality:e.profile.locality,privacy_class:e.profile.privacy_class,execution_authority:false,models:e.profile.models.map(m=>({...m,circuit:reliability.view(e.profile.id+':'+(m.profile_id||m.id))}))};
  });}
}
class ProviderRouter {
  constructor(registry,reliability,{persist=()=>{}}={}){this.registry=registry;this.reliability=reliability;this.persist=persist;}
  plan(input) {
    const result={request_id:input.request_id,run_id:input.run_id,selected_agent:input.selected_agent||null,selected_provider:null,selected_model:null,selected_profile:null,agent_rationale:'host_selected_agent',provider_rationale:null,data_class:input.data_class||'unknown',privacy:input.privacy||'project_policy',rejected:[],fallback_order:[],wait_reason:null,execution_authority:false};
    const finish=()=>{result.evaluated=true;result.provider_rejection_reasons=Object.fromEntries(result.rejected.map(r=>[r.provider,rejectionClass(r.reason)]));result.rejected_providers=[...new Set(result.rejected.map(r=>r.provider))];result.automatic_switch=!!result.selected_provider&&result.selected_provider!=='ollama'&&result.rejected_providers.includes('ollama');result.fallback_plan=result.fallback_order;this.persist(result);return result;};
    if(input.deterministic===true){result.provider_rationale='deterministic_provider_independent';result.status='bypass';return finish();}
    if(input.unknown_side_effects||input.execution_started){result.status='waiting';result.wait_reason='reconcile_unknown_side_effects';return finish();}
    const req=new Set(['chat',...(input.requirements||[])]);
    if(input.tools?.length)req.add('tool_calling');if(input.tool_choice==='required'||typeof input.tool_choice==='object')req.add('forced_tool_choice');if(input.structured_schema)req.add('json_output');if(input.strict_schema)req.add('strict_schema');if(input.stream)req.add('streaming');if(input.reasoning_mode==='enabled')req.add('thinking');if(input.temperature!=null)req.add('temperature');
    const eligible=[];
    for(const e of this.registry.entries())for(const m of e.profile.models) {
      const id=e.profile.id,key=id+':'+(m.profile_id||m.id),circuit=this.reliability.view(key),policy=dataPolicy(input,e.profile);let reason=null;
      if(input.allowed_providers && !input.allowed_providers.includes(id))reason='admission_provider_not_approved';
      else if(!policy.allow)reason=policy.reason;
      else if(input.required_provider&&id!==input.required_provider||input.required_model&&m.id!==input.required_model)reason='provider_model_requirement';
      else if(e.adapter?.health().state==='auth_required')reason='auth_required';
      else if(e.profile.runtime_only&&!e.adapter?.health().configured)reason=e.adapter?.health().reason||'agent_transport_required';
      else if(!e.adapter)reason='adapter_unconfigured';
      else if([...req].some(k=>m.capabilities[k]!==true))reason='required_capability_unknown_or_unsupported';
      else if(input.reasoning_mode&&m.thinking_mode!==input.reasoning_mode)reason='reasoning_mode_mismatch';
      else if(Math.max(input.context_tokens||0,Buffer.byteLength(JSON.stringify({messages:input.messages,tools:input.tools,structured_schema:input.structured_schema})))+(input.max_output||8192)>(m.max_context||Infinity)||input.context_tokens&&!m.max_context)reason='context_limit_unknown_or_exceeded';
      else if(input.max_output&&(!m.max_output||input.max_output>m.max_output))reason='output_limit_unknown_or_exceeded';
      else if(!e.enabled)reason=e.adapter.health().state==='auth_required'?'auth_required':'provider_disabled';
      else if(e.adapter.health().state==='auth_required')reason='auth_required';
      else if(input.failed_providers?.includes(id))reason='prior_failure';
      else if(circuit.circuit==='OPEN')reason='circuit_open';
      else if(circuit.probe_active)reason='half_open_probe_active';
      else if(circuit.state==='auth_required'||circuit.state==='quota_limited'&&circuit.circuit!=='HALF_OPEN')reason=circuit.state;
      else if(!['available','degraded'].includes(e.observation.state)&&circuit.last_success_at===null&&!e.profile.runtime_only)reason=e.observation.state;
      else if(['unavailable','quota_limited','auth_required','circuit_open'].includes(e.observation.state))reason=e.observation.state;
      else if(!e.profile.runtime_only&&circuit.circuit!=='HALF_OPEN'&&Math.max(e.observation.checked_at||0,circuit.last_success_at||0)+60000<this.reliability.now())reason='stale_provider_health';
      if(reason){result.rejected.push({provider:id,model:m.id,profile:m.profile_id||m.id,reason});continue;}
      eligible.push({id,m,key,circuit});
    }
    eligible.sort((a,b)=>(a.id==='ollama'?0:1)-(b.id==='ollama'?0:1)||(a.circuit.circuit==='HALF_OPEN'?1:0)-(b.circuit.circuit==='HALF_OPEN'?1:0)||(input.cost_preference==='low'?COST.indexOf(a.m.cost_class)-COST.indexOf(b.m.cost_class):0)||(input.latency_preference==='low'?LATENCY.indexOf(a.m.latency_class)-LATENCY.indexOf(b.m.latency_class):0)||a.key.localeCompare(b.key));
    result.eligible_providers=eligible.map(e=>({provider:e.id,model:e.m.id,profile:e.m.profile_id||e.m.id}));
    result.fallback_order=eligible.map(e=>({provider:e.id,model:e.m.id,profile:e.m.profile_id||e.m.id}));
    const first=eligible[0];result.status=first?'selected':'waiting';result.wait_reason=first?null:'no_eligible_provider';result.selected_provider=first?.id||null;result.selected_model=first?.m.id||null;result.selected_profile=first?(first.m.profile_id||first.m.id):null;result.provider_rationale=first?'privacy_capability_availability_context_reliability_then_preference':null;result.cost_class=first?.m.cost_class||'unknown';result.latency_class=first?.m.latency_class||'unknown';return finish();
  }
}
class ProviderGateway {
  #authorize;
  constructor({db=null,config={},secretReader=null,request=fetch,authorize=()=>false,now=Date.now}={}) {
    this.db=db;this.now=now;this.#authorize=authorize;
    const references=Object.fromEntries(Object.entries(config).filter(([,c])=>c.secret_reference).map(([id,c])=>[id,c.secret_reference]));
    const secrets=new ProviderSecrets({references,read:secretReader});
    this.registry=new ProviderRegistry({config,secrets,request,now});this.reliability=new ProviderReliability({db,now});this.decisions=[];
    db?.exec(`CREATE TABLE IF NOT EXISTS cp_provider_routes(id INTEGER PRIMARY KEY,run_id TEXT NOT NULL,request_id TEXT NOT NULL,record TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cp_provider_requests(run_id TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,record_id TEXT,PRIMARY KEY(run_id,request_id));`);
    if(db)prepareProviderRequestIdentitySchema(db);
    this.router=new ProviderRouter(this.registry,this.reliability,{persist:r=>{if(!db){this.decisions.push(r);if(this.decisions.length>100)this.decisions.shift();}db?.prepare('INSERT INTO cp_provider_routes(run_id,request_id,record,created_at) VALUES(?,?,?,?)').run(r.run_id||'preview',r.request_id||'preview',JSON.stringify(safeValue(r)),now());}});
    this.consumed=new Set();
  }
  assertReadable(){if(this.db)require('./memory-content-erasure').assertReadable(this.db);}
  assertRunReadable(runId){this.assertReadable();if(this.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_erasure_content_rows'").get()&&this.db.prepare("SELECT 1 FROM cp_provider_requests p JOIN memory_erasure_content_rows e ON e.table_name='cp_provider_requests' AND e.row_key=json_array(p.record_id) WHERE p.run_id=?").get(runId))throw Error('Provider request context erased; replay unavailable');}
  plan(input){this.assertRunReadable(input.run_id);return this.router.plan(input);}
  routes({run_id=null,limit=100}={}) {this.assertReadable();if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid provider page');return this.db?this.db.prepare(`SELECT record FROM cp_provider_routes ${run_id?'WHERE run_id=?':''} ORDER BY id DESC LIMIT ?`).all(...(run_id?[run_id]:[]),limit).map(r=>JSON.parse(r.record)):this.decisions.filter(r=>!run_id||r.run_id===run_id).slice(-limit).reverse();}
  views(){return safeValue({items:this.registry.views(this.reliability),routes:this.routes(),execution_authority:false});}
  async execute(input,{signal,probe=null}={}) {
    this.assertReadable();
    try{input=freeze(structuredClone(input));validateRequest(input);}catch{return {status:'failed',error_class:'invalid_request',accepted:false,execution_authority:false};}
    // Host validates immutable request/run binding and reasoning admission.
    if(await this.#authorize(input)!==true)return {status:'failed',error_class:'reasoning_admission_denied',accepted:false,execution_authority:false};
    this.assertRunReadable(input.run_id);
    const key=input.run_id+':'+input.request_id;
    if((!this.db&&this.consumed.has(key))||this.db?.prepare('SELECT state FROM cp_provider_requests WHERE run_id=? AND request_id=?').get(input.run_id,input.request_id))return {status:'waiting',wait_reason:'request_replay_or_reconcile',accepted:false,execution_authority:false};
    const recordId=randomUUID();
    if(!this.db)this.consumed.add(key);this.db?.prepare('INSERT INTO cp_provider_requests(run_id,request_id,state,record_id) VALUES(?,?,?,?)').run(input.run_id,input.request_id,'consumed',recordId);
    try {
      const plan=this.plan(input);if(plan.status!=='selected')return {...plan,accepted:false};
      for(const candidate of plan.fallback_order) {
        if(signal?.aborted)return {status:'failed',error_class:'cancelled',accepted:false,execution_authority:false};
        const e=this.registry.get(candidate.provider),m=e.profile.models.find(m=>(m.profile_id||m.id)===candidate.profile),circuitKey=e.profile.id+':'+candidate.profile;
        if(!this.reliability.enter(circuitKey))continue;
        let outcome;
        for(let attempt=0;attempt<=this.reliability.maxRetries;attempt++) {
          if(probe==='ollama_unavailable'&&e.profile.id==='ollama') {
            // Host-only synthetic seam: no local/global configuration changes or dispatch.
            outcome={status:'failed',error_class:'temporary_failure',state:'unavailable',retryable:false,execution_authority:false,accepted:false};
            this.router.persist({...plan,status:'unavailable',selected_provider:'ollama',provider_rationale:'host_synthetic_local_unavailable',execution_authority:false});
            break;
          }
          this.assertRunReadable(input.run_id);
          try{this.beforeInference?.(input,e.profile.id,attempt,candidate.profile,recordId);}catch{return{status:'waiting',wait_reason:'mission_manifest_budget_or_provider_denied',accepted:false,execution_authority:false};}
          this.assertRunReadable(input.run_id);
          outcome=await e.adapter.execute(input,m,{signal});
          this.assertRunReadable(input.run_id);
          if(outcome.status==='completed'){this.reliability.success(circuitKey);this.router.persist({...plan,selected_provider:e.profile.id,selected_model:m.id,selected_profile:candidate.profile,automatic_switch:plan.automatic_switch||candidate.provider!==plan.selected_provider,provider_rationale:candidate.provider===plan.selected_provider&&candidate.profile===plan.selected_profile?'completed_selected_provider':'completed_allowed_fallback',status:'completed'});return {...outcome,selected_agent:input.selected_agent||null};}
          this.reliability.failure(circuitKey,outcome);
          if(outcome.state==='auth_required')this.registry.observe(e.profile.id,'auth_required');
          // Adapter performs inference only. No tool execution occurs between attempts.
          if(!outcome.retryable||input.stream||attempt===this.reliability.maxRetries||this.reliability.view(circuitKey).circuit==='OPEN')break;
        }
        if(['policy_reject','invalid_request','invalid_response','cancelled','unknown_side_effects','unknown_error'].includes(outcome.error_class))return outcome;
      }
      const after=this.plan(input);return {...after,status:'waiting',wait_reason:'provider_failure_or_cooldown',accepted:false};
    }finally{if(this.db){const retired=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_erasure_content_rows'").get()&&this.db.prepare("SELECT 1 FROM memory_erasure_content_rows WHERE table_name='cp_provider_requests' AND row_key=json_array(?)").get(recordId);if(!retired)this.db.prepare("UPDATE cp_provider_requests SET state='settled' WHERE record_id=?").run(recordId);}}
  }
}
module.exports={ProviderRegistry,ProviderRouter,ProviderGateway,loadConfig,prepareProviderRequestIdentitySchema,prepareLegacyProviderRequestIdentities};
