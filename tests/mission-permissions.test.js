'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {normalizeAuthority,LEVELS,checkAuthority,callRequirements,trustedDefault}=require('../src/mission-permissions');
const SafetyPolicy=require('../src/safety-policy');
const {MissionAuthority}=require('../src/mission-authority');
const {fixture}=require('./fixtures/mission-fixture.cjs');
function isolated(t){const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/mission-permissions-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const workspace=path.join(root,'repo');fs.mkdirSync(workspace);return{root,workspace};}
function authority(workspace,level='development',extra={}){return normalizeAuthority({level,expiresAt:Date.now()+60000,...extra},{workspace,operator:true});}
test('six levels bound independent dimensions; production rights and secrets are opt-in',t=>{
 const {workspace}=isolated(t);assert.equal(LEVELS.length,6);
 for(const level of LEVELS){const a=authority(workspace,level);assert.equal(checkAuthority(a,{repository:['read']}).allow,true);assert.equal(checkAuthority(a,{secrets:['use']}).allow,false);assert.equal(checkAuthority(a,{data:['production']}).allow,false);assert.equal(checkAuthority(a,{repository:['write']}).allow,level!=='read_only');assert.equal(checkAuthority(a,{repository:['push']}).allow,LEVELS.indexOf(level)>=2);}
 const a=authority(workspace,'production',{permissions:{data:['production'],repository:['merge'],secrets:['production']}});assert.equal(checkAuthority(a,{data:['production'],repository:['merge'],secrets:['production']}).allow,true);
 assert.throws(()=>authority(workspace,'development',{permissions:{repository:['push']}}),/exceeds/);
 assert.throws(()=>normalizeAuthority({level:'production',expiresAt:Date.now()+60000},{workspace}),/operator/);
 assert.throws(()=>normalizeAuthority({level:'infrastructure',expiresAt:Date.now()+60000},{workspace,operator:true,inherited:true}),/operator/);
 assert.throws(()=>authority(workspace,'read_only',{filesystem:{read:[workspace],write:[workspace]}}),/Read Only/);
 assert.throws(()=>authority(workspace,'development',{permissions:{unknown:[]}}),/fields/);
 assert.throws(()=>authority(workspace,'development',{expiresAt:Date.now()-1}),/expiry/);
});
test('canonical filesystem bounds reject sibling-prefix, symlink and missing-child escapes',t=>{
 const {root,workspace}=isolated(t),sibling=path.join(root,'repo-other');fs.mkdirSync(sibling);fs.symlinkSync(sibling,path.join(workspace,'escape'));
 const a=authority(workspace);for(const target of [sibling,path.join(workspace,'escape','new.txt'),path.join(workspace,'..','repo-other','file')])assert.equal(checkAuthority(a,{filesystem:{write:[target]}}).allow,false);
 assert.equal(checkAuthority(a,{filesystem:{write:[path.join(workspace,'new.txt')]}}).allow,true);
 assert.equal(checkAuthority(a,{},a.expiresAt).allow,false);
 assert.equal(checkAuthority(a,{network:['internet']}).allow,false);
 assert.equal(checkAuthority(a,{unknown:true}).allow,false);
 assert.equal(checkAuthority(a,callRequirements({toolName:'capability',input:{name:'file_write',input:{path:'~/outside.txt',content:'x'}}},workspace)).allow,false);
 for (const [name,input] of [['archive_create',{sources:[sibling],destination:path.join(workspace,'archive.tar')}],['archive_extract',{archive:path.join(sibling,'archive.tar'),destination:workspace}]]) assert.equal(checkAuthority(a,callRequirements({toolName:'capability',input:{name,input}},workspace)).allow,false);
});
test('trusted defaults match canonical repository identity and cannot inherit production or escape roots',t=>{
 const {root,workspace}=isolated(t);const alias=path.join(root,'alias');fs.symlinkSync(workspace,alias);
 assert.equal(trustedDefault(alias,[{workspace,level:'development'}]).level,'development');
 assert.equal(trustedDefault(root,[{workspace,level:'development'}]),null);
 assert.throws(()=>trustedDefault(workspace,[{workspace,level:'production'}]),/inherit/);
 assert.throws(()=>trustedDefault(workspace,[{workspace,level:'development',filesystem:{read:[root],write:[root]}}]),/operator/);
});
test('SafetyPolicy intersects ceiling with existing protections and latches excess authority',t=>{
 const {workspace}=isolated(t);fs.writeFileSync(path.join(workspace,'a.txt'),'a');let now=Date.now();
 const p=new SafetyPolicy({now:()=>now});const a=authority(workspace,'read_only');
 p.registerTask({id:'task',sessionId:'session',workspace,mission:{authority:a}});
 assert.equal(p.check('task',{toolName:'read',input:{path:'a.txt'}}).allow,true);
 const denial=p.check('task',{toolName:'write',input:{path:'a.txt',content:'b'}});assert.equal(denial.kind,'mission_grant_denied');assert.ok(p.safetyStops.has('task'));assert.equal(p.check('task',{toolName:'read',input:{path:'a.txt'}}).allow,false);
 p.registerTask({id:'expiry',sessionId:'session',workspace,mission:{authority:a}});now=a.expiresAt;assert.equal(p.check('expiry',{toolName:'read',input:{path:'a.txt'}}).allow,false);assert.ok(p.safetyStops.has('expiry'));
});
test('signed grants bind ceiling changes and honor STOP revocation',t=>{
 const {workspace}=isolated(t),issuer=new MissionAuthority({fixtureOnly:true});const m={id:'mission-permissions',objective:'Read fixture',workspace,authority:authority(workspace),criteria:[]};const grant=issuer.issueFixtureGrant(m,{capabilities:['read']});m.grantId=grant.id;
 assert.equal(issuer.verify(m,'read').allow,true);assert.equal(issuer.verify({...m,authority:{...m.authority,expiresAt:m.authority.expiresAt+1}},'read').allow,false);assert.equal(issuer.verify({...m,authorityRevoked:true},'read').allow,false);issuer.revoke(m.id,'STOP');assert.equal(issuer.verify(m,'read').allow,false);
});
test('typed call mappings preserve runtime and network limits and deny unknown operations',t=>{
 const {workspace}=isolated(t);const a=authority(workspace,'development',{permissions:{runtime:[]}});
 assert.equal(checkAuthority(a,callRequirements({toolName:'test'},workspace)).allow,false);
 assert.equal(checkAuthority(a,callRequirements({toolName:'capability',input:{name:'git_push',input:{repo:workspace}}},workspace)).allow,false);
 assert.equal(checkAuthority(a,callRequirements({toolName:'capability',input:{name:'future_tool',input:{}}},workspace)).allow,false);
});
test('network and private data restrictions apply independently to otherwise trusted operations',t=>{
 const {workspace}=isolated(t),a=authority(workspace,'development',{permissions:{network:[]}});
 const {authorizeLocalOllamaInference}=require('../src/bridge-controller');
 assert.equal(authorizeLocalOllamaInference({}, {mission:{authority:a}}, null, null).allow,false);
 assert.equal(checkAuthority(a,callRequirements({toolName:'personal_memory_get',input:{}},workspace)).allow,false);
});
const native={max_attempts:1,fallback_after_attempts:1,privacy:'local_only',billing_classes:['local'],providers:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]};
test('operator Mission ceiling persists across restart, native work verifies, STOP revokes task authority',async t=>{
 const f=await fixture(t),m=f.create({authority:{level:'development',expiresAt:Date.now()+60000},task_type:'local_files',preferred_agent:'pi',fallback_agents:[],dispatch_policy:native});
 assert.equal(f.bridge.missions.detail(m.id).envelope.authority.level,'development');await f.reopen();
 assert.equal(f.bridge.snapshotTask(f.bridge.tasks.get(m.task_id)).missionAuthority.level,'development');
 f.bridge.missions.dispatch(m.id,{request_id:'authority-dispatch'});await f.settle(m.id);assert.equal(f.calls(),0);assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'beta\n');
 f.bridge.missions.cancel(m.id,{request_id:'authority-stop'});assert.equal(f.bridge.snapshotTask(f.bridge.tasks.get(m.task_id)).missionAuthority.status,'revoked');assert.equal(f.bridge.policy.tasks.has(m.task_id),false);
});
test('Read Only native write and unqualified external handoff stop before execution',async t=>{
 const f=await fixture(t),m=f.create({authority:{level:'read_only',expiresAt:Date.now()+60000},task_type:'local_files',preferred_agent:'pi',fallback_agents:[],dispatch_policy:native});
 f.bridge.missions.dispatch(m.id,{request_id:'readonly-dispatch'});await f.settle(m.id,'blocked');assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');assert.ok(f.bridge.tasks.get(m.task_id).safetyStop.latched);assert.equal(f.calls(),0);
 const other=f.create({objective:'Separate explicit handoff',authority:{level:'development',expiresAt:Date.now()+60000},preferred_agent:'codex'});assert.throws(()=>f.bridge.codexAdapter.startTask(other.id,'authority-handoff'),/qualified/);
});
test('watchdog expires idle authority and resume cannot restore it',async t=>{
 const f=await fixture(t),task=f.bridge.createTask('bounded',{workspace:f.repo,missionAuthority:{level:'development',expiresAt:Date.now()+60000}});const saved=f.bridge.tasks.get(task.id);
 await f.bridge.supervisor.tick(saved.mission.authority.expiresAt);assert.ok(saved.safetyStop.latched);await assert.rejects(f.bridge.resume(task.id),/Safety stop/);
});

test('mission subprocess sandbox denies external files, secrets and Git metadata writes',async t=>{
 const {root,workspace}=isolated(t);const {HostExecutor}=require('../src/host-exec');
 const executor=new HostExecutor({allowed:[process.execPath],home:root}),a=authority(workspace,'development',{permissions:{network:[]}});
 fs.writeFileSync(path.join(root,'outside.txt'),'fixture');fs.writeFileSync(path.join(workspace,'.env'),'fixture');fs.mkdirSync(path.join(workspace,'.git'));
 const script=`const fs=require('node:fs');let denied=0;for(const file of ${JSON.stringify([path.join(root,'outside.txt'),path.join(workspace,'.env')])})try{fs.readFileSync(file)}catch{denied++}try{fs.writeFileSync(${JSON.stringify(path.join(root,'outside-write'))},'x')}catch{denied++}try{fs.writeFileSync(${JSON.stringify(path.join(workspace,'.git','mutation'))},'x')}catch{denied++}console.log(denied)`;
 if(process.platform!=='darwin'){await assert.rejects(executor.run(process.execPath,['-e',script],{cwd:workspace,missionAuthority:a}),/unqualified/);return;}
 const result=await executor.run(process.execPath,['-e',script],{cwd:workspace,missionAuthority:a});assert.equal(result.exitCode,0,result.stderr);assert.equal(result.stdout.trim(),'4');
 assert.equal(fs.existsSync(path.join(root,'outside-write')),false);
});
test('authority expiration and cancellation terminate bounded subprocesses',async t=>{
 const {root,workspace}=isolated(t);const {HostExecutor}=require('../src/host-exec');const executor=new HostExecutor({allowed:[process.execPath],home:root});
 if(process.platform!=='darwin'){t.skip('Qualified macOS process boundary required');return;}
 const expired=await executor.run(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:workspace,timeoutMs:10000,missionAuthority:authority(workspace,'development',{expiresAt:Date.now()+150})});assert.equal(expired.timedOut,true);assert.equal(expired.signal,'SIGKILL');
 const controller=new AbortController();const result=executor.run(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:workspace,timeoutMs:10000,missionAuthority:authority(workspace),signal:controller.signal});setTimeout(()=>controller.abort(),150);assert.equal((await result).signal,'SIGKILL');
});
