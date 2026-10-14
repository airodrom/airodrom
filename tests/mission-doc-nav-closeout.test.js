'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),https=require('node:https'),{EventEmitter}=require('node:events');
const {randomUUID,createHash,generateKeyPairSync}=require('node:crypto');
const {ResearchNetwork}=require('../src/research-network');
const {ResearchBrowser}=require('../src/research-browser');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const hash=v=>createHash('sha256').update(v).digest('hex');

function privateDir(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-docnav-')));
 fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}

function chunkedWire(body,chunkSize=1024,calls=[]){
 const buffer=Buffer.from(body);
 return (options,callback)=>{
  const req=new EventEmitter();req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   calls.push(options);
   const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'text/html','content-length':String(buffer.length)};res.complete=false;res.destroy=()=>{};
   callback(res);
   let offset=0;
   const pump=()=>{
    if(offset>=buffer.length){res.complete=true;res.emit('end');return;}
    const next=buffer.subarray(offset,Math.min(offset+chunkSize,buffer.length));offset+=next.length;res.emit('data',next);queueMicrotask(pump);
   };
   queueMicrotask(pump);
  });
  return req;
 };
}

test('ResearchNetwork accounts transport bytes once after the complete body, not per chunk',async()=>{
 const body='Public fixture document. '.repeat(200);
 const calls=[],byteCalls=[];
 const n=new ResearchNetwork({scope:{origins:['https://research.example']},testing:{lookup:async()=>[{address:'8.8.8.8',family:4}],request:chunkedWire(body,64,calls)},onBytes:n=>byteCalls.push(n)});
 const result=await n.fetch({url:'https://research.example/',document:true});
 assert.equal(result.body.length,Buffer.byteLength(body));
 assert.equal(byteCalls.length,1);
 assert.equal(byteCalls[0],Buffer.byteLength(body));
 assert.equal(calls.length,1);
});

test('byte-budget onBytes failure still fails closed after the complete body',async()=>{
 const body='Public fixture document. '.repeat(50);
 const n=new ResearchNetwork({scope:{origins:['https://research.example']},testing:{lookup:async()=>[{address:'8.8.8.8',family:4}],request:chunkedWire(body,32)},onBytes:()=>{const e=Error('Public research network refused: mission_web_transport_budget');e.code='mission_web_transport_budget';throw e;}});
 await assert.rejects(n.fetch({url:'https://research.example/'}),/mission_web_transport_budget/);
});

test('Playwright navigation timeout maps to document_commit_timeout instead of origin denial',async t=>{
 process.env.NODE_ENV='test';
 const dir=privateDir(t);
 const events=[];
 let routeHandler;
 const page=new EventEmitter();
 page.url=()=>'about:blank';page.mainFrame=()=>({});page.waitForTimeout=async()=>{};page.waitForLoadState=async()=>{};page.close=async()=>{};
 page.goto=async()=>{throw Object.assign(new Error('page.goto: Timeout 15000ms exceeded.'),{name:'TimeoutError'});};
 page.on=()=>{};
 const context=new EventEmitter();
 context.setDefaultTimeout=()=>{};context.setDefaultNavigationTimeout=()=>{};context.addInitScript=async()=>{};context.routeWebSocket=async()=>{};
 context.route=async(_p,handler)=>{routeHandler=handler;};context.newPage=async()=>page;context.close=async()=>{};
 context.newCDPSession=async()=>({send:async()=>({}),detach:async()=>{}});
 const child={pid:4242,exitCode:null,signalCode:null};
 const server={wsEndpoint:()=>'ws://127.0.0.1/owned',process:()=>child,close:async()=>{child.exitCode=0;}};
 const browserObj={newContext:async()=>context,close:async()=>{}};
 const playwright={chromium:{launchServer:async()=>server,connect:async()=>browserObj}};
 const network={origins:new Set(['https://research.example']),validate:u=>u,fetch:async()=>({url:'https://research.example/',status:200,contentType:'text/html',body:Buffer.from('<html><body>Public</body></html>')}),accountURL:()=>{throw Error('no');}};
 const b=new ResearchBrowser({scope:{origins:['https://research.example'],maxActions:5},evidenceDir:dir,network,playwright,onEvent:e=>events.push(e)});
 t.after(()=>b.close().catch(()=>{}));
 await b.start();
 await assert.rejects(b.navigate('https://research.example/'),/document_commit_timeout/);
 const denial=events.find(e=>e.type==='research.network_denied');
 assert.equal(denial.reason,'document_commit_timeout');
 assert.equal(denial.stage,'navigation');
 assert.equal(denial.document_commit_observed,false);
 assert.equal(typeof routeHandler,'function');
});

test('MissionWeb byte-only transportUsage binds the active grant without requiring a fresh seal verify path for budgets',async t=>{
 const f=await fixture(t);
 const web=f.bridge.missions.web;
 f.bridge.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:2,maxActions:20,timeoutMs:30000};
 const created=web.createResearch({request_id:randomUUID(),objective:'Explore https://example.com/ public closeout.',mode:'on',entries:['https://example.com/'],confirmed:true,permission_mode:'strict'});
 const m=f.bridge.controlStore.requireMission(created.mission_id);
 f.bridge.controlStore.state(m.id,'dispatching');f.bridge.controlStore.state(m.id,'running');
 const g=web.grant(m);
 const before=g.bytes;
 web.transportUsage(g,{bytes:4096});
 const after=web.db.prepare('SELECT bytes FROM cp_mission_web_grants WHERE id=?').get(g.id).bytes;
 assert.equal(after,before+4096);
 web.db.prepare('UPDATE cp_mission_web_grants SET bytes=? WHERE id=?').run(0,g.id);
 web.transportUsage(g,{bytes:g.policy.max_bytes});
 assert.throws(()=>web.transportUsage(g,{bytes:1}),/transport_budget/);
});

test('synthetic Mission coordinator observes nonempty page evidence through MissionWeb network adapter',async t=>{
 const f=await fixture(t),web=f.bridge.missions.web;
 f.bridge.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:2,maxActions:20,timeoutMs:30000};
 web.options={synthetic:true,browserFactory:o=>{
  fs.mkdirSync(o.evidenceDir,{recursive:true,mode:0o700});
  return {
   start:async()=>{},
   ownedProcessId:()=>555,
   async execute(a){
    if(a.type==='navigate')return {state:'navigated',url:'https://example.com/',classification:'observed',untrusted:true,authority:false};
    const id=randomUUID(),text='Nonempty public body for acceptance closeout.',title='Closeout Public Page';
    const row={id,url:'https://example.com/',title,text,content:text,sha256:hash(text),classification:'observed',links:[{id:randomUUID(),text:'About',url:'https://example.com/about'}],forms:[],viewport:{width:1280,height:800},captured_at:Date.now(),authority:false,untrusted:true};
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
    const shot=path.join(o.evidenceDir,id+'.png');fs.writeFileSync(shot,png,{mode:0o600,flag:'wx'});row.screenshot_ref={id,path:shot,sha256:hash(png),mimeType:'image/png'};
    const bytes=Buffer.from(JSON.stringify(row)+'\n'),file=path.join(o.evidenceDir,id+'.json');fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});row.evidence_ref={id,path:file,sha256:hash(bytes)};
    return row;
   },
   verify:row=>require('../src/research-browser').verifyEvidence(row,{evidenceDir:o.evidenceDir,scope:o.scope}),
   close:async()=>({closed:true,termination_verified:true,owned_process_termination:'verified'})
  };
 }};
 const created=web.createResearch({request_id:randomUUID(),objective:'Explore https://example.com/ read-only closeout.',mode:'on',entries:['https://example.com/'],confirmed:true,permission_mode:'strict'});
 f.bridge.missions.dispatch(created.mission_id,{request_id:randomUUID()});
 const done=await f.settle(created.mission_id);
 assert.equal(done.state,'awaiting_acceptance');
 const rows=web.rows(f.bridge.controlStore.requireMission(created.mission_id));
 assert.equal(rows.length,1);
 const evidence=web.read(rows[0]);
 assert.equal(evidence.classification,'observed');
 assert.ok(evidence.title);
 assert.ok(evidence.text);
 assert.equal(evidence.termination.termination_verified,true);
 // Empty title/body must not count as observed in browser path — covered by research-browser; here ensure Mission persisted nonempty.
 assert.notEqual(evidence.title,'');
 assert.notEqual(evidence.text,'');
 const accepted=f.bridge.missions.accept(created.mission_id,{request_id:randomUUID(),verification_id:done.verifications[0].id,decision:'accept',rationale:'Synthetic report reviewed',evidence:'Synthetic screenshots and unknown baseline claim inspected'});
 assert.equal(accepted.state,'completed');
 assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE state='quarantined'").get().n,0);
 assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_runs WHERE state IN ('running','termination_unverified','unknown')").get().n,0);
});
