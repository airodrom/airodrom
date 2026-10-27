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
 const activeGmailSearch=gmailSearchSessions(server).hasActive({conversation_id:input.conversation_id||null,operator:'operator'});
 const activeCalendarSession=!!require('./calendar-service').sessions(server).hasActive?.({conversation_id:input.conversation_id||null,operator:'operator'});
 const activeEmailCompose=!!require('./email-compose-service').sessions(server).hasActive?.({conversation_id:input.conversation_id||null,operator:'operator'});
 const parsed=intent.parse(input.message,{nickname:server.conversationEngine?.nickname?.(),pendingResearch:context?.mode,researchURL:context?.entry_url,activeGmailSearch,activeCalendarSession,activeEmailCompose});
 if(session){
  pending.delete(session);
  if(parsed.pending_research||['research','research_session'].includes(parsed.kind)){
   if(pending.size>=64)pending.delete(pending.keys().next().value);
   pending.set(session,{mode:parsed.pending_research||(parsed.kind==='research_session'?'session':'public'),...(parsed.entry_url?{entry_url:parsed.entry_url}:{}),expires:now+300000});
  }
 }
 if(parsed.kind==='private_storage')return {...parsed,message:'Open this request in the native Airodrom terminal to choose Sensitive Memory or Vault and confirm.'};
 if(parsed.kind==='memory_awareness')return require('./memory-awareness').explain(server,parsed);
 if(parsed.kind==='public_web_offer')return require('./mission-web-guide').gateOffer(parsed);
 if(parsed.kind==='research_session')return parsed;
 if(parsed.kind==='research')return require('./assistant-missions').newMission(server,{objective:parsed.objective,capability_classes:['web_read'],request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:false});
 if(parsed.kind==='preference')return server.conversationEngine.setPreference({nickname:parsed.nickname});
 if(parsed.kind==='remember'){const item=server.rememberInteractive(parsed.content);return {kind:'remembered',memoryId:item.memoryId,message:'Remembered.'};}
 if(parsed.kind==='sensitive')return {kind:'clarify',message:'Use /remember-sensitive to explicitly save this as operator-only Sensitive Memory.'};
 if(parsed.kind==='forget')return forget(server,parsed.selection);
 if(parsed.kind==='recall')return require('./memory-recall').recall(server,parsed.query);
 if(parsed.kind==='connector'){
  const connectorBody={};
  if(parsed.query)connectorBody.query=parsed.query;
  if(parsed.page_size)connectorBody.limit=parsed.page_size;
  if(parsed.continuation)connectorBody.continuation=true;
  if(parsed.label)connectorBody.label=parsed.label;
  if(parsed.match)connectorBody.match=parsed.match;
  if(parsed.continuation_id)connectorBody.continuation_id=parsed.continuation_id;
  return connectorInput(server,{
   connector:parsed.connector,
   action:parsed.action,
   input:connectorBody,
   conversation_id:input.conversation_id,
   model:/^(?:codex|claude_code):/.test(input.model||'')?'auto':input.model,
   host_verified:parsed.host_verified===true
  });
 }
 if(parsed.kind==='calendar')return require('./calendar-service').run(server,parsed,{
  conversation_id:input.conversation_id||null,
  confirm_id:parsed.preview_id||null,
  confirmed:parsed.confirmed===true,
  destructive:parsed.destructive===true,
 });
 if(parsed.kind==='drive')return require('./drive-service').run(server,parsed,{
  conversation_id:input.conversation_id||null,
 });
 if(parsed.kind==='contextual_assistant')return require('./contextual-assistant-service').run(server,parsed,{
  conversation_id:input.conversation_id||null,
 });
 if(parsed.kind==='email_compose')return require('./email-compose-service').run(server,parsed,{
  conversation_id:input.conversation_id||null,
 });
 if(parsed.kind==='gmail_write')return require('./gmail-write-service').run(server,parsed,{
  conversation_id:input.conversation_id||null,
  confirm_id:parsed.preview_id||null,
  confirmed:parsed.confirmed===true,
  destructive:parsed.destructive===true,
  // ack_uncertain is carried on parsed and read inside gmail-write-service
 });
 if(parsed.kind==='host_fact')return require('./host-fact-service').run(server,parsed);
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
 if(parsed.kind==='operator_control')return {kind:'operator_control',message:'Operator control uses authenticated settings APIs. No coding workspace or Mission was created.',objective:parsed.objective,authority:false,execution_authorized:false};
 if(parsed.kind==='work'){
  // Terminal/Chat natural-language WORK uses ZeroSetupWork. Never create a draft-only Mission that demands UUID template forms.
  if(!server.bridge.zeroSetupWork)return require('./assistant-missions').newMission(server,{objective:parsed.objective,capability_classes:parsed.capability_classes,request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:false});
  const view=await server.bridge.zeroSetupWork.ask({instruction:parsed.objective,request_id:input.request_id},'operator');
  return {kind:'zero_setup',route:'WORK',...view,authority:false,execution_authorized:!!view.execution_authorized};
 }
 if(parsed.kind!=='conversation')return parsed;
 return server.conversationEngine.start({message:parsed.message,request_id:input.request_id,conversation_id:input.conversation_id,include_memory:input.include_memory!==false,model:/^(?:codex|claude_code):/.test(input.model||'')?'auto':input.model});
}
function authorizationOffer(server,connector){
 if(connector==='calendar')return require('./calendar-service').authorizationOffer(server);
 return {kind:'connect_required',route:'CONNECTOR',connector,can_start_oauth:connector==='gmail'&&!!server.gmailOAuth,message:connector==='gmail'?'Gmail needs authorization. Run /connect gmail for read-only, /connect gmail send for outbound send, or /connect gmail manage for mailbox writes. A “configured” indicator only means the OAuth client is present — it is not live access.':'The official WhatsApp inbound connector is unavailable. Configure its authorized host transport; personal WhatsApp history is not supported.',authorized:false,authority:false};
}
function jobSearchManager(server){
 const bridge=server.bridge;
 if(!bridge.jobSearchManager){
  const automation=require('./personal-ops-automation');
  bridge.jobSearchManager=require('./job-search-manager').createJobSearchManager({
   dataDir:bridge.dataDir,
   policy:automation.trackerPolicy(bridge.dataDir),
   audit:{append:(type,detail)=>bridge.ledger?.record?.({eventType:type,agent:'bridge',direction:'internal',metadata:{version:1,...detail,execution_authority:false}})}
  });
 }
 return bridge.jobSearchManager;
}
function jobSearchInput(server,parsed){
 const manager=jobSearchManager(server);
 if(parsed.action==='create_tracker'){
  return {kind:'job_search',route:'JOB_SEARCH',action:'create_tracker',...manager.createTracker(),message:'Local job-search tracker ready (CSV, Excel-openable — not an .xlsx workbook). Updates require typed identifiable evidence plus standing authorization or host per-action approval. Cloud Sheets/Drive remain NOT_SUPPORTED until separately enrolled.',authority:false};
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
  return {kind:'clarify',route:'JOB_SEARCH',message:'To log an application without standing permission: submit company, role, and typed evidence via Control Center or the job-search API (manual operator_confirmation claim is allowed). Review the exact proposal under Approvals, approve it, then re-submit with host_approval_id. Conversation cannot auto-approve tracker writes. Fabricated jobs are refused.',authority:false,conversational_auto_approve:false};
 }
 return {kind:'clarify',route:'JOB_SEARCH',message:'Supported job-search actions: create tracker, list applications, daily digest, or personal-ops capability plan.',authority:false};
}
function gmailSearchSessions(server){
 if(!server.gmailSearchSessions)server.gmailSearchSessions=new(require('./gmail-search-session').GmailSearchSessions)();
 return server.gmailSearchSessions;
}
function formatGmailSearchReceipt({items,label,page,has_more,exhausted,limit_reached,total_returned,continuation_id,result_size_estimate,match}){
 const who=label||'matching';
 const count=items.length;
 let message;
 if(!count&&page<=1)message=`No ${who}-related emails matched this read-only Gmail search.`;
 else if(!count)message=`No further ${who}-related emails on this page.`;
 else if(exhausted&&page<=1)message=`Found ${who}-related emails. Showing ${count} matching message${count===1?'':'s'} (search complete for this query).`;
 else if(exhausted)message=`Showing ${count} more ${who}-related email${count===1?'':'s'} (search complete for this query).`;
 else if(limit_reached)message=`Found ${who}-related emails. Showing ${count} on this page (${total_returned} so far). Host safety limit reached — results are partial, not complete.`;
 else message=`Found ${who}-related emails. Showing ${count} matching message${count===1?'':'s'} (page ${page}${result_size_estimate!=null?`; provider estimate ${result_size_estimate}`:''}).`;
 if(has_more&&continuation_id)message+='\nSay “show more” or “show the next page” for the next bounded page.';
 if(match==='display_name')message+='\nNote: a display-name match is not proof of authentic domain origin; inspect the From field.';
 return message;
}
function requireConversationId(conversation_id){
 if(typeof conversation_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversation_id)){
  return {kind:'clarify',route:'CONNECTOR',message:'Gmail search requires an authenticated Terminal conversation session. Re-open the interactive chat and try again.',authority:false,host_verified:true,model_invoked:false,code:'gmail_search_session_required'};
 }
 return null;
}
async function gmailSearchPage(server,{input={},conversation_id=null}){
 const sessions=gmailSearchSessions(server);
 const adapter=connectors(server.bridge);
 const missing=requireConversationId(conversation_id);
 if(missing)return missing;
 let sessionId=input.continuation_id||null;
 let pageToken=null;
 let label=input.label||null;
 let match=input.match||null;
 let query=input.query||null;
 const limit=input.limit||require('./gmail-search-intent').PAGE_SIZE_DEFAULT;
 if(input.continuation===true){
  let active;
  try{active=sessions.getActive({conversation_id,operator:'operator'});}
  catch(error){
   if(error?.code==='gmail_search_session_required'||error?.code==='gmail_search_session_invalid'){
    return {kind:'clarify',route:'CONNECTOR',message:error.message,authority:false,host_verified:true,model_invoked:false,code:error.code};
   }
   throw error;
  }
  if(!active?.continuation_id){
   return {kind:'clarify',route:'CONNECTOR',message:'No active Gmail search to continue in this conversation. Try: Find all mails from GitHub.',authority:false,host_verified:true,model_invoked:false};
  }
  sessionId=active.continuation_id;
 }
 if(sessionId){
  const row=sessions.require(sessionId,{conversation_id,operator:'operator',expected_query:query||undefined});
  query=row.query;label=row.label;match=row.match;
  pageToken=sessions.peekToken(sessionId,{conversation_id,operator:'operator'});
  if(!pageToken&&row.exhausted){
   sessions.clearActive({conversation_id,operator:'operator'});
   return {kind:'connector',route:'CONNECTOR',connector:'gmail',action:'search',items:[],message:'No further matching emails. This search is complete.',has_more:false,exhausted:true,host_verified:true,model_invoked:false,live_qualified:true,authority:false,worker_context:false};
  }
 }else{
  if(typeof query!=='string'||!query.trim())throw Error('Gmail search query required');
  sessionId=sessions.begin({query,label,match,conversation_id,operator:'operator',page_size:limit});
 }
 let raw;
 try{
  raw=await adapter.read('gmail','search',{query,limit,page_token:pageToken||undefined});
 }catch(error){
  if(error?.safe_error_class||['Gmail OAuth authorization required','Gmail OAuth renewal requires operator authorization','Secret reference is invalid or revoked','Current secret disposition unavailable','Secret reference revoked'].includes(error?.message)||/^gmail_oauth_/.test(error?.code||'')){
   const offer=authorizationOffer(server,'gmail');
   if(error?.safe_error_class||error?.code)offer.safe_error_class=error.safe_error_class||error.code;
   if(error?.message&&!/token|Bearer|refresh_token|access_token|pageToken|page_token/i.test(error.message))offer.failure_message=error.message;
   offer.host_verified=true;offer.model_invoked=false;
   return offer;
  }
  const err=Error(error?.message&&!/token|Bearer|pageToken/i.test(error.message)?error.message:'Gmail search unavailable; provider diagnostics withheld.');
  err.code=error?.code||'gmail_search_failed';
  err.safe_error_class=error?.safe_error_class||err.code;
  throw err;
 }
 let recorded;
 try{
  recorded=sessions.recordPage(sessionId,{messages:raw.items||[],next_page_token:raw._provider_next_page_token||null});
 }catch(error){
  if(error?.code==='gmail_search_limit'){
   const items=raw.items||[];
   sessions.clearActive({conversation_id,operator:'operator'});
   return {
    kind:'connector',route:'CONNECTOR',connector:'gmail',action:'search',items,
    message:formatGmailSearchReceipt({items,label,page:1,has_more:false,exhausted:false,limit_reached:true,total_returned:items.length,continuation_id:null,result_size_estimate:raw.result_size_estimate,match}),
    has_more:false,exhausted:false,limit_reached:true,partial:true,host_verified:true,model_invoked:false,
    live_qualified:true,authority:false,worker_context:false,untrusted:true
   };
  }
  throw error;
 }
 // Never project provider page tokens on the operator receipt.
 const items=recorded.items.map(m=>({id:m.id,from:m.from,subject:m.subject,date:m.date,snippet:typeof m.content==='string'?m.content.slice(0,240):'',untrusted:true,authority:false}));
 if(!(recorded.has_more&&recorded.continuation_id))sessions.clearActive({conversation_id,operator:'operator'});
 return {
  kind:'connector',
  route:'CONNECTOR',
  connector:'gmail',
  action:'search',
  items,
  message:formatGmailSearchReceipt({
   items,label:recorded.label,page:recorded.page,has_more:recorded.has_more,exhausted:recorded.exhausted,
   limit_reached:recorded.limit_reached,total_returned:recorded.total_returned,continuation_id:recorded.continuation_id,
   result_size_estimate:raw.result_size_estimate,match:recorded.match
  }),
  continuation_id:recorded.continuation_id,
  has_more:recorded.has_more,
  exhausted:recorded.exhausted,
  page:recorded.page,
  total_returned:recorded.total_returned,
  query_label:recorded.label,
  match:recorded.match,
  host_verified:true,
  model_invoked:false,
  live_qualified:true,
  authority:false,
  worker_context:false,
  untrusted:true
 };
}
async function connectorInput(server,{connector,action,input={},conversation_id,model,host_verified=false}){
 const adapter=connectors(server.bridge),current=adapter.status().items.find(item=>item.id===connector);
 if(!current)throw Error('Unknown connector');
 // configured = OAuth client present; connected = token; live_qualified = successful read.
 if(!['configured','connected','live_qualified'].includes(current.state)&&action!=='status'&&action!=='draft')return authorizationOffer(server,connector);
 if(current.state==='configured'&&!current.connected&&action!=='status'&&action!=='draft')return authorizationOffer(server,connector);
 if(connector==='gmail'&&action==='search')return gmailSearchPage(server,{input,conversation_id});
 const read=async(readAction)=>{try{return await adapter.read(connector,readAction,input);}catch(error){
  if(connector==='gmail'&&(error?.safe_error_class||['Gmail OAuth authorization required','Gmail OAuth renewal requires operator authorization','Secret reference is invalid or revoked','Current secret disposition unavailable','Secret reference revoked'].includes(error?.message)||/^gmail_oauth_/.test(error?.code||''))){
   const offer=authorizationOffer(server,connector);
   if(error?.safe_error_class||error?.code)offer.safe_error_class=error.safe_error_class||error.code;
   if(error?.message&&!/token|Bearer|refresh_token|access_token/i.test(error.message))offer.failure_message=error.message;
   offer.model_invoked=false;offer.host_verified=true;
   return offer;
  }
  throw error;
 }};
 if(!['summarize','attention','draft_reply'].includes(action)){
  const data=await read(action);
  // Never project Gmail provider page tokens onto operator/API receipts.
  const {_provider_next_page_token,...safe}=data||{};
  void _provider_next_page_token;
  if(connector==='gmail'&&conversation_id&&Array.isArray(data?.items)&&data.items.length){
   try{gmailSearchSessions(server).rememberResults({items:data.items,conversation_id,operator:'operator'});}catch{/* */}
  }
  return {kind:'connector',route:'CONNECTOR',...safe,model_invoked:false,host_verified:host_verified||data.host_verified===true};
 }
 const data=await read(action==='draft_reply'?(input.id?'read':'search'):action);
 if(data.kind==='connect_required')return data;
 if(!data.items.length)return {kind:'connector',message:'No current selected messages.',model_invoked:false,host_verified:true};
 if(action==='draft_reply'&&data.items.length!==1)return {kind:'clarify',message:'Choose one message ID to draft a reply.',choices:data.items.map(m=>({id:m.id,subject:m.subject}))};
 if(connector==='gmail'&&conversation_id&&data.items.length){
  try{gmailSearchSessions(server).rememberResults({items:data.items,conversation_id,operator:'operator'});}catch{/* */}
 }
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
