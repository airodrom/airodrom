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
 let items;
 if(/^[a-f0-9-]{36}$/i.test(selection)){
  const p=b.personalMemory.get(selection),a=b.authorityRuntime?.active?b.authorityRuntime.memory.get(selection):null;
  items=p?.domain==='personal'&&p.status==='active'?[{memoryId:selection,store:'personal'}]:a?.operator_id===b.authorityRuntime.store.operatorId&&a.scope==='global'&&a.status==='active'?[{memoryId:selection,store:'authority'}]:[];
 }else items=server.interactiveMemory(selection).items.map(m=>({...m,store:b.authorityRuntime?.active?'authority':'personal'}));
 if(items.length!==1)return {kind:'clarify',message:items.length?'Choose one current memory ID with /forget <id>.':'No matching ordinary memory. Use /sensitive for sensitive IDs.',choices:items.map(m=>({memoryId:m.memoryId,subject:m.subject}))};
 const m=items[0];if(m.store==='personal')b.personalMemory.forget(m.memoryId);else b.forgetPersonalMemory(m.memoryId);
 return {kind:'forgotten',memoryId:m.memoryId,message:'Forgotten.'};
}
async function submit(server,input){
 object(input,['message','request_id','conversation_id','include_memory','model','worker','workspace']);identifier(input.request_id,'request ID',160);
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.request_id))throw Error('Opaque request UUID required');
 const parsed=intent.parse(input.message);
 if(parsed.kind==='research_session')return parsed;
 if(parsed.kind==='research')return require('./assistant-missions').newMission(server,{objective:parsed.objective,capability_classes:['web_read'],request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:false});
 if(parsed.kind==='preference')return server.conversationEngine.setPreference({nickname:parsed.nickname});
 if(parsed.kind==='remember'){const item=server.rememberInteractive(parsed.content);return {kind:'remembered',memoryId:item.memoryId,message:'Remembered.'};}
 if(parsed.kind==='sensitive')return {kind:'clarify',message:'Use /remember-sensitive to explicitly save this as operator-only Sensitive Memory.'};
 if(parsed.kind==='forget')return forget(server,parsed.selection);
 if(parsed.kind==='recall')return {kind:'memory',items:server.interactiveMemory(parsed.query).items,memory_generation:require('./product-observability').memoryStatus(server.bridge).generation};
 if(parsed.kind==='connector')return connectorInput(server,{connector:parsed.connector,action:parsed.action,input:parsed.query?{query:parsed.query}:{},conversation_id:input.conversation_id,model:input.model});
 if(parsed.kind==='mission'){
  const missions=require('./assistant-missions');
  if(parsed.action==='list')return missions.list(server,{active:parsed.active===true});
  if(parsed.action==='status')return missions.status(server,{mission_id:parsed.mission_id});
  if(parsed.action==='cancel')return missions.cancel(server,{mission_id:parsed.mission_id,request_id:input.request_id});
  return missions.newMission(server,{objective:parsed.objective,request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:true});
 }
 if(parsed.kind==='work')return require('./assistant-missions').newMission(server,{objective:parsed.objective,capability_classes:parsed.capability_classes,request_id:input.request_id,workspace:input.workspace,model:input.model,worker:input.worker,explicit:false});
 if(parsed.kind!=='conversation')return parsed;
 return server.conversationEngine.start({message:parsed.message,request_id:input.request_id,conversation_id:input.conversation_id,include_memory:input.include_memory!==false,model:input.model});
}
function authorizationOffer(server,connector){return {kind:'connect_required',route:'CONNECTOR',connector,can_start_oauth:connector==='gmail'&&!!server.gmailOAuth,message:connector==='gmail'?'Gmail needs authorization. Start the existing Gmail OAuth flow to authorize read-only access.':'The official WhatsApp inbound connector is unavailable. Configure its authorized host transport; personal WhatsApp history is not supported.',authorized:false,authority:false};}
async function connectorInput(server,{connector,action,input={},conversation_id,model}){
 const adapter=connectors(server.bridge),current=adapter.status().items.find(item=>item.id===connector);
 if(!current)throw Error('Unknown connector');
 if(current.state!=='configured'&&action!=='status'&&action!=='draft')return authorizationOffer(server,connector);
 const read=async(readAction)=>{try{return await adapter.read(connector,readAction,input);}catch(error){if(connector==='gmail'&&['Gmail OAuth authorization required','Gmail OAuth renewal requires operator authorization','Secret reference is invalid or revoked','Current secret disposition unavailable','Secret reference revoked'].includes(error?.message))return authorizationOffer(server,connector);throw error;}};
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
function connectors(bridge){return bridge.assistantConnectors ||= new (require('./assistant-connectors').AssistantConnectors)(bridge.options.assistantConnectors||{});}
module.exports={submit,forget,sensitiveRecord,sensitiveList,reveal,connectors,connectorInput};
