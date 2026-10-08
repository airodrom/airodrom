'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const {SessionBrowser,authorization,profile,harden,allowedURL}=require('../src/research-session');
const ORIGIN='https://research.example',hash=v=>createHash('sha256').update(v).digest('hex');
const consent=()=>({id:randomUUID(),origin:ORIGIN,login_url:ORIGIN+'/',confirmed:true,purpose:'competitor_product_research',mode:'dedicated_manual'});
const scope={origins:[ORIGIN],maxActions:30,allowDownloads:false,usePersistentProfile:true};
function dir(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-session-')));fs.chmodSync(d,0o700);t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('session origin isolation and mutation denial cover encoded paths, query credentials and login phase',()=>{
 for(const url of [ORIGIN+'/settings',ORIGIN+'/export',ORIGIN+'/transactions/delete',ORIGIN+'/transactions?token=synthetic',ORIGIN+'/#secret',ORIGIN+'/%64elete','https://other.example/','http://research.example/','https://user:pass@research.example/'])assert.throws(()=>allowedURL(url,{origin:ORIGIN,navigation:true}));
 for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS'])assert.throws(()=>allowedURL(ORIGIN+'/transactions',{origin:ORIGIN,method,phase:'login'}));
 assert.equal(allowedURL(ORIGIN+'/transactions',{origin:ORIGIN,navigation:true}),ORIGIN+'/transactions');
 assert.equal(allowedURL(ORIGIN+'/api/auth/login',{origin:ORIGIN,phase:'login',method:'POST'}),ORIGIN+'/api/auth/login');
 assert.throws(()=>allowedURL(ORIGIN+'/api/auth/login',{origin:ORIGIN,phase:'inspect',method:'POST'}));
 assert.throws(()=>allowedURL(ORIGIN+'/graphql',{origin:ORIGIN,phase:'login',method:'POST'}));
});
test('session consent is exact, cannot select Chrome paths, endpoints or secrets and cannot enable downloads',()=>{
 assert.equal(authorization(consent(),scope).mode,'dedicated_manual');
 for(const patch of [{confirmed:false},{mode:'cdp'},{profile:'/Users/fixture/Chrome'},{endpoint:'http://127.0.0.1:9222'},{origin:'https://other.example'},{password:'synthetic-private'}])assert.throws(()=>authorization({...consent(),...patch},scope));
 assert.throws(()=>authorization(consent(),{...scope,allowDownloads:true}));
 const p=require('../src/browser-research').parse("I'm already logged in to Monarch; inspect my account");assert.equal(p.kind,'research_session');assert.equal(p.entry_url,'https://app.monarch.com/');assert.match(p.message,/not inherited/);
});
test('private profile permissions, single-owner lease and symlink denial preserve existing data',t=>{
 const d=dir(t),p=profile(d,ORIGIN);assert.equal(fs.statSync(p.dir).mode&0o777,0o700);assert.throws(()=>profile(d,ORIGIN),/EEXIST/);
 fs.writeFileSync(path.join(p.dir,'synthetic-browser-state'),'synthetic',{mode:0o644});harden(p.dir);assert.equal(fs.statSync(path.join(p.dir,'synthetic-browser-state')).mode&0o777,0o600);p.release();const again=profile(d,ORIGIN);again.release();assert.equal(fs.readFileSync(path.join(p.dir,'synthetic-browser-state'),'utf8'),'synthetic');
 const s=dir(t);fs.symlinkSync(d,path.join(s,'browser-profiles'));assert.throws(()=>profile(s,ORIGIN));
 fs.chmodSync(p.dir,0o755);assert.throws(()=>profile(d,ORIGIN));
});
test('reused profiles reject nested symlinks, hardlinks, broad permissions and special files before launch',t=>{
 for(const kind of ['symlink','hardlink','file_mode','directory_mode','fifo']){
  const d=dir(t),p=profile(d,ORIGIN);p.release();const outside=path.join(d,'synthetic-outside');fs.writeFileSync(outside,'synthetic-preserved',{mode:0o600});const nested=path.join(p.dir,'Default');fs.mkdirSync(nested,{mode:0o700});const target=path.join(nested,'fixture');
  if(kind==='symlink')fs.symlinkSync(outside,target);
  if(kind==='hardlink')fs.linkSync(outside,target);
  if(kind==='file_mode')fs.writeFileSync(target,'synthetic',{mode:0o644});
  if(kind==='directory_mode')fs.chmodSync(nested,0o755);
  if(kind==='fifo')require('node:child_process').execFileSync('/usr/bin/mkfifo',[target]);
  assert.throws(()=>profile(d,ORIGIN),/profile_integrity_denied/);assert.equal(fs.readFileSync(outside,'utf8'),'synthetic-preserved');assert.equal(fs.existsSync(path.join(p.dir,'.airodrom-owner')),true,'Rejected profile stays quarantined');
 }
});
test('source boundary has no credential/cookie/storage/header/body export, screenshots or external attach',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/research-session.js'),'utf8');
 assert.doesNotMatch(source,/\.(?:cookies|storageState|addCookies|allHeaders|headers|postData|postDataJSON|connectOverCDP)\s*\(/);
 assert.doesNotMatch(source,/--remote-debugging-port|--no-sandbox|ignoreHTTPSErrors:true|recordHar|recordVideo/);
 assert.match(source,/headless:false/);assert.match(source,/chromiumSandbox:true/);assert.match(source,/requestStage:'Response'/);
});
test('canonical Mission waits for operator hand-back, denies tampering, verifies safe artifacts and never self-accepts',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t),b=f.bridge,actions=[];let closed=false;
 class Browser{
  constructor(o){Object.assign(this,o);fs.mkdirSync(o.evidenceDir,{mode:0o700});}
  async qualify(){return {available:true};}
  async execute(a){actions.push(a.type);if(a.type==='navigate')return {state:'navigated',authority:false};if(a.type==='handoff')return {state:'authenticated',authority:false};assert.equal(a.type,'snapshot');const text='Verified account navigation categories: dashboard, transactions',id=randomUUID(),row={id,url:ORIGIN+'/',source_url_sha256:hash(ORIGIN+'/'),private_context:true,title:'Authorized account navigation',text,content:text,sha256:hash(text),classification:'observed',categories:['dashboard','transactions'],links:[],forms:[],untrusted:true,authority:false};const file=path.join(this.evidenceDir,id+'.json'),bytes=Buffer.from(JSON.stringify(row)+'\n');fs.writeFileSync(file,bytes,{mode:0o600});row.evidence_ref={id,path:file,sha256:hash(bytes)};return row;}
  verify(row){return require('../src/research-browser').verifyEvidence(row,{evidenceDir:this.evidenceDir,scope});}
  async close(){closed=true;return {closed:true,termination_verified:true,owned_process_termination:'verified'};}
 }
 b.options.researchMission={workspace:f.repo,synthetic:true,maxPages:2,maxActions:20,timeoutMs:30000,baselineFiles:['docs/README.md'],browserFactory:o=>new Browser(o)};
 f.host.researchAssess=(task,input)=>b.missions.research.assess(task,input);f.host.researchExecute=(task,input,signal)=>b.missions.research.perform(task,input,signal);
 for(const message of ["I'm already logged in to Monarch; inspect my account",'Airo, open an authenticated browser session for app.monarch.com. I will sign in manually.']){const offer=await require('../src/assistant-service').submit({bridge:b,conversationEngine:{nickname:()=> 'Airo'}},{message,request_id:randomUUID()});assert.equal(offer.kind,'research_session');assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n,0);assert.equal(f.inference(),0);}
 const research=b.missions.research,input={request_id:randomUUID(),objective:'Inspect the explicitly authorized synthetic account.',entry_url:ORIGIN+'/',session_authorization:{mode:'dedicated_manual',confirmed:true}};
 assert.throws(()=>research.create({...input,session_authorization:{mode:'dedicated_manual',confirmed:false}}));assert.throws(()=>research.create(input,'mcp'));
 const r=research.create(input),m=b.controlStore.requireMission(r.mission_id);assert.equal(m.envelope.authority.permissions.secrets.length,0);assert.equal(m.envelope.manifest.scope.allowDownloads,false);
 b.missions.dispatch(m.id,{request_id:randomUUID()});for(let i=0;i<150&&!research.active.get(m.id)?.waitingHandoff;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(b.controlStore.requireMission(m.id).state,'waiting_for_operator');assert.deepEqual(actions,['navigate']);assert.equal(f.inference(),0);
 assert.throws(()=>research.ready(m.id,{request_id:randomUUID(),confirmed:false}));assert.throws(()=>research.ready(m.id,{request_id:randomUUID(),confirmed:true},'mcp'));
 for(const type of ['download','screenshot','form','authenticate'])assert.throws(()=>research.assess(b.tasks.get(r.task_id),{mission_id:m.id,action:{type}}));
 research.ready(m.id,{request_id:randomUUID(),confirmed:true});const done=await f.settle(m.id);assert.equal(done.state,'awaiting_acceptance');assert.equal(done.acceptance.length,0);assert.equal(closed,true);assert.deepEqual(actions,['navigate','handoff','snapshot']);assert.equal(done.verifications.some(v=>v.result==='failed'),false);
 const report=await research.report(m.id);assert.match(report.markdown,/account navigation|Account navigation/);assert.equal(report.screenshots.length,0);assert.equal(report.report.sections.comparison.find(c=>c.feature_id==='transactions').competitor_classification,'observed');assert.match(report.report.sections.comparison.find(c=>c.feature_id==='transactions').reason,/functionality is unverified/);assert.equal(f.inference(),0);assert.equal(f.calls(),0);
 const cancelled=research.create({...input,request_id:randomUUID()});b.missions.dispatch(cancelled.mission_id,{request_id:randomUUID()});for(let i=0;i<150&&!research.active.get(cancelled.mission_id)?.waitingHandoff;i++)await new Promise(r=>setTimeout(r,10));b.missions.cancel(cancelled.mission_id,{request_id:randomUUID()});for(let i=0;i<150&&research.active.has(cancelled.mission_id);i++)await new Promise(r=>setTimeout(r,10));assert.equal(b.controlStore.requireMission(cancelled.mission_id).state,'cancelled');assert.equal(research.active.has(cancelled.mission_id),false);assert.equal(b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(cancelled.mission_id).n,0);
});
test('delayed dispatch closes an idle login browser at the signed Mission deadline',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t),b=f.bridge;let closed=false;
 b.options.researchMission={workspace:f.repo,synthetic:true,maxPages:2,maxActions:20,timeoutMs:2500,baselineFiles:['docs/README.md'],browserFactory:()=>({qualify:async()=>({available:true}),execute:async()=>({state:'navigated',authority:false}),close:async()=>{closed=true;return {closed:true,termination_verified:true,owned_process_termination:'verified'};}})};
 f.host.researchAssess=(task,input)=>b.missions.research.assess(task,input);f.host.researchExecute=(task,input,signal)=>b.missions.research.perform(task,input,signal);
 const r=b.missions.research.create({request_id:randomUUID(),objective:'Inspect synthetic account within the signed deadline.',entry_url:ORIGIN+'/',session_authorization:{mode:'dedicated_manual',confirmed:true}}),m=b.controlStore.requireMission(r.mission_id),deadline=m.envelope.manifest.expires_at;
 await new Promise(r=>setTimeout(r,1000));b.missions.dispatch(m.id,{request_id:randomUUID()});for(let i=0;i<150&&!b.missions.research.active.get(m.id)?.waitingHandoff;i++)await new Promise(r=>setTimeout(r,5));assert.equal(b.missions.research.active.get(m.id)?.waitingHandoff,true);
 await new Promise(r=>setTimeout(r,Math.max(0,deadline-Date.now()+200)));assert.equal(closed,true);assert.equal(b.missions.research.active.has(m.id),false);assert.throws(()=>b.missions.research.ready(m.id,{request_id:randomUUID(),confirmed:true}));assert.equal(b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n,0);
});
test('synthetic visible persistent-browser smoke sanitizes finance, closes cleanly and reuses only its own profile',async t=>{
 const d=dir(t),events=[],a=consent();
 const make=()=>new SessionBrowser({scope,evidenceDir:path.join(d,randomUUID()),profileRoot:d,sessionAuthorization:a,onEvent:e=>events.push(e)});
 const b=make();t.after(()=>b.close().catch(()=>{}));assert.equal((await b.qualify()).available,true);
 const html=`<script>const signed=document.cookie.includes('airo_synthetic_session=fixture-session');document.write(signed?'<h1>Overview</h1><nav><a href="/">Overview</a><a href="/transactions">Transactions</a><a href="/export">Export</a></nav><div>Andrew Synthetic - Balance $123,456.78 - synthetic-private-token</div>':'<h1>Sign in</h1><form action="/api/auth/login" method="POST"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>');</script>`;
 const response=r=>r.fulfill({status:200,contentType:'text/html',headers:r.request().method()==='POST'?{'set-cookie':'airo_synthetic_session=fixture-session; Path=/; Secure; SameSite=Lax; Max-Age=3600'}:{},body:html});
 await b.page.route(ORIGIN+'/**',response);await b.execute({type:'navigate',url:ORIGIN+'/'});assert.equal(b.authenticated,false);await b.page.locator('input[name="username"]').fill('synthetic-user');await b.page.locator('input[name="password"]').fill('synthetic-fixture-password');await b.page.locator('button').click();await b.page.locator('nav').waitFor();
 await assert.rejects(b.execute({type:'snapshot'}),/operator_handoff_required/);await assert.rejects(b.execute({type:'handoff',authorization_id:randomUUID()}));await b.execute({type:'handoff',authorization_id:a.id});const row=await b.execute({type:'snapshot'});
 assert.deepEqual(row.categories,['dashboard','transactions']);assert.equal(b.verify(row),true);assert.doesNotMatch(JSON.stringify(row),/Andrew|123,456|synthetic-private-token|\/transactions/);assert.equal(fs.readdirSync(b.evidenceDir).some(f=>f.endsWith('.png')),false);
 await assert.rejects(b.execute({type:'screenshot'}));await assert.rejects(b.execute({type:'download',url:ORIGIN+'/export',approval_id:randomUUID()}));
 await b.page.unroute(ORIGIN+'/**');let redirectRequests=0;await b.page.route(ORIGIN+'/**',r=>{redirectRequests++;return r.fulfill({status:302,headers:{location:ORIGIN+'/transactions/delete'},body:''});});await assert.rejects(b.execute({type:'navigate',url:ORIGIN+'/'}));assert.equal(redirectRequests,1,'Redirect must stop before a second request bypasses routing');
 const profileDir=b.profileLease.dir;assert.equal((await b.close()).termination_verified,true);assert.equal(fs.statSync(profileDir).mode&0o777,0o700);
 const reused=make();t.after(()=>reused.close().catch(()=>{}));assert.equal((await reused.qualify()).available,true);assert.equal(reused.profileLease.dir,profileDir);assert.equal(reused.authenticated,false);await reused.page.route(ORIGIN+'/**',response);await reused.execute({type:'navigate',url:ORIGIN+'/'});await reused.page.locator('nav').waitFor();await assert.rejects(reused.execute({type:'snapshot'}),/operator_handoff_required/);await reused.execute({type:'handoff',authorization_id:a.id});assert.equal((await reused.execute({type:'snapshot'})).private_context,true);await reused.close();assert.equal(events.some(e=>e.existing_chrome_login_inherited===true),false);
});

test('detached terminal consent cancels safely and hand-back targets only the selected Mission',async()=>{
 const {PassThrough}=require('node:stream'),guide=require('../src/research-session-guide');
 async function choose(fn,bytes){const input=new PassThrough(),output=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;const calls=[];const pending=fn({input,output,home:'synthetic-private-home',entry_url:ORIGIN+'/',mission_id:'synthetic-mission',request:async(_home,url,body)=>{calls.push({url,body});return {kind:'mission'};}});setImmediate(()=>input.write(bytes));const result=await pending;input.destroy();output.destroy();return {calls,result};}
 const cancel=await choose(guide.guide,'2\n');assert.equal(cancel.calls.length,0);
 const approved=await choose(guide.guide,'1\n');assert.equal(approved.calls.length,1);assert.equal(approved.calls[0].body.mode,'dedicated_manual');assert.equal(approved.calls[0].body.confirmed,true);
 const back=await choose(guide.ready,'yes\n');assert.equal(back.calls[0].url,'/api/assistant/research/session/ready');assert.equal(back.calls[0].body.mission_id,'synthetic-mission');
 const cancelled=await choose(guide.ready,'no\n');assert.equal(cancelled.calls[0].body.action,'cancel');
});
