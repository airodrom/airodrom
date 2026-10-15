'use strict';
const {object,text,identifier}=require('./control-plane-store');
const intent=require('./assistant-intent');
function sensitiveRecord(bridge,content,id=null){
 text(content,'sensitive memory',2000);if(intent.secret(content))throw Error('Secret content requires the Secret Vault secure input path.');
 if(id){const m=bridge.personalMemory.get(id);if(!m||m.domain!=='personal'||m.sensitivity!=='sensitive')throw Error('Current sensitive identity required');return bridge.personalMemory.update(id,{content});}
 return bridge.personalMemory.remember({domain:'personal',type:'fact',subject:'sensitive.'+require('node:crypto').randomUUID(),content,source:'user_explicit',sensitivity:'sensitive'});
}
function sensitiveList(bridge){return {items:bridge.personalMemory.recent({domain:'personal',limit:100,includeSensitive:true}).items.filter(m=>m.sensitivity!=='normal').map(m=>({memoryId:m.memoryId,sensitivity:m.sensitivity})),disclosure:'Operator-only explicit reveal by ID. No worker injection.',encryption:'Private local SQLite storage; no field-level encryption claim.'};}
function reveal(bridge,id){const m=bridge.personalMemory.get(id);if(!m||m.domain!=='personal'||m.sensitivity==='normal')throw Error('Current sensitive identity required.');return {memoryId:id,content:m.content,operator_only:true,authority:false};}
function forget(server,selection){
 text(selection,'memory selection',240);const b=server.bridge;
 const correction=require('./memory-correction');
 const target=correction.conversationalForgetTarget(selection);
 let items;
 if(/^[a-f0-9-]{36}$/i.test(selection)){
  const p=b.personalMemory.get(selection),a=b.authorityRuntime?.active?b.authorityRuntime.memory.get(selection):null;
  items=p?.domain==='personal'&&p.status==='active'?[{memoryId:selection,store:'personal'}]:a?.operator_id===b.authorityRuntime.store.operatorId&&a.scope==='global'&&a.status==='active'?[{memoryId:selection,store:'authority'}]:[];
 }else{
  items=server.interactiveMemory(selection).items.map(m=>({...m,store:b.authorityRuntime?.active?'authority':'personal'}));
  // Also try the derived subject key (e.g. "car" from "Range Rover is my car").
  if(!items.length&&target?.subject&&target.subject!==selection.toLowerCase()){
   items=server.interactiveMemory(target.subject).items.map(m=>({...m,store:b.authorityRuntime?.active?'authority':'personal'}));
  }
 }
 if(items.length>1)return {kind:'clarify',message:'Choose one current memory ID with /forget <id>.',choices:items.map(m=>({memoryId:m.memoryId,subject:m.subject}))};
 let memoryId=null;
 if(items.length===1){
  const m=items[0];memoryId=m.memoryId;
  if(m.store==='personal')b.personalMemory.forget(m.memoryId);else b.forgetPersonalMemory(m.memoryId);
 }
 // Always suppress matching conversation-history text so history-only facts
 // cannot resurrect after an explicit forget, including when Memory V2 had no row.
 const history=server.conversationEngine?.suppressForgottenFact
  ?server.conversationEngine.suppressForgottenFact(selection)
  :{suppressed:0};
 if(memoryId||history.suppressed>0){
  return {
   kind:'forgotten',
   memoryId,
   history_suppressed:history.suppressed||0,
   fact_key:history.fact_key||target?.key||null,
   message:memoryId?'Forgotten.':(history.suppressed?'Forgotten from conversation context. It was not stored in ordinary Memory V2.':'Forgotten.'),
   authority:false
  };
 }
 // Sensitive records are never returned by ordinary interactiveMemory.
 const sensitiveHits=b.personalMemory.search(target?.subject||selection,{domain:'personal',limit:5,includeSensitive:true}).items
  .filter(m=>m.sensitivity!=='normal'&&m.status==='active');
 if(sensitiveHits.length){
  return {kind:'clarify',message:'That may be Sensitive Memory. Use /sensitive and forget by exact ID; ordinary forget cannot remove it.',choices:sensitiveHits.map(m=>({memoryId:m.memoryId,sensitivity:m.sensitivity})),authority:false};
 }
 return {kind:'clarify',message:'No matching ordinary memory or conversation context. Use /sensitive for sensitive IDs.',choices:[],authority:false};
}
async function submit(server,input){
 object(input,['message','request_id','conversation_id','include_memory','model','worker','workspace']);identifier(input.request_id,'request ID',160);
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.request_id))throw Error('Opaque request UUID required');
 // Only host-issued operator sessions carry a short-lived pending URL choice.
 // No model/history/connector text can set it; it grants no browser consent.
 const now=Date.now(),pending=server.pendingResearch ||= new Map();
 for(const [key,item] of pending)if(item.expires<=now)pending.delete(key);
 const session=input.conversation_id&&server.conversationEngine?.requireSession?server.conversationEngine.requireSession(input.conversation_id).id:null;
 const context=session?pending.get(session):null;
 const parsed=intent.parse(input.message,{nickname:server.conversationEngine?.nickname?.(),pendingResearch:context?.mode,researchURL:context?.entry_url});
 if(session){
  pending.delete(session);
  if(parsed.pending_research||['research','research_session'].includes(parsed.kind)){
   if(pending.size>=64)pending.delete(pending.keys().next().value);
   pending.set(session,{mode:parsed.pending_research||(parsed.kind==='research_session'?'session':'public'),...(parsed.entry_url?{entry_url:parsed.entry_url}:{}),expires:now+300000});
  }
 }
 if(parsed.kind==='private_storage')return {...parsed,message:'Open this request in the native Airodrom terminal to choose Sensitive Memory or Vault and confirm.'};
 if(parsed.kind==='public_web_offer')return require('./mission-web-guide').gateOffer(parsed);
 if(parsed.kind==='research_session')return parsed;
 if(parsed.kind==='research')return require('./assistant-missions').newMission(server,{objective:parsed.objective,capability_classes:['web_read'],request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:false});
 if(parsed.kind==='preference')return server.conversationEngine.setPreference({nickname:parsed.nickname});
 if(parsed.kind==='remember'){const item=server.rememberInteractive(parsed.content);return {kind:'remembered',memoryId:item.memoryId,message:'Remembered.'};}
 if(parsed.kind==='sensitive')return {kind:'clarify',message:'Use /remember-sensitive to explicitly save this as operator-only Sensitive Memory.'};
 if(parsed.kind==='forget')return forget(server,parsed.selection);
 if(parsed.kind==='recall')return require('./memory-recall').recall(server,parsed.query);
 if(parsed.kind==='connector')return connectorInput(server,{connector:parsed.connector,action:parsed.action,input:parsed.query?{query:parsed.query}:{},conversation_id:input.conversation_id,model:/^(?:codex|claude_code):/.test(input.model||'')?'auto':input.model});
 if(parsed.kind==='personal_ops'){
  const plan=require('./personal-ops').plan(server,parsed.message);
  return {...plan,kind:'personal_ops',route:'PERSONAL_OPS',authority:false};
 }
 if(parsed.kind==='job_search')return jobSearchInput(server,parsed);
 if(parsed.kind==='mission'){
  const missions=require('./assistant-missions');
  if(parsed.action==='list')return missions.list(server,{active:parsed.active===true});
  if(parsed.action==='status')return missions.status(server,{mission_id:parsed.mission_id});
  if(parsed.action==='cancel')return missions.cancel(server,{mission_id:parsed.mission_id,request_id:input.request_id});
  return missions.newMission(server,{objective:parsed.objective,request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:true});
 }
 if(parsed.kind==='work'){
  // Terminal/Chat natural-language WORK uses ZeroSetupWork. Never create a draft-only Mission that demands UUID template forms.
  if(!server.bridge.zeroSetupWork)return require('./assistant-missions').newMission(server,{objective:parsed.objective,capability_classes:parsed.capability_classes,request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:false});
  const view=await server.bridge.zeroSetupWork.ask({instruction:parsed.objective,request_id:input.request_id},'operator');
  return {kind:'zero_setup',route:'WORK',...view,authority:false,execution_authorized:false};
 }
 if(parsed.kind!=='conversation')return parsed;
 return server.conversationEngine.start({message:parsed.message,request_id:input.request_id,conversation_id:input.conversation_id,include_memory:input.include_memory!==false,model:/^(?:codex|claude_code):/.test(input.model||'')?'auto':input.model});
}
function authorizationOffer(server,connector){return {kind:'connect_required',route:'CONNECTOR',connector,can_start_oauth:connector==='gmail'&&!!server.gmailOAuth,message:connector==='gmail'?'Gmail needs authorization. Start the existing Gmail OAuth flow to authorize read-only access. A “configured” indicator only means the OAuth client is present — it is not live read access.':'The official WhatsApp inbound connector is unavailable. Configure its authorized host transport; personal WhatsApp history is not supported.',authorized:false,authority:false};}
function jobSearchManager(server){
 const bridge=server.bridge;
 if(!bridge.jobSearchManager){
  bridge.jobSearchManager=require('./job-search-manager').createJobSearchManager({
   dataDir:bridge.dataDir,
   audit:{append:(type,detail)=>bridge.ledger?.record?.({eventType:type,agent:'bridge',direction:'internal',metadata:{version:1,...detail,execution_authority:false}})}
  });
 }
 return bridge.jobSearchManager;
}
function jobSearchInput(server,parsed){
 const manager=jobSearchManager(server);
 if(parsed.action==='create_tracker'){
  const standing=require('./personal-ops-automation').allows(server.bridge.dataDir,'local_tracker_updates');
  return {kind:'job_search',route:'JOB_SEARCH',action:'create_tracker',...manager.createTracker({standingLocalUpdates:standing}),message:'Local job-search tracker ready (CSV, Excel-openable — not an .xlsx workbook). Updates require typed identifiable evidence. Cloud Sheets/Drive remain NOT_SUPPORTED until separately enrolled.',authority:false};
 }
 if(parsed.action==='list'){
  const listed=manager.list();
  return {kind:'job_search',route:'JOB_SEARCH',action:'list',...listed,message:listed.applications.length?`Tracked ${listed.applications.length} evidence-backed application(s).`:'No applications yet. Nothing was fabricated.',fabricated:false,authority:false};
 }
 if(parsed.action==='digest'){
  const digest=manager.dailyDigest();
  return {kind:'job_search',route:'JOB_SEARCH',action:'digest',...digest,authority:false};
 }
 if(parsed.action==='recruiters'){
  return {kind:'clarify',route:'JOB_SEARCH',message:'To identify recruiters, first authorize Gmail read-only (/connect gmail), then search with a job-related query (for example: subject:(recruiter OR interview OR application)). Host categorization uses only returned message fields — it never invents emails.',authority:false};
 }
 if(parsed.action==='upsert'){
  return {kind:'clarify',route:'JOB_SEARCH',message:'To log an application, provide company, role, and identifiable evidence (posting URL, Gmail message id, or explicit operator confirmation). Fabricated jobs are refused.',authority:false};
 }
 return {kind:'clarify',route:'JOB_SEARCH',message:'Supported job-search actions: create tracker, list applications, daily digest, or personal-ops capability plan.',authority:false};
}
async function connectorInput(server,{connector,action,input={},conversation_id,model}){
 const adapter=connectors(server.bridge),current=adapter.status().items.find(item=>item.id===connector);
 if(!current)throw Error('Unknown connector');
 // configured = OAuth client present; connected = token; live_qualified = successful read.
 if(!['configured','connected','live_qualified'].includes(current.state)&&action!=='status'&&action!=='draft')return authorizationOffer(server,connector);
 if(current.state==='configured'&&!current.connected&&action!=='status'&&action!=='draft')return authorizationOffer(server,connector);
 const read=async(readAction)=>{try{return await adapter.read(connector,readAction,input);}catch(error){
  if(connector==='gmail'&&(error?.safe_error_class||['Gmail OAuth authorization required','Gmail OAuth renewal requires operator authorization','Secret reference is invalid or revoked','Current secret disposition unavailable','Secret reference revoked'].includes(error?.message)||/^gmail_oauth_/.test(error?.code||''))){
   const offer=authorizationOffer(server,connector);
   if(error?.safe_error_class||error?.code)offer.safe_error_class=error.safe_error_class||error.code;
   if(error?.message&&!/token|Bearer|refresh_token|access_token/i.test(error.message))offer.failure_message=error.message;
   return offer;
  }
  throw error;
 }};
 if(!['summarize','attention','draft_reply'].includes(action))return {kind:'connector',route:'CONNECTOR',...await read(action)};
 const data=await read(action==='draft_reply'?(input.id?'read':'search'):action);
 if(data.kind==='connect_required')return data;
 if(!data.items.length)return {kind:'connector',message:'No current selected messages.'};
 if(action==='draft_reply'&&data.items.length!==1)return {kind:'clarify',message:'Choose one message ID to draft a reply.',choices:data.items.map(m=>({id:m.id,subject:m.subject}))};
 const selected=data.items.slice(0,3).map(m=>({id:m.id,subject:m.subject.slice(0,200),content:m.content.slice(0,700),untrusted:true}));
 const instruction=action==='draft_reply'?'Draft a reply for operator review. Do not send.':action==='attention'?'Summarize selected messages and explain which may need attention based only on these excerpts; identify uncertainty.':'Summarize only the selected message text; identify incomplete context.';
 // Connector previews get a fresh session, avoiding disclosure of unrelated
 // prior chat or Memory context to a selected message's interpretation.
 const created=await server.conversationEngine.start({request_id:require('node:crypto').randomUUID(),model,message:instruction,context:selected,include_memory:false});
 return {...created,route:'CONNECTOR',connector,provenance:'Explicitly selected bounded untrusted connector data',draft_only:action==='draft_reply',sent:false};
}
function connectors(bridge){const wa=require('./whatsapp-inbound').whatsappSource(bridge);if(!bridge.assistantConnectors)bridge.assistantConnectors=new (require('./assistant-connectors').AssistantConnectors)({...(bridge.options.assistantConnectors||{}),...wa});else if(wa.whatsapp&&typeof bridge.assistantConnectors.ensureWhatsapp==='function')bridge.assistantConnectors.ensureWhatsapp(wa.whatsapp);return bridge.assistantConnectors;}
async function providerStatus(server){return require('./conversation-provider').status(server.conversationEngine);}
module.exports={providerStatus,submit,forget,sensitiveRecord,sensitiveList,reveal,connectors,connectorInput,jobSearchManager,jobSearchInput};
