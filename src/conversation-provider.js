'use strict';
// ADR 0023: preferences are operator intent, never provider qualification or authority.
const path=require('node:path');
const {object}=require('./control-plane-store');
const POLICY='public-text-only-v1';
const CONSENT='I allow Anthropic to process only public text that I explicitly review for each Claude message. No history, Memory, Google data, files, credentials, paid API use or new billing is authorized.';
function defaults(){return {schema_version:1,revision:0,provider:'qwen',privacy:'local_only',consent:null};}
function validate(value){
 object(value,['schema_version','revision','provider','privacy','consent']);
 if(value.schema_version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!['qwen','claude'].includes(value.provider)||!['local_only','public_text_review'].includes(value.privacy))throw Error('Unsupported conversation preferences; restore a reviewed configuration.');
 if(value.privacy==='local_only'&&value.consent!==null||value.privacy==='public_text_review'&&value.consent!==POLICY)throw Error('Invalid external conversation consent.');
 return value;
}
function read(dataDir){
 const file=path.join(dataDir,'conversation-provider.json'),p=require('./private-json');
 return p.privateFileExists(file)?validate(p.readPrivateJSON(file,4096)):defaults();
}
function save(dataDir,input,principal){
 if(principal!=='operator')throw Error('Authenticated local operator required.');
 object(input,['revision','provider','consent']);
 const previous=read(dataDir);
 if(input.revision!==previous.revision)throw Error('Conversation preferences changed; reload before saving.');
 if(!['qwen','claude'].includes(input.provider))throw Error('Choose qwen or claude.');
 if(input.consent!==undefined&&input.consent!==null&&input.consent!==CONSENT)throw Error('Review the exact external data consent before confirming.');
 // Switching to Qwen is also a privacy rollback. Selecting Claude alone never opts in.
 const consent=input.provider==='qwen'||input.consent===null?null:input.consent===CONSENT?POLICY:previous.consent;
 const next=validate({schema_version:1,revision:previous.revision+1,provider:input.provider,privacy:consent?'public_text_review':'local_only',consent});
 require('./config').atomicJSON(path.join(dataDir,'conversation-provider.json'),next);return next;
}
function externalReadiness(){return require('./claude-conversation-boundary').readiness();}

async function status(engine){
 const preferences=read(engine.bridge.dataDir),external=externalReadiness();
 if(preferences.provider==='claude'){
  const reason=preferences.privacy==='local_only'?'external_data_consent_required':external.reason;
  return {kind:'provider_status',schema_version:1,preferences,provider:null,requested_provider:'anthropic_subscription',model:null,state:'WAIT',reason,locality:'external',external_processing:false,worker:null,authority:false,consent_text:CONSENT,qualification:external,
   message:'Claude selected · WAIT · '+(reason==='external_data_consent_required'?'external data consent is OFF. ':'')+external.owner_action+' No effective model or fallback. Google previews remain local. Coding worker qualification is separate.'};
 }
 let route;try{route=await engine.qualify({model:'auto'});}catch{route={state:'WAIT'};}
 const ready=route.state==='READY'&&route.model===require('./model-worker-router').MODEL;
 return {kind:'provider_status',schema_version:1,preferences,provider:ready?'ollama':null,requested_provider:'ollama',model:ready?route.model:null,state:ready?'Ready':'WAIT',reason:ready?null:'local_model_unavailable',locality:'local',external_processing:false,worker:null,authority:false,consent_text:CONSENT,qualification:external,
  message:'Conversation: '+(ready?'Ollama · '+route.model+' · ready':'WAIT · qualified local model unavailable; no fallback')+'. Local text processing; no worker or tools. Claude is OFF. Provider selection never grants Mission or Capability Broker permissions.'};
}
function assertLocal(engine,{connector=false}={}){
 const preference=read(engine.bridge.dataDir);
 if(!connector&&preference.provider!=='qwen')throw Error('Claude WAIT: '+(preference.privacy==='local_only'?'external data consent is OFF; ':'')+externalReadiness().owner_action+' Use /provider qwen for local conversation.');
 return preference.revision;
}
module.exports={POLICY,CONSENT,defaults,validate,read,save,status,assertLocal,externalReadiness};
