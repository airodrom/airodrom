'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {profileFor,environment,invocation,classifyResult}=require('../src/anthropic-subscription-runtime');
test('nonzero JSON authentication failure is categorical and never exports diagnostics',()=>{
 const stdout=JSON.stringify({is_error:true,result:'Not logged in: private-fixture-value'});
 assert.deepEqual(classifyResult(stdout,{exitCode:1,maxOutput:64}),{error:'auth_required'});
 assert.deepEqual(classifyResult(stdout,{exitCode:0,maxOutput:64}),{error:'auth_required'});
});
test('nonzero exit never promotes JSON text to success and preserves other failure categories',()=>{
 for(const stdout of [JSON.stringify({result:'4'}),JSON.stringify({is_error:true,result:'private-fixture-error'}),'malformed'])
  assert.deepEqual(classifyResult(stdout,{exitCode:1,maxOutput:64}),{error:'runtime_unavailable'});
 assert.deepEqual(classifyResult('malformed',{exitCode:1,authFailure:true,maxOutput:64}),{error:'auth_required'});
 assert.deepEqual(classifyResult('malformed',{exitCode:0,maxOutput:64}),{error:'invalid_response'});
 assert.deepEqual(classifyResult('null',{exitCode:0,maxOutput:64}),{error:'invalid_response'});
 assert.deepEqual(classifyResult(JSON.stringify({is_error:true,result:'private-fixture-error'}),{exitCode:0,maxOutput:64}),{error:'runtime_unavailable'});
 assert.deepEqual(classifyResult(JSON.stringify({result:'oversized'}),{exitCode:0,maxOutput:1}),{error:'invalid_response'});
 assert.deepEqual(classifyResult(JSON.stringify({result:'4'}),{exitCode:0,maxOutput:64}),{text:'4'});
});
test('subscription environment withholds unrelated credentials and customization',()=>{
 const key='ANTHROPIC_RUNTIME_TEST_SECRET';process.env[key]='private-fixture';try{const e=environment('/private/tmp/fixture');assert.equal(e[key],undefined);assert.equal(e.SSH_AUTH_SOCK,undefined);assert.equal(e.ANTHROPIC_API_KEY,undefined);assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.ok(e.USER);assert.ok(e.LOGNAME);assert.equal(e.CLAUDE_CODE_SAFE_MODE,'1');}finally{delete process.env[key];}
});
test('subscription invocation structurally removes tools, MCP, settings, skills and sessions',()=>{
 const a=invocation('/fixture/claude','profile');for(const [flag,value]of [['--tools',''],['--setting-sources',''],['--mcp-config','{"mcpServers":{}}']])assert.equal(a[a.indexOf(flag)+1],value);
 for(const flag of ['--print','--restricted','--safe-mode','--strict-mcp-config','--no-session-persistence','--disable-slash-commands'])assert.ok(a.includes(flag));assert.equal(a.includes('--dangerously-skip-permissions'),false);
});
test('OS sandbox independently denies host reads, writes, shell and Git',{skip:process.platform!=='darwin'},(t)=>{
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'subscription-denial-'))),root=path.join(base,'runtime'),secret=path.join(base,'private-fixture'),write=path.join(base,'write-canary');fs.mkdirSync(root);fs.writeFileSync(secret,'private-fixture');
 try {
  const node=fs.realpathSync(process.execPath),p=profileFor(root,'/qualified/claude')+`(allow process-exec (literal ${JSON.stringify(node)}))`;
  const code=`const fs=require('fs'),cp=require('child_process');const out={};for(const [k,fn]of [['read',()=>fs.readFileSync(${JSON.stringify(secret)})],['write',()=>fs.writeFileSync(${JSON.stringify(write)},'x')]])try{fn();out[k]=false}catch(e){out[k]=['EPERM','EACCES'].includes(e.code)}for(const [k,bin]of [['shell','/bin/sh'],['git','/usr/bin/git']]){const r=cp.spawnSync(bin,['--version']);out[k]=!!r.error||r.status!==0;}console.log(JSON.stringify(out));`;
  const r=cp.spawnSync('/usr/bin/sandbox-exec',['-p',p,node,'-e',code],{cwd:root,env:environment(root),encoding:'utf8',timeout:5000});
  if(r.status===71&&/sandbox_apply:\s*Operation not permitted/i.test(String(r.stderr||''))){t.skip('nested macOS sandbox unavailable inside trusted test runner');return;}
  assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{read:true,write:true,shell:true,git:true});assert.equal(fs.existsSync(write),false);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
