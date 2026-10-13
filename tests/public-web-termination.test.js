'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const {ResearchBrowser}=require('../src/research-browser');
const {ResearchNetwork}=require('../src/research-network');
const {bootEpochMs}=require('../src/os-boot-epoch');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const ORIGIN='https://research.example';

function directory(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-web-term-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fakeBrowser({hangCloseMs=0,hangLaunch=false}={}){
 const events=[],options={},child={pid:45678,exitCode:null,signalCode:null,kill(sig){events.push('child.kill:'+sig);if(sig==='SIGKILL')child.exitCode=1;}};
 let releaseLaunch;const launchGate=hangLaunch?new Promise(r=>releaseLaunch=r):null;
 const page=new EventEmitter();page.url=()=>'about:blank';page.mainFrame=()=>({});page.waitForTimeout=async()=>{};page.close=async()=>{};page.setViewportSize=async()=>{};
 const context=new EventEmitter();context.setDefaultTimeout=()=>{};context.setDefaultNavigationTimeout=()=>{};context.addInitScript=async()=>{};context.routeWebSocket=async()=>{};context.route=async()=>{};context.newPage=async()=>page;
 context.close=async()=>{events.push('context.close');if(hangCloseMs)await new Promise(r=>setTimeout(r,hangCloseMs));};
 const browser={newContext:async opts=>{options.context=opts;return context;},close:async()=>{events.push('browser.close');}};
 const server={wsEndpoint:()=>'ws://127.0.0.1/owned-browser',process:()=>child,close:async()=>{events.push('server.close');child.exitCode=0;}};
 const playwright={chromium:{launchServer:async opts=>{options.launch=opts;if(launchGate)await launchGate;return server;},connect:async()=>browser}};
 return {playwright,events,options,child,context,server,releaseLaunch};
}
async function deadPid(){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const pid=child.pid;child.kill('SIGKILL');
 for(let i=0;i<50;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return pid;}await new Promise(r=>setTimeout(r,20));}
 throw Error('fixture pid did not exit');
}
async function uncertainWebMission(t,{bootEpoch,now}={}){
 const f=await fixture(t),b=f.bridge;b.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 let closes=0;b.missions.web.options={synthetic:true,bootEpoch,now,browserFactory:()=>({start:async()=>{},ownedProcessId:()=>null,execute:async()=>{throw Object.assign(Error('navigation_unavailable'),{code:'navigation_unavailable'});},close:async()=>++closes===1?{closed:false,termination_verified:false}:{closed:true,termination_verified:true,owned_process_termination:'verified'}})};
 const m=b.missions.web.createResearch({request_id:randomUUID(),objective:'Explore synthetic source.',mode:'on',entries:['https://example.com/'],confirmed:true});
 b.missions.dispatch(m.mission_id,{request_id:randomUUID()});
 const done=await f.settle(m.mission_id,'blocked');
 const run=done.runs.find(r=>r.agent_id==='host');
 b.missions.web.uncertainBrowsers.delete(m.mission_id);
 b.missions.web.active.delete(m.mission_id);
 const lease=b.controlStore.db.prepare("SELECT * FROM cp_leases WHERE run_id=? AND state='quarantined'").get(run.id);
 return {f,b,m,run,lease};
}

test('document fetches receive a reserved concurrency seat ahead of subresource saturation',async()=>{
 const n=new ResearchNetwork({scope:{origins:[ORIGIN]},testing:{lookup:async()=>[{address:'8.8.8.8',family:4}],request:(options,callback)=>{const req=new EventEmitter();req.end=()=>{};req.destroy=()=>{};queueMicrotask(()=>{});return req;}}});
 n.active=8;await n.acquireSlot(undefined,{priority:true});assert.equal(n.active,9);
 n.active=8;await assert.rejects(n.acquireSlot(AbortSignal.timeout(30),{priority:false}),/concurrency_bound|cancelled/);
});

test('hung context.close cannot strand Mission ownership past the bounded close budget',async t=>{
 const dir=directory(t),fake=fakeBrowser({hangCloseMs:60000});
 const b=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:5},evidenceDir:dir,network:{fetch:async()=>({url:ORIGIN+'/',status:200,contentType:'text/html',body:Buffer.from('ok')})},playwright:fake.playwright});
 await b.qualify();const started=Date.now();const result=await b.close();
 assert.ok(Date.now()-started<20000);assert.equal(result.termination_verified,true);assert.equal(fake.child.exitCode,0);
 assert.equal(fake.events.includes('child.kill:SIGTERM')||fake.events.includes('server.close'),true);
});

test('hung startPromise cannot block close past its deadline and fails closed without verification',async t=>{
 const dir=directory(t),fake=fakeBrowser({hangLaunch:true});
 const b=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:5},evidenceDir:dir,network:{fetch:async()=>({url:ORIGIN+'/',status:200,contentType:'text/html',body:Buffer.from('ok')})},playwright:fake.playwright});
 const starting=b.qualify();await new Promise(r=>setTimeout(r,20));
 const started=Date.now();await assert.rejects(b.close(),/termination_unverified/);assert.ok(Date.now()-started<20000);
 fake.releaseLaunch();await starting.catch(()=>{});
});

test('close signals only through the owned ChildProcess handle, never process.kill(pid)',async t=>{
 const dir=directory(t),fake=fakeBrowser();
 let signaled=null;const original=process.kill;process.kill=function(pid,sig){if(sig&&sig!==0)signaled={pid,sig};return original.apply(this,arguments);};
 t.after(()=>{process.kill=original;});
 fake.server.close=async()=>{fake.events.push('server.close');/* leave child alive so handle.kill runs */};
 const b=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:5},evidenceDir:dir,network:{fetch:async()=>({url:ORIGIN+'/',status:200,contentType:'text/html',body:Buffer.from('ok')})},playwright:fake.playwright});
 await b.qualify();
 assert.equal((await b.close()).termination_verified,true);
 assert.equal(signaled,null);
 assert.equal(fake.events.includes('child.kill:SIGTERM'),true);
 assert.equal(fake.events.includes('child.kill:SIGKILL'),true);
});

test('PID reconcile requires same-boot recorded PID ESRCH and never verifies siblings',async t=>{
 const boot={sec:Math.floor(Date.now()/1000)-60,usec:0,source:'kern.boottime'};
 const {b,m,run}=await uncertainWebMission(t,{bootEpoch:boot});
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()}),/owned_process_pid_required/);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID(),orphan_attestation:'no_owned_browser_process'}),/Unexpected input fields|owned_process_pid_required/);
 const sibling=randomUUID();
 b.controlStore.startRun({id:sibling,taskId:run.task_id,missionId:m.mission_id,agentId:'bridge'});
 b.controlStore.updateRun(sibling,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 const pid=await deadPid();
 b.controlStore.db.prepare('UPDATE cp_runs SET pid=?,updated_at=?,ended_at=? WHERE id=?').run(pid,bootEpochMs(boot)+1000,bootEpochMs(boot)+1000,run.id);
 const receipt=b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()});
 assert.equal(receipt.recovery_kind,'owned_pid_esrch');
 assert.equal(receipt.recovery_not_execution,true);
 assert.equal(b.controlStore.run(sibling).termination_verified,0);
 assert.equal(b.controlStore.run(sibling).state,'interrupted');
});

test('cross-boot recorded PID refuses PID reconcile and requires boot recovery',async t=>{
 const oldBoot={sec:1_700_000_000,usec:0,source:'kern.boottime'},current={sec:1_700_000_200,usec:0,source:'kern.boottime'};
 const {b,run}=await uncertainWebMission(t,{bootEpoch:current});
 const pid=await deadPid();
 b.controlStore.db.prepare('UPDATE cp_runs SET pid=?,updated_at=?,ended_at=? WHERE id=?').run(pid,bootEpochMs(oldBoot)+10,bootEpochMs(oldBoot)+10,run.id);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()}),/owned_process_cross_boot_use_boot_recovery/);
});

test('boot-epoch recovery: positive path after cold reboot; negatives for same boot, bad binding, post-boot activity',async t=>{
 const nowSec=Math.floor(Date.now()/1000);
 const prior={sec:nowSec-7_200,usec:1,source:'kern.boottime'};
 let clock=bootEpochMs(prior)+60_000;
 const {b,m,run,lease}=await uncertainWebMission(t,{bootEpoch:prior,now:()=>clock});
 assert.ok(lease);
 // Confine the historical run to the prior boot timeline before sealing evidence.
 b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=?,ended_at=? WHERE id=?').run(clock,clock,run.id);
 Object.assign(run,b.controlStore.run(run.id));
 assert.throws(()=>b.missions.web.prepareBootRecovery({run_id:run.id,request_id:randomUUID()}),/lease_binding_required/);
 const prepared=b.missions.web.prepareBootRecovery({run_id:run.id,lease_id:lease.id,request_id:randomUUID()});
 assert.equal(prepared.recovery_not_execution,true);
 assert.match(prepared.next,/cold OS reboot/i);
 assert.throws(()=>b.missions.web.reconcileBootRecovery({run_id:run.id,mission_id:m.mission_id,lease_id:lease.id,evidence_id:prepared.evidence_id,termination_verified:true,request_id:randomUUID(),recovery_kind:'cold_os_reboot'}),/cold_os_reboot_not_observed/);
 // Inject a boot epoch after sealed prior-boot event timestamps (fixture ledger
 // uses real wall time during Mission settle; production reboots naturally sort after).
 const nextBoot={sec:nowSec+120,usec:0,source:'kern.boottime'};
 b.missions.web.options.bootEpoch=nextBoot;
 clock=bootEpochMs(nextBoot)+1_000;
 assert.throws(()=>b.missions.web.reconcileBootRecovery({run_id:run.id,mission_id:randomUUID(),lease_id:lease.id,evidence_id:prepared.evidence_id,termination_verified:true,request_id:randomUUID(),recovery_kind:'cold_os_reboot'}),/mission_run_binding_mismatch/);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()}),/owned_process_pid_required/);
 const sibling=randomUUID();
 b.controlStore.startRun({id:sibling,taskId:run.task_id,missionId:m.mission_id,agentId:'bridge'});
 b.controlStore.updateRun(sibling,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 const ok=b.missions.web.reconcileBootRecovery({run_id:run.id,mission_id:m.mission_id,lease_id:lease.id,evidence_id:prepared.evidence_id,termination_verified:true,request_id:randomUUID(),recovery_kind:'cold_os_reboot'});
 assert.equal(ok.recovery_kind,'cold_os_reboot');
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(b.controlStore.run(run.id).termination_verified,1);
 assert.equal(b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE id=?').get(lease.id).state,'released');
 assert.equal(b.controlStore.run(sibling).termination_verified,0);
 const evidence=JSON.parse(fs.readFileSync(path.join(b.dataDir,'recovery','web-termination',prepared.evidence_id+'.json'),'utf8'));
 assert.equal(evidence.browser_closed_receipt,false);

 // Separate fixture for post-boot execution refusal (append-only ledger; no deletes).
 const prior2={sec:nowSec-10_800,usec:2,source:'kern.boottime'};
 let clock2=bootEpochMs(prior2)+60_000;
 const second=await uncertainWebMission(t,{bootEpoch:prior2,now:()=>clock2});
 second.b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=?,ended_at=? WHERE id=?').run(clock2,clock2,second.run.id);
 Object.assign(second.run,second.b.controlStore.run(second.run.id));
 const prepared2=second.b.missions.web.prepareBootRecovery({run_id:second.run.id,lease_id:second.lease.id,request_id:randomUUID()});
 const nextBoot2={sec:nowSec+180,usec:0,source:'kern.boottime'};
 second.b.missions.web.options.bootEpoch=nextBoot2;
 clock2=bootEpochMs(nextBoot2)+1_000;
 const eventId=randomUUID();
 second.b.controlStore.db.prepare("INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,run_id,mission_id,agent,direction,metadata,payload_byte_length,payload_stored_byte_length,payload_redacted,payload_truncated,protected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(eventId,eventId,eventId,'research.browser_started',new Date(clock2).toISOString(),clock2,second.run.id,second.m.mission_id,'bridge','internal','{}',0,0,0,0,0);
 assert.throws(()=>second.b.missions.web.reconcileBootRecovery({run_id:second.run.id,mission_id:second.m.mission_id,lease_id:second.lease.id,evidence_id:prepared2.evidence_id,termination_verified:true,request_id:randomUUID(),recovery_kind:'cold_os_reboot'}),/post_boot_execution_observed/);
});
