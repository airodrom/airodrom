'use strict';
// Governed public browser port. Actions are host typed data, never arbitrary JS.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {randomUUID,createHash}=require('node:crypto');
const {ResearchNetwork,error,MAX_DOWNLOAD_BYTES}=require('./research-network');
const {secretLike}=require('./provider-policy');
const {unsafeEvidenceText}=require('./research-baseline');
const {privateDirectory}=require('./local-bootstrap');
const sha=value=>createHash('sha256').update(value).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_EVIDENCE=4194304;
const PRIVATE_CATEGORIES=['dashboard','projects','settings','billing','team','integrations','activity','analytics','documentation','support','profile','transactions','accounts','balances','cashflow','forecasts','expenses','budgets','reconciliation','reports','payments','goals','recurring','insights'];
const exact=(o,keys)=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!keys.includes(k)))throw error('invalid_action');};
const bounded=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const clean=value=>require('node:util').stripVTControlCharacters(String(value||'')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'');

// Installed in every frame before website code. The browser also uses a local
// deny-all proxy, and only route.fulfill reaches the public pinned host port.
function restrictPage(){
 const denied=()=>{throw new Error('Unavailable in governed public research');};
 for(const key of ['WebSocket','WebTransport','RTCPeerConnection','webkitRTCPeerConnection','Worker','SharedWorker','EventSource','BroadcastChannel'])try{Object.defineProperty(globalThis,key,{value:denied,writable:false,configurable:false});}catch{}
 try{Object.defineProperty(window,'open',{value:()=>null,writable:false,configurable:false});}catch{}
 try{Object.defineProperty(navigator,'sendBeacon',{value:()=>false,writable:false,configurable:false});}catch{}
 try{Object.defineProperty(navigator,'credentials',{value:Object.freeze({get:denied,create:denied}),writable:false,configurable:false});}catch{}
}
// This fixed host projection is the only page script exported by this port.
function inspectDocument(){
 const sensitive=document.querySelector('input[type="password"],input[autocomplete="username"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[src*="recaptcha"],[data-sitekey],[data-private],[data-sensitive]');
 const headings=Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).slice(0,30).map(e=>e.innerText||'').join(' ');
 const auth=!!sensitive||/\b(?:sign in|log in|login|verify (?:your )?identity|two.factor authentication|enter (?:your )?(?:password|verification code|passcode)|captcha|multi.factor authentication)\b/i.test(headings);
 const text=(document.body?.innerText||'').slice(0,24000),title=(document.title||'').slice(0,300);
 const links=Array.from(document.querySelectorAll('a[href]')).slice(0,100).map(e=>({text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,160),url:e.href}));
 const forms=Array.from(document.querySelectorAll('form')).slice(0,10).map(f=>({action:f.action,method:(f.method||'GET').toUpperCase(),fields:Array.from(f.querySelectorAll('input,select,textarea')).slice(0,10).map(e=>({name:e.name,type:e.type||e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')||e.placeholder||e.name||'').slice(0,100),autocomplete:e.autocomplete||''}))}));
 return {auth,text,title,links,forms,url:location.href};
}
function inspectAccountDocument(){
 const headings=Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).slice(0,20).map(e=>e.innerText||'').join(' ').slice(0,1000);
 const takeover=!!document.querySelector('input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[src*="recaptcha"],[data-sitekey]')||/\b(?:verify (?:your )?identity|two.factor authentication|verification code|passcode|captcha|multi.factor authentication)\b/i.test(headings);
 const forms=Array.from(document.querySelectorAll('form')).slice(0,5).map(f=>{const semantics=headings+' '+Array.from(f.querySelectorAll('button,input[type="submit"]')).slice(0,5).map(e=>e.innerText||e.value||'').join(' ');return {action:f.action,method:(f.method||'GET').toUpperCase(),existing_login:/\b(?:sign in|log in|login|welcome back|access (?:your )?account)\b/i.test(semantics),registration:/\b(?:sign ?up|register|registration|create\s+(?:an?\s+)?account|reset\s+(?:your\s+)?password|forgot(?:ten)?\s+(?:your\s+)?password|change\s+(?:your\s+)?password|new\s+account)\b/i.test(semantics)||!!f.querySelector('input[autocomplete="new-password"]'),fields:Array.from(f.querySelectorAll('input,select,textarea')).slice(0,15).map(e=>({name:e.name,type:e.type||e.tagName.toLowerCase(),autocomplete:e.autocomplete||'',value:e.type==='hidden'?e.value:''}))};});
 const links=Array.from(document.querySelectorAll('nav a[href],[role="navigation"] a[href],aside a[href],header a[href]')).slice(0,60).map(e=>({text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,120),url:e.href}));
 const auth=!!document.querySelector('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]');
 return {url:location.href,takeover,auth,forms,links};
}
class ResearchBrowser{
 constructor({scope,evidenceDir,signal,onEvent=()=>{},network,playwright,approve,accountAuthorization,resolveCredential,testing}={}){
  if(testing&&process.env.NODE_ENV!=='test'||playwright&&process.env.NODE_ENV!=='test'||network&&!(network instanceof ResearchNetwork)&&process.env.NODE_ENV!=='test')throw error('test_browser_denied');
  this.lifecycle=new AbortController();this.signal=signal?AbortSignal.any([signal,this.lifecycle.signal]):this.lifecycle.signal;
  this.network=network||new ResearchNetwork({scope,signal:this.signal,testing});this.policy=new ResearchNetwork({scope,signal:this.signal,testing});
  this.scope=structuredClone(scope);this.onEvent=onEvent;this.playwright=playwright;this.approve=approve;this.resolveCredential=resolveCredential;this.accountAuthorization=null;this.accountHandle=null;this.loginForms=new Map();this.redactions=[];this.authenticated=false;this.takeover=false;this.privateNavigations=new Set();
  if(accountAuthorization){exact(accountAuthorization,['id','origin','login_url','username_reference','password_reference','confirmed','purpose']);const a=accountAuthorization;if(scope.useVault!==true||a.confirmed!==true||a.purpose!=='competitor_product_research'||![a.id,a.username_reference,a.password_reference].every(v=>UUID.test(v||''))||a.username_reference===a.password_reference||!this.policy.origins.has(a.origin)||typeof resolveCredential!=='function'||typeof this.network.openAccount!=='function')throw error('sealed_account_authorization_required');this.network.accountURL(a.login_url,a.origin);this.accountAuthorization=Object.freeze(structuredClone(a));}
  privateDirectory(evidenceDir,true);this.evidenceDir=fs.realpathSync(evidenceDir);this.maxActions=scope.maxActions??30;
  if(!bounded(this.maxActions,1,100))throw error('action_bound');
  this.actions=0;this.server=null;this.browser=null;this.context=null;this.page=null;this.proxy=null;this.links=new Map();this.forms=new Map();this.closed=false;this.blocked=false;this.privateMode=false;this.active=false;this.closePromise=null;this.startPromise=null;this.viewport={width:1280,height:800};this.abort=()=>{this.close().catch(()=>{});};this.signal.addEventListener('abort',this.abort,{once:true});
 }
 event(type,extra={}){try{this.onEvent({type,at:Date.now(),authority:false,...extra});}catch{throw error('audit_unavailable');}}
 ownedProcessId(){const value=this.server?.process()?.pid;return !this.closed&&Number.isSafeInteger(value)&&value>0?value:null;}
 ensure(){if(this.closed||this.signal?.aborted)throw error('cancelled');if(this.blocked)throw error('authentication_or_sensitive_content');}
 async start(){this.ensure();if(!this.startPromise)this.startPromise=this.open();return this.startPromise;}
 async open(){
  this.ensure();
  // Browser-native traffic has no upstream: this owned loopback proxy refuses
  // both normal HTTP and CONNECT, including requests outside page routing.
  this.proxy=http.createServer((_req,res)=>{res.writeHead(403);res.end();});this.proxy.on('connect',(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));this.proxy.on('upgrade',(_req,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{this.proxy.once('error',reject);this.proxy.listen(0,'127.0.0.1',resolve);});
  const pw=this.playwright||require('playwright-core');
  if(require('playwright-core/package.json').version!=='1.64.0')throw error('engine_version_unqualified');
  this.server=await pw.chromium.launchServer({channel:'chrome',chromiumSandbox:true,headless:true,host:'127.0.0.1',timeout:15000,env:{PATH:'/usr/bin:/bin',TMPDIR:require('node:os').tmpdir(),LANG:'en_US.UTF-8'},proxy:{server:'http://127.0.0.1:'+this.proxy.address().port,bypass:'<-loopback>'},args:['--disable-background-networking','--disable-component-update','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-features=WebTransport,MediaRouter']});
  if(this.signal?.aborted||this.closed){await this.server.close();throw error('cancelled');}
  this.browser=await pw.chromium.connect(this.server.wsEndpoint());
  this.ensure();
  this.context=await this.browser.newContext({viewport:this.viewport,javaScriptEnabled:true,serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:false});
  this.ensure();
  this.context.setDefaultTimeout(5000);this.context.setDefaultNavigationTimeout(15000);
  await this.context.addInitScript(restrictPage);
  await this.context.routeWebSocket('**/*',socket=>socket.close());
  await this.context.route('**/*',async route=>{
   try{
    this.ensure();const request=route.request(),url=this.validateURL(request.url(),request.method());
    if(request.postData())throw error('body_denied');
    if(request.isNavigationRequest()&&request.frame().parentFrame())throw error('embedded_navigation_denied');
    if(this.privateMode){const target=new URL(url);if(request.isNavigationRequest()){if(!this.privateNavigations.has(url))throw error('host_account_navigation_required');}else{
     const kind=request.resourceType?.(),allowed={stylesheet:/\.css$/i,script:/\.(?:js|mjs)$/i,image:/\.(?:png|jpe?g|webp|gif|svg|ico)$/i,font:/\.(?:woff2?|ttf|otf)$/i};
     if(target.search||!allowed[kind]?.test(target.pathname)||! /^\/(?:assets|static|css|js|images|img|fonts|_next\/static)\//.test(target.pathname))throw error('private_dynamic_request_denied');
    }}
    let ancestor=request.redirectedFrom?.(),redirects=0;while(ancestor){if(++redirects>3)throw error('redirect_denied');ancestor=ancestor.redirectedFrom?.();}
    const result=this.privateMode?await this.network.accountPage({handle:this.accountHandle,url,method:request.method(),signal:this.signal,followRedirects:false}):await this.network.fetch({url,method:request.method(),signal:this.signal,followRedirects:false});
    this.validateURL(result.url,request.method());
    if(this.privateMode&&request.isNavigationRequest()&&result.location)this.privateNavigations.add(this.validateURL(result.location));
    await route.fulfill({status:result.status,headers:{'content-type':result.contentType,'cache-control':'no-store','x-content-type-options':'nosniff',...(result.location?{location:this.validateURL(result.location)}:{})},body:result.body});
   }catch(e){try{await route.abort('blockedbyclient');}catch{}this.event('research.network_denied',{reason:/^[a-z_]+$/.test(e?.code||'')?e.code:'transport_unavailable'});}
  });
  this.context.on('page',page=>{if(this.page&&page!==this.page)page.close().catch(()=>{});});
  this.page=await this.context.newPage();this.page.on('download',download=>download.cancel().catch(()=>{}));this.page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
  this.page.on('framenavigated',frame=>{if(frame!==this.page.mainFrame())return;const value=frame.url();if(value==='about:blank')return;try{this.validateURL(value);}catch{this.blocked=true;this.page.close().catch(()=>{});}});
  this.event('research.browser_started',{private_context:true,credentials_available:false,network:'pinned_public_host'});
 }
 validateURL(url,method='GET'){if(!['GET','HEAD'].includes(method))throw error('method_denied');return this.privateMode?this.network.accountURL(url,this.accountAuthorization.origin):this.policy.validate(url,method);}
 async qualify(){try{await this.start();this.ensure();return {available:true,engine:'playwright-core',version:require('playwright-core/package.json').version,context:'owned_fresh',network:'pinned_public_host',authority:false,termination:'owned_until_close'};}catch(e){let termination='verified';try{await this.close();}catch{termination='unverified';}return {available:false,reason:/^[a-z_]+$/.test(e?.code||'')?e.code:'browser_unavailable',authority:false,termination};}}
 async navigate(url){
  if(this.accountAuthorization&&!this.privateMode){if(url!==this.accountAuthorization.login_url)throw error('sealed_login_url_required');this.accountHandle=this.network.openAccount({origin:this.accountAuthorization.origin,loginUrl:url});this.privateMode=true;}
  if(this.privateMode&&this.takeover)throw error('human_takeover_required');
  const safe=this.validateURL(url);if(this.privateMode){this.privateNavigations.clear();this.privateNavigations.add(safe);}await this.start();this.links.clear();this.forms.clear();this.loginForms.clear();
  try{await this.page.goto(safe,{waitUntil:'domcontentloaded'});await this.page.waitForTimeout(100);}catch{this.ensure();throw error('navigation_unavailable');}
  const current=this.validateURL(this.page.url());if(current!==safe){this.validateURL(current);}
  const inspection=await this.inspect();if(inspection.state==='blocked')return inspection;
  if(this.privateMode&&!this.authenticated)return inspection;
  this.event('research.navigated',{origin:new URL(current).origin});return {state:'navigated',url:this.privateMode?this.accountAuthorization.origin+'/':current,private_context:this.privateMode,classification:'observed',untrusted:true,authority:false};
 }
 async project(inspector){
  this.ensure();if(!this.page||this.page.url()==='about:blank')throw error('navigation_required');
  let row,session;try{
   // A separate browser world preserves native DOM readers even if a page
   // replaces main-world querySelector/innerText to hide credential controls.
   session=await this.context.newCDPSession(this.page);const tree=await session.send('Page.getFrameTree');const world=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'AirodromPublicResearchInspector',grantUniveralAccess:false});
   const result=await session.send('Runtime.evaluate',{expression:'('+inspector.toString()+')()',contextId:world.executionContextId,returnByValue:true,awaitPromise:true});if(result.exceptionDetails||!result.result?.value)throw error('page_unavailable');row=result.result.value;
  }catch{throw error('page_unavailable');}finally{await session?.detach().catch(()=>{});}
  return row;
 }
 async inspect(){
  if(this.privateMode)return this.inspectAccount();const row=await this.project(inspectDocument);
  const url=this.policy.validate(row.url);const text=clean(row.text),title=clean(row.title);
  if(row.auth||unsafeEvidenceText(row.text)||unsafeEvidenceText(row.title)){
   this.blocked=true;this.links.clear();this.forms.clear();this.event('research.page_blocked',{reason:'authentication_or_sensitive_content'});await this.page.close().catch(()=>{});
   return this.receipt({id:randomUUID(),state:'blocked',reason:'authentication_or_sensitive_content',classification:'inaccessible',url,title:'',text:'',content:'',sha256:sha(''),untrusted:true,authority:false,captured_at:Date.now()});
  }
  return {...row,url,text,title};
 }
 async inspectAccount(){
  const row=await this.project(inspectAccountDocument),url=this.validateURL(row.url),origin=this.accountAuthorization.origin;
  if(row.takeover){this.takeover=true;this.loginForms.clear();return this.receipt({id:randomUUID(),state:'human_takeover_required',reason:'authentication_or_sensitive_content',classification:'inaccessible',private_context:true,url:origin+'/',source_url_sha256:sha(url),title:'',text:'',content:'',sha256:sha(''),untrusted:true,authority:false,captured_at:Date.now()});}
  if(!this.authenticated){
   const forms=[];this.loginForms.clear();for(const form of row.forms||[])try{
    if(form.method!=='POST'||form.existing_login!==true||form.registration!==false||!Array.isArray(form.fields)||form.fields.length>15)continue;const action=this.network.accountURL(form.action,origin),passwords=form.fields.filter(f=>f.type==='password'&&f.autocomplete!=='new-password'),usernames=form.fields.filter(f=>['text','email'].includes(f.type)&&(f.autocomplete==='username'||/^(?:username|user|email|login|identifier)$/i.test(f.name)));
    if(passwords.length!==1||usernames.length!==1||form.fields.some(f=>!['text','email','password','hidden','submit','button'].includes(f.type))||form.fields.filter(f=>['text','email','password'].includes(f.type)).length!==2||form.fields.some(f=>f.autocomplete==='new-password'))continue;
    const name=n=>typeof n==='string'&&/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(n);if(!name(usernames[0].name)||!name(passwords[0].name))continue;const hiddenFields=form.fields.filter(f=>f.type==='hidden').map(f=>({name:f.name,value:f.value}));if(hiddenFields.length>8||hiddenFields.some(f=>!name(f.name)||! /(?:csrf|xsrf|authenticity|verification.?token|nonce)|^(?:utf8|token)$/i.test(f.name)||typeof f.value!=='string'||f.value.length>4096||/[\x00-\x1f\x7f]/.test(f.value)))continue;
    const id=randomUUID();this.loginForms.set(id,{action,usernameName:usernames[0].name,passwordName:passwords[0].name,hiddenFields,source:url});forms.push({id,fields:[{id:randomUUID(),type:'username'},{id:randomUUID(),type:'password'}]});
   }catch{}
   return this.receipt({id:randomUUID(),state:'authentication_required',reason:'authentication_or_sensitive_content',classification:'inaccessible',private_context:true,url:origin+'/',source_url_sha256:sha(url),title:'',text:'',content:'',sha256:sha(''),login_forms:forms,untrusted:true,authority:false,captured_at:Date.now()});
  }
  if(row.auth)throw error('authentication_unavailable');const categories=[],links=[];this.links.clear();
  for(const link of row.links||[]){let label=clean(link.text).toLowerCase().trim();for(const value of this.redactions){const exactValue=value.toString('utf8');if(exactValue)label=label.split(exactValue.toLowerCase()).join('[redacted]');}
   if(secretLike(label)||!PRIVATE_CATEGORIES.includes(label))continue;try{const destination=this.network.accountURL(link.url,origin);if(/(?:^|\/)(?:logout|signout|delete|remove|destroy|unsubscribe|connect|authorize)(?:\/|$)/i.test(new URL(destination).pathname))continue;const id=randomUUID();this.links.set(id,{id,url:destination,category:label});links.push({id,category:label});if(!categories.includes(label))categories.push(label);}catch{}
  }
  return {url:origin+'/',source_url_sha256:sha(url),private_context:true,title:'Authorized account navigation',text:'Verified account navigation categories: '+categories.join(', '),categories,links,forms:[]};
 }
 async snapshot({screenshot=false}={}){
  if(this.privateMode&&screenshot)throw error('private_screenshot_denied');const row=await this.inspect();if(row.classification==='inaccessible')return row;
  if(this.privateMode){const text=row.text;return this.receipt({id:randomUUID(),...row,content:text,sha256:sha(text),classification:'observed',untrusted:true,authority:false,viewport:{...this.viewport},captured_at:Date.now()});}
  this.links.clear();this.forms.clear();const links=[],forms=[];
  for(const link of row.links){try{const url=this.policy.validate(link.url);if(unsafeEvidenceText(link.text))continue;const id=randomUUID(),entry={id,text:clean(link.text),url};this.links.set(id,entry);links.push(entry);}catch{}}
  for(const form of row.forms){
   try{
    const action=this.policy.validate(form.action);if(form.method!=='GET'||!form.fields.length||form.fields.some(f=>!['search','text'].includes(f.type)||!['q','query','search'].includes(f.name)||f.autocomplete&&f.autocomplete!=='off'||secretLike(f.label)))continue;
    const id=randomUUID(),fields=form.fields.map(f=>({id:randomUUID(),label:clean(f.label),type:f.type,name:f.name}));this.forms.set(id,{action,fields});forms.push({id,action,fields:fields.map(({name,...field})=>field)});
   }catch{}
  }
  const id=randomUUID(),record={id,url:row.url,title:row.title,text:row.text,content:row.text,sha256:sha(row.text),classification:'observed',untrusted:true,authority:false,links,forms,viewport:{...this.viewport},captured_at:Date.now()};
  if(screenshot){
   // Capture only after the same fixed projection denies sensitive pages. A
   // host stylesheet suppresses all inputs to prevent accidental typed data.
   let style;try{style=await this.page.addStyleTag({content:'input,textarea,select,[contenteditable],iframe{visibility:hidden!important}'});const bytes=await this.page.screenshot({type:'png',fullPage:false,animations:'disabled',caret:'hide',timeout:5000});if(!Buffer.isBuffer(bytes)||bytes.length>MAX_EVIDENCE)throw error('screenshot_bound');const after=await this.inspect();if(after.state==='blocked')return after;
    const filename=id+'.png';this.write(filename,bytes);record.screenshot_ref={id,path:path.join(this.evidenceDir,filename),sha256:sha(bytes),mimeType:'image/png'};
   }finally{await style?.evaluate(element=>element.remove()).catch(()=>{});}
  }
  return this.receipt(record);
 }
 receipt(record){const filename=record.id+'.json',bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>MAX_EVIDENCE)throw error('evidence_bound');this.write(filename,bytes);record.evidence_ref={id:record.id,path:path.join(this.evidenceDir,filename),sha256:sha(bytes)};this.event('research.evidence_captured',{id:record.id,classification:record.classification});return record;}
 write(filename,bytes){const file=path.join(this.evidenceDir,filename),fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 read(reference,extension){
  if(!reference||!UUID.test(reference.id||'')||reference.path!==path.join(this.evidenceDir,reference.id+extension))throw error('evidence_scope_denied');
  const fd=fs.openSync(reference.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||stat.mode&0o077||stat.size>MAX_EVIDENCE)throw error('evidence_integrity_denied');const bytes=fs.readFileSync(fd);if(sha(bytes)!==reference.sha256)throw error('evidence_integrity_denied');return bytes;}finally{fs.closeSync(fd);}
 }
 verify(row){return verifyEvidence(row,{evidenceDir:this.evidenceDir,scope:this.scope,testing:this.policy.fixture?{allowLoopback:true}:undefined});}
 async approved(action,purpose,url,hostBinding={}){
  if(!UUID.test(action.approval_id||'')||typeof this.approve!=='function')throw error('explicit_host_approval_required');
  const accepted=await this.approve({approval_id:action.approval_id,purpose,origin:new URL(url).origin,...hostBinding,action:structuredClone(action)});if(accepted!==true)throw error('explicit_host_approval_required');this.ensure();
 }
 async execute(action){
  this.ensure();exact(action,['type','url','link_id','dy','width','height','form_id','fields','approval_id','username_reference','password_reference']);if(this.active)throw error('action_busy');if(++this.actions>this.maxActions)throw error('action_bound');this.active=true;
  try{
   if(action.type==='navigate'){exact(action,['type','url']);return await this.navigate(action.url);}
   if(action.type==='click'){exact(action,['type','link_id']);const link=this.links.get(action.link_id);if(!link)throw error('current_link_required');return await this.navigate(link.url);}
   if(action.type==='snapshot'){exact(action,['type']);return await this.snapshot();}
   if(action.type==='screenshot'){exact(action,['type']);return await this.snapshot({screenshot:true});}
   if(action.type==='viewport'){exact(action,['type','width','height']);if(!bounded(action.width,320,1920)||!bounded(action.height,400,1200))throw error('viewport_bound');await this.start();this.viewport={width:action.width,height:action.height};await this.page.setViewportSize(this.viewport);return {state:'viewport',...this.viewport,authority:false};}
   if(action.type==='scroll'){exact(action,['type','dy']);if(!bounded(action.dy,-1600,1600))throw error('scroll_bound');const row=await this.inspect();if(row.state==='blocked')return row;await this.page.evaluate(dy=>window.scrollBy({top:dy,behavior:'instant'}),action.dy);return {state:'scrolled',authority:false};}
   if(action.type==='form'){
    if(this.privateMode)throw error('private_form_unavailable');
    exact(action,['type','form_id','fields','approval_id']);const checked=await this.inspect();if(checked.state==='blocked')return checked;const form=this.forms.get(action.form_id);if(!form||!action.fields||typeof action.fields!=='object'||Array.isArray(action.fields)||!Object.keys(action.fields).length||Object.keys(action.fields).length>3)throw error('current_public_form_required');
    const url=new URL(form.action);for(const [id,value]of Object.entries(action.fields)){const field=form.fields.find(f=>f.id===id);if(!field||typeof value!=='string'||!value.trim()||value.length>100||secretLike(value)||/[\r\n\x00-\x1f]/.test(value))throw error('credential_or_invalid_form');url.searchParams.set(field.name,value);}
    const destination=this.policy.validate(url.href);await this.approved(action,'public_get_form',destination);return await this.navigate(destination);
   }
   if(action.type==='download'){
    if(this.privateMode)throw error('private_download_denied');
    exact(action,['type','url','approval_id']);if(this.scope.allowDownloads!==true)throw error('downloads_not_in_scope');const url=this.policy.validate(action.url);await this.approved(action,'public_download',url);const result=await this.network.fetch({url,signal:this.signal,download:true});this.ensure();this.policy.validate(result.url);if(!Buffer.isBuffer(result.body)||result.body.length>MAX_DOWNLOAD_BYTES)throw error('download_bound');const text=result.body.toString('utf8');if(!['text/plain','text/csv','application/json'].includes(result.contentType)||Buffer.from(text).compare(result.body)!==0||unsafeEvidenceText(text))throw error('credential_download_denied');const id=randomUUID(),filename=id+'.download';this.write(filename,result.body);return this.receipt({state:'downloaded',id,url:result.url,title:'Public text download',text,content:text,sha256:sha(text),classification:'observed',untrusted:true,authority:false,links:[],forms:[],captured_at:Date.now(),download_ref:{id,path:path.join(this.evidenceDir,filename),sha256:sha(result.body),mimeType:result.contentType}});
   }
   if(action.type==='authenticate'){
    exact(action,['type','form_id','username_reference','password_reference','approval_id']);
    const a=this.accountAuthorization;if(this.scope.useVault!==true||!a||!this.privateMode||this.authenticated||this.takeover||typeof this.resolveCredential!=='function')throw error('authentication_unavailable');
    if(!UUID.test(action.form_id||'')||!UUID.test(action.username_reference||'')||!UUID.test(action.password_reference||''))throw error('opaque_credential_references_required');
    if(action.username_reference!==a.username_reference||action.password_reference!==a.password_reference||action.approval_id!==a.id)throw error('sealed_account_references_required');
    const form=this.loginForms.get(action.form_id);if(!form||this.validateURL(this.page.url())!==form.source)throw error('current_login_form_required');const current=await this.project(inspectAccountDocument);if(current.takeover)return this.inspectAccount();
    const actual=current.forms.find(f=>f.method==='POST'&&f.action===form.action&&f.existing_login===true&&f.registration===false&&f.fields.every(v=>['text','email','password','hidden','submit','button'].includes(v.type))&&f.fields.filter(v=>['text','email','password'].includes(v.type)).length===2&&f.fields.some(v=>v.name===form.usernameName&&['text','email'].includes(v.type))&&f.fields.some(v=>v.name===form.passwordName&&v.type==='password'&&v.autocomplete!=='new-password')&&require('node:util').isDeepStrictEqual(f.fields.filter(v=>v.type==='hidden').map(v=>({name:v.name,value:v.value})),form.hiddenFields));if(!actual)throw error('current_login_form_required');
    const grant=Object.freeze({id:a.id,origin:a.origin,purpose:'account_login',submission_url:form.action,form_id:action.form_id,approval_id:action.approval_id,username_reference:a.username_reference,password_reference:a.password_reference});
    await this.approved(action,'account_login',form.action,{form_id:action.form_id,submission_url:form.action});
    let username,password;try{
     username=await this.resolveCredential(a.username_reference,grant);this.ensure();password=await this.resolveCredential(a.password_reference,grant);this.ensure();
     const secure=value=>{if(!Buffer.isBuffer(value)&&typeof value!=='string')throw error('secure_value_invalid');const bytes=Buffer.from(value);if(!bytes.length||bytes.length>4096||/[\x00-\x1f\x7f]/.test(bytes.toString('utf8')))throw error('secure_value_invalid');return bytes;};
     this.redactions=[secure(username),secure(password)];this.links.clear();this.forms.clear();this.loginForms.clear();
     const result=await this.network.authenticateAccount({handle:this.accountHandle,submissionUrl:form.action,usernameName:form.usernameName,passwordName:form.passwordName,hiddenFields:form.hiddenFields,username:Buffer.from(this.redactions[0]),password:Buffer.from(this.redactions[1]),signal:this.signal});this.ensure();
     const target=this.validateURL(result.url);result.body.fill(0);this.privateNavigations.clear();this.privateNavigations.add(target);await this.page.goto(target,{waitUntil:'domcontentloaded'});await this.page.waitForTimeout(100);this.ensure();const observed=await this.project(inspectAccountDocument);if(observed.takeover)return this.inspectAccount();
     if(observed.auth||!observed.links.some(link=>/^(?:log out|logout|sign out|signout)$/i.test(clean(link.text).trim()))||!this.network.accountSession(this.accountHandle).cookies.size)throw error('authentication_unavailable');
     this.authenticated=true;this.event('research.account_authenticated',{origin:a.origin});return {state:'authenticated',private_context:true,screenshots_disabled:true,authority:false};
    }finally{if(Buffer.isBuffer(username))username.fill(0);if(Buffer.isBuffer(password))password.fill(0);username=null;password=null;form.hiddenFields.length=0;}
   }
   // Arbitrary scripts, credential values, cookie APIs and untyped interactions
   // are intentionally absent from the model-facing action surface.
   throw error('unsupported_typed_action');
  }catch(e){throw error(/^[a-z_]+$/.test(e?.code||'')?e.code:'browser_operation_unavailable');}
  finally{this.active=false;}
 }
 async close(){
  if(this.closePromise)return this.closePromise;this.closed=true;this.signal?.removeEventListener('abort',this.abort);this.lifecycle.abort();
  this.closePromise=(async()=>{
   await this.startPromise?.catch(()=>{});let verified=true;
   try{await this.context?.close();}catch{}try{await this.browser?.close();}catch{}try{await this.server?.close();}catch{verified=false;}
   const child=this.server?.process();if(child&&child.exitCode===null&&child.signalCode===null)verified=false;
   if(this.proxy)await new Promise(resolve=>{this.proxy.closeAllConnections();this.proxy.close(resolve);});this.links.clear();this.forms.clear();this.loginForms.clear();this.privateNavigations.clear();for(const value of this.redactions)value.fill(0);this.redactions.length=0;this.network.closeAccount?.();
   this.event('research.browser_closed',{termination_verified:verified});if(!verified)throw error('termination_unverified');return {closed:true,termination_verified:true,owned_process_termination:'verified'};
  })();return this.closePromise;
 }
}
function verifyEvidence(row,{evidenceDir,scope,testing}={}){try{
 privateDirectory(evidenceDir);const root=fs.realpathSync(evidenceDir);
 const read=(reference,extension)=>{if(!reference||!UUID.test(reference.id||'')||reference.path!==path.join(root,reference.id+extension))throw error('evidence_scope_denied');const fd=fs.openSync(reference.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||stat.mode&0o077||stat.size>MAX_EVIDENCE)throw error('evidence_integrity_denied');const bytes=fs.readFileSync(fd);if(sha(bytes)!==reference.sha256)throw error('evidence_integrity_denied');return bytes;}finally{fs.closeSync(fd);}};
 const stored=JSON.parse(read(row.evidence_ref,'.json'));new ResearchNetwork({scope:scope||{origins:[new URL(stored.url).origin]},testing}).validate(stored.url);
 const {evidence_ref,...projection}=row;if(!require('node:util').isDeepStrictEqual(stored,projection))return false;
 if(stored.id!==row.id||stored.url!==row.url||stored.text!==row.text||stored.content!==row.text||typeof row.text!=='string'||stored.sha256!==sha(row.text)||row.sha256!==stored.sha256||!['observed','inaccessible'].includes(stored.classification)||stored.classification!==row.classification||stored.authority!==false||stored.untrusted!==true||unsafeEvidenceText(stored.text)||unsafeEvidenceText(stored.title)||stored.title!==row.title)return false;
 if(stored.classification==='inaccessible'&&(!['blocked','authentication_required','human_takeover_required'].includes(stored.state)||stored.reason!=='authentication_or_sensitive_content'||stored.text||row.reason!==stored.reason))return false;
 if(stored.private_context){
  if(stored.url!==new URL(stored.url).origin+'/'||! /^[a-f0-9]{64}$/.test(stored.source_url_sha256||'')||stored.screenshot_ref)return false;
  if(stored.classification==='observed'){
   if(stored.title!=='Authorized account navigation'||!Array.isArray(stored.categories)||stored.categories.length>PRIVATE_CATEGORIES.length||new Set(stored.categories).size!==stored.categories.length||stored.categories.some(v=>!PRIVATE_CATEGORIES.includes(v))||stored.text!=='Verified account navigation categories: '+stored.categories.join(', ')||!Array.isArray(stored.forms)||stored.forms.length||!Array.isArray(stored.links)||stored.links.some(l=>Object.keys(l).some(k=>!['id','category'].includes(k))||!UUID.test(l.id||'')||!stored.categories.includes(l.category)))return false;
  }else if(stored.login_forms&&(stored.state!=='authentication_required'||!Array.isArray(stored.login_forms)||stored.login_forms.length>5||stored.login_forms.some(f=>Object.keys(f).some(k=>!['id','fields'].includes(k))||!UUID.test(f.id||'')||!Array.isArray(f.fields)||f.fields.length!==2||f.fields.some(v=>Object.keys(v).some(k=>!['id','type'].includes(k))||!UUID.test(v.id||'')||!['username','password'].includes(v.type)))))return false;
 }
 if(stored.screenshot_ref){if(JSON.stringify(stored.screenshot_ref)!==JSON.stringify(row.screenshot_ref))return false;read(stored.screenshot_ref,'.png');}else if(row.screenshot_ref)return false;
 if(stored.download_ref){if(stored.private_context||stored.state!=='downloaded'||stored.title!=='Public text download'||!['text/plain','text/csv','application/json'].includes(stored.download_ref.mimeType))return false;const bytes=read(stored.download_ref,'.download');if(bytes.length>MAX_DOWNLOAD_BYTES||bytes.toString('utf8')!==stored.text||Buffer.from(stored.text).compare(bytes)!==0)return false;}else if(row.download_ref)return false;
 return true;
 }catch{return false;}}
module.exports={ResearchBrowser,verifyEvidence,inspectDocument,inspectAccountDocument,restrictPage};
