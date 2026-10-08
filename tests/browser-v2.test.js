'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const {SessionBrowser,authorization,profile,blockedMetadata}=require('../src/research-session');
const cdp=require('../src/browser-cdp'),policy=require('../src/mission-web-policy');
const ORIGIN='https://research.example';
const scope={origins:[ORIGIN],maxActions:40,allowDownloads:false,usePersistentProfile:true};
const consent=(patch={})=>({id:randomUUID(),origin:ORIGIN,login_url:ORIGIN+'/',confirmed:true,purpose:'competitor_product_research',mode:'dedicated_manual',permission_mode:'authentication',permission_expires_at:Date.now()+30000,...patch});
function dir(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-v2-')));fs.chmodSync(d,0o700);t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function make(t,a=consent()){const d=dir(t),events=[],b=new SessionBrowser({scope,evidenceDir:path.join(d,'evidence'),profileRoot:d,sessionAuthorization:a,onEvent:e=>events.push(e)});t.after(()=>b.close().catch(()=>{}));return {b,d,events};}
test('seven modes tell the truth about Chrome144, identity popups, passkeys, search and PDF',()=>{
 const row=require('../src/browser-connections').availability();assert.deepEqual(row.modes.map(m=>m.id),[1,2,3,4,5,6,7]);assert.equal(row.modes[0].available,false);assert.match(row.modes[0].reason,/144/);assert.match(row.modes[4].reason,/popups.*passkeys/);assert.equal(row.search_available,false);assert.equal(row.pdf_available,false);assert.equal(row.authority,false);
 assert.throws(()=>require('../src/browser-connections').humanURL('https://app.monarch.com/?token=synthetic'));assert.throws(()=>require('../src/browser-connections').humanURL('https://app.monarch.com/settings'));
});
test('sealed modes cannot select external profiles/endpoints, and owned CDP has separate storage',t=>{
 const d=dir(t),manual=profile(d,ORIGIN),debug=profile(d,ORIGIN,'dedicated_cdp');assert.notEqual(manual.dir,debug.dir);manual.release();debug.release();
 assert.equal(authorization(consent({mode:'dedicated_cdp'}),scope).mode,'dedicated_cdp');
 for(const patch of [{mode:'existing_chrome'},{endpoint:'http://127.0.0.1:9222'},{profile:'/Users/fixture/Chrome'},{permission_mode:'extended'},{permission_expires_at:'never'}])assert.throws(()=>authorization(consent(patch),scope));
});
test('CDP endpoint metadata rejects off-loopback, stale, symlink, hardlink and unowned listener',async t=>{
 const uuid=randomUUID(),d=dir(t),file=path.join(d,'DevToolsActivePort'),content='54321\n/devtools/browser/'+uuid+'\n';
 for(const value of ['ws://localhost:54321/devtools/browser/'+uuid,'ws://192.168.1.1:54321/devtools/browser/'+uuid,'wss://127.0.0.1:54321/devtools/browser/'+uuid,'ws://127.0.0.1:54321/devtools/browser/'+uuid+'?token=synthetic','ws://user:pass@127.0.0.1:54321/devtools/browser/'+uuid])assert.throws(()=>cdp.loopbackEndpoint(value));
 fs.writeFileSync(file,content,{mode:0o600});assert.throws(()=>cdp.endpointFile(d,Date.now()+1000));assert.equal(cdp.endpointFile(d,0),'ws://127.0.0.1:54321/devtools/browser/'+uuid);
 fs.linkSync(file,path.join(d,'extra'));assert.throws(()=>cdp.endpointFile(d,0));fs.unlinkSync(path.join(d,'extra'));fs.unlinkSync(file);fs.writeFileSync(path.join(d,'outside'),content,{mode:0o600});fs.symlinkSync(path.join(d,'outside'),file);assert.throws(()=>cdp.endpointFile(d,0));
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));assert.throws(()=>cdp.verifyListener('ws://127.0.0.1:'+server.address().port+'/devtools/browser/'+uuid));
});
test('expiry on arrival denies stale login POST, revocation drains sockets, budgets latch',t=>{
 const {b}=make(t,consent({permission_expires_at:Date.now()-1}));b.phase='login';let closed=0;b.sockets.add({destroy(){closed++;}});
 assert.throws(()=>b.allowed(ORIGIN+'/api/auth/login',{phase:'login',method:'POST',kind:'fetch'}));assert.equal(b.phase,'inspect');assert.equal(closed,1);assert.equal(b.permissions().mode,'strict');
 assert.throws(()=>b.allowed('https://accounts.google.com/o/oauth2/v2/auth?state=synthetic',{phase:'login',method:'GET',navigation:true}));
 b.stopNetwork('byte_budget');assert.equal(b.networkStopped,true);assert.throws(()=>b.allowed(ORIGIN+'/',{method:'GET',navigation:true}));b.revokePermission('operator');assert.equal(b.networkStopped,true);
});
test('Extended is public-only, explicit, capped at 15 minutes and immutable authority expiry',()=>{
 const now=Date.now(),base={mode:'all',entries:['https://example.com/'],confirmed:true,permission_mode:'extended',duration_ms:900000};
 const p=policy.normalize(base,{now,expiresAt:now+1200000});assert.equal(p.expires_at,now+900000);assert.equal(p.private_accounts,false);assert.deepEqual(p.methods,['GET','HEAD']);
 assert.equal(policy.normalize(base,{now,expiresAt:now+10000}).expires_at,now+10000);
 for(const patch of [{duration_ms:900001},{permission_mode:'strict'},{permission_mode:'authentication'},{mode:'on'},{confirmed:false},{duration_ms:1800000}])assert.throws(()=>policy.normalize({...base,...patch},{now}));
 assert.throws(()=>policy.normalize({...base,entries:['https://example.com/login']}));
});
test('blocked diagnostics never retain sensitive URL paths, parameters, body or invalid origins',()=>{
 const rows=[blockedMetadata('https://accounts.google.com/v3/signin/identifier?email=fixture@example.com&state=synthetic-private-token',{method:'POST',kind:'fetch',reason:'session_origin_or_query_denied'}),blockedMetadata('http://127.0.0.1:5555/private/synthetic-user?secret=fixture',{method:'GET'}),blockedMetadata('https://user:synthetic-pass@research.example/api/private/synthetic-account',{method:'POST'})];
 const text=JSON.stringify(rows);assert.doesNotMatch(text,/synthetic|fixture|identifier|127\.0\.0\.1|\/api\/private|pass@|email=/);assert.equal(rows[0].origin,'https://accounts.google.com');assert.equal(rows[0].query_present,true);assert.equal(rows[1].origin,'[invalid]');assert.equal(rows[2].origin,'[unapproved origin]');assert.equal(blockedMetadata('https://synthetic-private-token.attacker.example/').origin,'[unapproved origin]');
});
test('owned loopback CDP browser fixture keeps OAuth unavailable, sanitizes evidence and denies every redirect/mutation hop',async t=>{
 const {b,d,events}=make(t,consent({mode:'dedicated_cdp'}));const q=await b.qualify();assert.equal(q.available,true,q.reason);assert.ok(b.ownedProcessId());
 const html='<h1>Sign in</h1><button id="google" onclick="window.popupResult=window.open(\'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-private-token\')">Continue with Google</button><button id="identity" onclick="fetch(\'https://accounts.google.com/v3/signin/identifier?state=synthetic-private-token\',{method:\'POST\',body:\'synthetic-credential-body\'}).catch(()=>{})">Synthetic identity request</button><input type="password" value="synthetic-password">';
 await b.page.route(ORIGIN+'/**',r=>r.fulfill({status:200,contentType:'text/html',body:html}));await b.execute({type:'navigate',url:ORIGIN+'/'});await b.page.locator('#google').click();assert.equal(await b.page.evaluate(()=>window.popupResult),null);assert.equal(b.context.pages().length,1);
 await b.page.locator('#identity').click();for(let n=0;n<30&&!events.some(e=>e.type==='research.network_denied');n++)await new Promise(r=>setTimeout(r,10));assert.ok(events.some(e=>e.type==='research.network_denied'));assert.doesNotMatch(JSON.stringify(events),/synthetic-private-token|synthetic-credential-body|synthetic-password/);
 await assert.rejects(b.execute({type:'snapshot'}));await assert.rejects(b.execute({type:'screenshot'}));
 // A synthetic OAuth redirect with a callback code is denied, including metadata redaction.
 await b.page.unroute(ORIGIN+'/**');let requests=0;await b.page.route(ORIGIN+'/**',r=>{requests++;return r.fulfill({status:302,headers:{location:'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-private-token'},body:''});});await assert.rejects(b.execute({type:'navigate',url:ORIGIN+'/'}));assert.equal(requests,1);
 await b.page.unroute(ORIGIN+'/**');await b.page.route(ORIGIN+'/**',r=>r.fulfill({status:200,contentType:'text/html',body:'<h1>Overview</h1><nav><a href="/transactions">Transactions</a></nav><div>Synthetic Owner balance $9999 synthetic-private-token</div>'}));await b.execute({type:'navigate',url:ORIGIN+'/'}).catch(e=>{throw Error(e.code+' '+JSON.stringify({phase:b.phase,requests:b.requests,events:events.map(v=>({type:v.type,reason:v.reason,source:v.source}))}));});await b.execute({type:'handoff',authorization_id:b.session.id});assert.equal(b.permissions().mode,'strict');assert.throws(()=>b.allowed(ORIGIN+'/api/auth/login',{method:'POST'}));const row=await b.execute({type:'snapshot'});assert.equal(b.verify(row),true);assert.doesNotMatch(JSON.stringify(row),/Synthetic Owner|9999|synthetic-private-token/);
 await b.page.unroute(ORIGIN+'/**');requests=0;await b.page.route(ORIGIN+'/**',r=>{requests++;return r.fulfill({status:302,headers:{location:ORIGIN+'/transactions/delete'},body:''});});await assert.rejects(b.execute({type:'navigate',url:ORIGIN+'/'}));assert.equal(requests,1);
 const pid=b.ownedProcessId();await b.close();assert.throws(()=>process.kill(pid,0));assert.equal(fs.statSync(b.profileLease.dir).mode&0o777,0o700);assert.equal(fs.existsSync(path.join(b.profileLease.dir,'.airodrom-owner')),false);assert.equal(fs.readdirSync(path.join(d,'evidence')).some(f=>f.endsWith('.png')),false);
});

test('CDP admission budget really stops browser traffic at the 101st guarded request',async t=>{
 const {b,events}=make(t,consent({mode:'dedicated_cdp'}));assert.equal((await b.qualify()).available,true);
 await b.page.route(ORIGIN+'/**',r=>r.fulfill({status:200,contentType:'text/html',body:'<h1>Overview</h1><nav><a href="/">Overview</a></nav>'}));await b.execute({type:'navigate',url:ORIGIN+'/'});
 b.requests=100;await assert.rejects(b.execute({type:'navigate',url:ORIGIN+'/'}));assert.equal(b.networkStopped,true);assert.equal(b.requests,101);assert.ok(events.some(e=>e.type==='research.network_stopped'&&e.reason==='request_budget'));await assert.rejects(b.execute({type:'navigate',url:ORIGIN+'/'}));assert.equal((await b.close()).termination_verified,true);
});

test('canonical session status retains uncertain termination and revocation is operator-only',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t),b=f.bridge;let closing=false;
 b.options.researchMission={workspace:f.repo,synthetic:true,maxPages:1,maxActions:20,timeoutMs:30000,browserFactory:o=>({qualify:async()=>({available:true}),execute:async()=>({state:'navigated',authority:false}),revokePermission:()=>{closing=true;},close:async()=>{throw Error('Synthetic uncertain termination');}})};
 f.host.researchAssess=(task,input)=>b.missions.research.assess(task,input);f.host.researchExecute=(task,input,signal)=>b.missions.research.perform(task,input,signal);
 const research=b.missions.research,r=research.create({request_id:randomUUID(),objective:'Inspect authorized synthetic feature navigation.',entry_url:ORIGIN+'/',session_authorization:{mode:'dedicated_cdp',permission_mode:'authentication',confirmed:true}});
 b.missions.dispatch(r.mission_id,{request_id:randomUUID()});for(let n=0;n<150&&!research.active.get(r.mission_id)?.waitingHandoff;n++)await new Promise(r=>setTimeout(r,10));assert.equal(research.sessionStatus(r.mission_id).state,'human_control');const ownedRunId=research.active.get(r.mission_id).runId;
 assert.throws(()=>research.revokeSession(r.mission_id,{request_id:randomUUID()},'mcp'));research.revokeSession(r.mission_id,{request_id:randomUUID()});assert.equal(closing,true);
 for(let n=0;n<150&&research.active.has(r.mission_id);n++)await new Promise(r=>setTimeout(r,10));const run=b.controlStore.db.prepare('SELECT state,process_state FROM cp_runs WHERE id=?').get(ownedRunId);assert.equal(run.state,'termination_unverified');assert.equal(run.process_state,'unknown');const status=research.sessionStatus(r.mission_id);assert.equal(status.state,'termination_unverified');assert.equal(status.termination_verified,false);assert.equal(research.sessions().some(s=>s.mission_id===r.mission_id),true);b.controlStore.db.prepare("UPDATE cp_runs SET state='interrupted',process_state='unknown' WHERE mission_id=?").run(r.mission_id);research.recover(b.missions.require(r.mission_id));assert.equal(research.sessionStatus(r.mission_id).state,'termination_unverified');assert.equal(research.sessionStatus(r.mission_id).termination_verified,false);assert.equal(research.sessions().some(s=>s.mission_id===r.mission_id),true);assert.ok(b.controlStore.db.prepare("SELECT 1 FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(r.mission_id));
});

test('browser audit events have truthful display labels and scalar stages',()=>{
 const {eventView}=require('../src/product-observability');for(const event_type of ['research.browser_started','research.browser_closed','research.network_denied','research.network_stopped','research.permission_granted','research.permission_revoked','mission.web.granted','mission.web.revoked','mission.web.evidence']){const row=eventView({event_type,event_id:randomUUID(),sequence:1,timestamp_ms:Date.now()});assert.equal(row.stage,'execution');assert.equal(typeof row.label,'string');assert.equal(row.branch,'observed');}
});
