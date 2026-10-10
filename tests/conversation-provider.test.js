'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const providers=require('../src/conversation-provider'),{ConversationEngine}=require('../src/conversation-engine'),router=require('../src/model-worker-router');
async function setup(t,request){const f=await fixture(t),packets=[];const engine=new ConversationEngine(f.bridge,{qualify:async()=>({state:'READY',model:router.MODEL,provider:'ollama'}),request:async(url,options)=>{packets.push(JSON.parse(options.body));return request?request():new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Synthetic response.'}}]}));}});t.after(()=>engine.close());return {...f,engine,packets};}
test('defaults, persistent selection, exact policy consent and local-only rollback',async t=>{
 const f=await setup(t),dir=f.bridge.dataDir;
 assert.deepEqual(providers.read(dir),providers.defaults());
 assert.throws(()=>providers.save(dir,{revision:0,provider:'claude'},'worker'),/operator/);
 providers.save(dir,{revision:0,provider:'claude'},'operator');
 let s=await providers.status(f.engine);assert.equal(s.state,'WAIT');assert.equal(s.reason,'external_data_consent_required');assert.equal(s.model,null);assert.equal(s.external_processing,false);
 assert.throws(()=>providers.save(dir,{revision:0,provider:'qwen'},'operator'),/changed/);
 assert.throws(()=>providers.save(dir,{revision:1,provider:'claude',consent:true},'operator'),/exact/);
 providers.save(dir,{revision:1,provider:'claude',consent:providers.CONSENT},'operator');
 const restarted=new ConversationEngine(f.bridge);s=await providers.status(restarted);assert.equal(s.reason,'subscription_conversation_not_qualified');assert.equal(s.provider,null);
 await assert.rejects(()=>f.engine.start({message:'Explain rainbows.'}),/Claude WAIT/);assert.equal(f.packets.length,0);
 providers.save(dir,{revision:2,provider:'qwen'},'operator');s=await providers.status(f.engine);assert.equal(s.state,'Ready');assert.equal(s.preferences.consent,null);assert.equal(s.model,router.MODEL);
 for(const table of ['cp_missions','cp_runs','cp_leases','cp_acceptances','cp_mission_settlements'])assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
});
test('unknown schema and malformed consent fail closed without resetting preferences',async t=>{
 const f=await setup(t),file=require('node:path').join(f.bridge.dataDir,'conversation-provider.json');
 fs.writeFileSync(file,JSON.stringify({...providers.defaults(),schema_version:9}),{mode:0o600});
 await assert.rejects(()=>f.engine.start({message:'Hello'}),/Unsupported/);assert.equal(JSON.parse(fs.readFileSync(file)).schema_version,9);assert.equal(f.packets.length,0);
});
test('revision change discards late replies and rejects replay across selection changes',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await setup(t,async()=>{await gate;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Late result.'}}]}));});
 const input={message:'Explain clouds.',request_id:require('node:crypto').randomUUID(),...f.engine.session()};const r=await f.engine.start(input);
 providers.save(f.bridge.dataDir,{revision:0,provider:'qwen'},'operator');release();await f.engine.active.get(r.turn_id)?.promise;
 assert.equal(f.engine.result(rIdentity(r)).state,'cancelled');await assert.rejects(()=>f.engine.start(input),/replay rejected/);
});
test('connector excerpts remain local when Claude selected, without ordinary history or Memory',async t=>{
 const f=await setup(t);providers.save(f.bridge.dataDir,{revision:0,provider:'claude'},'operator');
 const r=await f.engine.start({message:'Summarize these excerpts.',include_memory:false,context:[{id:'fixture',subject:'Synthetic mail',content:'Public fixture data.',untrusted:true}]});await f.engine.active.get(r.turn_id)?.promise;
 assert.equal(f.engine.result(rIdentity(r)).state,'completed');assert.equal(f.packets.length,1);assert.equal(f.packets[0].model,router.MODEL.slice(7));assert.equal(f.inference(),0);
});
test('operator endpoint requires auth, rejects stale saves, and never calls external inference',async t=>{
 const f=await setup(t),ControlServer=require('../src/control-server'),server=new ControlServer(f.bridge,{port:0});await server.start();t.after(()=>server.close());server.conversationEngine.qualify=f.engine.qualify;
 const call=(body,token=server.token)=>fetch(server.origin+'/api/assistant/provider',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
 assert.equal((await call({revision:0,provider:'claude'},'invalid')).status,401);
 const r=await call({revision:0,provider:'claude'});assert.equal(r.status,200);assert.equal((await r.json()).state,'WAIT');assert.notEqual((await call({revision:0,provider:'qwen'})).status,200);assert.equal(f.inference(),0);assert.equal(f.calls(),0);
});
function rIdentity(r){return {conversation_id:r.conversation_id,turn_id:r.turn_id};}
