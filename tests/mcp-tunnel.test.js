'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {LABEL,ASSETS,buildPlan,assertMetadata,assertNoLinks,safeRead,plist}=require('../scripts/macos/mcp-tunnel.cjs');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pi-mcp-tunnel-'));
  fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const home=path.join(dir,'home'),project=path.join(dir,'project with spaces'),sourceDir=path.join(dir,'old work session'),dataDir=path.join(project,'.runtime');
  for(const d of [home,project,dataDir,path.join(project,'src'),path.join(sourceDir,'profiles'),path.join(sourceDir,'bin')])fs.mkdirSync(d,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(project,'src/mcp.js'),'// fixture\n',{mode:0o600});
  const node=path.join(dir,'node');fs.writeFileSync(node,'#!/bin/sh\nexit 0\n',{mode:0o700});
  for(const name of ASSETS)fs.writeFileSync(path.join(sourceDir,'bin',name),'fixture '+name,{mode:name==='tunnel-client'?0o700:0o600});
  const secret='NEVER_SERIALIZE_THIS_CREDENTIAL';fs.writeFileSync(path.join(sourceDir,'runtime-api-key'),secret,{mode:0o600});
  const profileFile=path.join(sourceDir,'profiles/pi-chatgpt-bridge-managed.yaml');
  const profile={config_version:1,control_plane:{base_url:'https://api.openai.com',tunnel_id:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',api_key:'file:'+path.join(sourceDir,'runtime-api-key')},mcp:{commands:[{channel:'main',command:'unsafe-old-session-wrapper'}]},extra_secret:secret};
  const save=()=>fs.writeFileSync(profileFile,JSON.stringify(profile),{mode:0o600});save();
  return {options:{home,project,sourceDir,node,dataDir},dir,profileFile,profile,save,secret};
}

test('login agent launches an independent durable tunnel with a minimal explicit environment',t=>{
  const {options,secret}=fixture(t),plan=buildPlan(options),agent=plan.launchAgent,config=plan.config;
  assert.equal(agent.Label,LABEL);assert.equal(agent.RunAtLoad,true);assert.equal(agent.KeepAlive,true);assert.equal(agent.ThrottleInterval,15);assert.equal(agent.Umask,0o077);
  assert.equal(agent.WorkingDirectory,options.project);
  assert.deepEqual(Object.keys(agent.EnvironmentVariables).sort(),['AIRODROM_DATA_DIR','HOME','PATH']);
  assert.deepEqual(agent.ProgramArguments.slice(0,2),['/usr/bin/env','-i']);
  assert.deepEqual(agent.ProgramArguments.slice(2,5),Object.entries(agent.EnvironmentVariables).map(([key,value])=>key+'='+value));
  assert.deepEqual(agent.ProgramArguments.slice(5),[path.join(plan.support,'bin/tunnel-client'),'run','--config',plan.configPath]);
  assert.equal(plan.support,path.join(options.home,'Library/Application Support/Pi Bridge/MCP Tunnel'));
  assert.equal(plan.agent,path.join(options.home,'Library/LaunchAgents',LABEL+'.plist'));
  assert.equal(config.control_plane.tunnel_id,'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(config.control_plane.base_url,'https://api.openai.com');
  assert.equal(config.control_plane.api_key,'file:'+path.join(plan.support,'runtime-api-key'));
  assert.equal(config.mcp.stdio_send_initialized_notification,true);
  assert.equal(config.mcp.commands.length,1);assert.equal(config.mcp.commands[0].channel,'main');
  assert.equal(config.mcp.commands[0].command,`'${options.node}' '${path.join(options.project,'src/mcp.js')}'`);
  assert.equal(config.health.listen_addr,'127.0.0.1:0');assert.equal(config.health.url_file,path.join(plan.support,'health.url'));
  assert.deepEqual(config.log,{file:path.join(plan.support,'tunnel.log'),format:'json',level:'warn'});
  const runtime=JSON.stringify({config,agent});assert(!runtime.includes(options.sourceDir));assert(!runtime.includes('unsafe-old-session-wrapper'));assert(!runtime.includes('cloudflared'));assert(!JSON.stringify(plan).includes(secret));
  assert.deepEqual(Object.keys(config).sort(),['admin_ui','config_version','control_plane','health','log','mcp']);
  assert(plan.assets.every(asset=>/^[0-9a-f]{64}$/.test(asset.sha256)));
});

test('clean launcher discards unrelated parent credentials and shell startup environment',t=>{
  const {options}=fixture(t),plan=buildPlan(options);
  const result=spawnSync('/usr/bin/env',[...plan.launchAgent.ProgramArguments.slice(1,5),'/usr/bin/env'],{encoding:'utf8',env:{CONTROL_PLANE_API_KEY:'should-not-inherit',OPENAI_API_KEY:'should-not-inherit',TUNNEL_CLIENT_CONFIG:'/wrong/profile',HOME:'/wrong/home',PATH:'/wrong/bin'}});
  assert.equal(result.status,0);
  const env=Object.fromEntries(result.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  assert.deepEqual(env,plan.launchAgent.EnvironmentVariables);
});

test('source credential must be an owned private regular file, including no dangling or parent symlinks',t=>{
  const {options}=fixture(t),key=path.join(options.sourceDir,'runtime-api-key');
  fs.chmodSync(key,0o644);assert.throws(()=>buildPlan(options),/unsafe ownership, permissions, or type/);fs.chmodSync(key,0o600);
  assert.throws(()=>assertMetadata(key,{privateMode:true,uid:process.getuid()+1}),/unsafe ownership/);
  fs.unlinkSync(key);fs.symlinkSync('/does/not/exist',key);assert.throws(()=>buildPlan(options),/symbolic link/);
  fs.unlinkSync(key);fs.mkdirSync(key);assert.throws(()=>buildPlan(options),/unsafe ownership/);fs.rmdirSync(key);
  const linked=path.join(options.sourceDir,'linked');fs.symlinkSync(options.home,linked);assert.throws(()=>assertNoLinks(path.join(linked,'new-file')),/symbolic link/);
});

test('regenerates an allowlisted profile and rejects remote origins or inline/environment keys',t=>{
  const {options,profile,save,secret}=fixture(t);
  profile.control_plane.base_url='https://evil.example';save();assert.throws(()=>buildPlan(options),/version 1 OpenAI tunnel profile/);
  profile.control_plane.base_url='https://api.openai.com';
  for(const key of [secret,'env:OPENAI_API_KEY','file:/tmp/other-key']) {profile.control_plane.api_key=key;save();assert.throws(()=>buildPlan(options),/version 1 OpenAI tunnel profile/);}
  profile.control_plane.api_key='file:'+path.join(options.sourceDir,'runtime-api-key');profile.control_plane.tunnel_id='tunnel_fixture\nother';save();assert.throws(()=>buildPlan(options),/version 1 OpenAI tunnel profile/);
});

test('rejects group writable binaries, nonprivate data directories and altered asset metadata',t=>{
  const {options}=fixture(t),binary=path.join(options.sourceDir,'bin/tunnel-client');
  fs.chmodSync(binary,0o770);assert.throws(()=>buildPlan(options),/unsafe ownership/);fs.chmodSync(binary,0o700);
  fs.chmodSync(options.dataDir,0o755);assert.throws(()=>buildPlan(options),/unsafe ownership/);fs.chmodSync(options.dataDir,0o700);
  const before=buildPlan(options);fs.appendFileSync(binary,'changed');const after=buildPlan(options);assert.notEqual(before.assets[0].sha256,after.assets[0].sha256);
  fs.unlinkSync(binary);fs.symlinkSync(options.node,binary);assert.throws(()=>safeRead(binary),/symbolic link/);
});

test('candidate plist is valid and carries no bridge or menu-bar restart operation',t=>{
  const {options}=fixture(t),plan=buildPlan(options),serialized=plist(plan.launchAgent);
  assert(serialized.includes('<key>KeepAlive</key><true/>'));
  assert(!serialized.includes('bootout'));assert(!serialized.includes('kickstart'));assert(!serialized.includes('src/index.js'));assert(!serialized.includes('AirodromMenu'));
  if(process.platform==='darwin') {
    const file=path.join(options.project,'candidate.plist');fs.writeFileSync(file,serialized,{mode:0o600});
    assert.equal(spawnSync('/usr/bin/plutil',['-lint',file],{stdio:'ignore'}).status,0);
  }
});

// Opt-in integration with the shipped binary catches schema drift such as the
// unsupported YAML pid field that the pure plan tests previously accepted.
test('generated profile is accepted by the installed tunnel client schema', {skip: !process.env.PI_TUNNEL_CLIENT}, t=>{
  const {options}=fixture(t),plan=buildPlan(options);
  fs.mkdirSync(plan.support,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(plan.support,'runtime-api-key'),'fixture-only-not-a-real-key',{mode:0o600});
  const file=path.join(options.project,'profile.json');
  const doctor=config=>{
    fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});
    return spawnSync(process.env.PI_TUNNEL_CLIENT,['doctor','--config',file,'--json'],{encoding:'utf8',timeout:15000,env:{HOME:options.home,PATH:process.env.PATH}});
  };
  const valid=doctor(plan.config);
  assert.equal(valid.status,0,valid.stderr+valid.stdout);
  assert.equal(JSON.parse(valid.stdout).result,'ok');
  const invalid=doctor({...plan.config,pid:{file:path.join(plan.support,'tunnel.pid')}});
  assert.notEqual(invalid.status,0);
  assert.match(invalid.stderr+invalid.stdout,/field pid not found/);
});
