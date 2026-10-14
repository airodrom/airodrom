#!/usr/bin/env node
'use strict';
// Disposable real-Chrome qualification for Mission-path ResearchBrowser + ResearchNetwork.
// Loopback HTTP fixture only. Does not touch live ~/.airodrom or arecibo.ca Missions.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {ResearchBrowser}=require('../src/research-browser');
const {ResearchNetwork}=require('../src/research-network');

async function main(){
 const outBase=process.argv[2]||fs.mkdtempSync(path.join(require('node:os').tmpdir(),'airodrom-doc-nav-'));
 fs.mkdirSync(outBase,{recursive:true,mode:0o700});
 const base=fs.mkdtempSync(path.join(outBase,'scratch-chrome-'));
 fs.chmodSync(base,0o700);
 const evidenceDir=path.join(base,'web-evidence');fs.mkdirSync(evidenceDir,{mode:0o700});fs.chmodSync(evidenceDir,0o700);

 const body=Buffer.from('<!DOCTYPE html><html><head><title>Local Mission Closeout</title></head><body><h1>Local Mission Closeout</h1><p>Nonempty public body for document commit verification.</p><script src="/blocked.js?token=private"></script><img src="/x.png?api_key=private"></body></html>');
 const usage={requests:0,bytes:0,onBytesCalls:0};
 const server=http.createServer((req,res)=>{
  if(req.url==='/'||req.url===''){res.writeHead(200,{'content-type':'text/html','content-length':body.length});res.end(body);return;}
  res.writeHead(404);res.end('missing');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;
 const origin=`http://127.0.0.1:${port}`;

 process.env.NODE_ENV='test';
 const events=[];
 const network=new ResearchNetwork({
  scope:{origins:[origin],maxOrigins:2},
  testing:{allowLoopback:true},
  timeoutMs:10000,
  onRequest:()=>{usage.requests++;},
  onBytes:n=>{usage.onBytesCalls++;usage.bytes+=n;}
 });
 // Expensive Mission-like byte accounting once per response (post-fix).
 const sealCost=()=>{for(let i=0;i<2000;i++)require('node:crypto').createHash('sha256').update(String(i)).digest('hex');};
 const browser=new ResearchBrowser({
  scope:{origins:[origin],maxActions:10,allowDownloads:false},
  network:new ResearchNetwork({
   scope:{origins:[origin],maxOrigins:2},
   testing:{allowLoopback:true},
   timeoutMs:10000,
   onRequest:()=>{usage.requests++;sealCost();},
   onBytes:n=>{usage.onBytesCalls++;usage.bytes+=n;sealCost();}
  }),
  evidenceDir,
  // allowLoopback must reach ResearchBrowser.policy as well as the shared network.
  testing:{allowLoopback:true},
  onEvent:e=>events.push({type:e.type,reason:e.reason||null,stage:e.stage||null,resource:e.resource||null,document_commit_observed:e.document_commit_observed})
 });
 const t0=Date.now();
 let nav,snap,close,err;
 try{
  await browser.start();
  nav=await browser.navigate(origin+'/');
  snap=await browser.execute({type:'snapshot'});
  close=await browser.close();
 }catch(e){
  err={code:e.code||null,message:String(e.message||'').slice(0,200)};
  try{close=await browser.close();}catch{}
 }
 server.close();
 const out={
  ms:Date.now()-t0,
  fixture:'loopback_http',
  nav:nav&&{state:nav.state,classification:nav.classification,url:nav.url},
  snap:snap&&{classification:snap.classification,title:snap.title,text_len:(snap.text||'').length,title_len:(snap.title||'').length},
  close:{closed:!!close?.closed,termination_verified:!!close?.termination_verified,owned_process_termination:close?.owned_process_termination||null},
  err,usage,
  denials:events.filter(e=>e.type==='research.network_denied'),
  events
 };
 fs.writeFileSync(path.join(outBase,'03-chrome-missionlike.json'),JSON.stringify(out,null,2)+'\n',{mode:0o600});
 const ok=!err&&nav?.classification==='observed'&&!!(snap?.title||snap?.text)&&close?.termination_verified===true&&usage.onBytesCalls>=1;
 console.log(JSON.stringify({ok,ms:out.ms,usage,nav:out.nav,snap:out.snap,close:out.close,err,denials:out.denials},null,2));
 if(!ok)process.exitCode=1;
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:String(e.message||e).slice(0,200)}));process.exit(1);});
