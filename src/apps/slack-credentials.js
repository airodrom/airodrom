'use strict';
const {execFile}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const SERVICE='local.pi-chatgpt-bridge.slack.test';
const ACCOUNTS=Object.freeze({SLACK_APP_TOKEN:'app_token',SLACK_BOT_TOKEN:'bot_token'});
// Internal domain is selected by this subsystem, never by worker-supplied fields.
const INTERNAL_DOMAIN='control_plane_internal';
const HELPER=path.resolve(require('node:path').resolve(__dirname, '..'),'../.runtime/slack-keychain/airodrom-slack-keychain');
function helperSafe(){try{if(fs.realpathSync(HELPER)!==HELPER)return false;for(const p of [path.dirname(HELPER),HELPER]){const s=fs.lstatSync(p);if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))return false;}return fs.statSync(HELPER).isFile();}catch{return false;}}
// Only this fixed executable receives allowlisted nonsecret argv. No fallback.
function resolveSlackCredential(reference,{execute=execFile,platform=process.platform,verifyHelper=helperSafe}={}){
 const account=Object.hasOwn(ACCOUNTS,reference)?ACCOUNTS[reference]:null;
 if(!account||platform!=='darwin'||!verifyHelper())return Promise.resolve(null);
 return new Promise(resolve=>{try{execute(HELPER,['read',account],{timeout:5000,killSignal:'SIGKILL',maxBuffer:8192,encoding:'buffer',env:{PATH:'/usr/bin:/bin'}},(error,stdout)=>{
  if(error){if(Buffer.isBuffer(stdout))stdout.fill(0);return resolve(null);}
  const bytes=Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout||'');
  const token=bytes.toString('utf8');bytes.fill(0);
  resolve(new RegExp('^'+(account==='app_token'?'xapp-':'xoxb-')+'[A-Za-z0-9-]+$').test(token)?token:null);
 });}catch{resolve(null);}});
}
// Authorization is a distinct operator-only action; normal reads remain silent.
function authorizeSlackCredential(reference,{execute=execFile,platform=process.platform,verifyHelper=helperSafe}={}){
 const account=Object.hasOwn(ACCOUNTS,reference)?ACCOUNTS[reference]:null;
 if(!account||platform!=='darwin'||!verifyHelper())return Promise.resolve({readable:false,token_class_valid:false,execution_domain:INTERNAL_DOMAIN});
 return new Promise(resolve=>{try{execute(HELPER,['authorize',account],{timeout:300000,killSignal:'SIGKILL',maxBuffer:8192,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}},(error,stdout)=>{
  let result=null;try{result=JSON.parse(stdout);}catch{}
  resolve({readable:!error&&result?.readable===true,token_class_valid:!error&&result?.token_class_valid===true,execution_domain:INTERNAL_DOMAIN});
 });}catch{resolve({readable:false,token_class_valid:false,execution_domain:INTERNAL_DOMAIN});}});
}
module.exports={resolveSlackCredential,authorizeSlackCredential,SERVICE,ACCOUNTS,HELPER,helperSafe};
