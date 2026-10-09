'use strict';
// Registry metadata is host-owned; discovery never becomes qualification.
const runtime=require('../config/agent-runtime-qualification-v1.json').opencode;
const evidence=require('../config/local-model-capability-v1.json').models.find(m=>m.model===runtime.model.slice(7));
const MODEL=runtime.model, EXPIRES=Date.parse(runtime.observed_date+'T00:00:00Z')+30*86400000;
function registry(bridge,observed={},now=Date.now()) {
 const configured=bridge.opencodeAdapter.options.model===MODEL;
 const qualified=runtime.execution_qualified===true&&evidence?.qualification_status==='qualified'&&configured&&now<EXPIRES;
 const ready=observed.ready===true;
 const external=bridge.workers?.catalog()||[];
 const models=external.filter(w=>w.qualified&&w.model).map(w=>({id:w.id+':'+w.model,name:w.model,provider:w.provider,locality:'external',workers:[w.id],data_classes:['public'],tasks:['WORK'],context_limit:null,cost:null,cost_class:'subscription',qualification:w.qualification,available:w.available,evidence_version:w.qualification_id,runtime_version:w.version,expires_at:w.expires_at}));
 return {models:[...models,{id:MODEL,name:'Qwen3 Coder 30B',provider:'ollama',locality:'local',workers:['opencode'],data_classes:['public','personal'],tasks:['CONVERSATION','WORK'],context_limit:null,effective_context_limit:null,cost:null,cost_class:'local',qualification:qualified?'qualified':'unqualified',available:ready&&qualified,evidence_version:'opencode-2.0.25-memory-v2',runtime_version:runtime.runtime_version,model_digest:evidence?.digest||null,expires_at:EXPIRES}],workers:[
 {id:'opencode',support:'supported',transport:'confined_local_cli',locality:'local',qualification:qualified?'qualified':'unqualified',available:ready&&qualified,version:ready&&qualified?runtime.runtime_version:null,expires_at:EXPIRES,auth_state:'local_account_not_required',reason:qualified?(observed.reason||(!ready?'local_runtime_not_ready':null)):'qualification_required',capabilities:['conversation','coding'],live_qualified:qualified&&ready&&!bridge.opencodeAdapter.options.fixtureExecutable},
 ...external

 ],authority:false};
}
function select(catalog,input={}) {
 if(input.worker==='claude-code')input={...input,worker:'claude_code'};
 const {mission_class='CONVERSATION',data_class='personal',model='auto',worker='auto',privacy='local_only',context_need=0,writer_conflict=false,max_cost=null,required_capabilities=[]}=input;
 const wait=reason=>({state:'WAIT',reason,model:null,worker:null,authority:false});
 if(!['CONVERSATION','WORK'].includes(mission_class)||!['public','personal','sensitive','secret'].includes(data_class)||!['local_only','approved_external'].includes(privacy)||!Number.isSafeInteger(context_need)||context_need<0)return wait('invalid_policy');
 if(max_cost!==null&&(!Number.isFinite(max_cost)||max_cost<0)||!Array.isArray(required_capabilities)||required_capabilities.some(c=>typeof c!=='string'))return wait('invalid_policy');
 if(privacy==='approved_external'&&(mission_class!=='WORK'||data_class!=='public'))return wait('external_requires_public_work');
 if(writer_conflict)return wait('writer_lease_conflict');
 if(['sensitive','secret'].includes(data_class))return wait('operator_only_data');
 const manual=model!=='auto'||worker!=='auto';
 if(!['auto','local'].includes(model)&&!catalog.models.some(m=>m.id===model))return wait('unknown_model');
 if(worker!=='auto'&&!catalog.workers.some(w=>w.id===worker))return wait('unknown_worker');
 if(worker!=='auto'){const chosen=catalog.workers.find(w=>w.id===worker);if(!chosen.available||chosen.qualification!=='qualified')return wait(chosen.reason||'worker_'+chosen.qualification);}
 const candidates=catalog.models.filter(m=>m.qualification==='qualified'&&m.available&&m.expires_at>Date.now()&&m.data_classes.includes(data_class)&&m.tasks.includes(mission_class)&&(privacy!=='local_only'||m.locality==='local')&&(model==='auto'||model==='local'&&m.locality==='local'||m.id===model)&&(max_cost===null||m.cost!==null&&m.cost<=max_cost)&&(context_need===0||m.context_limit!==null&&m.context_limit>=context_need)).sort((a,b)=>(a.locality==='local'?0:1)-(b.locality==='local'?0:1)||a.id.localeCompare(b.id));
 for(const m of candidates){const w=catalog.workers.find(w=>m.workers.includes(w.id)&&(worker==='auto'||w.id===worker)&&w.qualification==='qualified'&&w.available&&required_capabilities.every(c=>w.capabilities.includes(c))&&(privacy!=='local_only'||w.locality==='local'));if(w)return {state:'READY',model:m.id,worker:w.id,provider:m.provider,locality:m.locality,mode:manual?'MANUAL':'AUTO',reason:'Current qualified '+m.locality+' model and compatible bounded worker; minimum permitted context',evidence_version:m.evidence_version,expires_at:m.expires_at,authority:false};}
 return wait('no_current_qualified_compatible_route');
}
async function inspect(bridge,{conversation=qualifyConversation}={}){
 const [worker,direct]=await Promise.allSettled([bridge.opencodeAdapter.readiness(),conversation()]);
 const catalog=registry(bridge,worker.status==='fulfilled'?worker.value:{}),ready=direct.status==='fulfilled'&&direct.value.state==='READY'&&direct.value.model===MODEL;
 const local=catalog.models.find(m=>m.id===MODEL);local.conversation={available:ready,worker_required:false};
 if(ready){local.available=true;local.qualification='qualified';}
 return catalog;
}
// Conversation qualification admits only an observed, pinned local model.
// There is no worker selection or execution admission on this path.
async function qualifyConversation({model='auto',request=fetch,now=Date.now()}={}){
 const denied=()=>({state:'WAIT',reason:'conversation_model_unavailable',authority:false});
 if(!['auto','local',MODEL].includes(model)||now>=EXPIRES||runtime.execution_qualified!==true||evidence?.qualification_status!=='qualified')return denied();
 try{
  const response=await request('http://127.0.0.1:11434/api/show',{method:'POST',redirect:'error',signal:AbortSignal.timeout(1500),headers:{'Content-Type':'application/json'},body:JSON.stringify({model:MODEL.slice(7)})});
  if(!response.ok){await response.body?.cancel();return denied();}
  const reader=response.body.getReader(),decoder=new TextDecoder();let content='',bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>256000)return denied();content+=decoder.decode(value,{stream:true});}content+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  const capability=require('./local-model-capability'),live=capability.inspectOllamaShow(JSON.parse(content));
  if(!live.available||!live.digest||!live.templateHash||!capability.assessQualification(evidence,live).allow)return denied();
  return {state:'READY',model:MODEL,provider:'ollama',locality:'local',worker:null,expires_at:EXPIRES,authority:false};
 }catch{return denied();}
}
module.exports={MODEL,EXPIRES,registry,select,inspect,qualifyConversation};
