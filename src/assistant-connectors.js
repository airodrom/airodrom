'use strict';
// Host protocol boundary. Message bodies are untrusted data, never actions.
const {text,object}=require('./control-plane-store');
const {secret}=require('./assistant-intent');
const ID=/^[A-Za-z0-9_.:-]{1,200}$/;
const clean=value=>{const raw=String(value||'');if(secret(raw))return '[Sensitive content withheld]';return require('./secret-observation').redactText(require('node:util').stripVTControlCharacters(raw).slice(0,4000));};
class AssistantConnectors {
 #gmail; #whatsapp; #secret; #request;
 constructor({gmail=null,whatsapp=null,secrets=null,request=fetch}={}){this.#gmail=gmail;this.#whatsapp=whatsapp;this.#secret=secrets;this.#request=request;}
 status(){return {items:[{id:'gmail',protocol:'Google Gmail API / OAuth 2.0',state:this.#gmail&&this.#secret?'configured':'unavailable',read_only:true,live_qualified:false,setup:'Requires owner-configured OAuth gmail.readonly credential reference. No account connected by qualification.',mutations:'Remote draft/send/archive/delete/label/mark-read require separate canonical capabilities; unavailable in this read-only adapter.'},{id:'whatsapp',protocol:'WhatsApp Business Cloud API',state:this.#whatsapp?'configured':'unavailable',read_only:true,live_qualified:false,setup:'Official inbound webhook source only. Personal WhatsApp history is unavailable through this adapter. No WhatsApp Web automation.',mutations:'Sending remains unavailable until a separately governed official adapter is qualified.'}],authority:false};}
 async #get(resource,query={}) {
  if(!this.#gmail||!this.#secret)throw Error('Gmail OAuth connector is not configured.');
  if(this.#gmail.scope!=='https://www.googleapis.com/auth/gmail.readonly')throw Error('Gmail requires the exact read-only OAuth scope.');
  const token=await this.#secret.resolve(this.#gmail.reference,'gmail');
  const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+resource);
  for(const [k,v]of Object.entries(query))url.searchParams.set(k,String(v));
  try{
   const response=await this.#request(url,{method:'GET',headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error();const raw=await response.text();if(Buffer.byteLength(raw)>512000)throw Error();return JSON.parse(raw);
  }catch{throw Error('Gmail read unavailable; credentials and provider diagnostics withheld.');}
 }
 async read(connector,action,input={}) {
  if(!['gmail','whatsapp'].includes(connector))throw Error('Unknown connector');
  object(input,['query','id','limit','body']);
  if(action==='status')return this.status().items.find(m=>m.id===connector);
  if(action==='draft') {text(input.body,'draft body',4000);if(secret(input.body))throw Error('Secret-like draft refused.');return {draft:clean(input.body),local_only:true,sent:false,untrusted:true,authority:false};}
  if(!['unread','recent','search','read','thread','attention','summarize'].includes(action))throw Error('Mutation unavailable; an independently governed capability is required.');
  const limit=input.limit??10;if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('Bounded connector limit required.');
  if(input.query!==undefined){text(input.query,'query',1000);if(secret(input.query))throw Error('Secret query refused.');}
  let items;
  if(connector==='gmail') {
   const selected=['read','thread','summarize'].includes(action);
   if(selected&&(!ID.test(input.id||'')))throw Error('Explicit message or thread ID required.');
   if(action==='thread') {const thread=await this.#get('threads/'+encodeURIComponent(input.id),{format:'full'});items=(thread.messages||[]).slice(0,limit).map(m=>this.#mail(m));}
   else if(selected)items=[this.#mail(await this.#get('messages/'+encodeURIComponent(input.id),{format:'full'}))];
   else {const list=await this.#get('messages',{maxResults:limit,q:['unread','attention'].includes(action)?'is:unread':action==='search'?input.query||'': 'newer_than:7d'});items=[];for(const m of (list.messages||[]).slice(0,limit)){if(!ID.test(m.id))throw Error('Invalid Gmail reference');items.push(this.#mail(await this.#get('messages/'+encodeURIComponent(m.id),{format:'metadata',metadataHeaders:'Subject'})));}}
  }else {
   if(!this.#whatsapp||typeof this.#whatsapp.read!=='function')throw Error('Official WhatsApp inbound source unavailable. Personal WhatsApp history is not supported.');
   const rows=await this.#whatsapp.read({id:input.id,query:input.query,limit});if(!Array.isArray(rows)||rows.length>limit)throw Error('Invalid bounded inbound data');
   items=rows.map(m=>({id:ID.test(m.id||'')?m.id:null,subject:'Official inbound WhatsApp text',content:clean(m.text),untrusted:true,authority:false}));
  }
  return {items,analysis:['attention','summarize'].includes(action)?items.map(m=>({id:m.id,summary:m.content.slice(0,300),basis:'Bounded selected text excerpt; importance and factual accuracy need operator review.'})):[],untrusted:true,authority:false,worker_context:false};
 }
 #mail(m){if(!ID.test(m.id||''))throw Error('Invalid Gmail message reference');const subject=(m.payload?.headers||[]).find(h=>h.name?.toLowerCase()==='subject')?.value;let content=m.snippet||'';const parts=[m.payload,...(m.payload?.parts||[])];const plain=parts.find(p=>p?.mimeType==='text/plain'&&p.body?.data);if(plain)content=Buffer.from(plain.body.data,'base64url').toString('utf8');return {id:m.id,thread_id:ID.test(m.threadId||'')?m.threadId:null,subject:clean(subject),content:clean(content),untrusted:true,authority:false};}
}
// Called by an already authenticated host webhook transport, never by worker text.
function officialInbound(raw,signature,appSecret){
 if(!Buffer.isBuffer(raw)||raw.length>512000||typeof appSecret!=='string'||!appSecret)throw Error('Invalid webhook boundary');
 const crypto=require('node:crypto'),expected='sha256='+crypto.createHmac('sha256',appSecret).update(raw).digest('hex'),a=Buffer.from(signature||''),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw Error('Webhook signature refused');
 const data=JSON.parse(raw);if(data.object!=='whatsapp_business_account')throw Error('Official Business webhook required');
 const messages=[];for(const e of data.entry||[])for(const c of e.changes||[])for(const m of c.value?.messages||[]){if(m.type==='text'&&ID.test(m.id||''))messages.push({id:m.id,text:clean(m.text?.body)});if(messages.length>20)throw Error('Webhook bound exceeded');}return messages;
}
module.exports={AssistantConnectors,officialInbound};
