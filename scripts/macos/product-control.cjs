'use strict';
// Private native operator adapter. No discovery data is serialized to its caller.
const local=require('../../src/local-bootstrap'),{doctor,summary}=require('../../src/product-diagnostics');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
function launcher(home){local.privateDirectory(home);const file=path.join(home,'open-cli.command');
 const body='#!/bin/sh\nexec env AIRODROM_HOME='+quote(home)+' '+quote(process.execPath)+' '+quote(path.join(local.ROOT,'scripts/airodrom.cjs'))+'\n';
 try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.nlink!==1||stat.mode&0o077)throw Error('Unsafe launcher');}catch(e){if(e.code!=='ENOENT')throw e;}
 const temp=path.join(home,'.cli-'+require('node:crypto').randomUUID());try{fs.writeFileSync(temp,body,{mode:0o700,flag:'wx'});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
 return file;
}
// Optional observations: older services have no admission gate, and the ADR 0031
// supervisor heartbeat exists only when automatic startup is installed.
async function observations(home,stopped){
 let admission=null,supervisor=null,mcpReady=false;
 if(!stopped){try{const g=await local.request(home,'/api/interactive/lifecycle',undefined,{timeoutMs:3000});if(g?.version===1)admission=g;}catch{}
  try{mcpReady=require('../../src/mcp-client').discovery(path.join(home,'data')).pid===local.discovery(home).pid;}catch{}}
 try{const f=local.ownedJSON(path.join(home,'data','managed-supervisor.json'));if(f.version===1&&Date.now()-f.updated_at<=90000)supervisor=f;}catch{}
 return {admission,supervisor,mcpReady};
}
async function status(home){const stopped=local.isStopped(home);let product=null;if(!stopped)try{product=await local.request(home,'/api/product/native-status');}catch{}
 const diagnostic=product?.diagnostic||summary(await doctor(home));
 const seen=await observations(home,stopped),state=stopped?'Stopped':product?'Connected':'Error';
 const recovery=seen.supervisor?.last_recovery;
 const menu={indicator:require('../../src/menu-status').indicator({state,product,admission:seen.admission,supervisor:seen.supervisor?.state||null}),
  service:stopped?'Stopped':product?(seen.admission&&seen.admission.state!=='open'?'Running · maintenance hold':'Running'):'Not answering',
  mcp:seen.mcpReady?'Ready':'Not ready',maintenance:seen.admission?{state:seen.admission.state,unresolved_runs:seen.admission.blockers?.runs??null,idle:seen.admission.idle===true}:null,
  last_recovery:recovery?{at:recovery.at,reason:recovery.reason}:null};
 return {menu,state,message:product?null:stopped?'Local service is stopped.':'Local status unavailable. Existing service and data preserved.',pid:null,managed:true,now:Date.now(),mcp:{ready:false,lastCallAt:null},tasks:{active:product?.active_missions||0,connected:0,total:0,counts:{}},lastActivityAt:null,lastHeartbeatAt:null,
 product:product||{control:'Unavailable',status:'Unavailable',runtime:'Unavailable',runtimeReason:null,memory:'Unavailable',provider:'Unavailable',approvals:null,mission:null,diagnostic}};
}
async function action(command,home=local.localHome(),missionId){
 if(command==='status')return status(home);
 if(command==='doctor'){const s=await status(home);s.product.diagnostic=summary(await doctor(home));return s;}
 if(command==='start')await local.start(home);
 else if(command==='stop')await local.stop(home);
 else if(command==='restart'){await local.stop(home);await local.start(home);}
 else if(command==='requalify'){if(!local.isStopped(home))throw Error('Stop the owned service before requalification.');await local.requalify(home);}
  else if(command==='open')local.open(home);
  else if(command==='open-mission'){if(!require('../../src/product-observability').id(missionId))throw Error('Invalid Mission identity');local.open(home,{missionId});}
  else if(command==='cancel-mission'){if(!require('../../src/product-observability').id(missionId))throw Error('Invalid Mission identity');await local.request(home,'/api/product/cancel-mission',{id:missionId,request_id:require('node:crypto').randomUUID()});}
 else if(command==='cli'){const file=launcher(home);const r=spawnSync('/usr/bin/open',['-a','Terminal',file],{stdio:'ignore',timeout:5000});if(r.status!==0)throw Error('Explicit Terminal launcher unavailable.');}
 else throw Error('Unsupported action');
 return status(home);
}
if(require.main===module)action(process.argv[2]||'status',local.localHome(),process.argv[4]).then(s=>console.log(JSON.stringify(s))).catch(()=>{console.log(JSON.stringify({state:'Error',message:'Control request was refused. Run Doctor and inspect current work before retrying.',managed:true,now:Date.now(),mcp:{ready:false,lastCallAt:null},tasks:{active:0,connected:0,total:0,counts:{}},lastActivityAt:null,lastHeartbeatAt:null}));process.exitCode=1;});
module.exports={status,action,launcher};
