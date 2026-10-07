'use strict';
// Registry metadata is host-owned; discovery never becomes qualification.
const runtime=require('../config/agent-runtime-qualification-v1.json').opencode;
const evidence=require('../config/local-model-capability-v1.json').models.find(m=>m.model===runtime.model.slice(7));
const MODEL=runtime.model, EXPIRES=Date.parse(runtime.observed_date+'T00:00:00Z')+30*86400000;
function registry(bridge,observed={},now=Date.now()) {
 const configured=bridge.opencodeAdapter.options.model===MODEL;
 const qualified=runtime.execution_qualified===true&&evidence?.qualification_status==='qualified'&&configured&&now<EXPIRES;
 const ready=observed.ready===true;
 return {models:[{id:MODEL,name:'Qwen3 Coder 30B',provider:'ollama',locality:'local',workers:['opencode'],data_classes:['public','personal'],tasks:['CONVERSATION','WORK'],context_limit:null,effective_context_limit:null,cost:null,cost_class:'local',qualification:qualified?'qualified':'unqualified',available:ready&&qualified,evidence_version:'opencode-2.0.20-memory-v2',runtime_version:runtime.runtime_version,model_digest:evidence?.digest||null,expires_at:EXPIRES}],workers:[
 {id:'opencode',support:'supported',transport:'confined_local_cli',locality:'local',qualification:qualified?'qualified':'unqualified',available:ready&&qualified,capabilities:['conversation','coding'],live_qualified:qualified&&ready&&!bridge.opencodeAdapter.options.fixtureExecutable},
 {id:'codex',support:'optional',transport:'work_execution_adapter',locality:'external',qualification:'unqualified',available:false,capabilities:['coding','handoff'],live_qualified:false},
 {id:'claude_code',support:'supported',transport:'local_optional_adapter',locality:'external',qualification:'unqualified',available:false,capabilities:['coding'],live_qualified:false},
 {id:'cursor',support:'experimental',transport:'governed_acp',locality:'external',qualification:'denied',available:false,capabilities:[],live_qualified:false}
 ],authority:false};
}
function select(catalog,input={}) {
 const {mission_class='CONVERSATION',data_class='personal',model='auto',worker='auto',privacy='local_only',context_need=0,writer_conflict=false}=input;
 const wait=reason=>({state:'WAIT',reason,model:null,worker:null,authority:false});
 if(!['CONVERSATION','WORK'].includes(mission_class)||!['public','personal','sensitive','secret'].includes(data_class)||!['local_only','approved_external'].includes(privacy)||!Number.isSafeInteger(context_need)||context_need<0)return wait('invalid_policy');
 if(writer_conflict)return wait('writer_lease_conflict');
 if(['sensitive','secret'].includes(data_class))return wait('operator_only_data');
 const manual=model!=='auto'||worker!=='auto';
 if(!['auto','local'].includes(model)&&!catalog.models.some(m=>m.id===model))return wait('unknown_model');
 if(worker!=='auto'&&!catalog.workers.some(w=>w.id===worker))return wait('unknown_worker');
 const candidates=catalog.models.filter(m=>m.qualification==='qualified'&&m.available&&m.expires_at>Date.now()&&m.data_classes.includes(data_class)&&m.tasks.includes(mission_class)&&(privacy!=='local_only'||m.locality==='local')&&(model==='auto'||model==='local'&&m.locality==='local'||m.id===model)&&(context_need===0||m.context_limit!==null&&m.context_limit>=context_need)).sort((a,b)=>a.id.localeCompare(b.id));
 for(const m of candidates){const w=catalog.workers.find(w=>m.workers.includes(w.id)&&(worker==='auto'||w.id===worker)&&w.qualification==='qualified'&&w.available&&(privacy!=='local_only'||w.locality==='local'));if(w)return {state:'READY',model:m.id,worker:w.id,provider:m.provider,locality:m.locality,mode:manual?'MANUAL':'AUTO',reason:'Current qualified local model and compatible bounded worker; minimum permitted context',evidence_version:m.evidence_version,expires_at:m.expires_at,authority:false};}
 return wait('no_current_qualified_compatible_route');
}
async function inspect(bridge){return registry(bridge,await bridge.opencodeAdapter.readiness());}
module.exports={MODEL,EXPIRES,registry,select,inspect};
