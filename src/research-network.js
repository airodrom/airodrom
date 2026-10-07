'use strict';
// Public research transport: every hop has an exact origin and a pinned public
// DNS address. Browser credentials, cookies and request headers never enter it.
const dns=require('node:dns/promises'),https=require('node:https'),http=require('node:http'),net=require('node:net'),tls=require('node:tls');
const {secretLike}=require('./provider-policy');
const {containsSecret}=require('./personal-memory');
const {unsafeEvidenceText}=require('./research-baseline');
const {randomUUID}=require('node:crypto');
const deny4=new net.BlockList();for(const [address,prefix]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])deny4.addSubnet(address,prefix,'ipv4');
const global6=new net.BlockList();global6.addSubnet('2000::',3,'ipv6');const deny6=new net.BlockList();for(const [address,prefix]of [['2001::',23],['2001:db8::',32],['2002::',16],['3ffe::',16],['3fff::',20]])deny6.addSubnet(address,prefix,'ipv6');
const REDIRECTS=new Set([301,302,303,307,308]);
const TYPES=new Set(['text/html','application/xhtml+xml','text/plain','text/css','text/javascript','application/javascript','application/json','image/png','image/jpeg','image/webp','image/gif','image/svg+xml','image/x-icon','font/woff','font/woff2','application/font-woff']);
const DOWNLOAD_TYPES=new Set(['text/plain','text/csv','application/json']);
const MAX_DOWNLOAD_BYTES=49152;
const SENSITIVE_URL=/(?:^|[/.?&=_-])(?:login|log-in|signin|sign-in|signout|logout|oauth|authorize|authorization|auth|password|passwd|secret|credential|token|session|cookie|account|billing|payment|checkout|captcha|mfa|2fa|otp)(?:[/.?&=_-]|$)/i;
const KEY=/(?:password|passwd|secret|credential|token|session|cookie|authorization|api.?key|access.?key|email|username|user.?id|code|state)/i;
const PUBLIC_QUERY=new Set(['q','query','search','page','p','lang','language','locale','sort','order','category','filter','limit','offset']);
const MUTATION_PATH=/(?:^|\/)(?:logout|signout|log-out|sign-out|delete|remove|destroy|unsubscribe|connect|disconnect|authorize|revoke|update|create|save|add|new|invite|register|signup|sign-up|reset|change|checkout|purchase|pay(?!ments(?:\/|$))|submit|accept|approve|enable|disable|transfer|refund|withdraw|send|cancel|execute|redeem|subscribe|upgrade|downgrade|import|export|clear|close|terminate)/i;
const error=code=>{const e=Error('Public research network refused: '+code);e.code=code;return e;};
function publicAddress(address,family){return typeof address==='string'&&!address.includes('%')&&net.isIP(address)===family&&(family===4?!deny4.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!deny6.check(address,'ipv6'));}
function safeOrigin(value,allowFixture=false){
 if(typeof value!=='string'||value.length>400||/[\x00-\x20\x7f\\]/.test(value))throw error('invalid_origin');let u;try{u=new URL(value);}catch{throw error('invalid_origin');}
 const fixture=allowFixture&&u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname);
 const host=u.hostname.toLowerCase();
 if(u.origin!==value||u.username||u.password||u.pathname!=='/'||u.search||u.hash||(!fixture&&(u.protocol!=='https:'||u.port||net.isIP(host)||!host.includes('.')||host.split('.').some(p=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)||host.endsWith('.home.arpa'))))throw error('invalid_origin');
 return u.origin;
}
function abortable(promise,signal){return new Promise((resolve,reject)=>{const abort=()=>{signal?.removeEventListener('abort',abort);reject(error('cancelled'));};if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(v=>{signal?.removeEventListener('abort',abort);resolve(v);},()=>{signal?.removeEventListener('abort',abort);reject(error('dns_unavailable'));});});}
class ResearchNetwork{
 constructor({scope,signal,testing,timeoutMs=10000,maxBytes=2097152}={}){
  if(testing&&process.env.NODE_ENV!=='test')throw error('test_transport_denied');
  this.fixture=testing?.allowLoopback===true;this.lookup=testing?.lookup||dns.lookup;this.request=testing?.request||null;this.signal=signal;
  if(!scope||!Array.isArray(scope.origins)||!scope.origins.length||scope.origins.length>20)throw error('invalid_scope');
  this.origins=new Set(scope.origins.map(o=>safeOrigin(o,this.fixture)));if(this.origins.size!==scope.origins.length)throw error('duplicate_origin');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw error('invalid_bound');
  this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;this.active=0;
  this.account=null;
 }
 // These are host-only methods. The typed browser port never accepts bodies,
 // cookies or credential values from action JSON.
 openAccount({origin,loginUrl}={}){
  if(this.account)throw error('account_already_bound');origin=safeOrigin(origin,this.fixture);if(!this.origins.has(origin))throw error('account_origin_denied');
  const url=this.accountURL(loginUrl,origin),handle=randomUUID();this.account={handle,origin,loginUrl:url,attempted:false,cookies:new Map(),forbiddenValues:[]};return handle;
 }
 accountURL(value,origin=this.account?.origin){
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f\\]|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value))throw error('invalid_account_url');
  let url;try{url=new URL(value);}catch{throw error('invalid_account_url');}
  if(url.origin!==origin||!this.origins.has(origin)||url.username||url.password||url.hash)throw error('account_origin_denied');
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{throw error('invalid_account_url');}if(MUTATION_PATH.test(pathname))throw error('account_mutation_path_denied');
  if(containsSecret(value)&&! /^\/(?:api\/)?auth\/(?:login|signin|session)\/?$/i.test(pathname))throw error('credential_in_account_url');
  const decoded=pathname+'\n'+[...url.searchParams.values()].join('\n');for(const bytes of this.account?.forbiddenValues||[]){const secret=bytes.toString('utf8');if(secret&&decoded.includes(secret))throw error('credential_in_account_url');}for(const cookie of this.account?.cookies.values()||[])if(cookie.value&&decoded.includes(cookie.value))throw error('credential_in_account_url');
  if(/^\/(?:api|rpc|rest|graphql|v\d+)(?:\/|$)/i.test(pathname)&&! /^\/api\/(?:auth\/)?(?:login|signin|sign-in|session)\/?$/i.test(pathname))throw error('private_api_denied');
  for(const [k,v]of url.searchParams)if(!PUBLIC_QUERY.has(k)||KEY.test(k)||v.length>200||secretLike(v)||/[\x00-\x1f\x7f]/.test(v))throw error('private_query_denied');
  return url.href;
 }
 accountSession(handle){if(!this.account||this.account.handle!==handle)throw error('account_binding_required');return this.account;}
 async accountPage({handle,url,method='GET',signal=this.signal,followRedirects=false}={}){if(!['GET','HEAD'].includes(method))throw error('method_denied');const account=this.accountSession(handle);return this.accountFetch({account,url:this.accountURL(url,account.origin),method,signal,followRedirects});}
 async authenticateAccount({handle,submissionUrl,usernameName,passwordName,hiddenFields=[],username,password,signal=this.signal}={}){
  const account=this.accountSession(handle);if(account.attempted)throw error('login_attempt_already_consumed');
  const url=this.accountURL(submissionUrl,account.origin),safeName=name=>typeof name==='string'&&/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name);
  if(!safeName(usernameName)||!safeName(passwordName)||usernameName===passwordName||!Array.isArray(hiddenFields)||hiddenFields.length>8)throw error('login_form_invalid');
  const values=[username,password].map(v=>Buffer.isBuffer(v)?v.toString('utf8'):v);if(values.some(v=>typeof v!=='string'||!v||v.length>4096||/[\x00-\x1f\x7f]/.test(v)))throw error('secure_value_invalid');
  const fields=new URLSearchParams(),seen=new Set([usernameName,passwordName]);fields.set(usernameName,values[0]);fields.set(passwordName,values[1]);
  for(const field of hiddenFields){if(!field||!safeName(field.name)||! /(?:csrf|xsrf|authenticity|verification.?token|nonce)|^(?:utf8|token)$/i.test(field.name)||seen.has(field.name)||typeof field.value!=='string'||field.value.length>4096||/[\x00-\x1f\x7f]/.test(field.value))throw error('login_form_invalid');seen.add(field.name);fields.set(field.name,field.value);}
  const body=Buffer.from(fields.toString());if(body.length>32768)throw error('secure_body_bound');account.attempted=true;account.forbiddenValues=values.map(v=>Buffer.from(v));
  try{return await this.accountFetch({account,url,method:'POST',body,signal,followRedirects:true});}finally{body.fill(0);values.fill(null);if(Buffer.isBuffer(username))username.fill(0);if(Buffer.isBuffer(password))password.fill(0);}
 }
 cookieHeader(account,url){const values=[];let bytes=0;for(const [key,cookie]of account.cookies){if(cookie.expires<=Date.now()){account.cookies.delete(key);continue;}if(!(url.pathname===cookie.path||url.pathname.startsWith(cookie.path.endsWith('/')?cookie.path:cookie.path+'/')))continue;const value=cookie.name+'='+cookie.value;bytes+=value.length;if(bytes>8192)throw error('cookie_bound');values.push(value);}return values.join('; ');}
 saveCookies(account,url,headers){
  const rows=headers['set-cookie'];if(rows===undefined)return;if(!Array.isArray(rows)||rows.length>32)throw error('cookie_policy_denied');
  for(const raw of rows){if(typeof raw!=='string'||raw.length>4096||/[\x00-\x1f\x7f]/.test(raw))throw error('cookie_policy_denied');const parts=raw.split(';').map(v=>v.trim()),pair=parts.shift(),index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);if(index<1||! /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)||value.length>2048||/[\s;,\\]/.test(value))throw error('cookie_policy_denied');
   const attrs=new Map();for(const attr of parts){const eq=attr.indexOf('='),key=(eq<0?attr:attr.slice(0,eq)).toLowerCase();if(attrs.has(key))throw error('cookie_policy_denied');attrs.set(key,eq<0?'':attr.slice(eq+1));}
   if(attrs.has('domain')&&attrs.get('domain').toLowerCase()!==url.hostname.toLowerCase()||!this.fixture&&!attrs.has('secure')||name.startsWith('__Host-')&&(attrs.has('domain')||attrs.get('path')!=='/'||!attrs.has('secure'))||name.startsWith('__Secure-')&&!attrs.has('secure'))throw error('cookie_policy_denied');
   const cookiePath=attrs.get('path')||url.pathname.slice(0,url.pathname.lastIndexOf('/')+1)||'/';if(!cookiePath.startsWith('/')||cookiePath.length>512||/[\x00-\x20\x7f\\]/.test(cookiePath))throw error('cookie_policy_denied');
   let expires=Date.now()+1800000;if(attrs.has('max-age')){const age=attrs.get('max-age');if(!/^-?\d{1,10}$/.test(age))throw error('cookie_policy_denied');expires=Math.min(expires,Date.now()+Number(age)*1000);}else if(attrs.has('expires')){const date=Date.parse(attrs.get('expires'));if(!Number.isFinite(date))throw error('cookie_policy_denied');expires=Math.min(expires,date);}
   const key=name+'\n'+cookiePath;if(expires<=Date.now()){account.cookies.delete(key);continue;}if(!account.cookies.has(key)&&account.cookies.size>=32)throw error('cookie_bound');account.cookies.set(key,{name,value,path:cookiePath,expires});
  }
 }
 async accountFetch({account,url,method,body,signal,followRedirects}){
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,this.timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();if(this.active>=8){clearTimeout(timer);signal?.removeEventListener('abort',abort);throw error('concurrency_bound');}this.active++;
  try{let current=url,currentMethod=method,currentBody=body;const seen=new Set();for(;;){if(controller.signal.aborted)throw error('cancelled');current=this.accountURL(current,account.origin);const result=await this.hop(new URL(current),currentMethod,controller.signal,{account,body:currentBody});
    if(REDIRECTS.has(result.status)){if(seen.size>=3||typeof result.location!=='string'||currentMethod==='POST'&&[307,308].includes(result.status))throw error('account_redirect_denied');const next=this.accountURL(new URL(result.location,current).href,account.origin);if(next===current||seen.has(next))throw error('redirect_loop');if(!followRedirects)return {url:current,status:result.status,location:next,contentType:'text/html',body:Buffer.alloc(0)};seen.add(current);current=next;currentMethod='GET';currentBody=undefined;continue;}
    if(result.status<200||result.status>=300)throw error([401,403,407,429].includes(result.status)?'human_takeover_required':'account_response_unavailable');const type=String(result.contentType||'').split(';')[0].trim().toLowerCase();if(!TYPES.has(type)||result.attachment||!Buffer.isBuffer(result.body)||result.body.length>this.maxBytes)throw error('account_response_denied');return {url:current,status:result.status,contentType:type,body:result.body};
   }}catch(e){throw error(/^[a-z_]+$/.test(e?.code||'')?e.code:'account_transport_unavailable');}finally{this.active--;clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 closeAccount(){this.account?.cookies.clear();for(const bytes of this.account?.forbiddenValues||[])bytes.fill(0);this.account=null;}
 validate(value,method='GET'){
  if(!['GET','HEAD'].includes(method))throw error('method_denied');
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f\\]|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)||containsSecret(value))throw error('credential_or_invalid_url');
  let u;try{u=new URL(value);}catch{throw error('invalid_url');}
  let pathname;try{pathname=decodeURIComponent(u.pathname);}catch{throw error('invalid_url');}if(!this.origins.has(u.origin)||u.username||u.password||u.hash||SENSITIVE_URL.test(pathname)||MUTATION_PATH.test(pathname))throw error('origin_or_sensitive_path_denied');
  for(const [k,v]of u.searchParams)if(!PUBLIC_QUERY.has(k)||KEY.test(k)||v.length>200||secretLike(v)||/[\x00-\x1f\x7f]/.test(v)||/\b(?:bearer|password|passphrase|api.?key|private.?key|secret|credential|oauth|access.?token|refresh.?token)\b/i.test(v))throw error('private_query_denied');
  return u.href;
 }
 async fetch({url,method='GET',signal=this.signal,download=false,followRedirects=true}={}){
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,this.timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  if(this.active>=8){clearTimeout(timer);signal?.removeEventListener('abort',abort);throw error('concurrency_bound');}this.active++;
  try{
   let current=this.validate(url,method);const hops=[];
   for(;;){if(controller.signal.aborted)throw error('cancelled');const result=await this.hop(new URL(current),method,controller.signal,undefined,download?MAX_DOWNLOAD_BYTES:undefined);
    if(REDIRECTS.has(result.status)){if(hops.length>=3||typeof result.location!=='string')throw error('redirect_denied');let next;try{next=new URL(result.location,current).href;}catch{throw error('redirect_denied');}next=this.validate(next,method);if(next===current||hops.includes(next))throw error('redirect_loop');if(!followRedirects)return {url:current,status:result.status,location:next,contentType:'text/html',body:Buffer.alloc(0),redirects:1};hops.push(current);current=next;continue;}
    if(!Number.isInteger(result.status)||result.status<200||result.status>=300)throw error([401,403,407,429].includes(result.status)?'authentication_or_captcha':'response_unavailable');
    if(!Buffer.isBuffer(result.body)||result.body.length>this.maxBytes||method==='HEAD'&&result.body.length)throw error('response_bound');
    const type=String(result.contentType||'').split(';')[0].trim().toLowerCase();if(!(download?DOWNLOAD_TYPES:TYPES).has(type))throw error('content_type_denied');
    if(result.attachment&&!download)throw error('unapproved_download');
    if(download){const text=result.body.toString('utf8');if(Buffer.from(text).compare(result.body)!==0||unsafeEvidenceText(text))throw error('credential_download_denied');}
    return {url:current,status:result.status,contentType:type,body:result.body,redirects:hops.length};
   }
  }catch(e){throw error(typeof e?.code==='string'&&/^[a-z_]+$/.test(e.code)?e.code:'transport_unavailable');}
  finally{this.active--;clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async hop(url,method,signal,privateRequest,responseLimit=this.maxBytes){
  const fixture=this.fixture&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname);
  const addresses=fixture?[{address:url.hostname.replace(/^\[|\]$/g,''),family:url.hostname==='[::1]'?6:4}]:await abortable(Promise.resolve().then(()=>this.lookup(url.hostname,{all:true,verbatim:true})),signal);
  if(signal.aborted)throw error('cancelled');if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||!fixture&&addresses.some(r=>!r||!publicAddress(r.address,r.family)))throw error('private_dns_denied');
  const pinned=addresses[0],options={protocol:url.protocol,hostname:url.hostname,port:url.port||443,path:url.pathname+url.search,method,headers:{Accept:'*/*','Accept-Encoding':'identity','User-Agent':'Airodrom public research'},agent:false,family:pinned.family,autoSelectFamily:false,servername:url.hostname,rejectUnauthorized:true,checkServerIdentity:tls.checkServerIdentity,maxHeaderSize:16384,signal,lookup:(host,opts,callback)=>{if(host!==url.hostname)return callback(error('pinned_hostname_mismatch'));if(opts?.all)callback(null,[pinned]);else callback(null,pinned.address,pinned.family);}};
  if(privateRequest){const cookies=this.cookieHeader(privateRequest.account,url);if(cookies)options.headers.Cookie=cookies;if(method==='POST'){if(!Buffer.isBuffer(privateRequest.body))throw error('secure_body_required');options.headers['Content-Type']='application/x-www-form-urlencoded';options.headers['Content-Length']=privateRequest.body.length;options.headers.Origin=privateRequest.account.origin;}}
  return new Promise((resolve,reject)=>{
   let req,res,settled=false;const finish=(failure,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);res?.destroy();req?.destroy();failure?reject(failure):resolve(value);},abort=()=>finish(error('cancelled'));
   if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});
   try{
    req=(this.request||(fixture?http.request:https.request))(options,incoming=>{
     res=incoming;res.on('error',()=>finish(error('response_unavailable')));res.on('aborted',()=>finish(error('incomplete_response')));res.on('close',()=>{if(!res.complete)finish(error('incomplete_response'));});if(settled){res.destroy();return;}
     if(privateRequest)try{this.saveCookies(privateRequest.account,url,res.headers);}catch(e){return finish(e);}
     const status=res.statusCode;if(REDIRECTS.has(status))return finish(null,{status,location:res.headers.location});
     if(String(res.headers['content-encoding']||'identity').toLowerCase()!=='identity')return finish(error('compressed_response_denied'));
     const length=res.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(String(length))||BigInt(length)>BigInt(responseLimit)))return finish(error('response_bound'));
     let bytes=0;const chunks=[];res.on('data',chunk=>{const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=data.length;if(bytes>responseLimit||method==='HEAD'&&bytes)return finish(error('response_bound'));chunks.push(data);});
     res.on('end',()=>{if(!res.complete)return finish(error('incomplete_response'));finish(null,{status,contentType:res.headers['content-type'],attachment:/\battachment\b/i.test(String(res.headers['content-disposition']||'')),body:Buffer.concat(chunks,bytes)});});
    });
    req.on('error',()=>finish(error('transport_unavailable')));req.on('upgrade',(_r,socket)=>{socket.destroy();finish(error('upgrade_denied'));});req.on('connect',(_r,socket)=>{socket.destroy();finish(error('tunnel_denied'));});if(settled)req.destroy();else req.end(privateRequest?.body);
   }catch{finish(error('transport_unavailable'));}
  });
 }
}
module.exports={ResearchNetwork,publicAddress,safeOrigin,error,MAX_DOWNLOAD_BYTES};
