'use strict';
// Authenticated operator ingress. Objective text and the CLI's current directory
// are request data; neither can register execution authority or a write scope.
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {object,text,identifier}=require('./control-plane-store');
const intent=require('./assistant-intent'),router=require('./model-worker-router');
const TERMINAL=new Set(['completed','cancelled']);
const requestIdentity=value=>{identifier(value);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw Error('Opaque request UUID required');};
const workMission=m=>m.owner==='operator'&&m.envelope.kind!=='conversation';
function projection(server,m){
 const draft=m.envelope.kind==='work_request';
 return {id:m.id,objective:m.envelope.objective,state:m.state,created_at:m.created_at,scope_registered:!draft,...(m.envelope.kind==='browser_research'?{research:server.bridge.missions.research.progress(m)}:{}),...(draft?{execution_authorized:false,message:m.reason||'Choose a bounded workspace, allowed files and registered verification before execution.',requested_capabilities:m.envelope.requested_capabilities||[],capability_classes:[],authority:false}:{verification:require('./product-observability').missionView(server.bridge,m).verification})};
}
function list(server,{active=false}={}){
 if(typeof active!=='boolean')throw Error('Invalid Mission list filter');
 const items=server.bridge.controlStore.listMissions({owner:'operator',limit:100}).filter(workMission).filter(m=>!active||!TERMINAL.has(m.state)).map(m=>projection(server,m));
 return {kind:'missions',items,authority:false};
}
function selected(server,mission_id){
 if(mission_id){const m=server.bridge.missions.require(identifier(mission_id),'operator');if(!workMission(m))throw Error('Choose a Work Mission; ordinary conversations have no Mission.');return m;}
 const active=server.bridge.controlStore.listMissions({owner:'operator',limit:100}).filter(workMission).filter(m=>!TERMINAL.has(m.state));
 if(active.length!==1)return {kind:'clarify',message:active.length?'Which Mission? Use /mission status <id> or /mission cancel <id>.':'No active Work Mission. Use /mission new <objective>.',choices:active.map(m=>({id:m.id,state:m.state}))};
 return active[0];
}
function status(server,{mission_id=null}={}){const m=selected(server,mission_id);return m.kind==='clarify'?m:{kind:'mission_status',mission:projection(server,m),authority:false};}
function cancel(server,{mission_id=null,request_id=randomUUID()}={}){
 requestIdentity(request_id);const m=selected(server,mission_id);if(m.kind==='clarify')return m;
 return {kind:'mission',...server.bridge.missions.cancel(m.id,{request_id},'operator'),message:'Mission cancelled. Existing execution termination and ownership checks still apply.',authority:false};
}
function registry(bridge){
 // Existing canonical request idempotency stores only opaque registry IDs. No
 // second Mission or secret store is introduced by the assistant interface.
 return bridge.controlStore.request('operator','assistant-work-registry-v1',{op:'assistant_work_registry_v1'},()=>{
  const p=bridge.projects.createProject({name:'Assistant Work Requests',autonomyLevel:'suggest',privacyPolicy:'local_only',repositories:[],limitations:['Request drafts grant no execution or filesystem authority.']});
  const g=bridge.projects.createGoal({projectId:p.projectId,name:'Bound user work before execution',nextAction:'Select an owner-registered bounded Mission template.'});
  return {project_id:p.projectId,goal_id:g.goalId};
 });
}
function draft(server,input,message){
 const b=server.bridge,objective=input.objective||'Mission objective pending';
 return b.controlStore.request('operator','assistant-work:'+input.request_id,{op:'assistant_work_request_v1',...input},()=>{
  const r=registry(b),p=b.projects.createMission({goalId:r.goal_id,name:objective.slice(0,180),description:objective,status:'planned',acceptanceCriteria:[],nextAction:message});
  // cp_missions keeps an opaque task identity for schema compatibility. There
  // is deliberately no Task, task binding, execution lease or dispatch record.
  const m=b.controlStore.registerMission({id:p.missionId,projectId:r.project_id,goalId:r.goal_id,taskId:randomUUID(),owner:'operator',envelope:{control_version:2,kind:'work_request',objective,task_type:'work_request',workspace:null,requested_workspace:input.workspace||null,requested_capabilities:input.capability_classes||intent.workCapabilities(objective),explicit_mission:input.explicit===true,allowed_files:[],criteria:[],verification:{diff_check:null,tests:[],syntax:[]},capability_scopes:[],preferred_agent:null,fallback_agents:[],constraints:'No execution. A distinct fully scoped Mission requires the existing host registration and qualification gates.',budget:{maxRuntimeMs:0,maxActions:0,maxRetries:0,maxSpendMicros:0}},ceiling:{capability_scopes:[],filesystem:{read:[],write:[]},execution:false,authority:'none; bounded scope and registered verification required'}});
  b.controlStore.state(m.id,'draft',message);
  return {kind:'mission',route:input.explicit?'EXPLICIT MISSION':'WORK',mission_id:m.id,state:'draft',message,authority:false,execution_authorized:false};
 });
}
function matchingTemplates(bridge,workspace){
 if(!workspace)return [];
 const candidates=[];
 for(const entries of Object.values(bridge.options.externalMissionTemplates||{}))for(const template of Object.values(entries||{})){
  if(template&&typeof template.workspace==='string'&&path.isAbsolute(template.workspace)&&path.resolve(template.workspace)===path.resolve(workspace))candidates.push(template);
 }
 return candidates;
}
async function newMission(server,input){
 object(input,['objective','request_id','workspace','capability_classes','model','worker','explicit']);requestIdentity(input.request_id);
 if(input.explicit!==undefined&&typeof input.explicit!=='boolean')throw Error('Invalid explicit Mission choice');
 if(input.objective!==undefined&&input.objective!==null){text(input.objective,'Mission objective',4000);if(require('./private-vault-intent').containsPrivate(input.objective))throw Error('Private identifiers cannot be Mission objectives. Use /secret.');if(intent.secret(input.objective))throw Error('Secrets cannot be Mission objectives. Use /vault.');}
 if(input.workspace!==undefined){text(input.workspace,'workspace context',1000);if(!path.isAbsolute(input.workspace))throw Error('Absolute workspace context required');}
 const requested=input.capability_classes||[];
 if(!Array.isArray(requested)||requested.length>10||requested.some(c=>!['repo','developer_environment','communications','web_read','deployment'].includes(c)))throw Error('Unknown requested capabilities');
 // An explicit requested class can restrict routing further, but cannot remove
 // the host's classification of side effects in the objective itself.
 const capabilities=[...new Set([...intent.workCapabilities(input.objective||''),...requested])];
 const request={...input,capability_classes:capabilities};
 if(!input.objective)return draft(server,request,'What should this Mission accomplish? Then choose its bounded workspace, allowed files and registered checks.');
 const research=require('./browser-research').parse(input.objective);
 if(research){
  if(research.kind!=='research')return research;
  if(input.worker&&!['auto','host'].includes(input.worker))return {kind:'clarify',message:'Browser research uses the governed host browser. Choose /worker auto or /worker host.'};
  if(!server.bridge.missions.research)return {...draft(server,request,require('./browser-research').MESSAGE),browser_research_available:false,evidence:[],comparison:'unverified'};
  let created;
  try{created=server.bridge.missions.createResearch({request_id:input.request_id,objective:input.objective,entry_url:research.entry_url},'operator');}
  catch{return {...draft(server,request,'Research needs a valid approved public HTTPS domain and the current host-registered Arecibo repository. Review the scope before execution; no website has been investigated.'),browser_research_available:false,evidence:[],comparison:'unverified'};}
  const missionId=created.mission_id||created.id;
  if(created.state==='ready')server.bridge.missions.dispatch(missionId,{request_id:'assistant-research-dispatch:'+input.request_id},'operator');
  return {kind:'mission',route:input.explicit?'EXPLICIT MISSION':'WORK',mission_id:missionId,state:server.bridge.missions.require(missionId,'operator').state,browser_research_available:true,message:'Research Mission created. Beginning public website investigation within the approved domain. Account-only features require separate owner authorization.',authority:false};
 }
 const templates=matchingTemplates(server.bridge,input.workspace);
 if(templates.length!==1)return draft(server,request,templates.length?'Several approved scopes match this workspace. Choose one host-registered Mission template.':'Mission created as a draft. Choose an owner-registered workspace template with allowed files and checks before execution.');
 const template=templates[0];
 if(capabilities.some(c=>!(template.capability_scopes||[]).includes(c)))return draft(server,request,'This request needs capabilities outside the registered template. Choose a supported bounded scope; no capability has been granted.');
 let route=null;
 if(template.coding_plan){if(input.worker&&!['auto','host'].includes(input.worker))return draft(server,request,'This template requires its registered host plan. Choose the qualified host worker.');}
 else {
  // Preferences may restrict a template's fixed local route, never replace it
  // with an unqualified worker or external inference provider.
  if(template.preferred_agent&&template.preferred_agent!=='opencode')return draft(server,request,'The registered template worker is not qualified for automatic local execution.');
  route=router.select(await router.inspect(server.bridge),{mission_class:'WORK',data_class:'personal',privacy:'local_only',model:input.model,worker:input.worker});
  if(route.state!=='READY')return draft(server,request,'Mission created as a draft. Its model or worker is not currently qualified; inspect /status before execution.');
 }
 // Keep an implicit default route implicit: MissionService attaches the
 // canonical bounded local policy. An explicitly registered template must
 // already carry its matching immutable policy; this layer cannot invent one.
 const created=server.bridge.missions.create({...structuredClone(template),request_id:'assistant-work:'+input.request_id,objective:input.objective,...(route?{...(template.preferred_agent?{preferred_agent:route.worker}:{}),model:route.model}:{} )},'operator');
 if(created.state==='ready')server.bridge.missions.dispatch(created.id,{request_id:'assistant-dispatch:'+input.request_id},'operator');
 const current=server.bridge.missions.require(created.id,'operator');
 return {kind:'mission',route:input.explicit?'EXPLICIT MISSION':'WORK',mission_id:created.id,state:current.state,message:'Bounded Work Mission created with its registered scope, qualification and verification gates.',authority:false};
}
module.exports={newMission,list,status,cancel,projection};
