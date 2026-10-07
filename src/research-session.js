'use strict';
// ADR 0015: browser-owned session storage; no cookie/header/body/storage export.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net'),dns=require('node:dns/promises');
const {randomUUID,createHash}=require('node:crypto');
const {ResearchBrowser,restrictPage}=require('./research-browser');
const {safeOrigin,publicAddress,error}=require('./research-network');
const {privateDirectory}=require('./local-bootstrap');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash=v=>createHash('sha256').update(v).digest('hex');
const ROUTES=Object.freeze({'/':'dashboard','/dashboard':'dashboard','/overview':'dashboard','/transactions':'transactions','/accounts':'accounts','/budgets':'budgets','/budget':'budgets','/cash-flow':'cashflow','/cashflow':'cashflow','/reports':'reports','/recurring':'recurring','/goals':'goals','/insights':'insights'});
const LOGIN=/^\/(?:login|signin|sign-in|auth\/(?:login|signin|session|verify|mfa)|api\/auth\/(?:login|signin|session|verify|mfa))\/?$/i;
const ASSET=/^\/(?:assets|static|css|js|images|img|fonts|_next\/static)\/[A-Za-z0-9_./-]+\.(?:css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i;
const READ_API=/^\/(?:api\/)?(?:transactions|accounts|budgets|cashflow|reports|recurring|goals|insights)\/?$/;
function authorization(a,scope){
 if(!a||Object.keys(a).some(k=>!['id','origin','login_url','confirmed','purpose','mode'].includes(k))||!UUID.test(a.id||'')||a.confirmed!==true||a.purpose!=='competitor_product_research'||a.mode!=='dedicated_manual'||scope.usePersistentProfile!==true||scope.useVault||scope.allowDownloads!==false||scope.origins.length!==1||a.origin!==scope.origins[0]||new URL(a.login_url).origin!==a.origin)throw error('sealed_session_authorization_required');
 safeOrigin(a.origin);return Object.freeze(structuredClone(a));
}
function validateProfileTree(dir,{privateModes=true}={}){
 let nodes=0;
 const visit=(file,depth)=>{
  if(++nodes>100000||depth>64)throw error('profile_metadata_bound');
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||stat.uid!==process.getuid?.()||!stat.isDirectory()&&!stat.isFile()||stat.isFile()&&stat.nlink!==1||privateModes&&stat.mode&0o077)throw error('profile_integrity_denied');
  if(stat.isDirectory())for(const name of fs.readdirSync(file))visit(path.join(file,name),depth+1);
 };
 visit(dir,0);
}
function profile(root,origin){
 // No caller-selected paths. Inspect metadata only, never browser secret files.
 privateDirectory(root);const base=privateDirectory(path.join(root,'browser-profiles'),true),dir=privateDirectory(path.join(base,hash(origin)),true),lock=path.join(dir,'.airodrom-owner');
 const fd=fs.openSync(lock,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let identity;
 try{identity=fs.fstatSync(fd);validateProfileTree(dir);}finally{fs.closeSync(fd);}
 // Integrity failure retains the owner lease as quarantine. Never repair,
 // follow or delete suspect browser files, and never launch Chrome into them.
 return {dir,release:()=>{const current=fs.lstatSync(lock);if(!current.isFile()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||current.uid!==identity.uid||current.nlink!==1||current.mode&0o077)throw error('profile_owner_lease_changed');fs.unlinkSync(lock);}};
}
function harden(dir){
 validateProfileTree(dir,{privateModes:false});
 for(const row of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,row.name),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.isFile()&&stat.nlink!==1)throw error('profile_integrity_denied');
  if(stat.isDirectory()){fs.chmodSync(file,0o700);harden(file);}else if(stat.isFile())fs.chmodSync(file,0o600);else throw error('profile_integrity_denied');
 }
 fs.chmodSync(dir,0o700);
}
function allowedURL(value,{origin,phase='inspect',method='GET',kind='document',navigation=false}={}){
 if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f\\]|%/i.test(value))throw error('session_url_denied');
 const u=new URL(value);if(u.origin!==origin||u.username||u.password||u.search||u.hash)throw error('session_origin_or_query_denied');
 const route=Object.hasOwn(ROUTES,u.pathname),login=LOGIN.test(u.pathname);
 if(!['GET','HEAD'].includes(method)&&!(phase==='login'&&method==='POST'&&login))throw error('session_mutation_denied');
 if(navigation){if(!route&&!(phase==='login'&&login))throw error('session_navigation_denied');}
 else if(!route&&!ASSET.test(u.pathname)&&!READ_API.test(u.pathname)&&!(phase==='login'&&login))throw error('session_endpoint_denied');
 if(!['GET','HEAD'].includes(method)&&!login)throw error('session_mutation_denied');
 if(['websocket','eventsource','other'].includes(kind))throw error('session_transport_denied');
 return u.href;
}
// Only constants and booleans leave the DOM. No text, URLs, form values, account
// identifiers, ledger rows, balances, headers, bodies or storage are projected.
function inspectSessionDocument(){
 const labels={'overview':'dashboard','dashboard':'dashboard','transactions':'transactions','accounts':'accounts','budget':'budgets','budgets':'budgets','cash flow':'cashflow','cashflow':'cashflow','reports':'reports','recurring':'recurring','goals':'goals','insights':'insights','settings':'settings'};
 const routes={'/':'dashboard','/dashboard':'dashboard','/overview':'dashboard','/transactions':'transactions','/accounts':'accounts','/budgets':'budgets','/budget':'budgets','/cash-flow':'cashflow','/cashflow':'cashflow','/reports':'reports','/recurring':'recurring','/goals':'goals','/insights':'insights'};
 const headings=Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).slice(0,20).map(e=>e.innerText||'').join(' ');
 const takeover=!!document.querySelector('input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[src*="recaptcha"],[data-sitekey]')||/\b(?:captcha|verification code|passcode|verify (?:your )?identity|two.factor|multi.factor)\b/i.test(headings);
 const auth=!!document.querySelector('input[type="password"],input[autocomplete="current-password"]')||/\b(?:sign in|log in|login)\b/i.test(headings);
 const categories=[],links=[];
 for(const e of Array.from(document.querySelectorAll('nav a[href],[role="navigation"] a[href],aside a[href],header a[href]')).slice(0,100)){
  const category=labels[(e.innerText||e.getAttribute('aria-label')||'').trim().toLowerCase()];if(!category)continue;
  let u;try{u=new URL(e.href);}catch{continue;}
  if(u.origin!==location.origin||u.username||u.password||u.search||u.hash)continue;
  if(!categories.includes(category))categories.push(category);
  if(routes[u.pathname]===category)links.push({category,route:u.pathname});
 }
 return {auth,takeover,categories,links};
}
class SessionBrowser extends ResearchBrowser{
 constructor(options){
  super(options);this.session=authorization(options.sessionAuthorization,options.scope);this.accountAuthorization=this.session;this.privateMode=true;this.phase='locked';this.profileRoot=options.profileRoot;this.profileLease=null;this.sockets=new Set();this.redirectGuard=null;
 }
 async open(){
  this.ensure();this.profileLease=profile(this.profileRoot,this.session.origin);
  // The proxy sees only CONNECT hostnames and encrypted TLS bytes. Chromium
  // owns TLS validation and its cookies; Airodrom never copies them to a client.
  this.proxy=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
  this.proxy.on('connect',async(req,socket,head)=>{
   this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));
   try{
    if(this.closed||this.signal.aborted||this.phase==='locked'||req.url!==new URL(this.session.origin).hostname+':443')throw error('proxy_scope_denied');
    const rows=await dns.lookup(new URL(this.session.origin).hostname,{all:true,verbatim:true});
    if(this.closed||this.signal.aborted||this.phase==='locked'||!rows.length||rows.length>32||rows.some(r=>!publicAddress(r.address,r.family)))throw error('private_dns_denied');
    const upstream=net.connect({host:rows[0].address,port:443,family:rows[0].family});this.sockets.add(upstream);upstream.on('close',()=>this.sockets.delete(upstream));upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
    upstream.setTimeout(15000,()=>upstream.destroy());socket.setTimeout(15000,()=>socket.destroy());
    upstream.once('connect',()=>{if(this.closed||this.signal.aborted||this.phase==='locked'){upstream.destroy();socket.destroy();return;}socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
   }catch{socket.destroy();}
  });
  this.proxy.on('upgrade',(_req,socket)=>socket.destroy());await new Promise((resolve,reject)=>{this.proxy.once('error',reject);this.proxy.listen(0,'127.0.0.1',resolve);});
  const pw=this.playwright||require('playwright-core');if(require('playwright-core/package.json').version!=='1.64.0')throw error('engine_version_unqualified');
  this.context=await pw.chromium.launchPersistentContext(this.profileLease.dir,{channel:'chrome',chromiumSandbox:true,headless:false,timeout:15000,viewport:this.viewport,serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:false,permissions:[],env:{PATH:'/usr/bin:/bin',TMPDIR:require('node:os').tmpdir(),LANG:'en_US.UTF-8'},proxy:{server:'http://127.0.0.1:'+this.proxy.address().port,bypass:'<-loopback>'},args:['--disable-background-networking','--disable-component-update','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-features=WebTransport,MediaRouter']});
  this.browser=this.context.browser();this.ensure();this.context.setDefaultTimeout(5000);this.context.setDefaultNavigationTimeout(15000);
  await this.context.addInitScript(restrictPage);await this.context.routeWebSocket('**/*',socket=>socket.close());
  await this.context.route('**/*',async route=>{try{
   this.ensure();const request=route.request();if(request.frame().page()!==this.page)throw error('unowned_page_denied');allowedURL(request.url(),{origin:this.session.origin,phase:this.phase,method:request.method(),kind:request.resourceType(),navigation:request.isNavigationRequest()});
   if(request.isNavigationRequest()&&request.frame().parentFrame())throw error('embedded_navigation_denied');
   // Redirected requests may bypass Playwright routing; the Response-stage CDP
   // guard below denies redirects before Chromium can follow them.
   await route.continue();
  }catch{await route.abort('blockedbyclient').catch(()=>{});this.event('research.network_denied',{reason:'session_scope_denied'});}});
  this.page=this.context.pages()[0]||await this.context.newPage();
  this.context.on('page',page=>{if(page!==this.page)page.close().catch(()=>{});});
  for(const page of this.context.pages())if(page!==this.page)await page.close();
  await this.page.goto('about:blank');
  this.redirectGuard=await this.context.newCDPSession(this.page);await this.redirectGuard.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Response'}]});
  this.redirectGuard.on('Fetch.requestPaused',event=>{
   const method=event.responseStatusCode>=300&&event.responseStatusCode<400?'Fetch.failRequest':'Fetch.continueResponse';
   this.redirectGuard.send(method,{requestId:event.requestId,...(method==='Fetch.failRequest'?{errorReason:'BlockedByClient'}:{})}).catch(()=>{this.phase='locked';for(const s of this.sockets)s.destroy();});
  });
  this.page.on('download',d=>d.cancel().catch(()=>{}));this.page.on('dialog',d=>d.dismiss().catch(()=>{}));
  this.context.on('close',()=>{if(!this.closed)this.lifecycle.abort();});this.phase='login';
  this.event('research.browser_started',{private_context:true,credentials_available:false,network:'browser_owned_scoped_tls',existing_chrome_login_inherited:false});
 }
 validateURL(value,method='GET'){return allowedURL(value,{origin:this.session.origin,phase:this.phase==='locked'?'login':this.phase,method,navigation:true});}
 async navigate(value){
  const safe=this.validateURL(value);await this.start();this.links.clear();
  try{await this.page.goto(safe,{waitUntil:'domcontentloaded'});await this.page.waitForTimeout(100);}catch{this.ensure();throw error('session_navigation_unavailable');}
  this.validateURL(this.page.url());return {state:'navigated',private_context:true,url:this.session.origin+'/',authority:false};
 }
 async inspect(){
  this.ensure();if(!this.authenticated)throw error('operator_handoff_required');this.validateURL(this.page.url());
  const row=await this.project(inspectSessionDocument);
  if(row.auth||row.takeover){this.phase='locked';this.authenticated=false;for(const s of this.sockets)s.destroy();return this.receipt({id:randomUUID(),state:'human_takeover_required',reason:'authentication_or_sensitive_content',classification:'inaccessible',private_context:true,url:this.session.origin+'/',source_url_sha256:hash(this.session.origin+'/'),title:'',text:'',content:'',sha256:hash(''),untrusted:true,authority:false,captured_at:Date.now()});}
  this.links.clear();const links=[];for(const link of row.links||[])if(Object.hasOwn(ROUTES,link.route)&&ROUTES[link.route]===link.category){const id=randomUUID();this.links.set(id,{url:this.session.origin+link.route,category:link.category});links.push({id,category:link.category});}
  const categories=(row.categories||[]).filter(c=>['dashboard','transactions','accounts','budgets','cashflow','reports','expenses','forecasts','analytics','settings','goals','recurring','insights'].includes(c));
  return {url:this.session.origin+'/',source_url_sha256:hash(this.session.origin+'/'),private_context:true,title:'Authorized account navigation',text:'Verified account navigation categories: '+categories.join(', '),categories,links,forms:[]};
 }
 async handoff(action){
  if(Object.keys(action).some(k=>!['type','authorization_id'].includes(k))||action.authorization_id!==this.session.id||this.authenticated)throw error('sealed_handoff_required');
  this.ensure();this.phase='locked';for(const s of this.sockets)s.destroy();
  // Stop in-flight requests and page timers from the human-controlled phase
  // before enabling the stricter inspection policy. A fresh bounded navigation
  // follows confirmation; no pending login request can become inspection work.
  await this.page.goto('about:blank');this.phase='inspect';await this.navigate(this.session.origin+'/');
  const row=await this.project(inspectSessionDocument);if(row.auth||row.takeover||!row.categories?.some(c=>c!=='settings')){this.phase='locked';return {state:'human_takeover_required',private_context:true,authority:false};}
  this.authenticated=true;return {state:'authenticated',private_context:true,screenshots_disabled:true,existing_chrome_login_inherited:false,authority:false};
 }
 async execute(action){if(action?.type==='handoff'){if(this.active||++this.actions>this.maxActions)throw error('action_bound');this.active=true;try{return await this.handoff(action);}finally{this.active=false;}}return super.execute(action);}
 async close(){
  if(this.closePromise)return this.closePromise;this.closed=true;this.signal.removeEventListener('abort',this.abort);this.lifecycle.abort();this.phase='locked';for(const s of this.sockets)s.destroy();
  this.closePromise=(async()=>{
   await this.startPromise?.catch(()=>{});let verified=true;
   try{await this.context?.close();if(this.browser?.isConnected())verified=false;}catch{verified=false;}
   if(this.proxy)await new Promise(resolve=>{this.proxy.closeAllConnections();this.proxy.close(resolve);});this.links.clear();this.forms.clear();
   if(verified&&this.profileLease){try{harden(this.profileLease.dir);this.profileLease.release();}catch{verified=false;}}
   this.event('research.browser_closed',{termination_verified:verified});if(!verified)throw error('termination_unverified');return {closed:true,termination_verified:true,owned_process_termination:'verified'};
  })();return this.closePromise;
 }
}
module.exports={SessionBrowser,authorization,profile,harden,validateProfileTree,allowedURL,inspectSessionDocument,ROUTES};
