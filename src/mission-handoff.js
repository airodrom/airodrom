'use strict';
// Untrusted requests choose no authority. Host templates fix WORK scope.
const {object,text,identifier,fingerprint}=require('./control-plane-store'),{randomUUID}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const router=require('./model-worker-router');
function validate(packet){
 object(packet,['version','request_id','objective','constraints','acceptance_criteria','references','capability_classes','data_class','privacy','worker','model','project','workspace','mission_class']);
 if(![1,2].includes(packet.version))throw Error('Handoff version 1 or 2 required');identifier(packet.request_id);if(packet.request_id.length>80)throw Error('Bounded request ID required');text(packet.objective,'objective',4000);
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(packet.request_id))text(packet.request_id,'request ID',80);
 const {request_id,...content}=packet;if(require('./assistant-intent').secret(JSON.stringify(content)))throw Error('Secret handoff refused. Use opaque host references.');
 if(!['CONVERSATION','WORK'].includes(packet.mission_class)||!['public','personal'].includes(packet.data_class)||!(packet.privacy==='local_only'||packet.version===2&&packet.privacy==='approved_external'&&packet.mission_class==='WORK'&&packet.data_class==='public'))throw Error('Permitted local data classification required');
 for(const k of ['constraints','project','workspace'])if(packet[k]!==undefined)text(packet[k],k,k==='constraints'?1000:120);
 for(const k of ['acceptance_criteria','references','capability_classes'])if(packet[k]!==undefined&&(!Array.isArray(packet[k])||packet[k].length>10||packet[k].some(v=>typeof v!=='string'||!v||v.length>240)))throw Error('Bounded handoff fields required');
 if((packet.references||[]).length)throw Error('Reference handles require a host-approved resolver; unavailable');
 if(packet.mission_class==='CONVERSATION'&&((packet.capability_classes||[]).length||packet.workspace||packet.project))throw Error('Conversation cannot request capabilities or a workspace');
 return packet;
}
async function submit(bridge,packet,principal,operatorAcceptance=null){
 validate(packet);identifier(principal);if(principal!=='operator'&&!principal.startsWith('mcp:'))throw Error('Authenticated handoff principal required');
 const operation={op:packet.version===1?'external_handoff_v1':'external_handoff_v2',packet,
   ...(operatorAcceptance!==null?{preauthorized_expected_digest:fingerprint(operatorAcceptance)}:{})};
 const previous=bridge.controlStore.db.prepare('SELECT owner FROM cp_requests WHERE request_id=? AND owner LIKE ?').all(packet.request_id,'mcp:%');
 if(previous.some(r=>r.owner!==principal))throw Error('Resume the original authenticated handoff session; duplicate execution denied');
 if(bridge.controlStore.db.prepare('SELECT 1 FROM cp_requests WHERE owner=? AND request_id=?').get(principal,packet.request_id))return bridge.controlStore.request(principal,packet.request_id,operation,()=>{throw Error('Invalid replay');});
 const external=packet.privacy==='approved_external';
 // local_only WORK uses owner-registered WorkTemplates; never fall back to approved_external templates.
 const template=packet.mission_class==='WORK'?(external?bridge.workers.template(packet.project,packet.workspace):(packet.project&&packet.workspace&&bridge.workTemplates.read(packet.project,packet.workspace)?bridge.workTemplates.template(packet.project,packet.workspace):bridge.options.externalMissionTemplates?.[packet.project]?.[packet.workspace])):null;
 if(packet.mission_class==='WORK'&&!template)return {state:'WAIT',reason:'Host-approved WORK template required',authority:false};
 if(packet.mission_class==='WORK'&&template.data_class&&packet.data_class!==template.data_class)throw Error('Template data classification mismatch');
 const catalog=await router.inspect(bridge);
 if(packet.mission_class==='WORK'&&template.workers){catalog.workers=catalog.workers.filter(w=>template.workers.includes(w.id));catalog.models=catalog.models.filter(m=>m.workers.some(w=>template.workers.includes(w)));}
 const route=router.select(catalog,{mission_class:packet.mission_class,data_class:packet.data_class,privacy:packet.privacy,model:packet.model,worker:packet.worker});
 if(route.state!=='READY')return {state:'WAIT',reason:route.reason,authority:false};
 // Only a trusted owner-approved zero-setup flow may replace operator review with
 // an exact-file criterion. The untrusted MCP packet has no such field or power.
 if(operatorAcceptance!==null){
  object(operatorAcceptance,['file','before','after']);
  if(principal!=='operator'||packet.mission_class!=='WORK'||packet.privacy!=='local_only'||!template?.work_template||
     (packet.acceptance_criteria||[]).length||template.allowed_files.length!==1||
     template.allowed_files[0]!==operatorAcceptance.file||typeof operatorAcceptance.before!=='string'||
     typeof operatorAcceptance.after!=='string'||operatorAcceptance.before===operatorAcceptance.after||
     Buffer.byteLength(operatorAcceptance.after)>12000)throw Error('Preauthorized exact-file Acceptance scope required');
  const expected=path.join(template.workspace,operatorAcceptance.file);
  if(fs.realpathSync(expected)!==expected||fs.readFileSync(expected,'utf8')!==operatorAcceptance.before)
   throw Error('Preauthorized file baseline changed; request fresh owner authorization');
 }
 return bridge.controlStore.request(principal,packet.request_id,operation,()=>{
 const request_id='handoff:'+principal+':'+packet.request_id;
 let created;
 if(packet.mission_class==='WORK'){
  if((packet.capability_classes||[]).some(c=>!template.capability_scopes.includes(c)))throw Error('Requested capabilities exceed host template');
  const {privacy,data_class,workers,...scope}=template;
  // ADR 0051: owner-registered local WORK always carries the canonical Mission contract
  // (host-derived defaults; the untrusted packet cannot shape permissions). External
  // vendor WORK keeps its worker_contract ceiling until a disclosure-authorized contract exists.
  // Owner-registered local WORK authorizes exactly one automatic correction (matches the zero-setup CAE budget).
 const contract=!external&&template.work_template?{contract:{objective:{original_instruction:String(packet.objective).slice(0,4000)},budget:{risk_class:template.risk_class||'normal',max_repair_attempts:1}}}:{};
  created=bridge.missions.create({...scope,...contract,...(operatorAcceptance?{risk_auto_acceptance:true}:{}),...(external?{model:route.model,fallback_agents:[],dispatch_policy:{privacy:'cloud_allowed',providers:[require('./bounded-worker').SPECS[route.worker].provider],billing_classes:['subscription'],max_attempts:1}}:{}),criteria:[...(operatorAcceptance?[{id:'expected_file',type:'exact_file',path:operatorAcceptance.file,content:operatorAcceptance.after}]:template.criteria),...(packet.acceptance_criteria||[]).map((description,i)=>({id:'external-review-'+i,type:'operator_review',description}))],request_id,objective:packet.objective,constraints:[template.constraints||'',packet.constraints||'',...(packet.acceptance_criteria||[]).map(c=>'Operator review criterion (request data): '+c)].filter(Boolean).join('\n')||'Use only the owner-registered bounded scope.',preferred_agent:route.worker},'operator');
  created={mission_id:created.id,task_id:created.task_id,state:created.state};
 }else created=bridge.missions.createConversation({request_id,message:packet.objective+(packet.constraints?'\nConstraints (request data): '+packet.constraints:'')+((packet.acceptance_criteria||[]).length?'\nOperator review criteria (request data): '+packet.acceptance_criteria.join('; '):''),include_memory:principal==='operator'&&packet.data_class==='personal',runtime:route.worker,model:route.model,route_mode:route.mode});
 const task=bridge.tasks.get(created.task_id);
 if(task.source?.handoff_principal&&task.source.handoff_principal!==principal)throw Error('Handoff identity mismatch');
 task.source={...task.source,handoff_principal:principal};bridge.tasks.save(task);
 const m=bridge.missions.require(created.mission_id);
 // local_only owner WorkTemplates defer dispatch: Goal Plan + Control Center authorize-autonomous-goal own scheduling.
 const deferLocalWork=packet.mission_class==='WORK'&&packet.privacy==='local_only'&&!!template?.work_template;
 if(m.state==='ready'&&!deferLocalWork)bridge.missions.dispatch(m.id,{request_id:'handoff-dispatch:'+request_id});
 return {version:packet.version,mission_id:m.id,state:m.state,route,authority:false,deferred_dispatch:deferLocalWork,next_action:deferLocalWork?'propose_goal_plan_then_owner_authorize':'inspect'};
 });
}
function bound(bridge,id,principal){const m=bridge.missions.require(id),task=bridge.tasks.get(m.task_id);if(task.source?.handoff_principal!==principal)throw Error('Handoff belongs to another authenticated client');return m;}
function status(bridge,id,principal){const m=bound(bridge,id,principal),view=require('./product-observability').missionView(bridge,m);return {version:1,mission_id:m.id,state:m.state,progress:view.progress,verification:view.verification,review:view.acceptance,settlement:view.settlement,result:require('./conversation-mission').projectRead(bridge,m.task_id,bridge.tasks.get(m.task_id).lastResult||null,m.id),untrusted:true,authority:false};}
function askOwnsMission(bridge, id, principal) {
  const rows = bridge.controlStore.db.prepare(
    'SELECT request_id, principal, record FROM cp_zero_setup_requests WHERE principal=?'
  ).all(principal);
  for (const row of rows) {
    let rec; try { rec = JSON.parse(row.record); } catch { continue; }
    if (rec.mission_id === id) return row;
  }
  return null;
}

function cancel(bridge, id, principal, requestId = null) {
  // Prefer authenticated handoff ownership. Ask-origin Missions bind through the
  // durable zero-setup principal instead of submit_mission handoff metadata.
  let owned = false;
  try { bound(bridge, id, principal); owned = true; } catch { /* fall through */ }
  if (!owned && !askOwnsMission(bridge, id, principal)) {
    throw Error('Handoff belongs to another authenticated client');
  }
  const rid = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : randomUUID();
  if (rid.length > 120) throw Error('Bounded request ID required');
  const operation = { op: 'mcp_cancel_mission', mission_id: id };
  return bridge.controlStore.request(principal, rid, operation, () => {
    const m = bridge.missions.require(id);
    if (['cancelled', 'completed'].includes(m.state)) {
      return { mission_id: id, cancellation_requested: true, state: m.state, request_id: rid, authority: false };
    }
    bridge.missions.cancel(id, { request_id: rid });
    // Keep ask-origin presentation aligned when a zero-setup row owns this Mission.
    try {
      const row = askOwnsMission(bridge, id, principal);
      if (row && bridge.zeroSetupWork?.write) {
        const rec = JSON.parse(row.record);
        rec.state = 'rejected';
        rec.blocker_message = 'The task was cancelled. No Acceptance was recorded.';
        bridge.zeroSetupWork.write(row.request_id, row.principal, rec, 'rejected');
      }
    } catch { /* best-effort presentation sync */ }
    return { mission_id: id, cancellation_requested: true, request_id: rid, authority: false };
  });
}
module.exports={validate,submit,status,cancel};
