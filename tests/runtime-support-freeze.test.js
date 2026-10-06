'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {support,cloudStatus,denyCloudDispatch,TIERS}=require('../src/runtime-support');
const {agentRuntimeProfile}=require('../src/agent-runtime-profile');
const {CursorAdapter}=require('../src/cursor-adapter');
const {command,acpProbe}=require('../src/cursor-runtime');
const {fixture}=require('./fixtures/mission-fixture.cjs');
test('V1 required core is Pi; unsupported and optional profiles cannot grant authority',()=>{
 assert.deepEqual(TIERS,['REQUIRED','SUPPORTED','OPTIONAL','EXPERIMENTAL','UNSUPPORTED']);
 for(const id of ['pi','opencode','claude_code','codex','cursor','cloud']){const p=support(id);assert.equal(p.required_for_private,id==='pi');assert.equal(p.authority,false);}
 assert.equal(support('opencode').tier,'SUPPORTED');assert.equal(support('opencode').agent_role,'PRIMARY RUNTIME CANDIDATE');assert.equal(support('pi').agent_role,'COMPATIBILITY / DEPRECATION CANDIDATE');
 assert.equal(agentRuntimeProfile('codex',{available:true}).support_tier,'OPTIONAL');assert.equal(agentRuntimeProfile('cursor',{available:true}).support_tier,'EXPERIMENTAL');
 assert.equal(agentRuntimeProfile('cloud',{available:true,direct_dispatch:true}).available,false);assert.equal(cloudStatus().transport,'unsupported');assert.throws(denyCloudDispatch,/intentionally unsupported/);
});
test('generic Cloud cannot register a Mission, including via fallback',async t=>{
 const f=await fixture(t);assert.throws(()=>f.create({preferred_agent:'cloud'}),/Invalid declared agent route/);assert.throws(()=>f.create({fallback_agents:['cloud']}),/Invalid declared agent route/);
 assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_runs').get().n,0);
});
test('Cursor remains fail-closed for spoofed auth, workspace, session, continuation and result claims',async()=>{
 const adapter=new CursorAdapter();
 for(const input of [{workspace:'/tmp/a',allowed_files:['fixture.txt']},{session_id:'wrong',run_id:'other'},{loadSession:true,continuation:true},{runtime:{auth_state:'session_observed',availability:'available'},lifecycle_observation:true,result_publication:true}]){
  assert.equal((await adapter.readiness({observation:input})).ready,false);await assert.rejects(adapter.dispatch(input),/unqualified/);
 }
 assert.equal(adapter.health().workspace_write,false);assert.equal(adapter.health().result_publication,false);assert.equal(adapter.health().continuation,false);
});
test('Cursor observation rejects secret flags, endpoint overrides and arbitrary process commands before spawn',async()=>{
 let spawned=0;for(const args of [['--api-key','fixtureSecret'],['--auth-token','fixtureSecret'],['--api-key=fixtureSecret'],['login'],['acp'],['status','--endpoint','https://private.invalid']])await assert.rejects(command('/fixture/agent',args,{spawnImpl:()=>{spawned++;}}),/denied/);assert.equal(spawned,0);
});
test('ACP observation strips injected credential environment and ignores wrong/session notifications',async()=>{
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let options,killed=0;child.kill=()=>{killed++;};
 child.stdin.on('data',()=>queueMicrotask(()=>{child.stdout.write(JSON.stringify({id:22,result:{protocolVersion:1,sessionId:'wrong',diagnostic:'crsr_fixtureSecret'}})+'\n');child.stdout.write(JSON.stringify({id:1,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'}]}})+'\n');}));
 const result=await acpProbe('/fixture/agent',{timeout:100,env:{HOME:'/fixture',PATH:'/usr/bin',CURSOR_API_KEY:'fixtureSecret',CURSOR_AUTH_TOKEN:'fixtureSecret',OPENAI_API_KEY:'fixtureSecret'},spawnImpl:(_exe,args,opts)=>{assert.deepEqual(args,['acp']);options=opts;return child;}});
 assert.deepEqual(options.env,{HOME:'/fixture',PATH:'/usr/bin'});assert.equal(result.reachable,true);assert.equal(JSON.stringify(result).includes('fixtureSecret'),false);assert.equal(killed,1);
});
