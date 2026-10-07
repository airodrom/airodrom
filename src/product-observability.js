'use strict';
// ADR 0009: display projections are metadata, never authority or runtime context.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const id = value => typeof value === 'string' && UUID.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const enumValue = (value, values, fallback = 'unavailable') => values.includes(value) ? value : fallback;
const STATES = ['ready','dispatching','running','verifying','awaiting_acceptance','waiting_for_operator','paused','blocked','needs_rework','completed','cancelled'];
const ACTIVE = ['dispatching','running','verifying'];
const STAGES = Object.freeze({
 'memory.write':['Memory','Canonical Memory recorded'], 'memory.superseded':['Memory','Previous Memory superseded'], 'memory.forget':['Memory','Memory forgotten'], 'memory.expired':['Memory','Memory expired'], 'memory.content_redacted':['Memory','Memory content erased'], 'product.memory.recorded':['Memory','Canonical Memory recorded'], 'product.memory.corrected':['Memory','Canonical Memory corrected'], 'product.memory.forgotten':['Memory','Canonical Memory forgotten'],
 'mission.request_received':['Mission','Request received'], 'mission.authority_registered':['Mission','Bounded authority registered'],
 'mission.created':['Mission','Mission registered'], 'manifest.registered':['Mission','Scope registered'],
 'context_pack.created':['Memory','Memory context selected'], 'runtime.qualification.checked':['Runtime','Runtime qualification checked'],
 'agent.route.selected':['Runtime','Runtime selected'], 'mission.dispatching':['Mission','Queued / dispatching'],
 'run.started':['Mission','Worker starting'], 'runtime.execution.started':['Runtime','OpenCode executing'],
 'runtime.context.delivered':['Memory','Context delivered this turn'], 'mission.running':['Mission','Execution active'],
 'orchestrator.capability.requested':['Capability','Capability requested'], 'capability.failed':['Capability','Capability failed'], 'capability.denied':['Capability','Capability denied'], 'capability.requested':['Capability','Capability requested'], 'capability.completed':['Capability','Capability completed'],
 'approval.requested':['Approval','Protected approval required'], 'approval.revoked':['Approval','Protected approval revoked'], 'approval.required':['Approval','Protected approval required'], 'approval.approved':['Approval','Protected approval granted'],
 'approval.rejected':['Approval','Protected approval rejected'], 'approval.expired':['Approval','Protected approval expired'],
 'agent.completed':['Mission','Worker result received'], 'agent.failed':['Mission','Worker failed'],
 'verification.started':['Verification','Independent verification running'], 'verification.completed':['Verification','Independent verification finished'],
 'verification.failed':['Verification','Independent verification failed'], 'acceptance.started':['Verification','Acceptance evaluation started'],
 'acceptance.passed':['Verification','Acceptance evaluation passed; decision still required'],
 'acceptance.operator_review':['Verification','Operator review required'], 'acceptance.failed':['Verification','Acceptance evaluation failed'],
 'mission.awaiting_acceptance':['Mission','Waiting for Acceptance'], 'mission.waiting_for_operator':['Mission','Waiting for operator Decision'],
 'mission.paused':['Mission','Mission paused'], 'mission.blocked':['Mission','Mission blocked'], 'mission.needs_rework':['Mission','Rework required'],
 'mission.cancelled':['Mission','Cancellation recorded; termination checked separately'], 'mission.completed':['Mission','Mission completed'],
 'mission.accepted':['Settlement','Acceptance recorded'], 'mission.settled':['Settlement','Local Settlement recorded']
});
const DISPLAY_STAGE = Object.freeze({
 'mission.request_received':'request','mission.created':'request','mission.authority_registered':'request','manifest.registered':'request',
 'context_pack.created':'context','runtime.context.delivered':'context',
 'runtime.qualification.checked':'runtime','agent.route.selected':'runtime',
 'mission.dispatching':'execution','run.started':'execution','runtime.execution.started':'execution','mission.running':'execution','agent.completed':'execution','agent.failed':'execution',
 'verification.started':'verification','verification.completed':'verification','verification.failed':'verification','acceptance.started':'verification','acceptance.passed':'verification','acceptance.operator_review':'acceptance',
 'mission.awaiting_acceptance':'acceptance','mission.waiting_for_operator':'acceptance','mission.accepted':'acceptance','mission.settled':'settlement'
});
function eventView(event) {
 const mapping = STAGES[event.event_type]; if (!mapping) return null;
 const label=event.event_type==='run.started'&&event.metadata?.execution_role==='verifier'?'Independent verifier starting':event.event_type==='run.started'&&event.metadata?.agent_id==='host'&&event.metadata?.execution_role!=='worker'?'Host run starting; purpose unobserved':event.event_type==='mission.accepted'&&event.metadata?.decision==='rework'?'Rework decision recorded':event.event_type==='mission.settled'&&event.metadata?.state!=='settled'?'Settlement requires rework':mapping[1];
 return {event_id:id(event.event_id),sequence:count(event.sequence),timestamp_ms:time(event.timestamp_ms),mission_id:id(event.mission_id),mission_revision:count(event.metadata?.mission_revision),run_id:id(event.run_id),category:mapping[0],stage:event.event_type==='run.started'&&event.metadata?.execution_role==='verifier'?'verification':DISPLAY_STAGE[event.event_type]||null,label,branch:/(failed|blocked|rework|rejected|expired|cancelled)$/.test(event.event_type)?'attention':'observed',
  outcome:enumValue(event.metadata?.status,['passed','failed','operator_review','unavailable'],null),
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
 if(context){try{require('./memory-content-erasure').assertContext(db,context.id);bridge.opencodeAdapter.authorizedContext({id:context.id});selected=JSON.parse(context.refs).length;contextCurrent=true;}catch{}}
 const ev=bridge.ledger.list({missionId:mission.id,limit:200,order:'desc'}), history=timeline(ev.events);
 const delivered=contextCurrent&&ev.events.some(e=>e.event_type==='runtime.context.delivered' && e.metadata?.context_pack_id===context?.id && e.run_id===worker?.id);
 const state=enumValue(mission.state,STATES),budget=task.mission?.budget,used=task.mission?.used;
 return {id:id(mission.id),task_id:id(mission.task_id),state,revision:count(mission.revision),label:mission.envelope.kind==='conversation'?'Bounded local conversation':'Scoped Mission',workspace:mission.envelope.kind==='conversation'?'Isolated workspace':'Registered workspace',runtime:enumValue(worker?.agent_id||mission.envelope.preferred_agent,['opencode','host','claude_code','codex','cursor']),created_at:time(mission.created_at),started_at:time(worker?.created_at),finished_at:worker?.termination_verified===1&&['completed','failed','cancelled','blocked'].includes(worker.state)?time(worker.updated_at):null,observed_at:Date.now(),
  model:mission.envelope.preferred_agent==='opencode'&&mission.envelope.model===require('./model-worker-router').MODEL?{id:mission.envelope.model,provider:'ollama',locality:'local',mode:mission.envelope.model_route_mode||'AUTO',declared_context_limit:null,effective_context_limit:null,context_usage:null,tokens:null,cost:null}:null,
  attempts:db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=? AND run_id IS NOT NULL').get(mission.id).n,authority:{status:task.mission?.authorityRevoked?'revoked':'registered; current admission checked by host',expires_at:time(mission.envelope.manifest?.expires_at)},
  budget:{actions_used:count(used?.actions),actions_limit:count(budget?.maxActions),retries_used:count(used?.retries),retries_limit:count(budget?.maxRetries),runtime_limit_ms:count(budget?.maxRuntimeMs)},
  memory:{selected_count:selected,delivery:delivered?'delivered this turn':contextCurrent?'selected; delivery not observed':'unavailable or invalidated',used_this_turn:'Model use is not observable',provenance:contextCurrent?'Current authorized canonical context':'Unavailable'},
  verification:{current:verificationCurrent,id:id(verification?.id),status:enumValue(verification?.result,['passed','failed','operator_review','unavailable'],'not_observed'),checks,run_id:id(verification?.run_id)},
  acceptance:{status:enumValue(acceptance?.decision,['accept','rework'],'pending'),at:time(acceptance?.created_at)},
  settlement:{status:enumValue(settlement?.state,['waiting_acceptance','needs_rework','settled'],'not_observed'),at:time(settlement?.updated_at)},
  termination:{verified:worker?.termination_verified===1,process_state:enumValue(worker?.process_state,['alive','exited','unknown','not_started'])},
  progress:progress({state}),timeline:history,history_truncated:ev.has_more,
  actions:{cancel:!['completed','cancelled'].includes(state),dispatch:['ready','blocked','needs_rework'].includes(state)&&!task.mission?.authorityRevoked&&(!mission.envelope.manifest?.expires_at||mission.envelope.manifest.expires_at>Date.now())&&!(mission.envelope.kind==='conversation'&&db.prepare('SELECT 1 FROM cp_dispatches WHERE mission_id=?').get(mission.id))&&!runs.some(r=>r.process_state==='unknown')&&!require('./removed-runtime').removed(mission),accept:state==='awaiting_acceptance'&&verificationCurrent}};
}
function runtimeView(ready) {
 const reason=enumValue(ready?.reason,['opencode_runtime_pins_changed','opencode_unavailable','opencode_version_unqualified','opencode_local_provider_unavailable','opencode_local_provider_not_configured'],ready?.ready===true?null:'opencode_unavailable');
 return {state:ready?.ready===true?'Ready':reason==='opencode_runtime_pins_changed'?'Degraded':'Unavailable',ready:ready?.ready===true,role:'Primary',version:ready?.version==='2.0.20'?'2.0.20':null,reason,requalification:reason==='opencode_runtime_pins_changed'?'Required':'Not running'};
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
 return {epoch:bridge.runtimeFingerprint?.captured_at||null,observed_at:Date.now(),version:require('../package.json').version,release_state:'PRE-RELEASE',status:bridge.closed?'Unavailable':runtime.ready&&memoryReady&&ledger?.healthy===true&&!leases.some(l=>l.state==='quarantined')?'Ready':'Degraded',
  control:{state:bridge.closed?'Unavailable':'Ready',reason:'Local operator endpoint observation'},connection:{state:'Unavailable',reason:'Authenticated external client connection not checked'},runtime,memory,
  assistant:await require('./model-worker-router').inspect(bridge),connectors:require('./assistant-service').connectors(bridge).status(),sensitive:{disclosure:'Operator-only reveal; no worker context',encryption:'No field-level encryption claim'},vault:{backend:'macOS Keychain host port',values_displayed:false,worker_access:false},
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
 return {status:s.status,control:s.control.state,runtime:s.runtime.state,runtimeReason:s.runtime.reason,memory:s.memory.state,provider:s.provider.state,approvals:s.approvals.waiting,active_missions:activeCount,quarantined_leases:s.leases.quarantined,
  model:m?.model?.id||(s.runtime.ready?require('./model-worker-router').MODEL:'Unavailable'),routing:m?.model?.mode||(s.runtime.ready?'AUTO · local policy':'Unavailable'),connectors:s.connectors.items.map(c=>c.id+': '+c.state).join(' · '),
  mission:m?{id:m.id,label:m.label,state:m.state,phase:m.timeline.at(-1)?.label||'No transition observed',progress:m.progress.mode}:null,
  diagnostic:['AIRODROM · PRE-RELEASE','Control: '+s.control.state,'OpenCode: '+s.runtime.state+' · Primary','Memory V2: '+s.memory.state+' · Local','Active Missions: '+activeCount,'Waiting Approvals: '+s.approvals.waiting,'No tokens, URLs, paths, memory, prompts or process arguments exported.'].join('\n')};
}
function events(bridge,url) {
 const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw Error('Invalid event cursor');
 const mission=url.searchParams.get('mission');if(mission&&!id(mission))throw Error('Invalid Mission ID');
 const category=url.searchParams.get('category');if(category&&!['Mission','Runtime','Memory','Capability','Verification','Approval','Settlement','System'].includes(category))throw Error('Invalid category');
 const batch=bridge.ledger.list({afterSequence:after,limit:200,...(mission?{missionId:mission}:{})});
 return {events:timeline(batch.events).filter(e=>!category||e.category===category),cursor:batch.events.at(-1)?.sequence||after,has_more:batch.has_more,observed_at:Date.now()};
}
module.exports={id,state:value=>enumValue(value,STATES),STAGES,STATES,ACTIVE,eventView,timeline,progress,missionView,runtimeView,overview,nativeStatus,events,memoryStatus};
