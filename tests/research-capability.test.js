'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {validate,researchCapabilities}=require('../src/research-capability');
const {auditCapabilityInput}=require('../src/capability-host');
const {CapabilityPolicy}=require('../src/capability-policy');
test('typed browser schema blocks credentials/query fragments and arbitrary selectors/scripts',()=>{
 const mission_id=randomUUID();assert.deepEqual(validate({mission_id,action:{type:'navigate',url:'https://example.invalid/'}}).action,{type:'navigate',url:'https://example.invalid/'});
 for(const action of [{type:'evaluate',script:'globalThis.x=1'},{type:'click',selector:'button'},{type:'navigate',url:'https://example.invalid/?token=fixture'},{type:'navigate',url:'https://user:fixture@example.invalid/'},{type:'form',form_id:randomUUID(),approval_id:randomUUID(),fields:{[randomUUID()]:'password=fixture-private'}}])assert.throws(()=>validate({mission_id,action}));
});
test('browser scope is absent by default, adapter absence fails closed, audit retains only safe action identity',async()=>{
 const p=new CapabilityPolicy();assert.equal(p.decide('browser_research',{taskScopes:['repo']}).decision,'deny');assert.equal(p.decide('browser_research',{taskScopes:['web_read']}).decision,'auto_allow');
 assert.equal((await researchCapabilities().browser_research.assess({},{})).dynamic.decision,'deny');
 const audit=auditCapabilityInput('browser_research',{mission_id:randomUUID(),action:{type:'form',fields:{fixture:'synthetic-private-canary'},url:'https://example.invalid/private'}});assert.equal(audit.action,'form');assert.doesNotMatch(JSON.stringify(audit),/canary|example|private|Sha256/);
});
test('research reports, screenshots and account admission require the operator credential',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t),server=new(require('../src/control-server'))(f.bridge,{port:0});t.after(()=>server.close());let reads=0;f.bridge.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md']};const created=f.bridge.missions.createResearch({request_id:randomUUID(),objective:'Inspect the public fixture.',entry_url:'https://public.example/'});
 Object.defineProperty(f.bridge.missions,'research',{value:{report:async(id,owner)=>{assert.equal(owner,'operator');reads++;return{mission_id:id,markdown:'Synthetic public report https://public.example/',report:{authority:false,references:[],competitor:{url:'https://public.example/'}},authority:false};},evidence:async(id,ref,owner)=>{assert.equal(owner,'operator');reads++;return{mime:'image/png',buffer:Buffer.from('fixture')};}}});
 await server.start();const mission=created.mission_id,evidence=randomUUID();
 for(const route of ['/api/assistant/research/report?mission_id='+mission,'/api/assistant/research/evidence?mission_id='+mission+'&evidence_id='+evidence]){const denied=await fetch(server.origin+route);assert.equal(denied.status,401);const allowed=await fetch(server.origin+route,{headers:{Authorization:'Bearer '+server.token}});assert.equal(allowed.status,200,allowed.ok?'':await allowed.clone().text());assert.match(allowed.headers.get('cache-control'),/no-store/);if(route.includes('/evidence?'))assert.equal(await allowed.text(),'fixture');else assert.match((await allowed.json()).markdown,/https:\/\/public\.example\//);}
 const deniedAccount=await fetch(server.origin+'/api/assistant/research/account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true})});assert.equal(deniedAccount.status,401);assert.equal(reads,2);
 const rejected=await fetch(server.origin+'/api/assistant/research/account',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+server.token},body:JSON.stringify({entry_url:'https://example.invalid/',username_reference:randomUUID(),password_reference:randomUUID(),confirmed:false,request_id:randomUUID()})});assert.equal(rejected.ok,false);assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n,1);assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n,0);
});
