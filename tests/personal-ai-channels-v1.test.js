'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {ConversationEngine}=require('../src/conversation-engine'),router=require('../src/model-worker-router');
const response=content=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]}));

test('browser session history exposes worker/model identity and stays channel-scoped',async t=>{
 const f=await fixture(t);
 const engine=new ConversationEngine(f.bridge,{qualify:async()=>({state:'READY',model:router.MODEL}),request:async()=>response('Hello from local Qwen.')});
 t.after(()=>engine.close());
 const browser=engine.session({channel:'browser'});
 const terminal=engine.session({channel:'terminal'});
 const turn=await engine.start({message:'Hi',request_id:randomUUID(),conversation_id:browser.conversation_id,include_memory:false});
 assert.equal(turn.model,router.MODEL);assert.equal(turn.worker,'local-ollama');assert.equal(turn.activity,'Thinking…');
 await engine.active.get(turn.turn_id)?.promise;
 const result=engine.result({conversation_id:browser.conversation_id,turn_id:turn.turn_id});
 assert.equal(result.state,'completed');assert.equal(result.model,router.MODEL);assert.equal(result.worker,'local-ollama');
 const history=engine.history(browser.conversation_id);
 assert.equal(history.length,1);assert.equal(history[0].model,router.MODEL);assert.equal(history[0].worker,'local-ollama');
 assert.equal(history[0].channel,'browser');assert.equal(history[0].memory_included,false);
 assert.equal(engine.history(terminal.conversation_id).length,0);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n,0);
});

test('Control Center and macOS personal-channel surfaces stay wired without WhatsApp production enablement',()=>{
 const hub=fs.readFileSync(path.join(__dirname,'../public/control-hub.js'),'utf8');
 assert.match(hub,/includeMemoryConsent/);
 assert.match(hub,/historyQuery/);assert.match(hub,/conversationSessionId/);
 assert.match(hub,/\?view=Conversation|view==='Conversation'/);
 assert.match(hub,/include_memory:includeMemoryConsent/);
 assert.doesNotMatch(hub,/include_memory:true,model:selectedModel/);
 const menu=fs.readFileSync(path.join(__dirname,'../macos/AirodromMenu.swift'),'utf8');
 assert.match(menu,/open-conversation/);
 assert.match(menu,/Open Conversation/);
 assert.match(menu,/separated_from_missions/);
 const control=fs.readFileSync(path.join(__dirname,'../scripts/macos/product-control.cjs'),'utf8');
 assert.match(control,/open-conversation/);
 assert.match(control,/view:'Conversation'/);
 const bootstrap=fs.readFileSync(path.join(__dirname,'../src/local-bootstrap.js'),'utf8');
 assert.match(bootstrap,/view!=='Conversation'/);
 const production=require('../config/whatsapp-production-connection-v1.json');
 assert.equal(production.outbound_enabled,false);
 assert.equal(production.auto_mission_execution,false);
 assert.equal(production.ai_assistant_policy?.eligibility,'prohibited');
});

test('native status reports conversation identity separately from Mission execution',async t=>{
 const f=await fixture(t);
 f.bridge.conversationEngine=new ConversationEngine(f.bridge,{qualify:async()=>({state:'READY',model:router.MODEL}),request:async()=>response('ok')});
 t.after(()=>f.bridge.conversationEngine.close());
 f.bridge.conversationEngine.setPreference({nickname:'Airo'});
 const status=await require('../src/product-observability').nativeStatus(f.bridge);
 assert.equal(status.conversation.nickname,'Airo');
 assert.equal(status.conversation.separated_from_missions,true);
 assert.equal(status.conversation.channel,'browser');
 assert.match(status.diagnostic,/Conversation: Airo/);
});
