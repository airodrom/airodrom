'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PassThrough,Readable}=require('node:stream');
const {fixture}=require('./fixtures/mission-fixture.cjs'),{runtime}=require('./fixtures/opencode-fixture.cjs');
const local=require('../src/local-bootstrap'),ControlServer=require('../src/control-server');
const {interactive,parseLine}=require('../src/interactive-cli');
test('pasted command prompts and local shell flags never become conversation requests',()=>{
 for(const [line,expected]of [['You › /models','models'],['> /workers --json','workers'],['--version','version'],['--help','help']])assert.equal(parseLine(line).command,expected);
 assert.equal(parseLine('/workers --json').json,true);assert.equal(parseLine('/remember literal --json').json,false);
 assert.equal(parseLine('/connectorsAirodrom').command,'connectorsAirodrom');
});
test('interactive V2 renders human views, rejects unsafe selection and preserves the canonical review rail',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,old=b.dataDir,home=path.join(f.root,'v2');local.privateDirectory(home,true);b.dataDir=local.privateDirectory(path.join(home,'data'),true);
 const server=new ControlServer(b,{port:0}),address=await server.start();local.writePrivate(path.join(b.dataDir,'ui.json'),{...address,pid:process.pid});fs.writeFileSync(path.join(b.dataDir,'bridge.lock'),String(process.pid),{mode:0o600});
 t.after(async()=>{await server.close();b.dataDir=old;});
 const output=new PassThrough();let text='';output.on('data',c=>text+=c);
 await interactive(home,{input:Readable.from(['/models\n/model ollama/qwen3-coder:30b\n/model auto\n/model local\n/model unknown\n/model auto\n/workers\n/worker codex\n/worker claude_code\n/worker cursor\n/connectors\n/sensitive\n/vault\n/runtime --json\nYou › --version\n/mcp\n/connectorsAirodrom\nRemember that my name is Aurora.\nWhat do you remember about my name?\nForget my name\nExplain a synthetic greeting\n/quit\n']),output,env:{NO_COLOR:'1',TERM:'dumb'}});
 for(const expected of ['MODELS','Qwen3 Coder 30B','MANUAL','Routing: AUTO','WORKERS','NOT QUALIFIED','DENIED','CONNECTORS','Gmail','WhatsApp','SENSITIVE MEMORY','SECRET VAULT','Remembered in Personal Memory V2.','Aurora','Forgotten.','shell transport','Verification: operator review','Review: /accept','Settlement: waiting acceptance'])assert.ok(text.includes(expected),expected);
 assert.equal((text.match(/Selection unavailable/g)||[]).length,4);
 assert.doesNotMatch(text,/"qualification"|"data_classes"|"active_refs"|\x1b|Bearer |token=/);
 assert.match(text,/"runtime": "opencode"/); // JSON is explicit only.
 const missions=b.controlStore.listMissions({limit:10});assert.equal(missions.length,1);assert.equal(missions[0].envelope.preferred_agent,'opencode');assert.equal(missions[0].envelope.model_route_mode,'AUTO');assert.equal(missions[0].state,'awaiting_acceptance');
 assert.equal(server.interactiveMemory('name').items.length,0);
});
test('selected conversation history uses the existing current-context erasure projection',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),server=new ControlServer(f.bridge,{port:0});await server.start();t.after(()=>server.close());
 const memory=server.rememberInteractive('My test codename is Silver Falcon.');const m=f.bridge.missions.createConversation({message:'What is my test codename?',include_memory:true,request_id:require('node:crypto').randomUUID()});f.bridge.missions.dispatch(m.mission_id,{request_id:'v2-history'});await f.settle(m.mission_id);
 const read=async()=>{const response=await fetch(server.origin+'/api/assistant/history?mission_id='+m.mission_id,{headers:{Authorization:'Bearer '+server.token}});return response.json();};
 assert.match(JSON.stringify(await read()),/Silver Falcon/);f.bridge.forgetPersonalMemory(memory.memoryId);assert.doesNotMatch(JSON.stringify(await read()),/Silver Falcon/);
});
