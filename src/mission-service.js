'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {transaction,afterCommit}=require('./control-transaction');
const {text,identifier,object,fingerprint,redactValue}=require('./control-plane-store');
const {workspaceSnapshot}=require('./control-context');
const {repositoryRoot}=require('./control-execution');
const {MissionAgents}=require('./mission-agents');
const {MissionVerifier}=require('./mission-verifier');
const {normalizeResult}=require('./mission-result');
function relative(value){text(value,'file path',300);if(path.isAbsolute(value)||value.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'||p==='.git')||/(^|\/)(\.env|\.ssh|credentials|secrets)/i.test(value))throw Error('Unsafe Mission file path');return value;}
class MissionService {
  constructor(bridge){this.bridge=bridge;this.store=bridge.controlStore;this.db=this.store.db;this.db.exec('CREATE TABLE IF NOT EXISTS cp_continuity_checks(run_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,checked_at INTEGER NOT NULL)');this.program=new (require('./mission-program').MissionProgram)(this);this.codingAdapter=new (require('./qualified-coding-adapter').QualifiedCodingAdapter)(this);this.acceptanceEngine=new (require('./deterministic-acceptance').DeterministicAcceptance)(this);this.agents=new MissionAgents(bridge,this.store);this.verifier=new MissionVerifier(bridge,this.store);this.busy=false;this.stopped=false;}
  create(input,owner='operator'){
    object(input,['request_id','project_id','goal_id','objective','workspace','allowed_files','criteria','verification','preferred_agent','fallback_agents','capability_scopes','constraints','priority','fixture_auto_acceptance','dispatch_policy','task_type','continuity','target_domains','required_memory_keys','required_assurance','maxCostUsdBoundary','authority','manifest','coding_plan','automatic_acceptance']);
    if(input.continuity!==undefined&&!['prior_context','current_prompt'].includes(input.continuity))throw Error('Invalid continuity mode');
    for(const key of ['target_domains','required_memory_keys'])if(input[key]!==undefined&&(!Array.isArray(input[key])||input[key].length>20||input[key].some(v=>typeof v!=='string'||!v||v.length>120)))throw Error('Invalid typed memory requirement');
    if(input.required_assurance!==undefined&&(!Number.isInteger(input.required_assurance)||input.required_assurance<0||input.required_assurance>3))throw Error('Invalid required assurance');
    if(input.maxCostUsdBoundary!==undefined&&(!Number.isFinite(input.maxCostUsdBoundary)||input.maxCostUsdBoundary<0))throw Error('Invalid cost boundary');
    text(input.objective,'Mission objective',4000);identifier(input.request_id);
    const goal=this.bridge.projects.getGoal(input.goal_id);if(goal.projectId!==input.project_id)throw Error('Goal and Project do not match');
    const workspace=repositoryRoot(text(input.workspace,'workspace',1000));if(workspace!==fs.realpathSync(input.workspace))throw Error('Mission workspace must be repository root');
    if(!Array.isArray(input.allowed_files)||!input.allowed_files.length||input.allowed_files.length>40)throw Error('Explicit allowed files required');input.allowed_files.forEach(relative);
    if(input.allowed_files.some(f=>/(^|\/)(tests?|__tests__|\.vscode)(\/|$)|(^|\/)(package(?:-lock)?\.json|[^/]+\.(?:test|spec)\.[^/]+)$/.test(f)))throw Error('Verification inputs must remain protected');
    if(input.authority!==undefined&&owner!=='operator')throw Error('Only operator may set mission authority');
    const authority=input.authority===undefined?require('./mission-permissions').trustedDefault(workspace,this.bridge.options.trustedRepositoryDefaults||[]):require('./mission-permissions').normalizeAuthority(input.authority,{workspace,operator:owner==='operator'});
    const scopes=this.bridge.capabilityHost.policy.normalizeTaskScopes(input.capability_scopes||['repo','developer_environment']);
    if(input.coding_plan!==undefined){if(owner!=='operator'||input.dispatch_policy!==undefined||input.preferred_agent!==undefined||input.fallback_agents!==undefined||input.task_type!==undefined)throw Error('Coding plan requires operator registration and its fixed local route');input={...input,task_type:'local_files',preferred_agent:'pi',fallback_agents:[],dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:input.coding_plan.operations?.map(({name,path,content})=>({name,path,content}))}};}
    const taskType=input.task_type||'focused_refactor';
    if(!['focused_refactor','broad_investigation','large_multi_file_coding','ide_diagnostics','local_files'].includes(taskType))throw Error('Invalid agent task taxonomy');
    const automatic=input.preferred_agent===undefined;
    const preferred=input.preferred_agent||'claude_code',fallbacks=input.fallback_agents||(automatic?(taskType==='local_files'?[]:['broad_investigation','large_multi_file_coding'].includes(taskType)?['claude_code']:taskType==='ide_diagnostics'?['claude_code','codex']:['codex']):[]);
    if(!['claude_code','codex','cursor','pi'].includes(preferred)||!Array.isArray(fallbacks)||fallbacks.length>3||fallbacks.some(a=>!['claude_code','codex','cursor','pi'].includes(a)))throw Error('Invalid declared agent route');
    const criteria=input.criteria||[];if(!Array.isArray(criteria)||!criteria.length||criteria.length>10)throw Error('Acceptance criteria required');
    const ids=new Set();for(const c of criteria){object(c,['id','type','path','content','description']);identifier(c.id);if(ids.has(c.id))throw Error('Duplicate criterion');ids.add(c.id);if(c.type==='exact_file'){relative(c.path);if(!input.allowed_files.includes(c.path))throw Error('Expected file is outside declared changes');if(typeof c.content!=='string'||Buffer.byteLength(c.content)>12000)throw Error('Invalid expected content');text(c.content,'expected content',12000);}else{text(c.description,'criterion',1000);}}
    const verification=input.verification||{diff_check:'',tests:[],syntax:[]};object(verification,['diff_check','tests','syntax','typecheck','lint','benchmark']);text(verification.diff_check,'diff-check task',100);
    for(const key of ['tests','syntax','typecheck','lint','benchmark'].filter(k=>['tests','syntax'].includes(k)||verification[k]!==undefined))if(!Array.isArray(verification[key])||verification[key].length>8||verification[key].some(v=>typeof v!=='string'||!v||v.length>100))throw Error('Invalid registered verification tasks');
    if(!verification.tests.length)throw Error('At least one registered test required');
    if(input.constraints!==undefined)text(input.constraints,'constraints',2000);
    if(input.dispatch_policy!==undefined&&owner!=='operator')throw Error('Only operator may set immutable dispatch policy');
    const dispatchPolicy=input.dispatch_policy===undefined?null:require('./agent-dispatch').dispatchPolicy(input.dispatch_policy);
    if(taskType==='local_files'&&(!dispatchPolicy||!dispatchPolicy.native_actions.length||dispatchPolicy.task_category!=='deterministic_files'))throw Error('Deterministic routing requires an immutable native plan');
    if(dispatchPolicy&&dispatchPolicy.native_actions.some(a=>!input.allowed_files.includes(a.path)))throw Error('Native action outside Mission scope');
    if(input.manifest!==undefined&&owner!=='operator')throw Error('Only operator may register a Mission Manifest');
    const manifest=input.manifest===undefined?null:require('./mission-manifest').normalizeManifest(input.manifest,{workspace,allowedFiles:input.allowed_files,verification});
    const codingPlan=input.coding_plan===undefined?null:require('./qualified-coding-adapter').normalizePlan(input.coding_plan,{workspace,allowedFiles:input.allowed_files,manifest});
    if(input.automatic_acceptance!==undefined&&input.automatic_acceptance!==true)throw Error('Explicit automatic Acceptance must be true');
    if(input.automatic_acceptance&&(owner!=='operator'||!codingPlan||!manifest||criteria.some(c=>c.type!=='exact_file')||input.fixture_auto_acceptance||scopes.some(s=>!['repo','developer_environment'].includes(s))))throw Error('Automatic Acceptance requires operator, qualified coding plan and objective local criteria');
    const fixturePolicy=this.bridge.fixtureAcceptance.validateCreation({...input,workspace,criteria,capability_scopes:scopes},owner);
    const baseline=workspaceSnapshot(workspace);const verificationManifest=baseline.version===2?require('./repository-verification').manifest(baseline,input.allowed_files):null;if(baseline.dirty.some(f=>input.allowed_files.includes(f)))throw Error('Requested changes overlap pre-existing dirty work');
    return this.store.request(owner,input.request_id,{op:'create_mission',...input},()=>{
      const projectMission=this.bridge.projects.createMission({goalId:goal.goalId,name:input.objective.slice(0,180),description:input.objective,acceptanceCriteria:criteria.map(c=>c.description||`Verify ${c.id}`)});
      const envelope={control_version:2,...(codingPlan?{coding_plan:codingPlan}:{}),...(input.automatic_acceptance?{automatic_acceptance:true}:{}),...(manifest?{manifest}:{}),...(authority?{authority}:{}),...Object.fromEntries(['target_domains','required_memory_keys','required_assurance','maxCostUsdBoundary'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])),...(input.continuity?{continuity:input.continuity}:{}),route_mode:automatic?'automatic':'declared',task_type:taskType,...(dispatchPolicy?{dispatch_policy:dispatchPolicy}:{}),fixture_auto_acceptance:fixturePolicy,...(verificationManifest?{verification_manifest:verificationManifest}:{}),kind:'coding',objective:input.objective,workspace,allowed_files:input.allowed_files,criteria,verification,preferred_agent:preferred,fallback_agents:fallbacks,capability_scopes:scopes,constraints:input.constraints||'',priority:Number.isInteger(input.priority)?Math.max(0,Math.min(100,input.priority)):50,baseline};
      const task=this.newTask(projectMission.missionId,goal.projectId,envelope,owner,1);
      const m=this.store.registerMission({id:projectMission.missionId,projectId:goal.projectId,goalId:goal.goalId,taskId:task.id,owner,envelope,ceiling:{...(authority?{mission_authority:authority}:{}),capability_scopes:scopes,authority:'existing SafetyPolicy and signed authority only',policy_version:this.bridge.capabilityHost.policy.policyVersion}});
      this.db.prepare('INSERT INTO cp_mission_tasks VALUES(?,?,1,NULL,NULL,?)').run(task.id,m.id,Date.now());
      this.program.register(m);this.acceptanceEngine.register(m);
      if(fixturePolicy)this.store.event('fixture.auto_acceptance.authorized',m.id,{policy:fixturePolicy});
      this.store.event('task.created',m.id,{task_id:task.id});return this.detail(m.id,owner);
    });
  }
  newTask(missionId,projectId,envelope,owner,ordinal){
    const created=this.bridge.createTask(envelope.objective.slice(0,450),{workspace:envelope.workspace,projectId,capabilityScopes:envelope.capability_scopes,missionObjective:envelope.objective,...(envelope.authority?{missionAuthority:{level:envelope.authority.level,permissions:envelope.authority.permissions,filesystem:envelope.authority.filesystem,expiresAt:envelope.authority.expiresAt},authorityOperator:owner==='operator'}:{})});
    const task=this.bridge.tasks.get(created.id);task.controlPlaneMissionId=missionId;task.mission.manifest=envelope.manifest||null;task.controlPlaneOrdinal=ordinal;task.source={transport:owner==='mcp'?'mcp':'operator',principal:owner};task.orchestrator={mode:'direct'};task.mission.budget.maxRetries=0;task.status='queued';this.bridge.tasks.save(task);this.bridge.policy.registerTask(task);return task;
  }
  require(id,owner){return this.store.requireMission(id,owner==='operator'?null:owner);}
  detail(id,owner='operator'){
    const m=this.require(id,owner);return{...m,program_contract:this.program.detail(id),objective:m.envelope.objective,priority:m.envelope.priority,next_action:({ready:'dispatch',waiting_for_operator:'answer_decision',awaiting_acceptance:'accept_or_rework',needs_rework:'explicit_dispatch',blocked:'review_then_dispatch'})[m.state]||'inspect',tasks:this.db.prepare('SELECT * FROM cp_mission_tasks WHERE mission_id=? ORDER BY ordinal').all(id),runs:this.db.prepare('SELECT id FROM cp_runs WHERE mission_id=? ORDER BY created_at').all(id).map(r=>this.store.run(r.id)),decisions:this.store.decisions(id),verifications:this.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC').all(id).map(v=>({...v,evidence:JSON.parse(v.evidence)})),acceptance:this.db.prepare('SELECT * FROM cp_acceptances WHERE mission_id=? ORDER BY created_at DESC').all(id),artifacts:this.db.prepare('SELECT * FROM cp_artifacts WHERE mission_id=?').all(id),timeline:this.bridge.ledger.list({missionId:id,limit:100,order:'desc'}).events,results:this.db.prepare('SELECT run_id,normalized FROM cp_run_results WHERE mission_id=?').all(id).map(r=>({run_id:r.run_id,result:{...JSON.parse(r.normalized),continuity:JSON.parse(this.db.prepare('SELECT evidence FROM cp_continuity_checks WHERE run_id=?').get(r.run_id)?.evidence||'null')}})),dispatches:this.db.prepare('SELECT * FROM cp_dispatches WHERE mission_id=? ORDER BY created_at').all(id).map(d=>({...d,route:d.route?JSON.parse(d.route):null}))};
  }
  dispatch(id,{request_id},owner='operator'){
    const mission=this.require(id,owner);
    this.assertAuthority(mission);
    if(!this.bridge.authorityRuntime?.routing&&mission.envelope.preferred_agent==='codex'&&mission.envelope.dispatch_policy){const result=this.bridge.codexAdapter.startTask(id,request_id);this.bridge.agentDispatch.schedule();return result;}
    const result=this.store.request(owner,request_id,{op:'dispatch',id},()=>this.queue(id));this.schedule();return result;
  }
  assertAuthority(mission, requirements={}){
    this.program.assert(mission);
    const result=require('./mission-permissions').checkAuthority(mission.envelope.authority,requirements);
    if(!result.allow) {
      const task=this.bridge.tasks.get(mission.task_id);
      this.bridge._recordPolicyDenial(task,{toolName:'mission_dispatch'},{allow:false,kind:'mission_grant_denied',reason:result.reason});
      if(!['completed','cancelled','blocked'].includes(mission.state))this.store.state(mission.id,'blocked',result.reason);
      throw Error(result.reason);
    }
  }
  queue(id,decisionId=null){
    const m=this.store.requireMission(id);this.assertAuthority(m);if(!['ready','needs_rework','blocked','waiting_for_operator'].includes(m.state))throw Error('Mission cannot dispatch in its current state');
    if(m.state==='waiting_for_operator'&&!decisionId)throw Error('Mission requires its Decision answer');
    if(this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown')").get(id))throw Error('Mission has an active or uncertain dispatch; reconcile it first');
    if(m.state!=='ready')this.store.state(id,'ready');
    let task=this.bridge.tasks.get(m.task_id);const previous=this.db.prepare('SELECT max(ordinal) n FROM cp_mission_tasks WHERE mission_id=?').get(id).n||1;
    if(this.db.prepare('SELECT 1 FROM cp_dispatches WHERE task_id=?').get(task.id)){
      task=this.newTask(id,m.project_id,m.envelope,m.owner,previous+1);
      this.db.prepare('INSERT INTO cp_mission_tasks VALUES(?,?,?,NULL,NULL,?)').run(task.id,id,previous+1,Date.now());
      this.db.prepare('UPDATE cp_missions SET task_id=? WHERE id=?').run(task.id,id);this.store.event('task.created',id,{task_id:task.id});
      if(this.bridge.authorityRuntime?.active)this.db.prepare('UPDATE authority_missions SET task_id=? WHERE id=?').run(task.id,id);
    }
    const dispatch=randomUUID();this.db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'queued',?,NULL,NULL,?,?)").run(dispatch,id,task.id,decisionId,Date.now(),Date.now());
    this.db.prepare('UPDATE cp_mission_tasks SET dispatch_id=? WHERE task_id=?').run(dispatch,task.id);
    this.store.state(id,'dispatching');return{mission_id:id,task_id:task.id,dispatch_id:dispatch,status:'queued'};
  }
  schedule(){if(this.stopped||this.pending)return;this.pending=true;queueMicrotask(()=>{this.pending=false;this.tick().catch(()=>{});});}
  async tick(){
    if(this.busy||this.stopped||this.bridge.closed)return;this.busy=true;
    try{
      this.store.expireDecisions();this.acceptanceEngine.reconcile();this.program.tick();
      for(const c of this.db.prepare("SELECT * FROM cp_continuations WHERE state='queued'").all()){
        const m=this.store.getMission(c.mission_id);if(m?.envelope.control_version!==2)continue;
        const chains=this.db.prepare('SELECT c.* FROM cp_autonomy_claims a JOIN cp_autonomy_chains c ON c.id=a.chain_id WHERE a.mission_id=?').all(m.id);
        if(chains.some(chain=>{if(Date.now()-chain.started_at>=chain.max_runtime_ms){this.bridge.boundedNextActions.pause(chain.id,'runtime_budget');return true;}return chain.state==='paused';}))continue;
        if(m.state==='cancelled'){this.db.prepare("UPDATE cp_continuations SET state='cancelled' WHERE id=?").run(c.id);continue;}
        const answered=this.store.decision(c.decision_id);
        if(answered?.agent_id==='codex'){
          // Human input is evidence, never proof that the previous writer stopped.
          if(this.bridge.codexAdapter.getTask(answered.run_id).state!=='settled')continue;
          transaction(this.db,()=>{
            if(m.state!=='ready')this.store.state(m.id,'ready');
            const h=this.bridge.codexAdapter.startTask(m.id,`codex-continuation:${c.id}`,answered.id);
            this.db.prepare("UPDATE cp_continuations SET state='scheduled' WHERE id=? AND state='queued'").run(c.id);
            this.store.event('mission.resumed_after_decision',m.id,{decision_id:c.decision_id,dispatch_path:'codex_handoff',run_id:h.run_id});
          });continue;
        }
        transaction(this.db,()=>{this.queue(m.id,c.decision_id);this.db.prepare("UPDATE cp_continuations SET state='scheduled' WHERE id=? AND state='queued'").run(c.id);this.store.event('mission.resumed_after_decision',m.id,{decision_id:c.decision_id,dispatch_path:'decision_resume_native'});this.store.event('mission.resumed',m.id,{decision_id:c.decision_id});});
      }
      for(const row of this.db.prepare("SELECT * FROM cp_dispatches WHERE state='queued' ORDER BY created_at LIMIT 1").all())await this.launch(row);
      for(const row of this.db.prepare('SELECT * FROM cp_run_results WHERE processed_at=0').all()) {try{await this.processResult(row);}catch(error){const m=this.store.getMission(row.mission_id);if(!['cancelled','completed','blocked'].includes(m.state))this.store.state(m.id,'blocked','Structured result could not be processed safely');}}
    }finally{this.busy=false;}
  }
  async launch(dispatch){
    let m=this.store.getMission(dispatch.mission_id);if(m.state==='cancelled')return;
    try{
      const project=this.bridge.projects.getProject(m.project_id);if(project.status==='archived')throw Error('Project is archived');
      const unresolved=this.db.prepare("SELECT 1 FROM project_dependencies d LEFT JOIN project_missions p ON d.depends_on_type='mission' AND p.mission_id=d.depends_on_id WHERE d.owner_id=? AND d.status='active' AND (d.depends_on_type<>'mission' OR p.status<>'completed')").get(m.id);if(unresolved)throw Error('Mission dependency is unresolved');
      const task=this.bridge.tasks.get(dispatch.task_id);if(task.safetyStop?.latched)throw Error('Task safety stop is latched');
      const fallback=this.bridge.agentDispatch?.fallbackFor(dispatch.id);
      let route;
      if(fallback){
        if(fingerprint({version:2,envelope:m.envelope,ceiling:m.ceiling})!==fallback.policy_hash)throw Error('Immutable fallback policy changed');
        const choice=this.bridge.agentDispatch.fallbackChoice(fallback,await this.agents.refresh());
        if(choice.selected!==fallback.selected_fallback)return;
        route=this.bridge.authorityRuntime?.routing?await this.bridge.authorityRuntime.route(m,await this.agents.refresh()):{selected:choice.selected,reason:'durable_compatible_fallback',transport:'native'};
        if(route.selected!==fallback.selected_fallback)throw Error('Governed fallback requires WAIT and reconciliation');
      }else route=await this.agents.select(m.envelope);
      transaction(this.db,()=>{this.db.prepare('UPDATE cp_dispatches SET route=?,updated_at=? WHERE id=?').run(JSON.stringify(route),Date.now(),dispatch.id);this.store.event('agent.route.planned',m.id,route);});
      if(!route.selected)throw Error(route.reason);
      this.assertAuthority(m);
      if(m.envelope.coding_plan)this.codingAdapter.assert(m);
      if(m.envelope.manifest&&route.selected!=='pi')throw Error('Mission Manifest requires a qualified bounded native adapter');
      // Existing external adapters do not enforce all six permission dimensions.
      if(m.envelope.authority && route.selected!=='pi')throw Error('Mission authority requires a qualified bounded native adapter');
      if(m.envelope.authority && m.envelope.dispatch_policy?.native_actions.length)this.assertAuthority(m,{repository:['write'],data:['workspace_write'],filesystem:{write:m.envelope.dispatch_policy.native_actions.map(a=>path.resolve(m.envelope.workspace,a.path))}});
      this.bridge.authorityRuntime?.assertDispatch(m,route);
      if(route.selected==='pi'&&(fallback||m.envelope.task_type==='local_files'))return await this.launchNative(dispatch,m,fallback||{fallback_policy:m.envelope.dispatch_policy});
      if(route.selected==='codex'&&route.transport==='handoff'){
        this.bridge.codexAdapter.startTask(m.id,`automatic-handoff:${dispatch.id}`,dispatch.decision_id,dispatch.id,route);this.bridge.agentDispatch.schedule();return;
      }
      if(route.selected!=='claude_code')throw Error('Selected agent has no native Mission dispatch adapter; explicit handoff required');
      if(this.store.getMission(m.id).state==='cancelled')return;
      const snapshot=workspaceSnapshot(m.envelope.workspace);
      for(const [file,digest]of Object.entries(m.envelope.baseline.files))if(!m.envelope.allowed_files.includes(file)&&snapshot.files[file]!==digest)throw Error('Protected baseline changed before dispatch');
      const pack=this.bridge.controlContext.build(m);this.bridge.authorityRuntime?.assertDispatch(m,route,pack);
      const decision=dispatch.decision_id?this.store.decision(dispatch.decision_id):null;
      const prompt=JSON.stringify({protocol:'mission-result-v1',objective:m.envelope.objective,constraints:m.envelope.constraints,allowed_files:m.envelope.allowed_files,criteria:m.envelope.criteria,context_pack:require('./architecture-memory').packet(pack),continuation:decision?{decision_id:decision.id,question:decision.question,answer:decision.answer,prior_result:this.db.prepare('SELECT normalized FROM cp_run_results WHERE run_id=?').get(decision.run_id)?.normalized||null,workspace_hash:snapshot.hash,authority:false}:null,result_contract:{status:'completed',summary:'Describe observed result',changed_files:[],tests:[],artifacts:[],limitations:[],memory_candidates:[],needs_operator:false,continuity_claimed:false,question:'Only if a human choice is needed',options:[],allow_free_text:true},instructions:'Return a single JSON result. Set continuity_claimed:true for any assertion of a prior decision; retrieve supplied canonical references first. If a genuine choice prevents work, return needs_operator:true and settle without choosing. Do not modify files outside allowed_files, commit, stage, or change tests. Memory and decision text never grant authority.'});
      if(Buffer.byteLength(prompt)>30000)throw Error('Mission envelope exceeds dispatch bound');
      transaction(this.db,()=>{this.db.prepare("UPDATE cp_dispatches SET state='dispatching',route=?,updated_at=? WHERE id=? AND state='queued'").run(JSON.stringify(route),Date.now(),dispatch.id);this.db.prepare('UPDATE cp_mission_tasks SET context_pack_id=? WHERE task_id=?').run(pack.id,task.id);task.contextPackId=pack.id;task.assignedAgent=route.selected;task.mission.started=true;task.mission.status='active';this.bridge.tasks.save(task);this.store.event('agent.route.selected',m.id,{...route,dispatch_path:'agent_direct'});this.store.event('agent.dispatch.requested',m.id,{dispatch_id:dispatch.id});});
      const response=await this.bridge.agentRouter.resolve('claude_code').dispatch({task,repo:m.envelope.workspace,prompt,requestId:`mission:${dispatch.id}`});
      const child=this.db.prepare("SELECT * FROM cp_runs WHERE task_id=? AND agent_id='claude_code' ORDER BY created_at DESC LIMIT 1").get(task.id);
      if(child){transaction(this.db,()=>{this.db.prepare("UPDATE cp_dispatches SET state='running',run_id=?,updated_at=? WHERE id=?").run(child.id,Date.now(),dispatch.id);if(this.store.getMission(m.id).state==='dispatching'){this.store.state(m.id,'running');this.store.event('mission.started',m.id,{}, {runId:child.id});this.store.event('task.dispatched',m.id,{task_id:task.id},{runId:child.id});}});}
      else if(response.status==='pending')throw Error('Dispatch outcome is uncertain; reconcile invocation before proceeding');
      else throw Error(`Claude dispatch ${response.status}; review policy/approval or workspace ownership`);
    }catch(error){
      const current=this.store.getMission(m.id);if(current.state==='cancelled')return;
      transaction(this.db,()=>{const invocation=this.store.invocation(`mission:${dispatch.id}`);this.db.prepare('UPDATE cp_dispatches SET state=?,updated_at=? WHERE id=?').run(invocation&&invocation.state!=='settled'?'unknown':'blocked',Date.now(),dispatch.id);if(this.store.getMission(m.id).state!=='blocked')this.store.state(m.id,'blocked',String(error.message).slice(0,900));});
    }
  }
  async launchNative(dispatch,m,fallback){
    const runId=randomUUID(),task=this.bridge.tasks.get(dispatch.task_id),plan=fallback.fallback_policy.native_actions;
    if(workspaceSnapshot(m.envelope.workspace).hash!==m.envelope.baseline.hash)throw Error('Workspace changed before native fallback');
    transaction(this.db,()=>{
      this.store.startRun({id:runId,taskId:task.id,missionId:m.id,agentId:'pi'});
      this.store.acquireLease({resource:m.envelope.workspace,runId,missionId:m.id,baseline:m.envelope.baseline});
      const pack=this.bridge.controlContext.build(m,runId);const governedRoute=JSON.parse(this.db.prepare('SELECT route FROM cp_dispatches WHERE id=?').get(dispatch.id).route);this.bridge.authorityRuntime?.assertDispatch(m,governedRoute,pack);this.db.prepare('UPDATE cp_mission_tasks SET context_pack_id=? WHERE task_id=?').run(pack.id,task.id);task.contextPackId=pack.id;
      this.store.updateRun(runId,{state:'running',processState:'not_started'});
      this.db.prepare("UPDATE cp_dispatches SET state='running',run_id=?,route=?,updated_at=? WHERE id=? AND state='queued'").run(runId,JSON.stringify({...governedRoute,selected:'pi',selected_agent:'pi',provider:null,selected_provider:null,reason:'immutable_native_plan',rejected:[],fallback_plan:[],wait_reason:null}),Date.now(),dispatch.id);
      if(this.store.getMission(m.id).state==='dispatching')this.store.state(m.id,'running');
      task.assignedAgent='pi';this.bridge.tasks.save(task);
    });
    const receipts=[];let failed=false;
    try{
      for(const [i,a]of plan.entries()){
        this.program.assert(this.store.requireMission(m.id));
        if(m.envelope.coding_plan)this.codingAdapter.assert(this.store.requireMission(m.id),a);
        if(this.store.getMission(m.id).state==='cancelled'||task.safetyStop?.latched){failed=true;break;}
        const requestId=`native-fallback:${runId}:${i}`;
        const response=await this.bridge.invokeCapability(task.id,{name:a.name,input:{path:path.join(m.envelope.workspace,a.path),content:a.content},requestId});
        if(['unknown','pending'].includes(response.status))throw Error('Uncertain native fallback');
        if(response.status!=='completed'){failed=true;break;}receipts.push(requestId);
      }
      transaction(this.db,()=>{
        this.store.updateRun(runId,{state:failed?'failed':'completed',processState:'not_started',verified:true,result:{...(m.envelope.coding_plan?{coding_adapter:m.envelope.coding_plan.adapter,coding_plan_hash:fingerprint(m.envelope.coding_plan)}:{}),native_execution_evidence:{run_id:runId,required_execution_kind:'native',completed_invocations:receipts.length,receipt_refs:receipts}}});
        this.captureResult(runId,{status:failed?'failed':'completed',result:{text:JSON.stringify({summary:failed?'Native plan stopped by policy':'Immutable native file plan completed',changed_files:plan.map(a=>a.path),tests:[],artifacts:[],limitations:[]})}});
      });
    }catch{
      this.store.updateRun(runId,{state:'termination_unverified',processState:'unknown',resolution:'reconcile_native_invocation'});
      this.db.prepare("UPDATE cp_dispatches SET state='unknown' WHERE id=?").run(dispatch.id);
      if(this.store.getMission(m.id).state!=='cancelled')this.store.state(m.id,'blocked','Native fallback requires reconciliation');
    }
  }
  runStarted(runId){
    const run=this.store.run(runId),m=run?.mission_id?this.store.getMission(run.mission_id):null;
    if(m?.envelope.control_version!==2)return;
    if(m.state==='cancelled')throw Error('Mission was cancelled before process observation');
    const dispatch=this.db.prepare('SELECT * FROM cp_dispatches WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(run.task_id);
    if(!dispatch)throw Error('External run has no durable dispatch');
    this.db.prepare("UPDATE cp_dispatches SET state='running',run_id=?,updated_at=? WHERE id=?").run(runId,Date.now(),dispatch.id);
    if(m.state==='blocked'){this.store.state(m.id,'ready');this.store.state(m.id,'dispatching');}
    if(this.store.getMission(m.id).state==='dispatching')this.store.state(m.id,'running');
    this.db.prepare("UPDATE cp_runs SET provider_id='anthropic_subscription' WHERE id=?").run(runId);
    this.store.event('task.dispatched',m.id,{task_id:run.task_id},{runId});
    this.store.event('agent.started',m.id,{agent:'claude_code',dispatch_id:dispatch.id},{runId});
    this.store.event('mission.started',m.id,{}, {runId});
  }
  captureResult(runId,job){
    const run=this.store.run(runId),m=run?.mission_id?this.store.getMission(run.mission_id):null;if(m?.envelope.control_version!==2)return;
    let result;try{result=normalizeResult(job);}catch{result={status:'failed',summary:'Invalid structured agent result',questions:[],memory_candidates:[],untrusted:true};}
    this.bridge.resultInbox.publish({run_id:runId,mission_id:run.mission_id,task_id:run.task_id,agent_id:run.agent_id,request_id:`capture:${runId}`,result});
    this.db.prepare('INSERT OR IGNORE INTO cp_run_results VALUES(?,?,?,0)').run(runId,m.id,JSON.stringify(result));
    afterCommit(this.db,()=>this.schedule());
  }
  async processResult(row){
    const m=this.store.getMission(row.mission_id),run=this.store.run(row.run_id),result=JSON.parse(row.normalized);
    if(m.state==='dispatching')return;
    transaction(this.db,()=>{
      this.db.prepare('UPDATE cp_run_results SET processed_at=? WHERE run_id=? AND processed_at=0').run(Date.now(),run.id);
      this.db.prepare("UPDATE cp_dispatches SET state='settled' WHERE run_id=?").run(run.id);
      if(m.state==='cancelled')return;
      const task=this.bridge.tasks.get(run.task_id);
      result.continuity=this.bridge.controlContext.continuity(m,run,result);
      this.db.prepare('INSERT OR IGNORE INTO cp_continuity_checks VALUES(?,?,?,?,?)').run(run.id,m.id,result.continuity.status,JSON.stringify(result.continuity),Date.now());
      if(result.continuity.status==='continuity_unverified'){this.store.event('continuity.unverified',m.id,{context_hash:result.continuity.context_hash},{runId:run.id});this.store.state(m.id,'needs_rework','continuity_unverified: retrieve canonical context before claiming prior decisions');return;}
      this.store.event(result.status==='completed'?'agent.completed':'agent.failed',m.id,{result_untrusted:true},{runId:run.id});
      for(const candidate of result.memory_candidates||[])this.bridge.controlContext.propose(m.id,run.id,{...candidate,domain:'project'});
      if(result.status!=='completed'){this.store.state(m.id,'needs_rework','Agent run failed; explicit rework required');return;}
      if(result.questions?.length){const question=result.questions[0];this.store.createDecision(m.id,{...question,run_id:run.id,agent_id:run.agent_id});task.status='waiting_for_operator';this.bridge.tasks.save(task);this.store.event('mission.paused_for_decision',m.id,{}, {runId:run.id});return;}
      task.status='completed';this.bridge.tasks.save(task);this.store.event('task.completed',m.id,{task_id:task.id});this.store.state(m.id,'verifying');this.store.event('verification.started',m.id,{dispatch_path:'verification_native'}, {runId:run.id});
    });
    if(this.store.getMission(m.id).state==='verifying'){
      // Exclude another writer while independent checks run and evidence is captured.
      const verifyId=randomUUID();this.store.startRun({id:verifyId,taskId:run.task_id,missionId:m.id,agentId:'pi'});
      try {this.store.acquireLease({resource:m.envelope.workspace,runId:verifyId,missionId:m.id});const verified=await this.verifier.verify(this.store.getMission(m.id),run);if(this.store.getMission(m.id).state==='verifying')this.verifier.persist(m,run,verified);}
      catch(error){if(this.store.getMission(m.id).state==='verifying')this.store.state(m.id,'blocked','Independent verification unavailable');}
      finally{this.store.updateRun(verifyId,{state:'completed',processState:'not_started',verified:true,deferAudit:true});}
      if(m.envelope.automatic_acceptance)this.acceptanceEngine.attempt(m.id);
      if(m.envelope.fixture_auto_acceptance?.authorized)this.bridge.fixtureAcceptance.attempt(m.id);
    }
  }
  async reverify(id,input,owner='operator'){
    object(input,['id','request_id']);identifier(input.request_id);
    const m=this.require(id,owner);
    const receipt=this.store.request(owner,input.request_id,{op:'reverify',id},()=>{
      if(!['needs_rework','awaiting_acceptance'].includes(m.state)||m.envelope.baseline.version!==2)throw Error('V2 failed verification required');
      const run=this.db.prepare("SELECT * FROM cp_runs WHERE mission_id=? AND agent_id='claude_code' AND state='completed' AND termination_verified=1 ORDER BY ended_at DESC LIMIT 1").get(id);
      if(!run||!this.db.prepare("SELECT 1 FROM cp_verifications WHERE mission_id=? AND run_id=? AND result='failed'").get(id,run.id))throw Error('Settled implementation with failed verification required');
      const verificationRun=randomUUID();this.store.startRun({id:verificationRun,taskId:run.task_id,missionId:id,agentId:'pi'});
      this.store.acquireLease({resource:m.envelope.workspace,runId:verificationRun,missionId:id});
      this.store.state(id,'verifying','Explicit independent verification retry');
      this.store.event('verification.started',id,{retry:true},{runId:run.id});
      return{mission_id:id,implementation_run:run.id,verification_run:verificationRun};
    });
    if(receipt.duplicate)return receipt;
    try{const result=await this.verifier.verify(this.store.getMission(id),this.store.run(receipt.implementation_run));
      if(this.store.getMission(id).state==='verifying')this.verifier.persist(m,this.store.run(receipt.implementation_run),result);
      this.store.updateRun(receipt.verification_run,{state:result.status==='failed'||result.status==='unavailable'?'failed':'completed',processState:'not_started',verified:true,deferAudit:true});
      this.bridge.resultInbox.publish({run_id:receipt.verification_run,mission_id:id,task_id:this.store.run(receipt.verification_run).task_id,agent_id:'pi',request_id:input.request_id,result:{status:result.status==='failed'||result.status==='unavailable'?'failed':'completed',summary:`Independent registered Pi verification: ${result.status}; workspace ${result.workspace_hash}. Completion and verification do not grant Acceptance.`,changed_files:[],tests:result.checks.filter(c=>c.id.startsWith('task:')).map(c=>({name:c.id,status:c.status,exit_code:c.evidence.exit_code})),artifacts:[],limitations:['Real-project Acceptance remains operator review; original implementation result and failure evidence retained.']}});
      return{...receipt,result:result.status,accepted:false};
    }finally{if(!['completed','failed'].includes(this.store.run(receipt.verification_run).state))this.store.updateRun(receipt.verification_run,{state:'failed',processState:'not_started',verified:true,deferAudit:true});}
  }
  answer(id,input,actor='operator',surface='operator'){
    const result=this.store.request(actor,input.request_id,{op:'answer',id,...input},()=>this.store.answerDecision(id,{option_id:input.option_id??null,free_text:input.free_text??null,actor,surface}));this.schedule();return result;
  }
  accept(id,input,owner='operator'){
    const m=this.require(id,owner);identifier(input.request_id);text(input.rationale,'acceptance rationale',2000);
    return this.store.request(owner,input.request_id,{op:'accept',id,...input},()=>{
      if(m.state!=='awaiting_acceptance')throw Error('Mission is not awaiting acceptance');
      if(input.decision==='accept')this.program.assertAcceptance(m,input.verification_id);
      const v=this.db.prepare('SELECT * FROM cp_verifications WHERE id=? AND mission_id=?').get(input.verification_id,id);
      if(!v||v.revision!==m.revision||workspaceSnapshot(m.envelope.workspace).hash!==v.workspace_hash)throw Error('Acceptance evidence is stale');
      if(input.decision==='accept')this.bridge.workExecution?.assertEvidence(m.id,v.run_id);
      if(!['accept','rework'].includes(input.decision))throw Error('Invalid acceptance decision');
      if(input.decision==='accept'&&!require('./execution-evidence').runSatisfied(this.store.run(v.run_id)))throw Error('Required native execution evidence is missing');
      if(input.decision==='accept'&&v.result==='operator_review'){if(owner!=='operator')throw Error('Unsupported criterion requires operator review');text(input.evidence,'operator evidence',4000);}
      if(input.decision==='accept'&&!['passed','operator_review'].includes(v.result))throw Error('Verification has not passed');
      const acceptanceId=randomUUID();
      if(this.bridge.authorityRuntime?.active&&this.bridge.authorityRuntime.store.one('verification_records',v.id))this.bridge.authorityRuntime.store.accept({id:acceptanceId,mission_id:id,mission_revision:m.revision,verification_id:v.id,decision:input.decision==='accept'?'accepted':'rework_requested',reason:input.rationale,review_evidence:input.evidence?[input.evidence]:[]},this.bridge.authorityRuntime.store.operator,{transition:false});
      this.db.prepare('INSERT INTO cp_acceptances VALUES(?,?,?,?,?,?,?)').run(acceptanceId,id,v.id,input.decision,owner,JSON.stringify({rationale:input.rationale,evidence:input.evidence||null}),Date.now());
      this.store.state(id,input.decision==='accept'?'completed':'needs_rework');this.program.settle(id,input.decision);if(input.decision==='accept'&&this.bridge.authorityRuntime?.active&&this.bridge.authorityRuntime.store.one('acceptance_records',acceptanceId))this.bridge.authorityRuntime.memory.distill(acceptanceId);return this.detail(id,owner);
    });
  }
  cancel(id,{request_id},owner='operator'){
    this.require(id,owner);const result=this.store.request(owner,request_id,{op:'cancel',id},()=>{
      const m=this.store.getMission(id);if(['completed','cancelled'].includes(m.state))throw Error('Mission is terminal');this.store.state(id,'cancelled');this.store.cancelDecisions(id);
      for(const row of this.db.prepare('SELECT task_id FROM cp_mission_tasks WHERE mission_id=?').all(id)){const task=this.bridge.tasks.get(row.task_id);task.cancelRequested=true;this.bridge.leases.requestCancel(task.id,'emergency STOP');if(task.mission?.authority)task.mission.authorityRevoked=true;this.bridge.policy.revokeTask(task.id);this.bridge.missionAuthority.revoke(task.mission?.id||task.id,'emergency STOP');task.status='cancelled';this.bridge.tasks.save(task);}
      this.db.prepare("UPDATE cp_dispatches SET state='cancelled' WHERE mission_id=? AND state='queued'").run(id);
      this.db.prepare("UPDATE cp_continuations SET state='cancelled' WHERE mission_id=? AND state='queued'").run(id);
      for(const h of this.db.prepare("SELECT h.run_id FROM cp_codex_handoffs h JOIN cp_runs r ON r.id=h.run_id WHERE r.mission_id=? AND h.state<>'settled'").all(id))this.bridge.codexAdapter.cancelTask(h.run_id);
      this.store.event('mission.stop_requested',id,{});return{mission_id:id,state:'cancelled'};
    });
    afterCommit(this.db,()=>{for(const job of this.bridge.capabilityHost.jobs.jobs.values())if(this.store.missionForTask(job.taskId)?.id===id)this.bridge.capabilityHost.jobs.cancel(job);});
    return result;
  }
  decisionDetails(id){const d=this.store.decision(id);if(!d)throw Error('Decision not found');const m=this.detail(d.mission_id);return{decision:d,mission_objective:m.objective,result:this.db.prepare('SELECT normalized FROM cp_run_results WHERE run_id=?').get(d.run_id)?.normalized||null,verification:m.verifications,risks:['Worker rationale is untrusted; protected approvals are separate.']};}
  recover(){for(const {id} of this.db.prepare('SELECT id FROM cp_missions').all()){const m=this.store.getMission(id);{if(m.envelope.control_version===2&&['dispatching','verifying','running'].includes(m.state)&&!this.db.prepare('SELECT 1 FROM cp_run_results WHERE mission_id=? AND processed_at=0').get(m.id)&&!this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state='queued'").get(m.id))this.store.state(m.id,'blocked','Interrupted execution or verification requires reconciliation');}}this.schedule();}
  async close(){this.stopped=true;while(this.busy)await new Promise(resolve=>setTimeout(resolve,20));}
}
module.exports={MissionService,relative};
