'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {agentRuntimeProfile}=require('./agent-runtime-profile');
const ENV_KEYS=['HOME','PATH','TMPDIR','TMP','TEMP','USER','LOGNAME','LANG','LC_ALL'];
function environment(source=process.env){return Object.fromEntries(ENV_KEYS.filter(k=>typeof source[k]==='string'&&!source[k].includes('\0')).map(k=>[k,source[k]]));}
function errorClass(text){return /quota|usage limit|credit|resource_exhausted|spending limit/i.test(text)?'quota_limited':/not logged|not authenticated|login required|unauthorized|session expired/i.test(text)?'auth_required':'runtime_unavailable';}
// Only categorical observations leave the process; never retain auth stdout/stderr.
async function command(executable,args,{spawnImpl=spawn,env=environment(),timeout=5000}={}){
 if(!Array.isArray(args)||args.length!==1||!['--version','status'].includes(args[0]))throw Error('Cursor observation command denied');
 env=environment(env);
 return new Promise(resolve=>{let child,raw='',bytes=0,settled=false;const finish=exit=>{if(settled)return;settled=true;clearTimeout(timer);resolve({exit,raw});};let timer;
  try{child=spawnImpl(executable,args,{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe']});}catch{return finish(-1);}
  timer=setTimeout(()=>{child.kill('SIGKILL');finish(-1);},timeout);
  const receive=v=>{bytes+=v.length;if(bytes<=64000)raw+=v.toString();else{child.kill('SIGKILL');finish(-1);}};
  child.stdout.on('data',receive);child.stderr.on('data',receive);child.on('error',()=>finish(-1));child.on('close',finish);
 });
}
async function acpProbe(executable,{spawnImpl=spawn,env=environment(),timeout=5000}={}){
 env=environment(env);
 return new Promise(resolve=>{let child,reader,timer,done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);reader?.close();try{child?.kill('SIGKILL');}catch{}resolve(value);};
  try{child=spawnImpl(executable,['acp'],{cwd:os.tmpdir(),env,stdio:['pipe','pipe','pipe']});reader=createInterface({input:child.stdout});}catch{return finish({reachable:false});}
  timer=setTimeout(()=>finish({reachable:false}),timeout);let bytes=0;
  child.stderr.on('data',()=>{});child.on('error',()=>finish({reachable:false}));child.on('close',()=>finish({reachable:false}));child.stdin.on('error',()=>finish({reachable:false}));
  reader.on('line',line=>{bytes+=Buffer.byteLength(line);if(bytes>64000)return finish({reachable:false});let r;try{r=JSON.parse(line);}catch{return;}
   if(r.id!==1)return;const result=r.result;finish({reachable:result?.protocolVersion===1,load_session:result?.agentCapabilities?.loadSession===true,cursor_login:result?.authMethods?.some(a=>a.id==='cursor_login')===true});});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'airodrom-runtime-status',version:'1'}}})+'\n');
 });
}
function qualificationObservation(version,{file=path.join(__dirname,'../config/agent-runtime-qualification-v1.json'),now=Date.now()}={}){
 try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>4000)return null;const q=JSON.parse(fs.readFileSync(file,'utf8')).cursor;if(q?.runtime_version!==version||!Number.isSafeInteger(q.observed_at)||q.observed_at>now||now-q.observed_at>86400000||!['quota_limited','auth_required','unavailable'].includes(q.availability))return null;return{availability:q.availability,observed_at:q.observed_at};}catch{return null;}
}
let cache=null,inflight=null;
async function cursorRuntimeStatus({home=os.homedir(),fixture=false}={}){
 if(fixture)return{installed:false,availability:'unavailable',auth_state:'unknown',reason:'cursor_execution_unqualified',acp_reachable:false};
 if(cache&&Date.now()-cache.checked_at<60000)return cache;if(inflight)return inflight;
 inflight=(async()=>{const executable=[path.join(home,'.local/bin/agent'),path.join(home,'.local/bin/cursor-agent'),'/usr/local/bin/cursor-agent'].find(p=>{try{return fs.statSync(p).isFile();}catch{return false;}});
  const base={installed:!!executable,availability:'unavailable',auth_state:'unknown',quota_state:'unknown',reason:'cursor_execution_unqualified',acp_reachable:false,checked_at:Date.now()};
  if(!executable)return cache={...base,reason:'cursor_agent_not_installed'};
  const [version,auth,acp]=await Promise.all([command(executable,['--version']),command(executable,['status']),acpProbe(executable)]);
  const authenticated=auth.exit===0&&/logged in|authenticated/i.test(auth.raw)&&!/not logged|not authenticated/i.test(auth.raw);
  const currentVersion=/^[0-9][0-9A-Za-z._+ -]{0,100}$/.test(version.raw.trim())?version.raw.trim():null;const qualification=qualificationObservation(currentVersion);
  const classification=qualification?.availability||errorClass(auth.raw);return cache={...base,executable,last_qualification:qualification,quota_state:classification==='quota_limited'?'quota_limited':'unknown',version:/^[0-9][0-9A-Za-z._+ -]{0,100}$/.test(version.raw.trim())?version.raw.trim():null,auth_state:authenticated?'session_observed':classification==='auth_required'?'auth_required':'unknown',availability:classification==='quota_limited'?'quota_limited':classification==='auth_required'?'auth_required':'unavailable',acp_reachable:acp.reachable,load_session_advertised:acp.load_session===true,reason:classification==='quota_limited'?'quota_limited':classification==='auth_required'?'auth_required':acp.reachable?'cursor_execution_unqualified':'cursor_acp_unavailable'};
 })();try{return await inflight;}finally{inflight=null;}
}
module.exports={cursorRuntimeStatus,acpProbe,command,environment,errorClass,qualificationObservation,agentRuntimeProfile};
