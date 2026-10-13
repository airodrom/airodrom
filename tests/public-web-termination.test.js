'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const {ResearchBrowser}=require('../src/research-browser');
const {ResearchNetwork}=require('../src/research-network');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const ORIGIN='https://research.example';

function directory(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-web-term-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fakeBrowser({hangCloseMs=0}={}){
 const events=[],options={},child={pid:45678,exitCode:null,signalCode:null};
 const page=new EventEmitter();page.url=()=>'about:blank';page.mainFrame=()=>({});page.waitForTimeout=async()=>{};page.close=async()=>{};page.setViewportSize=async()=>{};page.on=page.on.bind(page);
 const context=new EventEmitter();context.setDefaultTimeout=()=>{};context.setDefaultNavigationTimeout=()=>{};context.addInitScript=async()=>{};context.routeWebSocket=async()=>{};context.route=async()=>{};context.newPage=async()=>page;
 context.close=async()=>{events.push('context.close');if(hangCloseMs)await new Promise(r=>setTimeout(r,hangCloseMs));};
 const browser={newContext:async opts=>{options.context=opts;return context;},close:async()=>{events.push('browser.close');}};
 const server={wsEndpoint:()=>'ws://127.0.0.1/owned-browser',process:()=>child,close:async()=>{events.push('server.close');child.exitCode=0;}};
 const playwright={chromium:{launchServer:async opts=>{options.launch=opts;return server;},connect:async()=>browser}};
 return {playwright,events,options,child,context,server};
}

test('document fetches receive a reserved concurrency seat ahead of subresource saturation',async()=>{
 const n=new ResearchNetwork({scope:{origins:[ORIGIN]},testing:{lookup:async()=>[{address:'8.8.8.8',family:4}],request:(options,callback)=>{const req=new EventEmitter();req.end=()=>{};req.destroy=()=>{};queueMicrotask(()=>{/* hold slot open */});return req;}}});
 n.active=8;
 const started=Date.now();
 const pending=n.acquireSlot(undefined,{priority:true});
 await pending;
 assert.equal(n.active,9);
 assert.ok(Date.now()-started<50);
 n.active=8;
 await assert.rejects(n.acquireSlot(AbortSignal.timeout(30),{priority:false}),/concurrency_bound|cancelled/);
});

test('hung context.close cannot strand Mission ownership past the bounded close budget',async t=>{
 const dir=directory(t),fake=fakeBrowser({hangCloseMs:60000});
 const b=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:5},evidenceDir:dir,network:{fetch:async()=>({url:ORIGIN+'/',status:200,contentType:'text/html',body:Buffer.from('ok')})},playwright:fake.playwright});
 await b.qualify();
 assert.equal(b.ownedProcessId(),45678);
 const started=Date.now();
 const result=await b.close();
 assert.ok(Date.now()-started<20000,'close must finish within bounded steps');
 assert.equal(result.termination_verified,true);
 assert.equal(fake.child.exitCode,0);
 assert.equal(fake.events.includes('server.close'),true);
});

test('mission-web reconcile releases quarantine only with process proof or orphan attestation',async t=>{
 const f=await fixture(t),b=f.bridge;b.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 let closes=0;b.missions.web.options={synthetic:true,browserFactory:()=>({start:async()=>{},ownedProcessId:()=>null,execute:async()=>{throw Object.assign(Error('navigation_unavailable'),{code:'navigation_unavailable'});},close:async()=>++closes===1?{closed:false,termination_verified:false}:{closed:true,termination_verified:true,owned_process_termination:'verified'}})};
 const m=b.missions.web.createResearch({request_id:randomUUID(),objective:'Explore synthetic source.',mode:'on',entries:['https://example.com/'],confirmed:true});
 b.missions.dispatch(m.mission_id,{request_id:randomUUID()});
 const done=await f.settle(m.mission_id,'blocked');
 const run=done.runs.find(r=>r.agent_id==='host');
 assert.equal(run.state,'termination_unverified');
 assert.equal(b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE run_id=?').get(run.id).state,'quarantined');
 assert.equal(b.missions.web.uncertainBrowsers.has(m.mission_id),true);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID(),orphan_attestation:'no_owned_browser_process'}),/uncertain_browser_handle_retained/);
 b.missions.web.uncertainBrowsers.delete(m.mission_id);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()}),/orphan_attestation_required/);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:false,request_id:randomUUID(),orphan_attestation:'no_owned_browser_process'}),/explicit_termination_confirmation_required|Unexpected/);
 const receipt=b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID(),orphan_attestation:'no_owned_browser_process'});
 assert.equal(receipt.reconciled,true);
 assert.equal(b.controlStore.run(run.id).termination_verified,1);
 assert.equal(b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE run_id=?').get(run.id).state,'released');
 assert.equal(b.controlStore.db.prepare("SELECT state FROM cp_dispatches WHERE run_id=?").get(run.id).state,'blocked');
});

test('mission-web records owned browser pid before navigation work',async t=>{
 const f=await fixture(t),b=f.bridge;b.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 const pids=[];
 b.missions.web.options={synthetic:true,browserFactory:()=>({
  start:async()=>{},
  ownedProcessId:()=>424242,
  execute:async(action)=>{if(action.type==='navigate'){const run=b.controlStore.db.prepare("SELECT pid,process_state FROM cp_runs WHERE agent_id='host' ORDER BY created_at DESC LIMIT 1").get();pids.push(run);return {state:'navigated'};}const id=randomUUID(),text='Public',row={id,url:'https://example.com/',title:'Public',text,content:text,sha256:require('node:crypto').createHash('sha256').update(text).digest('hex'),classification:'observed',links:[],forms:[],viewport:{width:1280,height:800},captured_at:Date.now(),authority:false,untrusted:true};const bytes=Buffer.from(JSON.stringify(row)+'\n');const file=path.join(arguments[0]/*placeholder*/);return row;},
  verify:()=>true,
  close:async()=>({closed:true,termination_verified:true,owned_process_termination:'verified'})
 })};
 // Use simpler perform path through createResearch settlement with working browser
 b.missions.web.options={synthetic:true,browserFactory:(o)=>{
  const dir=o.evidenceDir;
  return {
   start:async()=>{},
   ownedProcessId:()=>424242,
   async execute(action){
    if(action.type==='navigate'){
     const run=b.controlStore.db.prepare("SELECT pid,process_state FROM cp_runs WHERE agent_id='host' ORDER BY created_at DESC LIMIT 1").get();
     pids.push(run);return {state:'navigated'};
    }
    const id=randomUUID(),text='Public features',row={id,url:'https://example.com/',title:'Public',text,content:text,sha256:require('node:crypto').createHash('sha256').update(text).digest('hex'),classification:'observed',links:[],forms:[],viewport:{width:1280,height:800},captured_at:Date.now(),authority:false,untrusted:true};
    if(action.type==='screenshot'){const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');fs.writeFileSync(path.join(dir,id+'.png'),png,{mode:0o600,flag:'wx'});row.screenshot_ref={id,path:path.join(dir,id+'.png'),sha256:require('node:crypto').createHash('sha256').update(png).digest('hex'),mimeType:'image/png'};}
    const bytes=Buffer.from(JSON.stringify(row)+'\n');fs.writeFileSync(path.join(dir,id+'.json'),bytes,{mode:0o600,flag:'wx'});row.evidence_ref={id,path:path.join(dir,id+'.json'),sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')};return row;
   },
   verify:row=>require('../src/research-browser').verifyEvidence(row,{evidenceDir:dir,scope:o.scope}),
   close:async()=>({closed:true,termination_verified:true,owned_process_termination:'verified'})
  };
 }};
 const m=b.missions.web.createResearch({request_id:randomUUID(),objective:'Explore synthetic source.',mode:'on',entries:['https://example.com/'],confirmed:true});
 b.missions.dispatch(m.mission_id,{request_id:randomUUID()});
 const done=await f.settle(m.mission_id);
 assert.equal(done.state,'awaiting_acceptance');
 assert.ok(pids.length>=1);
 assert.equal(pids[0].pid,424242);
 assert.equal(pids[0].process_state,'alive');
});
