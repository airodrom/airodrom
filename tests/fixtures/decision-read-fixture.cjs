'use strict';
// Exercise the canonical Decision/continuation controller with real, authorized
// file reads. Only the untrusted result question is synthetic; no implementation
// policy, authority, verification, termination or Acceptance check is replaced.
const {fixture:base,createReadMission}=require('./read-mission-fixture.cjs');
async function fixture(t,options={}){
 const f=await base(t,options),create=f.create;
 f.create=extra=>createReadMission({...f,create},extra);
 f.calls=()=>f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_runs WHERE agent_id='host' AND json_extract(result,'$.native_execution_evidence') IS NOT NULL").get().n;
 const bind=()=>{
  const service=f.bridge.missions,capture=service.captureResult.bind(service);
  service.captureResult=(id,job)=>{
   const run=service.store.run(id),m=service.store.getMission(run.mission_id);
   if(job.status==='completed'&&/DECISION/.test(m.envelope.objective)&&!service.store.decisions(m.id).length){
    const result=JSON.parse(job.result.text);
    Object.assign(result,{needs_operator:true,question:'Which review strategy should this read-only Mission use?',options:[{id:'A',label:'Strategy A'},{id:'B',label:'Strategy B'}],allow_free_text:true});
    job={...job,result:{...job.result,text:JSON.stringify(result)}};
   }
   return capture(id,job);
  };
 };
 bind();const reopen=f.reopen;f.reopen=async(options={})=>reopen({...options,beforeResume:async()=>{bind();await options.beforeResume?.();}});
 return f;
}
module.exports={fixture};
