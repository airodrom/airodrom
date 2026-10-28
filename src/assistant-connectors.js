'use strict';
// Host protocol boundary. Message bodies are untrusted data, never actions.
const {createHash}=require('node:crypto');
const {text,object}=require('./control-plane-store');
const {secret}=require('./assistant-intent');
const {hasReadCapability,hasSendScope,hasModifyScope,READ_SCOPE}=require('./gmail-oauth');
const ID=/^[A-Za-z0-9_.:-]{1,200}$/;
const clean=value=>{const raw=String(value||'');if(secret(raw))return '[Sensitive content withheld]';return require('./secret-observation').redactText(require('node:util').stripVTControlCharacters(raw).slice(0,4000));};
function emailLocal(value){
  const m=/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(String(value||''));
  return m?m[1].toLowerCase():null;
}
function walkParts(root, out=[]){
  if(!root)return out;
  out.push(root);
  for(const p of root.parts||[])walkParts(p, out);
  return out;
}
class AssistantConnectors {
 #gmail; #whatsapp; #secret; #request; #liveGmail=false; #connectedProbe=null; #capabilities=null; #writeQualifiedProbe=null;
 constructor({gmail=null,whatsapp=null,secrets=null,request=fetch,connected=null,capabilities=null,writeQualified=null}={}){
  this.#gmail=gmail;this.#whatsapp=whatsapp;this.#secret=secrets;this.#request=request;this.#connectedProbe=connected;this.#capabilities=capabilities;this.#writeQualifiedProbe=writeQualified;
 }
 #writeQualified(){
  if(typeof this.#writeQualifiedProbe!=='function')return false;
  try{return this.#writeQualifiedProbe()===true;}catch{return false;}
 }
 #caps(){
  if(typeof this.#capabilities==='function'){
   try{return this.#capabilities()||{};}catch{return {};}
  }
  const scope=this.#gmail?.scope||READ_SCOPE;
  return {
   scope,
   can_send:hasSendScope(scope),
   can_modify:hasModifyScope(scope),
   can_write:hasSendScope(scope)||hasModifyScope(scope),
   read_only:!(hasSendScope(scope)||hasModifyScope(scope)),
   mode:hasModifyScope(scope)&&hasSendScope(scope)?'manage':hasSendScope(scope)?'send':'readonly',
  };
 }
 status(){
  const oauthClient=!!(this.#gmail&&this.#secret);
  const connected=oauthClient&&(typeof this.#connectedProbe==='function'?!!this.#connectedProbe():true);
  const caps=this.#caps();
  // configured = OAuth client wiring present. connected = usable token probe.
  // token may be present without live_qualified. live_qualified = successful bounded read.
  // write_qualified stays false until a governed write receipt confirms provider outcome.
  let state='unavailable';
  if(oauthClient&&this.#liveGmail&&connected)state='live_qualified';
  else if(oauthClient&&connected)state='connected';
  else if(oauthClient)state='configured';
  const writeQualified=this.#writeQualified();
  const writeHint=caps.can_modify
   ?'Manage consent present — governed send/archive/label/trash use host preview confirmation (/gmail confirm).'
   :(caps.can_send
    ?'Send consent present — governed outbound send/draft use host preview confirmation. Mailbox modify needs /connect gmail manage.'
    :'No send/archive/label until /connect gmail send or /connect gmail manage.');
  const writeQualHint=writeQualified
   ?' write_qualified=true from a durable provider-confirmed send receipt.'
   :' write_qualified stays false until a provider-confirmed governed send receipt is recorded.';
  return {items:[{
   id:'gmail',
   protocol:'Google Gmail API / OAuth 2.0',
   state,
   configured:oauthClient,
   connected:!!connected,
   read_only:!!caps.read_only,
   can_write:!!caps.can_write,
   can_send:!!caps.can_send,
   can_modify:!!caps.can_modify,
   mode:caps.mode||'readonly',
   write_qualified:writeQualified,
   live_qualified:this.#liveGmail&&connected,
   setup:connected
    ?(this.#liveGmail
      ?(`Gmail reads are live-qualified for bounded list/search/read in this process. ${writeHint}${writeQualHint}`)
      :(`OAuth credentials appear usable. Run a bounded Gmail search/read to live-qualify. Presence alone is not live access. ${writeHint}${writeQualHint}`))
    :(oauthClient
      ?'OAuth client is configured. Account consent still required via /connect gmail [send|manage]. Saved references are not live access.'
      :'Requires owner-configured OAuth Gmail credential reference. No account connected by qualification.'),
   mutations:caps.can_write
    ?'Writes require host preview + /gmail confirm. Trash/forward/bulk need independent /gmail approve. OpenCode never receives unrestricted Gmail access.'
    :'Remote draft/send/archive/delete/label/mark-read unavailable until /connect gmail send or /connect gmail manage. Read adapter stays least-privilege.'
  },this.#whatsappItem()],authority:false};
 }
 ensureWhatsapp(whatsapp){if(whatsapp)this.#whatsapp=whatsapp;return this;}
 markLive(connector){if(connector==='gmail')this.#liveGmail=true;return this;}
 clearLive(connector){if(connector==='gmail')this.#liveGmail=false;return this;}
 #whatsappItem(){
  const base={id:'whatsapp',protocol:'WhatsApp Business Cloud API',read_only:true,live_qualified:false,connected:false,configured:!!this.#whatsapp,mutations:'Outbound messaging unavailable until a separately governed official adapter is qualified. Sending is not available through this connector.'};
  if(!this.#whatsapp)return {...base,state:'unavailable',setup:'Official inbound webhook source only. Personal WhatsApp history is unavailable through this adapter. No WhatsApp Web automation.',capabilities:{graph:'Unavailable',binding_state:'Unbound',callback:'Not prepared',messages:'Not subscribed',inbound_delivery:'Not yet verified',outbound:'Unavailable'},outbound:'Unavailable'};
  let inbound=null;try{inbound=typeof this.#whatsapp.inboundStatus==='function'?this.#whatsapp.inboundStatus():null;}catch{}
  if(inbound?.capabilities)return {...base,state:inbound.state||'configured',state_label:inbound.state_label,setup:inbound.setup||base.mutations,capabilities:inbound.capabilities,detail:inbound.detail||null,outbound:inbound.outbound||'Unavailable',inbound_delivery:inbound.inbound_delivery||'Not yet verified',mutations:inbound.mutations||base.mutations};
  return {...base,state:'configured',setup:'Official inbound webhook source only. Personal WhatsApp history is unavailable through this adapter. No WhatsApp Web automation.',outbound:'Unavailable'};
 }
 async #get(resource,query={}) {
  if(!this.#gmail||!this.#secret)throw Error('Gmail OAuth connector is not configured.');
  const caps=this.#caps();
  const scope=caps.scope||this.#gmail.scope;
  if(!hasReadCapability(scope))throw Error('Gmail requires an authorized read-capable OAuth scope (gmail.readonly or gmail.modify).');
  const token=await this.#secret.resolve(this.#gmail.reference,'gmail');
  const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+resource);
  for(const [k,v]of Object.entries(query)){
   // Gmail users.messages.get expects repeated metadataHeaders params, not a CSV.
   if(k==='metadataHeaders'&&Array.isArray(v)){for(const header of v)url.searchParams.append(k,String(header));}
   else if(Array.isArray(v)){for(const item of v)url.searchParams.append(k,String(item));}
   else url.searchParams.set(k,String(v));
  }
  try{
   const response=await this.#request(url,{method:'GET',headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error();const raw=await response.text();if(Buffer.byteLength(raw)>512000)throw Error();return JSON.parse(raw);
  }catch(error){
   if(error?.safe_error_class||error?.code?.startsWith?.('gmail_oauth_'))throw error;
   throw Error('Gmail read unavailable; credentials and provider diagnostics withheld.');
  }
 }
 async #listMessages({q,limit,pageToken=null}) {
  const params={maxResults:limit,q};
  if(pageToken){
   if(typeof pageToken!=='string'||!pageToken||pageToken.length>2048||/[\r\n\0]/.test(pageToken))throw Error('Invalid Gmail page token');
   params.pageToken=pageToken;
  }
  const list=await this.#get('messages',params);
  const items=[];
  for(const m of (list.messages||[]).slice(0,limit)){
   if(!ID.test(m.id))throw Error('Invalid Gmail reference');
   // Metadata only — no full bodies on list/search pages.
   items.push(this.#mail(await this.#get('messages/'+encodeURIComponent(m.id),{format:'metadata',metadataHeaders:['From','Subject','Date']})));
  }
  return {
   items,
   next_page_token:typeof list.nextPageToken==='string'&&list.nextPageToken?list.nextPageToken:null,
   result_size_estimate:Number.isFinite(list.resultSizeEstimate)?list.resultSizeEstimate:null,
   provider_exhausted:!list.nextPageToken
  };
 }
 async read(connector,action,input={}) {
  if(!['gmail','whatsapp'].includes(connector))throw Error('Unknown connector');
  object(input,['query','id','limit','body','page_token','expected_from','expected_to','verify','want_attachment']);
  if(action==='status')return this.status().items.find(m=>m.id===connector);
  if(action==='draft') {text(input.body,'draft body',4000);if(secret(input.body))throw Error('Secret-like draft refused.');return {draft:clean(input.body),local_only:true,sent:false,untrusted:true,authority:false};}
  if(!['unread','recent','search','read','thread','attention','summarize','job_categorize'].includes(action))throw Error('Mutation unavailable; an independently governed capability is required.');
  const limit=input.limit??10;if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('Bounded connector limit required.');
  if(input.query!==undefined){
   text(input.query,'query',1000);
   // Host NL Gmail search queries use from:domain atoms that trip chat secret heuristics.
   if(!require('./gmail-search-intent').isHostSearchQuery(input.query)&&secret(input.query))throw Error('Secret query refused.');
  }
  // Provider page tokens are host-session only (gmailSearchPage). Clients cannot supply them.
  if(input.page_token!==undefined&&action!=='search')throw Error('Gmail page continuation is host-session only.');
  if(input.page_token!==undefined&&action==='search'&&(typeof input.page_token!=='string'||!input.page_token||input.page_token.length>2048))throw Error('Invalid Gmail page continuation.');
  let items;
  let pageMeta=null;
  if(connector==='gmail') {
   const selected=['read','thread','summarize'].includes(action);
   if(selected&&(!ID.test(input.id||'')))throw Error('Explicit message or thread ID required.');
   if(action==='thread') {const thread=await this.#get('threads/'+encodeURIComponent(input.id),{format:'full'});items=(thread.messages||[]).slice(0,limit).map(m=>this.#mail(m,{attachments:false}));}
   else if(selected){
    const raw=await this.#get('messages/'+encodeURIComponent(input.id),{format:'full'});
    items=[this.#mail(raw,{attachments:input.want_attachment===true||input.verify===true})];
   }
   else {
    const q=action==='job_categorize'
     ?(input.query||'newer_than:30d (subject:(application OR interview OR recruiter OR hiring OR opportunity) OR from:(recruiter OR talent OR careers))')
     :(['unread','attention'].includes(action)?'is:unread':action==='search'?input.query||'': 'newer_than:7d');
    pageMeta=await this.#listMessages({q,limit,pageToken:action==='search'?(input.page_token||null):null});
    items=pageMeta.items;
   }
   this.#liveGmail=true;
  }else {
   if(!this.#whatsapp||typeof this.#whatsapp.read!=='function')throw Error('Official WhatsApp inbound source unavailable. Personal WhatsApp history is not supported.');
   const rows=await this.#whatsapp.read({id:input.id,query:input.query,limit});if(!Array.isArray(rows)||rows.length>limit)throw Error('Invalid bounded inbound data');
   items=rows.map(m=>({id:ID.test(m.id||'')?m.id:null,subject:'Official inbound WhatsApp text',content:clean(m.text),untrusted:true,authority:false}));
  }
  const base={items,analysis:['attention','summarize'].includes(action)?items.map(m=>({id:m.id,summary:m.content.slice(0,300),basis:'Bounded selected text excerpt; importance and factual accuracy need operator review.'})):[],untrusted:true,authority:false,worker_context:false,host_verified:true,live_qualified:this.#liveGmail};
  if(pageMeta){
   // Raw provider page tokens stay off the public receipt; sessions wrap them.
   base._provider_next_page_token=pageMeta.next_page_token;
   base.provider_exhausted=pageMeta.provider_exhausted;
   base.result_size_estimate=pageMeta.result_size_estimate;
  }
  if(action==='job_categorize'&&connector==='gmail'){
   const categorized=require('./job-search-manager').categorizeRecruiters(items.map(m=>({
    id:m.id,from:m.from,subject:m.subject,snippet:m.content,thread_id:m.thread_id
   })));
   return {...base,...categorized,live_qualified:true};
  }
  return base;
 }
 #mail(m,{attachments=false}={}){
  if(!ID.test(m.id||''))throw Error('Invalid Gmail message reference');
  const headers=m.payload?.headers||[];
  const get=(n)=>headers.find(h=>h.name?.toLowerCase()===n)?.value;
  const subject=get('subject');
  const from=get('from');
  const to=get('to');
  const date=get('date');
  let content=m.snippet||'';
  const parts=walkParts(m.payload);
  const plain=parts.find(p=>p?.mimeType==='text/plain'&&p.body?.data&&!p.filename);
  if(plain)content=Buffer.from(plain.body.data,'base64url').toString('utf8');
  const label_ids=Array.isArray(m.labelIds)?m.labelIds.filter(l=>typeof l==='string').slice(0,40):[];
  const item={
   id:m.id,
   thread_id:ID.test(m.threadId||'')?m.threadId:null,
   from:clean(from),
   to:clean(to),
   from_email:emailLocal(from),
   to_email:emailLocal(to),
   date:clean(date),
   subject:clean(subject),
   content:clean(content),
   label_ids,
   label_sent:label_ids.includes('SENT'),
   label_inbox:label_ids.includes('INBOX'),
   untrusted:true,
   authority:false,
  };
  if(attachments){
   const att=[];
   for(const p of parts){
    if(!p||!p.filename||!p.body?.data)continue;
    if(String(p.mimeType||'')!=='text/plain'&&!/\.txt$/i.test(p.filename))continue;
    const buf=Buffer.from(p.body.data,'base64url');
    if(buf.length>256000)continue;
    att.push({
     filename:String(p.filename).slice(0,200),
     mime_type:p.mimeType||'text/plain',
     size:buf.length,
     sha256:createHash('sha256').update(buf).digest('hex'),
    });
    if(att.length>=5)break;
   }
   item.attachments=att;
   item.attachment_inspection=att.length
    ?'text/plain named parts decoded from provider full format'
    :'No text/plain named attachment parts found on this message (body text may still be present).';
  }
  return item;
 }
}
// Called by an already authenticated host webhook transport, never by worker text.
function officialInbound(raw,signature,appSecret){
 if(!Buffer.isBuffer(raw)||raw.length>512000||typeof appSecret!=='string'||!appSecret)throw Error('Invalid webhook boundary');
 const crypto=require('node:crypto'),expected='sha256='+crypto.createHmac('sha256',appSecret).update(raw).digest('hex'),a=Buffer.from(signature||''),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw Error('Webhook signature refused');
 const data=JSON.parse(raw);if(data.object!=='whatsapp_business_account')throw Error('Official Business webhook required');
 const messages=[];for(const e of data.entry||[])for(const c of e.changes||[])for(const m of c.value?.messages||[]){if(m.type==='text'&&ID.test(m.id||''))messages.push({id:m.id,text:clean(m.text?.body)});if(messages.length>20)throw Error('Webhook bound exceeded');}return messages;
}
module.exports={AssistantConnectors,officialInbound};
