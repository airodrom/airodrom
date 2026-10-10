'use strict';
// ADR 0009: display projections are metadata, never authority or runtime context.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const id = value => typeof value === 'string' && UUID.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const enumValue = (value, values, fallback = 'unavailable') => values.includes(value) ? value : fallback;
const STATES = ['draft','ready','dispatching','running','verifying','awaiting_acceptance','waiting_for_operator','paused','blocked','needs_rework','completed','cancelled'];
const ACTIVE = ['dispatching','running','verifying'];
const STAGES = Object.freeze({
 'memory.write':['Memory','Canonical Memory recorded'], 'memory.superseded':['Memory','Previous Memory superseded'], 'memory.forget':['Memory','Memory forgotten'], 'memory.expired':['Memory','Memory expired'], 'memory.content_redacted':['Memory','Memory content erased'], 'product.memory.recorded':['Memory','Canonical Memory recorded'], 'product.memory.corrected':['Memory','Canonical Memory corrected'], 'product.memory.forgotten':['Memory','Canonical Memory forgotten'],
 'research.browser_started':['Capability','Owned browser opened'], 'research.browser_closed':['Capability','Browser closure checked'], 'research.network_denied':['Capability','Browser request blocked by scoped policy'], 'research.network_stopped':['Capability','Browser transport budget stopped'], 'research.permission_granted':['Approval','Temporary browser permission granted'], 'research.permission_revoked':['Approval','Temporary browser permission revoked'], 'mission.web.granted':['Approval','Public web permission granted'], 'mission.web.revoked':['Approval','Public web permission revoked'], 'mission.web.evidence':['Capability','Public web evidence recorded'],
 'mission.request_received':['Mission','Request received'], 'mission.authority_registered':['Mission','Bounded authority registered'],
 'mission.created':['Mission','Mission registered'], 'manifest.registered':['Mission','Scope registered'],
 'context_pack.created':['Memory','Memory context selected'], 'runtime.qualification.checked':['Runtime','Runtime qualification checked'],
 'agent.route.selected':['Runtime','Runtime selected'], 'mission.dispatching':['Mission','Queued / dispatching'],
 'run.started':['Mission','Worker starting'], 'runtime.execution.started':['Runtime','OpenCode executing'],
 'runtime.context.delivered':['Memory','Context delivered this turn'], 'mission.running':['Mission','Execution active'],
 'orchestrator.capability.requested':['Capability','Capability requested'], 'capability.failed':['Capability','Capability failed'], 'capability.denied':['Capability','Capability denied'], 'capability.requested':['Capability','Capability requested'], 'capability.completed':['Capability','Capability completed'],
 'approval.requested':['Approval','Protected approval required'], 'approval.revoked':['Approval','Protected approval revoked'], 'approval.required':['Approval','Protected approval required'], 'approval.approved':['Approval','Protected approval granted'],
 'approval.rejected':['Approval','Protected approval rejected'], 'approval.expired':['Approval','Protected approval expired'],
 'agent.completed':['Mission','Worker result received'], 'agent.failed':['Mission','Worker failed'], 'agent.started':['Worker','Worker started'],
 'worker.started':['Worker','Worker started'], 'worker.tool_requested':['Worker','Tool requested'], 'worker.tool_permitted':['Worker','Tool permitted'],
 'worker.tool_denied':['Worker','Tool denied'], 'worker.tool_completed':['Worker','Tool completed'], 'worker.waiting':['Worker','Worker waiting'],
 'worker.failed':['Worker','Worker failed'], 'worker.terminated':['Worker','Worker terminated'],
 'worker.execution_started':['Worker','Worker execution started'], 'worker.output_observed':['Worker','Worker output observed'],
 'worker.proxy':['Worker','Worker network proxy observed'], 'worker.proxy_denied':['Worker','Worker network proxy denied'],
 'fs.file_read':['File','File read'], 'fs.file_created':['File','File created'], 'fs.file_modified':['File','File modified'], 'fs.file_deleted':['File','File deleted'],
 'git.diff_observed':['Git','Git diff observed'], 'git.diff.observed':['Git','Git diff observed'], 'git.branch.observed':['Git','Git branch observed'], 'git.baseline.observed':['Git','Git baseline observed'],
 'shell.command.requested':['Command','Command started'], 'shell.command.completed':['Command','Command completed'],
 'test.started':['Test','Test started'], 'test.completed':['Test','Test completed'], 'test.observed':['Test','Test result observed'],
 'observatory.heartbeat':['System','Live observatory heartbeat'],
 'verification.started':['Verification','Independent verification running'], 'verification.completed':['Verification','Independent verification finished'],
 'verification.failed':['Verification','Independent verification failed'], 'acceptance.started':['Verification','Acceptance evaluation started'],
 'acceptance.passed':['Verification','Acceptance evaluation passed; decision still required'],
 'acceptance.operator_review':['Verification','Operator review required'], 'acceptance.failed':['Verification','Acceptance evaluation failed'],
 'mission.awaiting_acceptance':['Mission','Waiting for Acceptance'], 'mission.waiting_for_operator':['Mission','Waiting for operator Decision'],
 'mission.paused':['Mission','Mission paused'], 'mission.blocked':['Mission','Mission blocked'], 'mission.needs_rework':['Mission','Rework required'],
 'mission.cancelled':['Mission','Cancellation recorded; termination checked separately'], 'mission.completed':['Mission','Mission completed'],
 'mission.accepted':['Settlement','Acceptance recorded'], 'mission.settled':['Settlement','Local Settlement recorded'],
 'whatsapp.inbound.received':['System','WhatsApp webhook received'], 'whatsapp.inbound.verified':['System','WhatsApp signature verified'],
 'whatsapp.inbound.stored':['System','WhatsApp message stored'], 'whatsapp.inbound.available':['System','WhatsApp message available in inbox'],
 'whatsapp.inbound.rejected':['System','WhatsApp webhook rejected'], 'whatsapp.inbound.duplicate':['System','WhatsApp duplicate ignored'],
 'whatsapp.inbound.unauthorized_sender':['System','WhatsApp sender not allowlisted'], 'whatsapp.inbound.status':['System','WhatsApp delivery status observed'],
 'whatsapp.inbound.challenge_ok':['System','WhatsApp verify challenge accepted'], 'whatsapp.inbound.enabled':['System','WhatsApp inbound enabled'],
 'whatsapp.inbound.disabled':['System','WhatsApp inbound disabled'],
 'whatsapp.inbound.discovery_recorded':['System','WhatsApp Meta discovery recorded'], 'whatsapp.inbound.callback_prepared':['System','WhatsApp HTTPS callback prepared'],
 'whatsapp.inbound.webhook_subscribed':['System','WhatsApp webhook subscription recorded']
});
const DISPLAY_STAGE = Object.freeze({
 'research.browser_started':'execution','research.browser_closed':'execution','research.network_denied':'execution','research.network_stopped':'execution','research.permission_granted':'execution','research.permission_revoked':'execution','mission.web.granted':'execution','mission.web.revoked':'execution','mission.web.evidence':'execution',
 'mission.request_received':'request','mission.created':'request','mission.authority_registered':'request','manifest.registered':'request',
 'context_pack.created':'context','runtime.context.delivered':'context',
 'runtime.qualification.checked':'runtime','agent.route.selected':'runtime',
 'mission.dispatching':'execution','run.started':'execution','runtime.execution.started':'execution','mission.running':'execution','agent.completed':'execution','agent.failed':'execution',
 'agent.started':'execution','worker.started':'execution','worker.tool_requested':'execution','worker.tool_permitted':'execution','worker.tool_denied':'execution','worker.tool_completed':'execution','worker.waiting':'execution','worker.failed':'execution','worker.terminated':'execution','worker.execution_started':'execution','worker.output_observed':'execution','worker.proxy':'execution','worker.proxy_denied':'execution',
 'fs.file_read':'execution','fs.file_created':'execution','fs.file_modified':'execution','fs.file_deleted':'execution','git.diff_observed':'execution','git.diff.observed':'execution','git.branch.observed':'execution','git.baseline.observed':'execution',
 'shell.command.requested':'execution','shell.command.completed':'execution','test.started':'execution','test.completed':'execution','test.observed':'execution',
 'verification.started':'verification','verification.completed':'verification','verification.failed':'verification','acceptance.started':'verification','acceptance.passed':'verification','acceptance.operator_review':'acceptance',
 'mission.awaiting_acceptance':'acceptance','mission.waiting_for_operator':'acceptance','mission.accepted':'acceptance','mission.settled':'settlement'
});
function eventView(event) {
 const mapping = STAGES[event.event_type]; if (!mapping) return null;
 const tool=typeof event.metadata?.tool==='string'?event.metadata.tool:null;
 const job=typeof event.metadata?.job_name==='string'?event.metadata.job_name:null;
 const file=typeof event.metadata?.path==='string'?event.metadata.path:null;
 const label=event.event_type==='run.started'&&event.metadata?.execution_role==='verifier'?'Independent verifier starting':event.event_type==='run.started'&&event.metadata?.agent_id==='host'&&event.metadata?.execution_role!=='worker'?'Host run starting; purpose unobserved':event.event_type==='mission.accepted'&&event.metadata?.decision==='rework'?'Rework decision recorded':event.event_type==='mission.settled'&&event.metadata?.state!=='settled'?'Settlement requires rework':event.event_type==='worker.tool_requested'&&tool?`Tool requested · ${tool}`:event.event_type==='shell.command.requested'&&job?`Command started · ${job}`:event.event_type==='shell.command.completed'&&job?`Command completed · ${job}`:event.event_type==='test.completed'&&job?`Test completed · ${job}`:event.event_type.startsWith('fs.file_')&&file?`${mapping[1]} · ${file}`:mapping[1];
 return {event_id:id(event.event_id),event_type:event.event_type,sequence:count(event.sequence),timestamp_ms:time(event.timestamp_ms),mission_id:id(event.mission_id),mission_revision:count(event.metadata?.mission_revision),run_id:id(event.run_id),category:mapping[0],stage:event.event_type==='run.started'&&event.metadata?.execution_role==='verifier'?'verification':DISPLAY_STAGE[event.event_type]||null,label,branch:/(failed|blocked|rework|rejected|expired|cancelled|denied)$/.test(event.event_type)?'attention':'observed',
  outcome:enumValue(event.metadata?.status,['passed','failed','operator_review','unavailable','completed'],null),
  runtime:enumValue(event.metadata?.agent_id,['opencode','host','claude_code','codex','cursor'],null)};
}
function timeline(events) {
 const seen = new Set(); return events.filter(e => id(e.event_id) && !seen.has(e.event_id) && seen.add(e.event_id)).sort((a,b)=>a.sequence-b.sequence).map(eventView).filter(Boolean);
}
function progress({state, checks = [], declaredChecks = null} = {}) {
 if (count(declaredChecks) && declaredChecks > 0 && checks.length <= declaredChecks) return {mode:'determinate',label:'Declared verification checks',value:checks.filter(c=>['passed','failed','operator_review','unavailable'].includes(c.status)).length,maximum:declaredChecks};
 return {mode:ACTIVE.includes(state)?'indeterminate':'paused',label:ACTIVE.includes(state)?'Observed activity; completion denominator unavailable':'No advancing activity observed'};
}
const checkLabel = (key, index) => ({read_only_boundary:'Read-only confinement and termination',response:'Response factual accuracy',runtime_provenance:'Runtime provenance',repository_v2:'Repository boundary',creation_repository_v2:'Original scope',workspace:'Workspace available',protected_files:'Protected files',expected_changes:'Expected changes',git_status:'Repository status',task_owned_diff:'Task-owned diff',verification_workspace_stable:'Verification workspace stability',verification_available:'Verification available',native_execution:'Native execution'})[key] || 'Declared check '+(index+1);
function missionView(bridge, mission) {
 if(mission.envelope.kind==='work_request')return {id:id(mission.id),task_id:null,state:mission.state,revision:count(mission.revision),label:'Work Mission draft',workspace:'Scope required',runtime:null,created_at:time(mission.created_at),observed_at:Date.now(),authority:{status:'none; scope and registered checks required'},budget:{},memory:{selected_count:0,delivery:'not requested'},verification:{current:false,status:'not_observed',checks:[]},acceptance:{status:'not_applicable'},settlement:{status:'not_applicable'},termination:{verified:true,process_state:'not_started'},attempts:0,progress:progress({state:mission.state}),timeline:[],actions:{cancel:mission.state!=='cancelled',dispatch:false,accept:false}};
 const db=bridge.controlStore.db, runs=db.prepare('SELECT id,agent_id,state,created_at,updated_at,termination_verified,process_state FROM cp_runs WHERE mission_id=? ORDER BY created_at DESC LIMIT 200').all(mission.id);
 const worker=db.prepare('SELECT r.id,r.agent_id,r.state,r.created_at,r.updated_at,r.termination_verified,r.process_state FROM cp_runs r JOIN cp_dispatches d ON d.run_id=r.id WHERE d.mission_id=? ORDER BY r.created_at DESC LIMIT 1').get(mission.id), task=bridge.tasks.get(mission.task_id);
 const verification=db.prepare('SELECT id,run_id,revision,result,evidence,created_at FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
 const acceptedBinding=verification?db.prepare("SELECT 1 FROM cp_acceptances WHERE mission_id=? AND verification_id=? AND decision='accept'").get(mission.id,verification.id):null;
 const verificationCurrent=!!verification&&verification.run_id===worker?.id&&(verification.revision===mission.revision||mission.state==='completed'&&!!acceptedBinding);
 const checks=verification?JSON.parse(verification.evidence).slice(0,100).map((c,i)=>({label:checkLabel(c.id,i),status:enumValue(c.status,['passed','failed','operator_review','unavailable']),evidence:'Host-measured outcome; raw evidence withheld'})):[];
 const acceptance=verification?db.prepare('SELECT decision,created_at FROM cp_acceptances WHERE mission_id=? AND verification_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id,verification.id):null;
 const settlement=db.prepare('SELECT state,updated_at FROM cp_mission_settlements WHERE mission_id=?').get(mission.id);
 const context=db.prepare('SELECT id,refs,created_at FROM cp_context_packs WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
 let selected=null,contextCurrent=false;
 if(context){try{require('./memory-content-erasure').assertContext(db,context.id);if(mission.envelope.worker_contract){if(JSON.parse(context.refs).length)throw Error('External context denied');}else bridge.opencodeAdapter.authorizedContext({id:context.id});selected=JSON.parse(context.refs).length;contextCurrent=true;}catch{}}
 const ev=bridge.ledger.list({missionId:mission.id,limit:200,order:'desc'}), history=timeline(ev.events);
 const delivered=contextCurrent&&ev.events.some(e=>e.event_type==='runtime.context.delivered' && e.metadata?.context_pack_id===context?.id && e.run_id===worker?.id);
 const workerProvenance=worker?.id?bridge.controlStore.run(worker.id).result?.worker_provenance:null;
 const state=enumValue(mission.state,STATES),budget=task.mission?.budget,used=task.mission?.used;
 return {id:id(mission.id),task_id:id(mission.task_id),state,revision:count(mission.revision),label:mission.envelope.kind==='conversation'?'Bounded local conversation':mission.envelope.kind==='browser_research'?'Arecibo product research':'Scoped Mission',workspace:mission.envelope.kind==='conversation'?'Isolated workspace':'Registered workspace',runtime:enumValue(worker?.agent_id||mission.envelope.preferred_agent,['opencode','host','claude_code','codex','cursor']),created_at:time(mission.created_at),started_at:time(worker?.created_at),finished_at:worker?.termination_verified===1&&['completed','failed','cancelled','blocked'].includes(worker.state)?time(worker.updated_at):null,observed_at:Date.now(),
  model:mission.envelope.worker_contract?{id:mission.envelope.model,provider:mission.envelope.model_provider,locality:'external',mode:mission.envelope.model_route_mode,declared_context_limit:null,effective_context_limit:null,context_usage:null,tokens:workerProvenance?.usage||null,cost:null,requested:mission.envelope.worker_contract.model,observed:workerProvenance?.observed_model||null}:mission.envelope.preferred_agent==='opencode'&&mission.envelope.model===require('./model-worker-router').MODEL?{id:mission.envelope.model,provider:'ollama',locality:'local',mode:mission.envelope.model_route_mode||'AUTO',declared_context_limit:null,effective_context_limit:null,context_usage:null,tokens:null,cost:null}:null,
  attempts:db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=? AND run_id IS NOT NULL').get(mission.id).n,authority:{status:task.mission?.authorityRevoked?'revoked':'registered; current admission checked by host',expires_at:time(mission.envelope.manifest?.expires_at)},
  ...(['coding','browser_research'].includes(mission.envelope.kind)&&bridge.missions._web?{web:bridge.missions.web.status(mission.id)}:{}),
  ...(mission.envelope.kind==='browser_research'?{research:bridge.missions.research.progress(mission)}:{}),
  budget:{actions_used:count(used?.actions),actions_limit:count(budget?.maxActions),retries_used:count(used?.retries),retries_limit:count(budget?.maxRetries),runtime_limit_ms:count(budget?.maxRuntimeMs)},
  memory:{selected_count:selected,delivery:delivered?'delivered this turn':contextCurrent?'selected; delivery not observed':'unavailable or invalidated',used_this_turn:'Model use is not observable',provenance:contextCurrent?'Current authorized canonical context':'Unavailable'},
  verification:{current:verificationCurrent,id:id(verification?.id),status:enumValue(verification?.result,['passed','failed','operator_review','unavailable'],'not_observed'),checks,run_id:id(verification?.run_id)},
  acceptance:(()=>{
    const auto=!!(acceptance?.decision==='accept'&&(mission.envelope.risk_auto_acceptance?.authorized||mission.envelope.fixture_auto_acceptance?.authorized||mission.envelope.automatic_acceptance));
    const reviewReason=state==='awaiting_acceptance'?(bridge.missions.riskAcceptance?.reviewReason(mission.id)||null):null;
    return{
      status:enumValue(acceptance?.decision,['accept','rework'],'pending'),
      at:time(acceptance?.created_at),
      mode:enumValue(auto?'automatically_verified':state==='awaiting_acceptance'||state==='waiting_for_operator'?'needs_operator_review':'not_applicable',['automatically_verified','needs_operator_review','not_applicable']),
      review_reason:typeof reviewReason==='string'&&reviewReason.length<=120?reviewReason:null
    };
  })(),
  settlement:{status:enumValue(settlement?.state,['waiting_acceptance','needs_rework','settled'],'not_observed'),at:time(settlement?.updated_at)},
  termination:{verified:worker?.termination_verified===1,process_state:enumValue(worker?.process_state,['starting','alive','exited','unknown','not_started'])},
  progress:progress({state}),timeline:history,history_truncated:ev.has_more,
  actions:{cancel:!['completed','cancelled'].includes(state),dispatch:['ready','blocked','needs_rework'].includes(state)&&!task.mission?.authorityRevoked&&(!mission.envelope.manifest?.expires_at||mission.envelope.manifest.expires_at>Date.now())&&!(mission.envelope.kind==='conversation'&&db.prepare('SELECT 1 FROM cp_dispatches WHERE mission_id=?').get(mission.id))&&!runs.some(r=>r.process_state==='unknown')&&!require('./removed-runtime').removed(mission),accept:state==='awaiting_acceptance'&&verificationCurrent}};
}
function runtimeView(ready) {
 const reason=enumValue(ready?.reason,['opencode_runtime_pins_changed','opencode_unavailable','opencode_version_unqualified','opencode_local_provider_unavailable','opencode_local_provider_not_configured'],ready?.ready===true?null:'opencode_unavailable');
 return {state:ready?.ready===true?'Ready':reason==='opencode_runtime_pins_changed'?'Degraded':'Unavailable',ready:ready?.ready===true,role:'Primary',version:ready?.version==='2.0.25'?'2.0.25':null,reason,requalification:reason==='opencode_runtime_pins_changed'?'Required':'Not running'};
}
function memoryStatus(bridge){
 const db=bridge.controlStore.db;
 let memoryReady=false,memoryStats=null,memoryGeneration=null;try{
  if(bridge.authorityRuntime?.active){
   const operator=bridge.authorityRuntime.store.operatorId,now=bridge.authorityRuntime.store.now();
   const rows=db.prepare("SELECT CASE WHEN status='active' AND (expires_at<=? OR last_verified_at+ttl_ms<=?) THEN 'expired' ELSE status END status,count(*) count,sum(revision) revisions FROM authority_memories WHERE operator_id=? AND scope='global' AND kind='personal_preference' AND privacy IN ('public','internal') GROUP BY 1").all(now,now,operator);
   memoryStats={byStatus:Object.fromEntries(rows.map(r=>[r.status,r.count]))};memoryGeneration=JSON.stringify(rows.map(r=>[r.status,r.count,r.revisions]));
  }else{memoryStats=bridge.personalMemory.stats();const rows=db.prepare("SELECT status,count(*) count,max(updated_at) updated FROM personal_memories WHERE domain='personal' AND sensitivity='normal' GROUP BY status ORDER BY status").all();memoryGeneration=JSON.stringify(rows.map(r=>[r.status,r.count,r.updated]));memoryStats={byStatus:Object.fromEntries(rows.map(r=>[r.status,r.count]))};}
  memoryGeneration+=':'+db.prepare('SELECT coalesce(max(generation),0) n FROM memory_erasure_markers').get().n;memoryReady=true;
 }catch{}
 return {state:memoryReady?'Ready':'Unavailable',local:true,backend:bridge.authorityRuntime?.active?'Governed canonical':'Personal canonical',generation:memoryGeneration,active_records:memoryReady?(count(memoryStats?.byStatus?.active)||0):null,expired_records:memoryReady?(count(memoryStats?.byStatus?.expired)||0):null,superseded_records:memoryReady?(count(memoryStats?.byStatus?.superseded)||0):null};
}
async function overview(bridge,{includeMissions=true,currentOffset=0}={}) {
 if(!Number.isSafeInteger(currentOffset)||currentOffset<0)throw Error('Invalid current Mission page');
 require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
 const db=bridge.controlStore.db, ready=await bridge.opencodeAdapter.readiness();
 const leases=db.prepare("SELECT state,count(*) count FROM cp_leases WHERE state IN ('held','quarantined') GROUP BY state").all();
 const memory=memoryStatus(bridge),memoryReady=memory.state==='Ready';
 const currentCount=db.prepare("SELECT count(*) n FROM cp_missions WHERE state NOT IN ('completed','cancelled')").get().n;
 const activeCount=db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('dispatching','running','verifying')").get().n;
 const current=(includeMissions?db.prepare("SELECT id FROM cp_missions WHERE state NOT IN ('completed','cancelled') ORDER BY CASE WHEN state IN ('dispatching','running','verifying') THEN 0 ELSE 1 END,created_at DESC,id LIMIT 50 OFFSET ?").all(currentOffset):[]).map(m=>missionView(bridge,bridge.controlStore.requireMission(m.id)));
 const recent=(includeMissions?bridge.controlStore.listMissions({limit:50}):[]).map(m=>missionView(bridge,m));
 const missions=[...new Map([...current,...recent].map(m=>[m.id,m])).values()];
 const approvalRecords=bridge.policy.list(),pending=approvalRecords.filter(a=>a.status==='pending'&&(!a.expiresAt||a.expiresAt>Date.now())).length;
 const approvals=approvalRecords.sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)).slice(0,50).map(a=>({id:id(a.id),task_id:id(a.taskId),label:'Protected operation',status:enumValue(a.status,['pending','approved','expired','rejected','revoked','used']),created_at:time(a.createdAt),expires_at:time(a.expiresAt)}));
 const runtime=runtimeView(ready),ledger=bridge.ledger.health();
 let cursor={agent_availability:'unqualified',agent_execution:false,agent_reason:'cursor_execution_unqualified',editor_available:false,last_ide_task:null};
 try{
  const agents=await bridge.capabilityHost.agentStatus();
  const c=agents?.cursor||{};
  cursor={
    agent_availability:enumValue(c.agent_availability||c.availability,['unqualified','unavailable','auth_required','quota_limited','available'],'unqualified'),
    agent_execution:c.agent_execution===true,
    agent_reason:typeof c.agent_reason==='string'?c.agent_reason.slice(0,120):(typeof c.runtime?.reason==='string'?c.runtime.reason.slice(0,120):'cursor_execution_unqualified'),
    editor_available:c.editor_available===true||c.installed===true,
    last_ide_task:c.last_ide_task&&typeof c.last_ide_task==='object'?{
      status:enumValue(c.last_ide_task.status,['running','completed','failed','timed_out','cancelled','not_observed'],'not_observed'),
      label:typeof c.last_ide_task.label==='string'?c.last_ide_task.label.slice(0,80):null,
      exit_code:Number.isInteger(c.last_ide_task.exit_code)?c.last_ide_task.exit_code:null,
      agent_execution:false
    }:null
  };
 }catch{/* Cursor projection is best-effort. */}
 const overviewStatus=bridge.closed?'Unavailable':runtime.ready&&memoryReady&&ledger?.healthy===true&&!leases.some(l=>l.state==='quarantined')?'Ready':'Degraded';
 const connectivity=require('./connection-status').derive({authorized:true,reachable:true,overviewStatus,lastOkAt:Date.now(),maintenance:!!bridge.closed});
 const acceptanceConfig=(()=>{try{return bridge.missions.riskAcceptance.status();}catch{return{preference:{enabled:false},waits:require('./wait-presentation').status(bridge)};}})();
 return {epoch:bridge.runtimeFingerprint?.captured_at||null,observed_at:Date.now(),version:require('../package.json').version,release_state:'PRE-RELEASE',status:overviewStatus,connectivity,
  control:{state:bridge.closed?'Unavailable':'Ready',reason:'Local operator endpoint observation'},connection:{state:'Unavailable',reason:'Authenticated external client / MCP not checked; does not imply service disconnect'},runtime,cursor,acceptance_config:acceptanceConfig,memory,
  assistant:await require('./model-worker-router').inspect(bridge),connectors:require('./assistant-service').connectors(bridge).status(),whatsapp_inbound:(()=>{try{return bridge.whatsappInbound?.status()||null;}catch{return null;}})(),whatsapp_conversations:(()=>{try{return bridge.whatsappConversations?.status()||null;}catch{return null;}})(),whatsapp_outbound:(()=>{try{return bridge.whatsappOutbound?.status()||null;}catch{return null;}})(),sensitive:{disclosure:'Operator-only reveal; no worker context',encryption:'No field-level encryption claim'},vault:{backend:'macOS Keychain host port',values_displayed:false,worker_access:false},
  projects:includeMissions?bridge.projects.listProjects({limit:50}).map(p=>({id:id(p.projectId),status:enumValue(p.status,['active','paused','completed','archived']),label:'Registered project',updated_at:time(p.updatedAt)})):[],
  provider:{state:runtime.ready?'Ready':ready?.provider_ready===false?'Unavailable':'Unavailable',reason:runtime.ready?'Qualified local provider observed':'Readiness unavailable'},
  approvals:{waiting:pending,records:includeMissions?approvals:[],scope:'Up to 50 retained protected Approvals, pending first'},leases:{held:leases.find(l=>l.state==='held')?.count||0,quarantined:leases.find(l=>l.state==='quarantined')?.count||0},
  audit:{state:ledger?.healthy===true?'Ready':ledger?.state==='degraded'?'Degraded':'Unavailable',retained_events:count(db.prepare('SELECT count(*) n FROM event_ledger_events').get().n)},disk:{state:'Unavailable',reason:'Not checked'},
  missions,current_mission_ids:current.map(m=>m.id),counts:{scope:'Recent 50 retained Missions plus a separate current Mission page',visible:missions.length,active:activeCount,current:currentCount,current_offset:currentOffset,current_page_size:current.length,current_has_more:currentOffset+current.length<currentCount},
  limitations:['Model reasoning and prompts are private.','Memory delivery does not prove model use.','Worker completion requires independent verification, Acceptance and Settlement.']};
}
async function nativeStatus(bridge) {
 const s=await overview(bridge,{includeMissions:false}),db=bridge.controlStore.db;
 const active=db.prepare("SELECT id FROM cp_missions WHERE state IN ('dispatching','running','verifying','awaiting_acceptance','waiting_for_operator') ORDER BY CASE WHEN state IN ('dispatching','running','verifying') THEN 0 ELSE 1 END,created_at DESC LIMIT 1").get();
 const m=active?missionView(bridge,bridge.controlStore.requireMission(active.id)):null;
 const activeCount=db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('dispatching','running','verifying')").get().n;
 const {derive,menuPresentation}=require('./connection-status');
 const connectivity=derive({authorized:true,reachable:true,overviewStatus:s.status,lastOkAt:Date.now(),maintenance:!!bridge.closed});
 const presentation=menuPresentation({bridgeState:bridge.closed?'Stopped':'Connected',productStatus:s.status,activeMissions:activeCount,approvals:s.approvals.waiting,missionState:m?.state||null});
 const activity_status=presentation.tone==='working'?'Working '+activeCount:presentation.tone==='approval'?'Approval needed':presentation.label;
 const elapsed_s=m?.started_at?Math.max(0,Math.floor((Date.now()-m.started_at)/1000)):null;
 return {status:s.status,control:s.control.state,runtime:s.runtime.state,runtimeReason:s.runtime.reason,memory:s.memory.state,provider:s.provider.state,approvals:s.approvals.waiting,active_missions:activeCount,quarantined_leases:s.leases.quarantined,
  activity_status,connection_state:connectivity.state,connection_label:connectivity.label,menu_tone:presentation.tone,
  model:m?.model?.id||(s.runtime.ready?require('./model-worker-router').MODEL:'Unavailable'),routing:m?.model?.mode||(s.runtime.ready?'AUTO · local policy':'Unavailable'),connectors:s.connectors.items.map(c=>c.id+': '+c.state).join(' · '),
  workers:'OpenCode: '+s.runtime.state+' · Provider: '+s.provider.state+' · Cursor Agent: '+(s.cursor?.agent_availability||'unqualified'),
  cursor:s.cursor,
  acceptance_config:s.acceptance_config,
  mission:m?{id:m.id,label:m.label,state:m.state,phase:m.timeline.at(-1)?.label||'No transition observed',progress:m.progress.mode,worker:m.runtime||null,model:m.model?.id||null,elapsed_s,progress_value:m.progress.mode==='determinate'?m.progress.value:null,progress_maximum:m.progress.mode==='determinate'?m.progress.maximum:null}:null,
  review_missions:db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('awaiting_acceptance','waiting_for_operator')").get().n,
  failed_missions:db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('blocked','needs_rework')").get().n,
  diagnostic:['AIRODROM · PRE-RELEASE','Control: '+s.control.state,'OpenCode: '+s.runtime.state+' · Primary','Memory V2: '+s.memory.state+' · Local','Provider: '+s.provider.state,'Active Missions: '+activeCount,'Waiting Approvals: '+s.approvals.waiting,'Connection: '+connectivity.label,'No tokens, URLs, paths, memory, prompts or process arguments exported.'].join('\n')};
}
function events(bridge,url) {
 const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw Error('Invalid event cursor');
 const mission=url.searchParams.get('mission');if(mission&&!id(mission))throw Error('Invalid Mission ID');
 const category=url.searchParams.get('category');if(category&&!['Mission','Runtime','Memory','Capability','Verification','Approval','Settlement','System','Worker','File','Git','Command','Test'].includes(category))throw Error('Invalid category');
 const batch=bridge.ledger.list({afterSequence:after,limit:200,...(mission?{missionId:mission}:{})});
 return {events:timeline(batch.events).filter(e=>!category||e.category===category),cursor:batch.events.at(-1)?.sequence||after,has_more:batch.has_more,observed_at:Date.now()};
}
module.exports={id,state:value=>enumValue(value,STATES),STAGES,STATES,ACTIVE,eventView,timeline,progress,missionView,runtimeView,overview,nativeStatus,events,memoryStatus};
