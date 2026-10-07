'use strict';
// Operator-only PKCE loopback flow. Tokens remain inside the host vault port.
const crypto=require('node:crypto');
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';
class GmailOAuth {
 #vault; #request; #client; #pending=null; #reference=null; #refresh=null;
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
  try{const r=await this.#request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();const raw=await r.text();if(Buffer.byteLength(raw)>12000)throw Error();const value=JSON.parse(raw);if(typeof value.access_token!=='string'||!value.access_token||!Number.isInteger(value.expires_in)||value.expires_in<1||value.scope&&value.scope!==SCOPE)throw Error();return value;}catch{throw Error('Gmail OAuth exchange unavailable; credential diagnostics withheld');}
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
  this.#refresh=(async()=>{const next=await this.#exchange({client_id:this.#client,grant_type:'refresh_token',refresh_token:token.refresh_token});
   if(this.#reference!==old)throw Error('Gmail authorization changed during renewal');
   const receipt=this.#vault.replace(old,JSON.stringify({...next,refresh_token:next.refresh_token||token.refresh_token,expires_at:Date.now()+next.expires_in*1000}),'gmail');this.#reference=receipt.reference;this.onReference(this.#reference);return next.access_token;
  })();try{return await this.#refresh;}finally{this.#refresh=null;}
 }
 configuration(){return {scope:SCOPE,reference:'host-oauth'};}
 status(){return {configured:!!this.#reference,pending:!!this.#pending,scope:SCOPE,values_displayed:false};}
}
module.exports={GmailOAuth,SCOPE};
