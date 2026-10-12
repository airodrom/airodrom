'use strict';
// Operator-imported aggregate evidence. This cannot run evaluations, alter policy or accept work.
const { object, identifier } = require('./control-plane-store');
const COUNTS=['scenarios','passed','failed','security_failures','recovery_passed','recovery_failed','duration_ms'];
function summary(input) {
 object(input,['source_sha','evidence_class',...COUNTS,'task_success_rate','memory']);
 if (!/^[a-f0-9]{40}$/.test(input.source_sha||'') || !['MOCKED_CONTRACT','DISPOSABLE_FIXTURE','REAL_LOCAL_MODEL'].includes(input.evidence_class)) throw Error('Invalid evidence provenance');
 for(const k of COUNTS)if(!Number.isSafeInteger(input[k])||input[k]<0||input[k]>100000000)throw Error('Invalid aggregate count');
 if(input.passed+input.failed!==input.scenarios)throw Error('Inconsistent scenario counts');
 const ratio=v=>v===null||Number.isFinite(v)&&v>=0&&v<=1;
 if(!ratio(input.task_success_rate))throw Error('Invalid task metric');
 object(input.memory,['precision','recall','provenance','budget_utilization','forbidden_hits','relevant','irrelevant','correction_passed','forgetting_passed']);
 for(const k of ['precision','recall','provenance','budget_utilization'])if(!ratio(input.memory[k]))throw Error('Invalid memory metric');
 if(input.memory.forbidden_hits!==null&&(!Number.isSafeInteger(input.memory.forbidden_hits)||input.memory.forbidden_hits<0))throw Error('Invalid memory security metric');
 for(const k of ['relevant','irrelevant'])if(input.memory[k]!==undefined&&input.memory[k]!==null&&(!Number.isSafeInteger(input.memory[k])||input.memory[k]<0||input.memory[k]>100000000))throw Error('Invalid retrieval count');
 for(const k of ['correction_passed','forgetting_passed'])if(input.memory[k]!==undefined&&input.memory[k]!==null&&typeof input.memory[k]!=='boolean')throw Error('Invalid memory lifecycle result');
 return JSON.parse(JSON.stringify(input));
}
function record(bridge,input) {
 object(input,['request_id','summary']);identifier(input.request_id);const report=summary(input.summary);
 return bridge.controlStore.request('operator',input.request_id,{op:'record_evaluation_summary',report},()=>{
  const event=bridge.controlStore.event('evaluation.report',null,{...report,provenance:'operator_imported',authority:false});return {event_id:event.event_id,authority:false};
 });
}
function recent(bridge) {
 const events=bridge.ledger.list({eventType:'evaluation.report',limit:20,order:'desc'}).events;
 const items=[];
 for(const e of events)try{const {provenance,authority,...input}=e.metadata;items.push({id:e.event_id,at:e.timestamp_ms,...summary(input),provenance:'operator_imported',authority:false});}catch{}
 const [latest,prior]=items;
 const comparable=!!(latest&&prior&&latest.evidence_class===prior.evidence_class&&latest.scenarios===prior.scenarios);
 return {items,comparison:comparable?{passed_delta:latest.passed-prior.passed,security_failure_delta:latest.security_failures-prior.security_failures}:null,execution_enabled:false,authority:false};
}
module.exports={summary,record,recent};
