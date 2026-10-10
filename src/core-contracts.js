'use strict';
// Versioned canonical contracts. Validation is additive observation — never a
// silent rewrite of durable ConversationEngine, Mission, or ledger rows.
const fs=require('node:fs'),path=require('node:path');
const {object,text,identifier}=require('./control-plane-store');
const MANIFEST=require('../config/core-contracts-v1.json');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NAMES=Object.keys(MANIFEST.contracts);

function manifest(){return {schema_version:MANIFEST.schema_version,family:MANIFEST.family,owner:MANIFEST.owner,compatibility:MANIFEST.compatibility,contracts:Object.fromEntries(NAMES.map(name=>{const c=MANIFEST.contracts[name];return [name,{id:c.id,version:c.version,state_owner:c.state_owner,authority:c.authority===true,kind:c.kind||null}];})),kinds:MANIFEST.kinds};}

function definition(name){
 if(!MANIFEST.contracts[name])throw Error('Unknown core contract');
 return MANIFEST.contracts[name];
}

function stamp(name,extra={}){
 const def=definition(name);
 return {contract:{id:def.id,version:def.version,family:MANIFEST.family},...extra};
}

function requireFields(input,fields,label){
 object(input,[...new Set([...fields,...Object.keys(input)])]);
 for(const field of fields)if(input[field]===undefined||input[field]===null)throw Error(label+' missing '+field);
}

function validateConversation(input){
 const def=definition('Conversation');
 requireFields(input,['contract','conversation_id','channel','operator_id'],'Conversation');
 if(!input.contract||input.contract.id!==def.id)throw Error('Conversation contract identity required');
 if(input.contract.version!==def.version){
  if(!Number.isInteger(input.contract.version)||input.contract.version<1||input.contract.version>def.version)throw Error('Unsupported Conversation contract version');
 }
 if(!UUID.test(input.conversation_id))throw Error('Host-issued conversation identity required');
 if(!def.channels.includes(input.channel))throw Error('Invalid conversation channel');
 text(input.operator_id,'operator',160);
 if(input.include_memory!==undefined&&typeof input.include_memory!=='boolean')throw Error('Invalid Memory choice');
 if(input.include_history!==undefined&&typeof input.include_history!=='boolean')throw Error('Invalid history choice');
 if(input.authority===true)throw Error('Conversation cannot carry Mission authority');
 return {ok:true,contract:def.id,version:input.contract.version,historical:input.contract.version<def.version};
}

function validateModelRequest(input){
 const def=definition('ModelRequest');
 requireFields(input,['contract','request_id','model','messages','privacy'],'ModelRequest');
 if(!input.contract||input.contract.id!==def.id||input.contract.version!==def.version)throw Error('ModelRequest contract identity/version required');
 if(!UUID.test(input.request_id))throw Error('Opaque request UUID required');
 text(String(input.model),'model',160);
 if(!Array.isArray(input.messages)||!input.messages.length||input.messages.length>64)throw Error('ModelRequest messages bound');
 if(!['local_only','public_text_review'].includes(input.privacy))throw Error('Unsupported ModelRequest privacy');
 if(input.tools||input.workspace||input.mission_id)throw Error('Model provider contracts cannot carry agent/workspace authority');
 return {ok:true,contract:def.id,version:def.version,kind:'model_provider'};
}

function validateWorkerAssignment(input){
 const def=definition('WorkerAssignment');
 requireFields(input,['contract','mission_id','worker','model','security'],'WorkerAssignment');
 if(!input.contract||input.contract.id!==def.id||input.contract.version!==def.version)throw Error('WorkerAssignment contract identity/version required');
 if(!UUID.test(input.mission_id))throw Error('Mission identity required');
 identifier(input.worker);text(String(input.model),'model',160);
 object(input.security,Object.keys(input.security||{}));
 const security=input.security;
 for(const key of Object.keys(security)){
  if(!['workspace_confinement','tool_mediation','credential_isolation','cancellation','result_publication','recovery_support'].includes(key))throw Error('Unknown security property');
  if(!['VERIFIED','UNVERIFIED','UNSUPPORTED'].includes(security[key]))throw Error('Invalid security classification');
 }
 return {ok:true,contract:def.id,version:def.version,kind:'agent_runtime',requires_verified:Object.entries(security).filter(([,v])=>v==='VERIFIED').map(([k])=>k)};
}

function validateMission(input){
 const def=definition('Mission');
 requireFields(input,['contract','mission_id','state','kind'],'Mission');
 if(!input.contract||input.contract.id!==def.id)throw Error('Mission contract identity required');
 if(!Number.isInteger(input.contract.version)||input.contract.version<1||input.contract.version>def.version)throw Error('Unsupported Mission contract version');
 if(!UUID.test(input.mission_id))throw Error('Mission identity required');
 text(input.state,'mission state',80);text(input.kind,'mission kind',80);
 return {ok:true,contract:def.id,version:input.contract.version,historical:input.contract.version<def.version,authority:true};
}

function validateExecutionEvent(input){
 const def=definition('ExecutionEvent');
 requireFields(input,['contract','event_type','observed_at'],'ExecutionEvent');
 if(!input.contract||input.contract.id!==def.id||input.contract.version!==def.version)throw Error('ExecutionEvent contract identity/version required');
 text(input.event_type,'event type',160);
 if(!Number.isSafeInteger(input.observed_at)||input.observed_at<=0)throw Error('Invalid event observation time');
 if(input.mission_id&&!UUID.test(input.mission_id))throw Error('Invalid Mission identity');
 return {ok:true,contract:def.id,version:def.version};
}

function validateVerificationEvidence(input){
 const def=definition('VerificationEvidence');
 requireFields(input,['contract','verification_id','mission_id','status','provenance'],'VerificationEvidence');
 if(!input.contract||input.contract.id!==def.id||input.contract.version!==def.version)throw Error('VerificationEvidence contract identity/version required');
 if(!UUID.test(input.verification_id)||!UUID.test(input.mission_id))throw Error('Verification identities required');
 text(input.status,'verification status',80);
 text(input.provenance,'evidence provenance',200);
 if(input.provenance==='worker_self_report')throw Error('Worker self-reports cannot establish verification evidence');
 return {ok:true,contract:def.id,version:def.version,worker_self_report_insufficient:true};
}

const VALIDATORS={
 Conversation:validateConversation,
 ModelRequest:validateModelRequest,
 WorkerAssignment:validateWorkerAssignment,
 Mission:validateMission,
 ExecutionEvent:validateExecutionEvent,
 VerificationEvidence:validateVerificationEvidence
};

function validate(name,input){
 if(!VALIDATORS[name])throw Error('Unknown core contract');
 return VALIDATORS[name](input);
}

function annotateHistorical(name,record){
 // Observe durable records without rewriting them. Missing contract stamps are
 // treated as pre-contract historical evidence, not migration candidates.
 const def=definition(name);
 if(record&&record.contract&&record.contract.id===def.id)return {record,status:'versioned',version:record.contract.version};
 return {record,status:'historical_unversioned',version:null,compatibility:'readable_without_rewrite'};
}

function assertAssignmentSecurity(assignment,{required=[]}={}){
 const result=validateWorkerAssignment(assignment);
 for(const property of required){
  const state=assignment.security?.[property];
  if(state!=='VERIFIED')throw Error('Assignment requires verified '+property+'; observed '+(state||'missing'));
 }
 return result;
}

function loadPath(){return path.join(__dirname,'../config/core-contracts-v1.json');}
function intact(){return fs.existsSync(loadPath())&&MANIFEST.schema_version===1&&NAMES.length===6;}

module.exports={MANIFEST,manifest,definition,stamp,validate,annotateHistorical,assertAssignmentSecurity,intact,NAMES};
