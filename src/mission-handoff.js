'use strict';
// Untrusted requests choose no authority. Host templates fix WORK scope.
const {object,text,identifier}=require('./control-plane-store'),{randomUUID}=require('node:crypto');
const router=require('./model-worker-router');
function validate(packet){
 object(packet,['version','request_id','objective','constraints','acceptance_criteria','references','capability_classes','data_class','privacy','worker','model','project','workspace','mission_class']);
 if(packet.version!==1)throw Error('Handoff version 1 required');identifier(packet.request_id);if(packet.request_id.length>80)throw Error('Bounded request ID required');text(packet.objective,'objective',4000);
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(packet.request_id))text(packet.request_id,'request ID',80);
 const {request_id,...content}=packet;if(require('./assistant-intent').secret(JSON.stringify(content)))throw Error('Secret handoff refused. Use opaque host references.');
 if(!['CONVERSATION','WORK'].includes(packet.mission_class)||!['public','personal'].includes(packet.data_class)||packet.privacy!=='local_only')throw Error('Permitted local data classification required');
 for(const k of ['constraints','project','workspace'])if(packet[k]!==undefined)text(packet[k],k,k==='constraints'?1000:120);
 for(const k of ['acceptance_criteria','references','capability_classes'])if(packet[k]!==undefined&&(!Array.isArray(packet[k])||packet[k].length>10||packet[k].some(v=>typeof v!=='string'||!v||v.length>240)))throw Error('Bounded handoff fields required');
 if((packet.references||[]).length)throw Error('Reference handles require a host-approved resolver; unavailable');
 if(packet.mission_class==='CONVERSATION'&&((packet.capability_classes||[]).length||packet.workspace||packet.project))throw Error('Conversation cannot request capabilities or a workspace');
 return packet;
}
async function submit(bridge,packet,principal){
 validate(packet);identifier(principal);if(principal!=='operator'&&!principal.startsWith('mcp:'))throw Error('Authenticated handoff principal required');
 const route=router.select(await router.inspect(bridge),{mission_class:packet.mission_class,data_class:packet.data_class,privacy:packet.privacy,model:packet.model,worker:packet.worker});
 if(route.state!=='READY')return {state:'WAIT',reason:route.reason,authority:false};
 const previous=bridge.controlStore.db.prepare('SELECT owner FROM cp_requests WHERE request_id=? AND owner LIKE ?').all(packet.request_id,'mcp:%');
 if(previous.some(r=>r.owner!==principal))throw Error('Resume the original authenticated handoff session; duplicate execution denied');
 return bridge.controlStore.request(principal,packet.request_id,{op:'external_handoff_v1',packet},()=>{
 const request_id='handoff:'+principal+':'+packet.request_id;
 let created;
 if(packet.mission_class==='WORK'){
  const template=bridge.options.externalMissionTemplates?.[packet.project]?.[packet.workspace];
  if(!template)return {state:'WAIT',reason:'Host-approved WORK template required',authority:false};
  if((packet.capability_classes||[]).some(c=>!template.capability_scopes.includes(c)))throw Error('Requested capabilities exceed host template');
  created=bridge.missions.create({...template,criteria:[...template.criteria,...(packet.acceptance_criteria||[]).map((description,i)=>({id:'external-review-'+i,type:'operator_review',description}))],request_id,objective:packet.objective,constraints:[template.constraints||'',packet.constraints||'',...(packet.acceptance_criteria||[]).map(c=>'Operator review criterion (request data): '+c)].join('\n'),preferred_agent:route.worker},'operator');
  created={mission_id:created.id,task_id:created.task_id,state:created.state};
 }else created=bridge.missions.createConversation({request_id,message:packet.objective+(packet.constraints?'\nConstraints (request data): '+packet.constraints:'')+((packet.acceptance_criteria||[]).length?'\nOperator review criteria (request data): '+packet.acceptance_criteria.join('; '):''),include_memory:principal==='operator'&&packet.data_class==='personal',runtime:route.worker,model:route.model,route_mode:route.mode});
 const task=bridge.tasks.get(created.task_id);
 if(task.source?.handoff_principal&&task.source.handoff_principal!==principal)throw Error('Handoff identity mismatch');
 task.source={...task.source,handoff_principal:principal};bridge.tasks.save(task);
 const m=bridge.missions.require(created.mission_id);
 if(m.state==='ready')bridge.missions.dispatch(m.id,{request_id:'handoff-dispatch:'+request_id});
 return {version:1,mission_id:m.id,state:m.state,route,authority:false};
 });
}
function bound(bridge,id,principal){const m=bridge.missions.require(id),task=bridge.tasks.get(m.task_id);if(task.source?.handoff_principal!==principal)throw Error('Handoff belongs to another authenticated client');return m;}
function status(bridge,id,principal){const m=bound(bridge,id,principal),view=require('./product-observability').missionView(bridge,m);return {version:1,mission_id:m.id,state:m.state,progress:view.progress,verification:view.verification,review:view.acceptance,settlement:view.settlement,result:require('./conversation-mission').projectRead(bridge,m.task_id,bridge.tasks.get(m.task_id).lastResult||null,m.id),untrusted:true,authority:false};}
function cancel(bridge,id,principal){bound(bridge,id,principal);bridge.missions.cancel(id,{request_id:randomUUID()});return {mission_id:id,cancellation_requested:true,authority:false};}
module.exports={validate,submit,status,cancel};
