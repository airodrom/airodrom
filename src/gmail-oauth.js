'use strict';
// Operator-only PKCE loopback flow. Tokens remain inside the host vault port.
const crypto=require('node:crypto');
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';

const FAIL=Object.freeze({
 network:'gmail_oauth_network_error',
 timeout:'gmail_oauth_timeout',
 http:'gmail_oauth_http_rejected',
 schema:'gmail_oauth_response_invalid',
 scope:'gmail_oauth_scope_mismatch',
 consent:'gmail_oauth_consent_required',
 client:'gmail_oauth_client_rejected',
 grant:'gmail_oauth_grant_invalid',
 request:'gmail_oauth_request_invalid'
});

// Google token-error identifiers only. Never retain error_description or raw bodies.
const PROVIDER_ERRORS=Object.freeze({
 invalid_grant:FAIL.grant,
 invalid_client:FAIL.client,
 unauthorized_client:FAIL.client,
 invalid_request:FAIL.request,
 unsupported_grant_type:FAIL.request,
 invalid_scope:FAIL.scope,
 access_denied:FAIL.consent
});

function exchangeError(safeClass,message,providerError=null){
 const err=Error(message);
 err.code=safeClass;
 err.safe_error_class=safeClass;
 if(providerError)err.provider_error=providerError;
 return err;
}

function phaseOf(form){
 const grant=form&&form.grant_type;
 if(grant==='authorization_code')return 'authorization_code';
 if(grant==='refresh_token')return 'refresh_token';
 return 'exchange';
}

function scopeExact(value){
 return typeof value==='string'&&value===SCOPE;
}

function parseProviderError(raw){
 if(typeof raw!=='string'||!raw||Buffer.byteLength(raw)>12000)return null;
 let value;
 try{value=JSON.parse(raw);}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const id=value.error;
 if(typeof id!=='string'||!Object.prototype.hasOwnProperty.call(PROVIDER_ERRORS,id))return null;
 return id;
}

class GmailOAuth {
 #vault; #request; #client; #clientSecretReference; #pending=null; #reference=null; #refresh=null; #lastFailure=null;
 constructor({clientId,vault,request=fetch,reference=null,clientSecretReference=null,onReference=()=>{}}){
  if(typeof clientId!=='string'||!clientId.endsWith('.apps.googleusercontent.com')||clientId.length>200||!vault)throw Error('Owner-configured Google desktop OAuth client required');
  if(clientSecretReference!==null&&clientSecretReference!==undefined){
   if(typeof clientSecretReference!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(clientSecretReference)){
    throw Error('Owner-configured Google desktop OAuth client required');
   }
  }
  this.#vault=vault;this.#request=request;this.#client=clientId;this.#reference=reference;
  this.#clientSecretReference=clientSecretReference||null;this.onReference=onReference;
  // Surface known-unusable saved grants immediately (presence ≠ live readonly access).
  if(this.#reference){
   try{
    const token=JSON.parse(this.#vault.resolve(this.#reference,'gmail'));
    if(token?.scope&&!scopeExact(token.scope))this.#recordFailure(FAIL.scope,'resolve',null);
   }catch{/* resolve path reports unavailable references */}
  }
 }
 #authorizationFromPending(){
  const p=this.#pending;if(!p)throw Error('OAuth session is not pending');
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [k,v]of Object.entries({
   client_id:this.#client,redirect_uri:p.redirect,response_type:'code',scope:SCOPE,state:p.state,
   code_challenge:crypto.createHash('sha256').update(p.verifier).digest('base64url'),
   code_challenge_method:'S256',access_type:'offline',prompt:'consent',
  }))url.searchParams.set(k,v);
  return {authorization_url:String(url),read_only:true,expires_at:p.expires,reused:true};
 }
 start(redirect,{forceNew=false}={}){
  const u=new URL(redirect);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.pathname!=='/oauth/gmail/callback')throw Error('Pinned loopback callback required');
  // Reuse an unexpired pending PKCE session so browser-launch retries do not
  // invalidate a still-active authorization that the operator may complete.
  if(!forceNew&&this.#pending&&this.#pending.expires>Date.now()&&this.#pending.redirect===redirect){
   return this.#authorizationFromPending();
  }
  const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(32).toString('base64url');
  this.#pending={state,verifier,redirect,expires:Date.now()+300000};
  return {...this.#authorizationFromPending(),reused:false};
 }
 #attachClientSecret(form){
  if(!this.#clientSecretReference)return;
  let secret;
  try{secret=this.#vault.resolve(this.#clientSecretReference,'gmail');}
  catch{
   this.#recordFailure(FAIL.client,phaseOf(form),null);
   throw exchangeError(FAIL.client,'Gmail OAuth client secret is unavailable from the host vault. Restore the Keychain helper reference, then /connect gmail fresh.');
  }
  if(typeof secret!=='string'||!secret||secret.length>400||secret.includes('\0')){
   secret=undefined;
   this.#recordFailure(FAIL.client,phaseOf(form),null);
   throw exchangeError(FAIL.client,'Gmail OAuth client secret reference is invalid. Credentials withheld.');
  }
  form.client_secret=secret;
  secret=undefined;
 }
 #recordFailure(safeClass,phase,providerError){
  this.#lastFailure={
   safe_error_class:safeClass,
   at:Date.now(),
   phase,
   ...(providerError?{provider_error:providerError}:{})
  };
 }
 #messageFor(safeClass,phase){
  if(safeClass===FAIL.timeout)return 'Gmail OAuth timed out contacting Google. Retry /connect gmail or check network; tokens were not printed.';
  if(safeClass===FAIL.network)return 'Gmail OAuth network error contacting Google. Retry later; tokens and response bodies are withheld.';
  if(safeClass===FAIL.client)return 'Gmail OAuth client was rejected by Google. Confirm the Desktop OAuth client and vault client-secret reference, then /connect gmail fresh.';
  if(safeClass===FAIL.grant)return phase==='refresh_token'
   ?'Gmail OAuth refresh grant is invalid or revoked. Re-authorize with /connect gmail fresh; credentials withheld.'
   :'Gmail OAuth authorization code was rejected. Retry /connect gmail fresh; credentials withheld.';
  if(safeClass===FAIL.request)return 'Gmail OAuth token request was rejected as invalid. Retry /connect gmail fresh; credentials withheld.';
  if(safeClass===FAIL.scope)return 'Gmail OAuth scope mismatch; expected gmail.readonly only. Re-authorize with /connect gmail fresh.';
  if(safeClass===FAIL.consent)return 'Gmail OAuth consent or refresh was rejected. Re-authorize with /connect gmail; credentials withheld.';
  if(safeClass===FAIL.schema)return 'Gmail OAuth response invalid; credential diagnostics withheld';
  return 'Gmail OAuth HTTP exchange rejected. Re-authorize with /connect gmail; provider diagnostics withheld.';
 }
 async #exchange(form){
  const phase=phaseOf(form);
  this.#attachClientSecret(form);
  let response;
  try{
   response=await this.#request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),redirect:'error',signal:AbortSignal.timeout(10000)});
  }catch(error){
   const safe=error?.name==='TimeoutError'||error?.code==='TIMEOUT'?FAIL.timeout:FAIL.network;
   this.#recordFailure(safe,phase,null);
   throw exchangeError(safe,this.#messageFor(safe,phase));
  }finally{
   if(form.client_secret)form.client_secret='';
   delete form.client_secret;
  }
  if(!response.ok){
   let providerError=null,safe=FAIL.http;
   try{
    const raw=await response.text();
    providerError=parseProviderError(raw);
    if(providerError)safe=PROVIDER_ERRORS[providerError];
    else if(response.status===400||response.status===401)safe=FAIL.consent;
   }catch{
    try{await response.body?.cancel?.();}catch{/* */}
    if(response.status===400||response.status===401)safe=FAIL.consent;
   }
   this.#recordFailure(safe,phase,providerError);
   throw exchangeError(safe,this.#messageFor(safe,phase),providerError);
  }
  let raw;
  try{
   raw=await response.text();
   if(Buffer.byteLength(raw)>12000)throw exchangeError(FAIL.schema,'Gmail OAuth response exceeded size bound');
   const value=JSON.parse(raw);
   if(typeof value.access_token!=='string'||!value.access_token||!Number.isInteger(value.expires_in)||value.expires_in<1){
    throw exchangeError(FAIL.schema,'Gmail OAuth response schema invalid');
   }
   if(value.scope&&!scopeExact(value.scope))throw exchangeError(FAIL.scope,'Gmail OAuth scope mismatch; expected gmail.readonly only');
   this.#lastFailure=null;
   return value;
  }catch(error){
   if(error?.safe_error_class){this.#recordFailure(error.safe_error_class,phase,error.provider_error||null);throw error;}
   this.#recordFailure(FAIL.schema,phase,null);
   throw exchangeError(FAIL.schema,'Gmail OAuth response invalid; credential diagnostics withheld');
  }finally{raw=undefined;}
 }
 #readStoredToken(){
  if(!this.#reference)throw exchangeError(FAIL.consent,'Gmail OAuth authorization required');
  let token;
  try{token=JSON.parse(this.#vault.resolve(this.#reference,'gmail'));}
  catch{
   this.#recordFailure(FAIL.consent,'resolve',null);
   throw exchangeError(FAIL.consent,'Gmail OAuth authorization required');
  }
  if(!token||typeof token!=='object'||typeof token.access_token!=='string'||!token.access_token){
   this.#recordFailure(FAIL.schema,'resolve',null);
   throw exchangeError(FAIL.schema,'Gmail authorization unavailable');
  }
  // Fail closed on broader historical grants (e.g. gmail.modify / calendar / drive).
  if(token.scope&&!scopeExact(token.scope)){
   this.#recordFailure(FAIL.scope,'resolve',null);
   throw exchangeError(FAIL.scope,'Gmail OAuth scope mismatch; expected gmail.readonly only. Re-authorize with /connect gmail fresh.');
  }
  return token;
 }
 async complete({state,code}){
  const p=this.#pending;this.#pending=null;if(!p||p.expires<Date.now()||state!==p.state||typeof code!=='string'||!code||code.length>2000)throw Error('OAuth callback refused');
  const token=await this.#exchange({client_id:this.#client,redirect_uri:p.redirect,grant_type:'authorization_code',code,code_verifier:p.verifier});
  const prior=this.#reference;
  const receipt=this.#vault.put(JSON.stringify({...token,expires_at:Date.now()+token.expires_in*1000}),'gmail');
  this.#reference=receipt.reference;this.#lastFailure=null;this.onReference(this.#reference);
  if(prior&&prior!==receipt.reference){try{this.#vault.forget(prior);}catch{/* replaced */}}
  return {connected:true,read_only:true,values_displayed:false,live_qualified:false};
 }
 async resolve(){
  if(this.#refresh)return this.#refresh;
  const old=this.#reference,token=this.#readStoredToken();
  if(token.expires_at>Date.now()+30000)return token.access_token;
  if(!token.refresh_token){
   this.#recordFailure(FAIL.consent,'refresh_token',null);
   throw exchangeError(FAIL.consent,'Gmail OAuth renewal requires operator authorization');
  }
  this.#refresh=(async()=>{
   try{
    const next=await this.#exchange({client_id:this.#client,grant_type:'refresh_token',refresh_token:token.refresh_token});
    if(this.#reference!==old)throw Error('Gmail authorization changed during renewal');
    const receipt=this.#vault.replace(old,JSON.stringify({...next,refresh_token:next.refresh_token||token.refresh_token,expires_at:Date.now()+next.expires_in*1000}),'gmail');
    this.#reference=receipt.reference;this.#lastFailure=null;this.onReference(this.#reference);return next.access_token;
   }catch(error){
    if(!error?.safe_error_class)this.#recordFailure(FAIL.consent,'refresh_token',null);
    throw error;
   }
  })();try{return await this.#refresh;}finally{this.#refresh=null;}
 }
 configuration(){return {scope:SCOPE,reference:'host-oauth'};}
 binding(){return this.#reference?('gmail-ref:'+crypto.createHash('sha256').update(this.#reference).digest('hex').slice(0,16)):null;}
 status(){
  const tokenPresent=!!this.#reference;
  const blocking=this.#lastFailure&&[FAIL.client,FAIL.grant,FAIL.consent,FAIL.scope,FAIL.request].includes(this.#lastFailure.safe_error_class);
  return {
   configured:true,
   token_present:tokenPresent,
   // connected means a token reference exists and is not known-unusable from the last failure.
   connected:tokenPresent&&!blocking,
   pending:!!this.#pending,
   scope:SCOPE,
   read_only:true,
   values_displayed:false,
   // Live qualification is process-local after a successful bounded Gmail read.
   live_qualified:false,
   client_secret_configured:!!this.#clientSecretReference,
   last_safe_error_class:this.#lastFailure?.safe_error_class||null,
   last_failure_phase:this.#lastFailure?.phase||null,
   last_provider_error:this.#lastFailure?.provider_error||null
  };
 }
 revoke(){
  const ref=this.#reference;this.#pending=null;this.#reference=null;this.#refresh=null;this.#lastFailure=null;
  if(ref){try{this.#vault.forget(ref);}catch{/* already revoked */}this.onReference(null);}
  return {revoked:true,read_only:true,values_displayed:false};
 }
}
module.exports={GmailOAuth,SCOPE,FAIL,PROVIDER_ERRORS,parseProviderError};
