'use strict';
// Display/evidence boundary. Execution arguments and credential resolver values
// must never be inspected through this module's public process observation.
const {execFile}=require('node:child_process');
function redactText(value){return require('./transport-outcome').redactUrls(String(value).normalize('NFKC'))
 .replace(/\b(?:xox[baprs]-|xapp-|sk-ant-|sk-proj-|sk-|crsr_)[A-Za-z0-9_-]+/g,'[redacted-secret]')
 .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi,'[redacted-secret]')
 .replace(/((?:--)?(?:[A-Z0-9_]*?(?:TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION)(?:[_-][A-Z0-9]+)*)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[redacted-secret]');}
function sensitiveKey(k){
  k=String(k).normalize('NFKC');
  // Boolean/count binding metadata may include token/secret in the name; values are never secret material.
  if (/(?:_present|_bound|_count|_resolvable)$/i.test(k) || /^token_count$/i.test(k)) return false;
  return /^(?:argv|args|environment|env|auth|bearer|authentication|jwt)$/i.test(k)
    || /password|passwd|secret|api.?key|authorization|cookie|credential|session.?value|private.?key|access.?key|signature|signed/i.test(k)
    || /token/i.test(k);
}
function safeValue(v,depth=0){if(depth>12)return'[bounded]';if(typeof v==='string')return redactText(v);if(Array.isArray(v))return v.slice(0,200).map(x=>safeValue(x,depth+1));if(v instanceof Error)return safeValue({name:v.name,message:v.message,stack:v.stack,cause:v.cause},depth+1);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sensitiveKey(k)?'[omitted]':safeValue(x,depth+1)]));return v;}
function observeProcesses({execute=execFile}={}){return new Promise((resolve,reject)=>execute('/bin/ps',['-axo','pid=,ppid=,uid=,stat=,comm='],{timeout:3000,maxBuffer:262144},(error,stdout)=>{if(error)return reject(Error('Process observation unavailable'));resolve(String(stdout).split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);return m?[{pid:+m[1],ppid:+m[2],uid:+m[3],state:m[4],executable:redactText(m[5])}]:[];}));}));}
module.exports={redactText,safeValue,sensitiveKey,observeProcesses};
