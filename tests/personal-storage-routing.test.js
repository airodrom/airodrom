'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const intent=require('../src/assistant-intent'),service=require('../src/assistant-service'),privateMemory=require('../src/personal-storage-service');
const {SecretVault}=require('../src/secret-vault'),{guide}=require('../src/personal-storage-guide'),{ConversationEngine}=require('../src/conversation-engine');
const {fixture}=require('./fixtures/mission-fixture.cjs'),{qualifyCanonical}=require('./fixtures/opencode-fixture.cjs'),ControlServer=require('../src/control-server');
const PHRASE="Hi Airo, let's save my mailbox number 818.";
class Terminal extends EventEmitter {
 constructor(steps=[]){super();this.isTTY=true;this.isRaw=false;this.steps=steps;}
 setRawMode(value){this.isRaw=value;}pause(){}resume(){const step=this.steps.shift();if(step!==undefined)queueMicrotask(()=>typeof step==='function'?step(this):this.emit('data',Buffer.from(step)));}
}
const output=()=>{let text='';return {isTTY:true,write:value=>{text+=value;},text:()=>text};};
function vaultFixture(t,root){
 const home=path.join(root,'vault');fs.mkdirSync(home,{mode:0o700});const values=new Map(),revoked=new Set(),calls=[];
 const port=(op,id,value)=>{calls.push({op,id});if(op==='revoke'){revoked.add(id);return '';}if(op==='delete'){values.delete(id);return '';}if(revoked.has(id))throw Error('revoked');if(op==='put'){values.set(id,value);return '';}if(op==='read')return values.get(id);};
 return {home,values,calls,port,vault:new SecretVault(home,port)};
}
test('greetings, contractions, polite preambles, nickname and punctuation route explicit saves without values',()=>{
 for(const message of [PHRASE,PHRASE.slice(0,-1),"Hello Airodrom! Could you please store my mailbox number: 818?","Hey, let’s remember that my mailbox number is 818.",'Please store my mailbox number 818',"Hello Airo, I’d like to save my mailbox number 818.",'Airo please save my mailbox number 818','Can you remember my mailbox number 818?','Airo, please save my mailbox number = 818!','Hi Nova, would you please save my mailbox number 818.']){
  const parsed=intent.parse(message,{nickname:'Nova'});assert.equal(parsed.kind,'private_storage',message);assert.equal(parsed.action,'save');assert.equal(parsed.label,'Mailbox number');assert.doesNotMatch(JSON.stringify(parsed),/\b818\b/);
 }
 assert.equal(intent.parse("What's my mailbox number?").action,'reveal');assert.equal(intent.parse('Hi Nova, please save my mailbox number 818.').kind,'private_storage');
 assert.equal(intent.parse('Hi Airo, please forget 12345678-1234-4123-8123-123456789012').kind,'forget');
});
test('quoted, negated, incomplete, multiline and ambiguous input cannot authorize a save',()=>{
 for(const message of ['Please store','Can you remember?',"Don't save my mailbox number 818",'Do not remember my mailbox number 818','Explain the text "save my mailbox number 818"','"Save my mailbox number 818"','Save my mailbox number','Maybe save my mailbox number 818','Hi Airo, save my mailbox number 818\nThanks','Please store my mailbox number 818 and send it']){
  assert.equal(intent.parse(message).kind,'clarify',message);
 }
 for(const message of ['Explain the phrase "remember I prefer TypeScript"','Do not save my name','I remember a poem'])assert.equal(intent.parse(message).kind,'conversation');
});
test('credential-looking input is refused before all storage and inference paths',async()=>{
 let calls=0;const server={conversationEngine:{start(){calls++;throw Error('No inference');}},rememberInteractive(){calls++;throw Error('No write');}};
 for(const message of ['Hi Airo, please save my mailbox number sk-proj-syntheticcanary','Can you remember my PIN 818?','Please store my password synthetic-password','Hi Airo, save my secret synthetic-value','Save my mailbox number password is synthetic-password','Remember my mailbox number 4111111111111111']){
  const receipt=await service.submit(server,{message,request_id:randomUUID()});assert.equal(receipt.kind,'secret',message);assert.doesNotMatch(JSON.stringify(receipt),/synthetic-password|syntheticcanary|818|4111111111111111/);
 }
 assert.equal(intent.parse('Hi Airo, let’s save a password.').kind,'vault');assert.equal(calls,0);
});
for(const canonical of [false,true])test('named Sensitive Memory confirms, survives reopening and remains outside inference and authority / '+canonical,async t=>{
 const f=await fixture(t);if(canonical)qualifyCanonical(f.bridge);const v=vaultFixture(t,f.root),out=output();
 const server=Object.create(ControlServer.prototype);server.bridge=f.bridge;server.conversationEngine={start(){throw Error('No inference');},nickname(){return 'Airo';}};
 const plan=await service.submit(server,{message:PHRASE,request_id:randomUUID()});assert.equal(plan.kind,'private_storage');assert.equal(f.bridge.personalMemory.stats().count,0);
 const receipt=await guide({input:new Terminal(['1\r','yes\r']),output:out,plan,message:PHRASE,vault:v.vault,request:body=>privateMemory.operate(f.bridge,body)});
 assert.equal(receipt.state,'saved');assert.match(out.text(),/Yes \/ No/);assert.match(out.text(),/\nYes\n/);assert.doesNotMatch(out.text()+JSON.stringify(receipt),/\b818\b/);const item=f.bridge.personalMemory.get(receipt.memoryId);assert.equal(item.content,'818');assert.equal(item.sensitivity,'sensitive');assert.match(item.subject,/^sensitive\.[a-f0-9-]+$/);
 assert.doesNotMatch(JSON.stringify(server.interactiveMemory('mailbox')),/\b818\b/);assert.throws(()=>server.rememberInteractive('My mailbox number is 818'),/Sensitive/);
 const packets=[],engine=new ConversationEngine(f.bridge,{qualify:async()=>({state:'READY',model:'ollama/qwen3-coder:30b'}),request:async(_url,options)=>{packets.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Hello.'}}]}));}});
 const chat=await engine.start({message:'Hi',request_id:randomUUID()});await engine.active.get(chat.turn_id)?.promise;assert.doesNotMatch(JSON.stringify(packets),/\b818\b/);await engine.close();
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n,0);assert.equal(f.calls(),0);
 await f.reopen();const lookup=privateMemory.operate(f.bridge,{action:'lookup',label:'Mailbox number'});assert.equal(lookup.items[0].memoryId,receipt.memoryId);assert.doesNotMatch(JSON.stringify(lookup),/\b818\b/);
 const reveal=output();assert.equal((await guide({input:new Terminal(['yes\r']),output:reveal,plan:intent.parse("What's my mailbox number?"),vault:v.vault,request:body=>privateMemory.operate(f.bridge,body)})).state,'revealed');assert.match(reveal.text(),/Yes \/ No/);assert.match(reveal.text(),/\nYes\n/);assert.match(reveal.text(),/mailbox number is 818/);
 f.bridge.personalMemory.forget(receipt.memoryId);assert.equal(privateMemory.operate(f.bridge,{action:'lookup',label:'Mailbox number'}).items.length,0);assert.throws(()=>privateMemory.operate(f.bridge,{action:'reveal',label:'Mailbox number',id:receipt.memoryId,confirmed:true}));
});
test('named Vault save requires choice and confirmation; fresh lookup uses current purpose and disposition',async t=>{
 const f=await fixture(t),v=vaultFixture(t,f.root),request=body=>privateMemory.operate(f.bridge,body),out=output();
 const saved=await guide({input:new Terminal(['2\r','yes\r']),output:out,plan:intent.parse(PHRASE),message:PHRASE,vault:v.vault,request});assert.equal(saved.state,'saved');assert.equal(v.values.get(saved.reference),'818');
 assert.doesNotMatch(out.text()+JSON.stringify(saved)+fs.readFileSync(path.join(v.home,'vault-dispositions.json'),'utf8'),/\b818\b/);
 const restarted=new SecretVault(v.home,v.port),reveal=output();assert.equal((await guide({input:new Terminal(['yes\r']),output:reveal,plan:intent.parse("What's my mailbox number?"),vault:restarted,request})).state,'revealed');assert.match(reveal.text(),/is 818/);
 assert.throws(()=>restarted.revealPrivate(saved.reference));assert.throws(()=>restarted.resolve(saved.reference,'gmail'));assert.throws(()=>restarted.put('999','operator',{kind:'private_identifier',name:'Mailbox number'}));
 const credential=restarted.put('synthetic-password','operator',{kind:'password'}),gmail=restarted.put('synthetic-oauth','gmail');for(const id of [credential.reference,gmail.reference])assert.throws(()=>restarted.revealPrivate(id,{confirmed:true}));
 restarted.forget(saved.reference);assert.equal(restarted.search('Mailbox number').length,0);assert.throws(()=>restarted.revealPrivate(saved.reference,{confirmed:true}));const dispositions=JSON.parse(fs.readFileSync(path.join(v.home,'vault-dispositions.json'),'utf8'));assert.deepEqual(Object.keys(dispositions.refs[saved.reference]).sort(),['purpose','state']);assert.doesNotMatch(JSON.stringify(dispositions),/Mailbox|\b818\b/);
});
test('cancellation, competing readers, stale confirmation and ambiguous backends cannot disclose or write silently',async t=>{
 const f=await fixture(t),v=vaultFixture(t,f.root),request=body=>privateMemory.operate(f.bridge,body),plan=intent.parse(PHRASE);
 for(const steps of [['3\r'],['1\r','no\r'],['1\r','\r'],['2\r','\x03']]){const cancelled=output();assert.equal((await guide({input:new Terminal(steps),output:cancelled,plan,message:PHRASE,vault:v.vault,request})).state,'cancelled');if(steps[0]==='1\r'){assert.match(cancelled.text(),/Yes \/ No/);assert.match(cancelled.text(),/\nNo\n/);}assert.doesNotMatch(cancelled.text(),/\b818\b/);}
 assert.deepEqual(v.calls,[]);assert.equal(privateMemory.operate(f.bridge,{action:'lookup',label:plan.label}).items.length,0);
 for(const input of [Object.assign(new Terminal(),{isTTY:false}),new Terminal()]){if(input.isTTY)input.on('data',()=>{});await assert.rejects(guide({input,output:output(),plan,message:PHRASE,vault:v.vault,request}));}
 const m=privateMemory.operate(f.bridge,{action:'save',label:plan.label,value:'818',confirmed:true});v.vault.put('999','operator',{kind:'private_identifier',name:plan.label});
 const out=output();assert.equal((await guide({input:new Terminal(['0\r']),output:out,plan:intent.parse("What's my mailbox number?"),vault:v.vault,request})).state,'cancelled');assert.doesNotMatch(out.text(),/818|999/);
 const stale=output();assert.equal((await guide({input:new Terminal([stream=>{f.bridge.personalMemory.forget(m.memoryId);stream.emit('data',Buffer.from('yes\r'));}]),output:stale,plan:intent.parse('What is my locker number?'),vault:v.vault,request:body=>body.action==='lookup'?{items:[{memoryId:m.memoryId}]}:request(body)})).state,'unavailable');assert.doesNotMatch(stale.text(),/\b818\b/);
});
test('operator endpoint denies anonymous callers, credentials, missing confirmation, wrong name and stale IDs',async t=>{
 const f=await fixture(t),server=new ControlServer(f.bridge,{port:0});await server.start();t.after(()=>server.close());
 server.conversationEngine.setPreference({nickname:'Nova'});const state=await fetch(server.origin+'/api/interactive/status',{headers:{Authorization:'Bearer '+server.token}});assert.equal(state.status,200);assert.equal((await state.json()).nickname,'Nova');
 assert.equal((await fetch(server.origin+'/api/interactive/status',{headers:{Authorization:'Bearer '+server.mcpToken}})).status,401);
 assert.equal((await fetch(server.origin+'/api/assistant/private-memory',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+server.mcpToken},body:JSON.stringify({action:'lookup',label:'Mailbox number'})})).status,401);
 const post=async(body,authorized=true)=>{const r=await fetch(server.origin+'/api/assistant/private-memory',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+server.token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 assert.equal((await post({action:'lookup',label:'Mailbox number'},false)).status,401);
 for(const body of [{action:'save',label:'Mailbox number',value:'818'},{action:'save',label:'Mailbox number',value:'synthetic-password',confirmed:true},{action:'save',label:'Password',value:'818',confirmed:true}])assert.equal((await post(body)).status,400);
 const saved=await post({action:'save',label:'Mailbox number',value:'818',confirmed:true});assert.equal(saved.status,200);assert.doesNotMatch(JSON.stringify(saved),/\b818\b/);
 assert.equal((await post({action:'reveal',label:'Locker number',id:saved.body.memoryId,confirmed:true})).status,400);
 assert.equal((await post({action:'reveal',label:'Mailbox number',id:saved.body.memoryId})).status,400);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n,0);
});
test('split queued input cannot confirm a private save or selected reveal before its fresh prompt',async t=>{
 const f=await fixture(t),v=vaultFixture(t,f.root),request=body=>privateMemory.operate(f.bridge,body);
 const terminal=()=>{const input=new(require('node:stream').PassThrough)();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};t.after(()=>input.destroy());return input;};
 for(const action of ['save','reveal']){
  if(action==='reveal'){privateMemory.operate(f.bridge,{action:'save',label:'Mailbox number',value:'818',confirmed:true});v.vault.put('999','operator',{kind:'private_identifier',name:'Mailbox number'});}
  const input=terminal(),out=output(),write=out.write;let queued=false,fresh=false;
  out.write=value=>{write(value);if(!queued&&value.includes(action==='save'?'Choose 1–3':'Choose an entry number')){queued=true;queueMicrotask(()=>{input.write(action==='save'?'2\r':'1\r');input.write('yes\r');});}if(!fresh&&value.includes(action==='save'?'Type yes to confirm':'Type yes to reveal')){fresh=true;setImmediate(()=>input.write('no\r'));}};
  const receipt=await guide({input,output:out,plan:intent.parse(action==='save'?PHRASE:"What's my mailbox number?"),message:PHRASE,vault:v.vault,request});
  assert.equal(receipt.state,'cancelled');assert.equal(queued,true);assert.equal(fresh,true);assert.doesNotMatch(out.text(),/Your mailbox number is|\b818\b|\b999\b/);
  if(action==='save'){assert.deepEqual(v.calls,[]);assert.equal(privateMemory.operate(f.bridge,{action:'lookup',label:'Mailbox number'}).items.length,0);}
  else assert.equal(v.calls.some(call=>call.op==='read'),false);
 }
});
test('direct model bypass and unsolicited model persistence claims fail closed',async t=>{
 const f=await fixture(t);let content='I have saved your information.',calls=0;const engine=new ConversationEngine(f.bridge,{qualify:async()=>({state:'READY',model:'ollama/qwen3-coder:30b'}),request:async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]}));}});t.after(()=>engine.close());
 await assert.rejects(engine.start({message:PHRASE,request_id:randomUUID()}),/deterministic host workflow/);assert.equal(calls,0);
 for(content of ['I have saved your information.',"I don't have the ability to store personal information.",'Your mailbox number is 818.']){const receipt=await engine.start({message:'Hi',request_id:randomUUID()});await engine.active.get(receipt.turn_id)?.promise;assert.equal(engine.result({conversation_id:receipt.conversation_id,turn_id:receipt.turn_id}).state,'failed');assert.equal(engine.db.prepare('SELECT response FROM cp_conversation_turns WHERE id=?').get(receipt.turn_id).response,null);}
});
test('a Vault rename during resolution invalidates the confirmed name before disclosure',async t=>{
 const f=await fixture(t),v=vaultFixture(t,f.root),saved=v.vault.put('818','operator',{kind:'private_identifier',name:'Mailbox number'}),out=output();
 const changing=new SecretVault(v.home,(op,id,value)=>{if(op==='read')v.vault.rename(saved.reference,'Locker number');return v.port(op,id,value);});
 const receipt=await guide({input:new Terminal(['yes\r']),output:out,plan:intent.parse("What's my mailbox number?"),vault:changing,request:()=>({items:[]})});
 assert.equal(receipt.state,'unavailable');assert.doesNotMatch(out.text(),/\b818\b/);
});
