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
async function status(home){const stopped=local.isStopped(home);let product=null;if(!stopped)try{product=await local.request(home,'/api/product/native-status');}catch{}
 const diagnostic=product?.diagnostic||summary(await doctor(home));
 return {state:stopped?'Stopped':product?'Connected':'Error',message:product?null:stopped?'Local service is stopped.':'Local status unavailable. Existing service and data preserved.',pid:null,managed:true,now:Date.now(),mcp:{ready:false,lastCallAt:null},tasks:{active:product?.active_missions||0,connected:0,total:0,counts:{}},lastActivityAt:null,lastHeartbeatAt:null,
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
  else if(command==='open-conversation')local.open(home,{view:'Conversation'});
  else if(command==='open-mission'){if(!require('../../src/product-observability').id(missionId))throw Error('Invalid Mission identity');local.open(home,{missionId});}
  else if(command==='cancel-mission'){if(!require('../../src/product-observability').id(missionId))throw Error('Invalid Mission identity');await local.request(home,'/api/product/cancel-mission',{id:missionId,request_id:require('node:crypto').randomUUID()});}
 else if(command==='cli'){const file=launcher(home);const r=spawnSync('/usr/bin/open',['-a','Terminal',file],{stdio:'ignore',timeout:5000});if(r.status!==0)throw Error('Explicit Terminal launcher unavailable.');}
 else throw Error('Unsupported action');
 return status(home);
}
if(require.main===module)action(process.argv[2]||'status',local.localHome(),process.argv[4]).then(s=>console.log(JSON.stringify(s))).catch(()=>{console.log(JSON.stringify({state:'Error',message:'Control request was refused. Run Doctor and inspect current work before retrying.',managed:true,now:Date.now(),mcp:{ready:false,lastCallAt:null},tasks:{active:0,connected:0,total:0,counts:{}},lastActivityAt:null,lastHeartbeatAt:null}));process.exitCode=1;});
module.exports={status,action,launcher};
