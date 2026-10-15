'use strict';
// Operator-only PKCE loopback flow. Tokens remain inside the host vault port.
const crypto=require('node:crypto');
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';

const FAIL={
 network:'gmail_oauth_network_error',
 timeout:'gmail_oauth_timeout',
 http:'gmail_oauth_http_rejected',
 schema:'gmail_oauth_response_invalid',
 scope:'gmail_oauth_scope_mismatch',
 consent:'gmail_oauth_consent_required'
};

function exchangeError(safeClass,message){
 const err=Error(message);
 err.code=safeClass;
 err.safe_error_class=safeClass;
 return err;
}

class GmailOAuth {
 #vault; #request; #client; #pending=null; #reference=null; #refresh=null; #lastFailure=null;
 constructor({clientId,vault,request=fetch,reference=null,onReference=()=>{}}){
  if(typeof clientId!=='string'||!clientId.endsWith('.apps.googleusercontent.com')||clientId.length>200||!vault)throw Error('Owner-configured Google desktop OAuth client required');
  this.#vault=vault;this.#request=request;this.#client=clientId;this.#reference=reference;this.onReference=onReference;
 }
 start(redirect){
  const u=new URL(redirect);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.pathname!=='/oauth/gmail/callback')throw Error('Pinned loopback callback required');
  const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(32).toString('base64url');
  this.#pending={state,verifier,redirect,expires:Date.now()+300000};
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');for(const [k,v]of Object.entries({client_id:this.#client,redirect_uri:redirect,response_type:'code',scope:SCOPE,state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'consent'}))url.searchParams.set(k,v);
  return {authorization_url:String(url),read_only:true,expires_at:this.#pending.expires};
 }
 async #exchange(form){
  let response;
  try{
   response=await this.#request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),redirect:'error',signal:AbortSignal.timeout(10000)});
  }catch(error){
   const safe=error?.name==='TimeoutError'||error?.code==='TIMEOUT'?FAIL.timeout:FAIL.network;
   this.#lastFailure={safe_error_class:safe,at:Date.now(),phase:form.grant_type||'exchange'};
   throw exchangeError(safe,safe===FAIL.timeout
    ?'Gmail OAuth timed out contacting Google. Retry /connect gmail or check network; tokens were not printed.'
    :'Gmail OAuth network error contacting Google. Retry later; tokens and response bodies are withheld.');
  }
  if(!response.ok){
   try{await response.body?.cancel?.();}catch{/* */}
   // Categorical only — never surface Google error bodies or codes that may embed tokens.
   const safe=response.status===400||response.status===401?FAIL.consent:FAIL.http;
   this.#lastFailure={safe_error_class:safe,http_status_class:response.status>=500?'5xx':response.status>=400?'4xx':'other',at:Date.now(),phase:form.grant_type||'exchange'};
   throw exchangeError(safe,safe===FAIL.consent
    ?'Gmail OAuth consent or refresh was rejected. Re-authorize with /connect gmail; credentials withheld.'
    :'Gmail OAuth HTTP exchange rejected. Re-authorize with /connect gmail; provider diagnostics withheld.');
  }
  let raw;
  try{
   raw=await response.text();
   if(Buffer.byteLength(raw)>12000)throw exchangeError(FAIL.schema,'Gmail OAuth response exceeded size bound');
   const value=JSON.parse(raw);
   if(typeof value.access_token!=='string'||!value.access_token||!Number.isInteger(value.expires_in)||value.expires_in<1){
    throw exchangeError(FAIL.schema,'Gmail OAuth response schema invalid');
   }
   if(value.scope&&value.scope!==SCOPE)throw exchangeError(FAIL.scope,'Gmail OAuth scope mismatch; expected gmail.readonly only');
   this.#lastFailure=null;
   return value;
  }catch(error){
   if(error?.safe_error_class){this.#lastFailure={safe_error_class:error.safe_error_class,at:Date.now(),phase:form.grant_type||'exchange'};throw error;}
   this.#lastFailure={safe_error_class:FAIL.schema,at:Date.now(),phase:form.grant_type||'exchange'};
   throw exchangeError(FAIL.schema,'Gmail OAuth response invalid; credential diagnostics withheld');
  }finally{raw=undefined;}
 }
 async complete({state,code}){
  const p=this.#pending;this.#pending=null;if(!p||p.expires<Date.now()||state!==p.state||typeof code!=='string'||!code||code.length>2000)throw Error('OAuth callback refused');
  const token=await this.#exchange({client_id:this.#client,redirect_uri:p.redirect,grant_type:'authorization_code',code,code_verifier:p.verifier});
  const receipt=this.#vault.put(JSON.stringify({...token,expires_at:Date.now()+token.expires_in*1000}),'gmail');this.#reference=receipt.reference;this.onReference(this.#reference);return {connected:true,read_only:true,values_displayed:false};
 }
 async resolve(){
  if(this.#refresh)return this.#refresh;
  if(!this.#reference)throw Error('Gmail OAuth authorization required');
  const old=this.#reference,token=JSON.parse(this.#vault.resolve(old,'gmail'));
  if(token.expires_at>Date.now()+30000)return token.access_token;
  if(!token.refresh_token)throw Error('Gmail OAuth renewal requires operator authorization');
  this.#refresh=(async()=>{
   try{
    const next=await this.#exchange({client_id:this.#client,grant_type:'refresh_token',refresh_token:token.refresh_token});
    if(this.#reference!==old)throw Error('Gmail authorization changed during renewal');
    const receipt=this.#vault.replace(old,JSON.stringify({...next,refresh_token:next.refresh_token||token.refresh_token,expires_at:Date.now()+next.expires_in*1000}),'gmail');this.#reference=receipt.reference;this.onReference(this.#reference);return next.access_token;
   }catch(error){
    // Refresh failures stay categorical for /gmail status without leaking bodies.
    if(!error?.safe_error_class)this.#lastFailure={safe_error_class:FAIL.consent,at:Date.now(),phase:'refresh_token'};
    throw error;
   }
  })();try{return await this.#refresh;}finally{this.#refresh=null;}
 }
 configuration(){return {scope:SCOPE,reference:'host-oauth'};}
 binding(){return this.#reference?('gmail-ref:'+crypto.createHash('sha256').update(this.#reference).digest('hex').slice(0,16)):null;}
 status(){
  return {
   configured:!!this.#reference,
   connected:!!this.#reference,
   pending:!!this.#pending,
   scope:SCOPE,
   read_only:true,
   values_displayed:false,
   live_qualified:false,
   last_safe_error_class:this.#lastFailure?.safe_error_class||null,
   last_failure_phase:this.#lastFailure?.phase||null
  };
 }
 revoke(){
  const ref=this.#reference;this.#pending=null;this.#reference=null;this.#refresh=null;this.#lastFailure=null;
  if(ref){try{this.#vault.forget(ref);}catch{/* already revoked */}this.onReference(null);}
  return {revoked:true,read_only:true,values_displayed:false};
 }
}
module.exports={GmailOAuth,SCOPE,FAIL};
