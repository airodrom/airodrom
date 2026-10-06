'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const PIN='75e3016e9d2570767b08e43a7467d4817a4f149232c169ca295f2c95fef21433';
function profileFor(root,cli,home=os.homedir()) {
 const q=JSON.stringify,uid=process.getuid();
 const reads=['/System','/usr','/bin','/sbin','/private/etc','/Library','/opt',path.dirname(cli),root,path.join(home,'Library/Keychains'),'/dev','/private/var/db/timezone',`/private/var/db/mds/messages/${uid}`];
 const literals=['/','/Users',home,'/private','/private/var','/var','/tmp',path.join(home,'.claude.json'),path.join(home,'.CFUserTextEncoding'),path.join(home,'Library/Preferences/com.apple.security.plist')];
 // Runtime scratch reads only; writes outside this invocation remain denied.
 reads.push(`/private/tmp/claude-${uid}`,path.join(home,'.claude'));
 return `(version 1)(deny default)(allow file-read* ${reads.map(p=>`(subpath ${q(p)})`).join(' ')} ${literals.map(p=>`(literal ${q(p)})`).join(' ')})(allow file-read-metadata)(allow file-write* (subpath ${q(root)}) (literal "/dev/null"))(allow process-exec (literal ${q(cli)}) (literal "/usr/bin/security"))(allow process-fork)(allow process-info*)(allow dynamic-code-generation)(allow sysctl-read)(allow mach-lookup)(allow network-outbound)(allow signal (target self))`;
}
function environment(root) {
 const username=os.userInfo().username;
 return {HOME:os.homedir(),USER:username,LOGNAME:username,PATH:'/usr/bin:/bin',TMPDIR:root,CLAUDE_CODE_SAFE_MODE:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_SKIP_PROMPT_HISTORY:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
}
function invocation(cli,profile) {return ['-p',profile,cli,'--print','--tools','','--restricted','--safe-mode','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--disable-slash-commands','--no-session-persistence','--output-format','json','--system-prompt','You are a bounded reasoning-only provider. Use only the supplied text. No tools, files, shell, Git, network tools, memory or execution authority. Action suggestions are inert text.'];}
function classifyResult(stdout,{exitCode,authFailure=false,maxOutput}) {
 let raw;try{raw=JSON.parse(stdout)}catch{}
 // The CLI can report authentication failures in JSON while exiting nonzero.
 const jsonAuthFailure=raw?.is_error===true&&/not logged in|authentication|session expired|login required|oauth.*expired/i.test(String(raw.result));
 if(exitCode!==0)return {error:authFailure||jsonAuthFailure?'auth_required':'runtime_unavailable'};
 if(!raw||typeof raw!=='object')return {error:'invalid_response'};
 if(raw.is_error)return {error:jsonAuthFailure?'auth_required':'runtime_unavailable'};
 if(typeof raw.result!=='string'||!raw.result.trim()||Buffer.byteLength(raw.result)>maxOutput*4)return {error:'invalid_response'};
 return {text:raw.result};
}
class SubscriptionRuntime {
 constructor(){this.state={configured:false,state:'unavailable',reason:'reasoning_runtime_sandbox_unverified',auth_state:'subscription_session_not_verified'};}
 qualify() {
  try {
   if(process.platform!=='darwin')return this.state;
   this.cli=fs.realpathSync(path.join(os.homedir(),'.local/bin/claude'));
   if(createHash('sha256').update(fs.readFileSync(this.cli)).digest('hex')!==PIN)return this.state;
   const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'anthropic-auth-')));
   try {const r=spawnSync('/usr/bin/sandbox-exec',['-p',profileFor(root,this.cli),this.cli,'auth','status','--json'],{cwd:root,env:environment(root),encoding:'utf8',timeout:5000,maxBuffer:64000});let a;try{a=JSON.parse(r.stdout)}catch{}
    this.state=r.status===0&&a?.loggedIn===true&&['claude.ai','oauth_token'].includes(a.authMethod)?{configured:true,state:'available',reason:null,auth_state:'subscription_session_verified'}:{configured:false,state:'auth_required',reason:'auth_required',auth_state:'auth_required'};
   }finally{fs.rmSync(root,{recursive:true,force:true});}
  }catch{ /* No raw errors or auth data exported. */ }
  return this.state;
 }
 async run(prompt,{signal,timeoutMs=45000,maxOutput=8192}={}) {
  if(!this.state.configured)throw Object.assign(Error('Runtime unavailable'),{code:'auth_required'});
  if(Buffer.byteLength(prompt)>128*1024||!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>8192)throw Object.assign(Error('Bound rejected'),{code:'invalid_request'});
  if(createHash('sha256').update(fs.readFileSync(this.cli)).digest('hex')!==PIN)throw Object.assign(Error('Runtime changed'),{code:'runtime_unavailable'});
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'anthropic-reasoning-')));
  try {
   return await new Promise((resolve,reject)=>{
    let stdout='',bytes=0,settled=false,failure=null,timer,killTimer,authFailure=false,stderrBytes=0;
    const child=spawn('/usr/bin/sandbox-exec',invocation(this.cli,profileFor(root,this.cli)),{cwd:root,env:{...environment(root),CLAUDE_CODE_MAX_OUTPUT_TOKENS:String(maxOutput)},stdio:['pipe','pipe','pipe'],detached:true});
    const stop=code=>{failure=code;try{process.kill(-child.pid,'SIGTERM')}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},500);};
    const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>stop('timeout'),Math.min(120000,Math.max(1,timeoutMs)));
    if(signal?.aborted)abort();
    child.stdout.on('data',v=>{bytes+=v.length;if(bytes>1024*1024)stop('invalid_response');else stdout+=v.toString('utf8');});
    child.stderr.on('data',v=>{stderrBytes+=v.length;if(stderrBytes>1024*1024)stop('invalid_response');if(/not logged in|authentication|session expired|login required|oauth.*expired/i.test(v.toString('utf8')))authFailure=true;}); // Retain only classification, never diagnostics.
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);try{process.kill(-child.pid,'SIGKILL')}catch{}signal?.removeEventListener('abort',abort);error?reject(Object.assign(Error('Subscription runtime failed'),{code:error})):resolve(result);};
    child.on('error',()=>finish('runtime_unavailable'));
    child.on('close',code=>{if(failure)return finish(failure);const result=classifyResult(stdout,{exitCode:code,authFailure,maxOutput});if(result.error)return finish(result.error);finish(null,{text:result.text,runtime_version:'2.1.286',runtime_sha256:PIN});});
    child.stdin.on('error',()=>{});child.stdin.end(prompt);
   });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
}
module.exports={SubscriptionRuntime,profileFor,environment,invocation,classifyResult,PIN};
