'use strict';
/**
 * Regression for Mission 1439260b-32bd-44a9-9286-8b4a813594cc:
 * broker settled mission_web as execution_failed with
 * "Public research network refused: navigation_unavailable",
 * then MissionWeb.call collapsed that into mission_web_preflight_stopped.
 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {ResearchNetwork}=require('../src/research-network');
const {ResearchBrowser}=require('../src/research-browser');

function privateDir(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-preflight-')));
 fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}

test('MissionWeb.call surfaces navigation_unavailable instead of generic preflight_stopped',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t);
 f.bridge.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 const created=f.bridge.missions.web.createResearch({
  request_id:randomUUID(),objective:'explore website https://example.com',mode:'on',entries:['https://example.com/'],confirmed:true
 });
 const m=f.bridge.controlStore.requireMission(created.mission_id);
 const task=f.bridge.tasks.get(created.task_id);
 // call() no longer requires a live run — it only unwraps the broker response.
 f.bridge.invokeCapability=async()=>({
  status:'failed',allow:false,
  decision:{policy_decision:'deny',kind:'execution_failed',reason:'Public research network refused: navigation_unavailable'}
 });
 await assert.rejects(()=>f.bridge.missions.web.call(m,task,{type:'explore',url:'https://example.com/'}),error=>{
  assert.equal(error.code,'navigation_unavailable');
  assert.match(error.message,/navigation_unavailable/);
  assert.doesNotMatch(error.message,/mission_web_preflight_stopped/);
  return true;
 });
});

test('committed document survives goto failure from subresource denials',async t=>{
 const dir=privateDir(t);
 const ORIGIN='https://example.com';
 let current='about:blank';
 const page={
  url:()=>current,mainFrame:()=>({}),waitForTimeout:async()=>{},close:async()=>{},
  goto:async url=>{current=url;throw Error('net::ERR_ABORTED');},
  on(){},evaluate:async()=>{},addStyleTag:async()=>({evaluate:async()=>{}}),screenshot:async()=>Buffer.from('png'),
  setViewportSize:async()=>{}
 };
 const context={
  setDefaultTimeout(){},setDefaultNavigationTimeout(){},addInitScript:async()=>{},routeWebSocket:async()=>{},
  route:async(_p,handler)=>{await handler({request:()=>({url:()=>ORIGIN+'/',method:()=>'GET',postData:()=>null,isNavigationRequest:()=>true,frame:()=>({parentFrame:()=>null}),redirectedFrom:()=>null}),fulfill:async()=>{},abort:async()=>{}});},
  newPage:async()=>page,close:async()=>{},newCDPSession:async()=>({
   send:async method=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'f'}}}:method==='Page.createIsolatedWorld'?{executionContextId:1}:{result:{value:{auth:false,text:'Public body',title:'Public',links:[],forms:[],url:current}}},
   detach:async()=>{}
  }),
  on(){}
 };
 const child={pid:4242,exitCode:null,signalCode:null};
 const playwright={chromium:{
  launchServer:async()=>({wsEndpoint:()=>'ws://127.0.0.1/x',process:()=>child,close:async()=>{child.exitCode=0;}}),
  connect:async()=>({newContext:async()=>context,close:async()=>{}})
 }};
 const network={fetch:async({url})=>({url,status:200,contentType:'text/html',body:Buffer.from('<html>Public</html>')}),validate:u=>u,accountURL:u=>u};
 const browser=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:10},evidenceDir:dir,network,playwright,onEvent:()=>{}});
 t.after(()=>browser.close().catch(()=>{}));
 const nav=await browser.execute({type:'navigate',url:ORIGIN+'/'});
 assert.equal(nav.state,'navigated');
 assert.equal(nav.url,ORIGIN+'/');
});

test('research network queues under concurrency instead of aborting immediately',async()=>{
 const ORIGIN='https://example.com';
 let inFlight=0,maxSeen=0,started=0;
 const n=new ResearchNetwork({
  scope:{origins:[ORIGIN]},timeoutMs:2000,
  testing:{
   lookup:async()=>[{address:'8.8.8.8',family:4}],
   request:(options,callback)=>{
    const req=new (require('node:events').EventEmitter)();
    req.destroy=()=>{};
    req.end=()=>{
     started++;inFlight++;maxSeen=Math.max(maxSeen,inFlight);
     queueMicrotask(()=>{
      const res=new (require('node:events').EventEmitter)();
      res.statusCode=200;res.headers={'content-type':'text/html'};res.complete=false;res.destroy=()=>{};
      callback(res);res.emit('data',Buffer.from('ok'));res.complete=true;res.emit('end');inFlight--;
     });
    };
    return req;
   }
  }
 });
 const jobs=Array.from({length:12},()=>n.fetch({url:ORIGIN+'/'}));
 const results=await Promise.all(jobs);
 assert.equal(results.length,12);
 assert.equal(started,12);
 assert.ok(maxSeen<=8);
});

test('natural website research phrases route to public_web_offer; chat approval is not consent',()=>{
 const guide=require('../src/mission-web-guide');
 const intent=require('../src/assistant-intent');
 assert.equal(intent.parse('Can you research arecibo.ca?').kind,'public_web_offer');
 assert.equal(guide.parse('Go to arecibo.ca and tell me what it does.').kind,'public_web_offer');
 assert.ok(guide.parse('Go to arecibo.ca and tell me what it does.').entries[0].includes('arecibo.ca'));
 assert.equal(guide.parse('Explore website https://arecibo.ca').kind,'public_web_offer');
 assert.equal(guide.parse('I already approved').kind,'clarify');
 assert.match(guide.parse('I already approved').message,/Terminal permission prompt/);
 assert.equal(require('../src/provider-policy').operatorSecretLike('Can you research arecibo.ca?'),false);
 assert.equal(require('../src/provider-policy').operatorSecretLike('arecibo.ca?token=private'),true);
});
