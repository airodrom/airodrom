'use strict';
// Owned CDP only. Never probe external endpoints or read ordinary Chrome data.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {error}=require('./research-network');
function loopbackEndpoint(value){
 let u;try{u=new URL(value);}catch{throw error('cdp_loopback_required');}
 if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash||!/^\/devtools\/browser\/[a-f0-9-]{36}$/.test(u.pathname))throw error('cdp_loopback_required');return u.href;
}
function endpointFile(dir,startedAt){
 const file=path.join(dir,'DevToolsActivePort'),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||s.size>200||s.mtimeMs<startedAt)throw error('cdp_owner_unverified');
 const rows=fs.readFileSync(fd,'utf8').trim().split('\n');if(rows.length!==2||!/^\d{1,5}$/.test(rows[0])||Number(rows[0])<1024||Number(rows[0])>65535)throw error('cdp_owner_unverified');fs.fchmodSync(fd,0o600);return loopbackEndpoint('ws://127.0.0.1:'+rows[0]+rows[1]);}finally{fs.closeSync(fd);}
}
function verifyListener(endpoint){
 const u=new URL(loopbackEndpoint(endpoint));
 const r=spawnSync('/usr/sbin/lsof',['-nP','-a','-iTCP:'+u.port,'-sTCP:LISTEN','-F','pun'],{encoding:'utf8',timeout:3000,maxBuffer:16000});
 if(r.status!==0)throw error('cdp_owner_unverified');
 const lines=r.stdout.trim().split('\n'),pids=lines.filter(v=>v.startsWith('p')).map(v=>Number(v.slice(1))),uids=lines.filter(v=>v.startsWith('u')).map(v=>Number(v.slice(1))),names=lines.filter(v=>v.startsWith('n')).map(v=>v.slice(1));
 if(pids.length!==1||!Number.isSafeInteger(pids[0])||uids.some(v=>v!==process.getuid())||!uids.length||!names.length||names.some(v=>v!=='127.0.0.1:'+u.port))throw error('cdp_owner_unverified');
 // ps comm is executable identity only, not command-line arguments.
 const p=spawnSync('/bin/ps',['-p',String(pids[0]),'-o','uid=,ppid=,comm='],{encoding:'utf8',timeout:3000,maxBuffer:2048});
 const row=/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(p.stdout||'');
 if(p.status!==0||!row||Number(row[1])!==process.getuid()||Number(row[2])!==process.pid||row[3]!==require('./browser-connections').CHROME)throw error('cdp_owner_unverified');return pids[0];
}
async function attachOwned({playwright,launchContext,dir,startedAt,signal}){
 if(!launchContext||signal?.aborted)throw error('cdp_owner_unverified');let endpoint;
 const deadline=Date.now()+5000;
 while(!endpoint&&Date.now()<deadline){if(signal?.aborted)throw error('cancelled');try{endpoint=endpointFile(dir,startedAt);}catch(e){if(e.code!=='ENOENT')throw e;}if(!endpoint)await new Promise(r=>setTimeout(r,25));}
 if(!endpoint)throw error('cdp_owner_unverified');const pid=verifyListener(endpoint),file=path.join(dir,'DevToolsActivePort'),identity=fs.lstatSync(file);
 const browser=await playwright.chromium.connectOverCDP(endpoint,{timeout:5000});
 try{const current=fs.lstatSync(file);if(current.dev!==identity.dev||current.ino!==identity.ino||current.mtimeMs!==identity.mtimeMs||current.mode&0o077||endpointFile(dir,startedAt)!==endpoint)throw error('cdp_owner_unverified');if(signal?.aborted||verifyListener(endpoint)!==pid||browser.contexts().length!==1)throw error('cdp_owner_unverified');return {browser,context:browser.contexts()[0],pid};}catch(e){await browser.close().catch(()=>{});throw e;}
}
module.exports={loopbackEndpoint,endpointFile,verifyListener,attachOwned};
