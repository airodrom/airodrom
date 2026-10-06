'use strict';
const {text,object,redactValue}=require('./control-plane-store');
function normalizeResult(job){
  const raw=job.result?.text||'';let value=null;
  try{value=JSON.parse(raw);}catch{const match=/```(?:json)?\s*([\s\S]*?)```/.exec(raw);try{if(match)value=JSON.parse(match[1]);}catch{}}
  if(!value||typeof value!=='object'||Array.isArray(value))value={summary:raw};
  const list=(key)=>Array.isArray(value[key])?redactValue(value[key].slice(0,20)):[];
  const result={status:job.status==='cancelled'?'cancelled':job.status==='completed'&&!job.result?.is_error?'completed':'failed',summary:redactValue(String(value.summary||raw).slice(0,8000)),changed_files:list('changed_files'),tests:list('tests'),artifacts:list('artifacts'),limitations:list('limitations'),questions:[],memory_candidates:[],continuity_claimed:value.continuity_claimed===true||/\b(?:we previously decided|I remember|as previously agreed)\b/i.test(String(value.summary||'')),untrusted:true};
  if(value.needs_operator===true){
    text(value.question,'agent question',3000);
    const options=value.options??[];if(!Array.isArray(options)||options.length>8)throw Error('Invalid structured decision options');
    for(const o of options){object(o,['id','label','description','recommended']);text(o.id,'option id',80);text(o.label,'option label',240);}
    result.questions=[{question:value.question,options,allow_free_text:value.allow_free_text!==false}];
  }
  for(const candidate of (Array.isArray(value.memory_candidates)?value.memory_candidates.slice(0,5):[])){
    object(candidate,['type','subject','content','confidence','source']);text(candidate.subject,'candidate subject',240);text(candidate.content,'candidate content',12000);
    result.memory_candidates.push({type:candidate.type||'project_fact',subject:candidate.subject,content:candidate.content,confidence:candidate.confidence??50});
  }
  return result;
}
module.exports={normalizeResult};
