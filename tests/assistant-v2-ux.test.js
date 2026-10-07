'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PassThrough,Readable}=require('node:stream');
const {fixture}=require('./fixtures/mission-fixture.cjs'),{runtime}=require('./fixtures/opencode-fixture.cjs');
const local=require('../src/local-bootstrap'),ControlServer=require('../src/control-server');
const {interactive,parseLine}=require('../src/interactive-cli');
test('pasted command prompts and local shell flags never become conversation requests',()=>{
 for(const [line,expected]of [['You › /models','models'],['> /workers --json','workers'],['--version','version'],['--help','help']])assert.equal(parseLine(line).command,expected);
 assert.equal(parseLine('/details --json').json,true);assert.equal(parseLine('/workers --json').json,true);assert.equal(parseLine('/remember literal --json').json,false);
 assert.equal(parseLine('/connectorsAirodrom').command,'connectorsAirodrom');
});
test('interactive V2 renders human views, rejects unsafe selection and keeps the canonical review rail behind explicit details',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,old=b.dataDir,home=path.join(f.root,'v2');local.privateDirectory(home,true);b.dataDir=local.privateDirectory(path.join(home,'data'),true);
 const server=new ControlServer(b,{port:0,conversationOptions:require('./fixtures/direct-conversation-fixture.cjs').conversationOptions()}),address=await server.start();local.writePrivate(path.join(b.dataDir,'ui.json'),{...address,pid:process.pid});fs.writeFileSync(path.join(b.dataDir,'bridge.lock'),String(process.pid),{mode:0o600});
 t.after(async()=>{await server.close();b.dataDir=old;});
 const output=new PassThrough();let text='';output.on('data',c=>text+=c);
 await interactive(home,{input:Readable.from(['/models\n/model ollama/qwen3-coder:30b\n/model auto\n/model local\n/model unknown\n/model auto\n/workers\n/worker codex\n/worker claude_code\n/worker cursor\n/connectors\n/sensitive\n/vault\n/runtime --json\nYou › --version\n/mcp\n/connectorsAirodrom\nRemember that my name is Aurora.\nWhat do you remember about my name?\nForget my name\nExplain a synthetic greeting\n/details\n/quit\n']),output,env:{NO_COLOR:'1',TERM:'dumb'}});
 for(const expected of ['MODELS','Qwen3 Coder 30B','MANUAL','Routing: AUTO','WORKERS','NOT QUALIFIED','DENIED','CONNECTORS','Gmail','WhatsApp','SENSITIVE MEMORY','Secure Vault requires an interactive operator terminal','Thank you, Aurora.','Aurora','Forgotten.','shell transport','No Mission is selected.'])assert.ok(text.includes(expected),expected);
 assert.equal((text.match(/Selection unavailable/g)||[]).length,4);
 assert.doesNotMatch(text,/"qualification"|"data_classes"|"active_refs"|\x1b|Bearer |token=/);
 assert.match(text,/"runtime": "opencode"/); // JSON is explicit only.
 const missions=b.controlStore.listMissions({limit:10});assert.equal(missions.length,0);assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_conversation_turns').get().n,1);
 assert.equal(server.interactiveMemory('name').items.length,0);
});
test('selected conversation history uses the existing current-context erasure projection',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),server=new ControlServer(f.bridge,{port:0});await server.start();t.after(()=>server.close());
 const memory=server.rememberInteractive('My test codename is Silver Falcon.');const m=f.bridge.missions.createConversation({message:'What is my test codename?',include_memory:true,request_id:require('node:crypto').randomUUID()});f.bridge.missions.dispatch(m.mission_id,{request_id:'v2-history'});await f.settle(m.mission_id);
 const read=async()=>{const response=await fetch(server.origin+'/api/assistant/history?mission_id='+m.mission_id,{headers:{Authorization:'Bearer '+server.token}});return response.json();};
 assert.match(JSON.stringify(await read()),/Silver Falcon/);f.bridge.forgetPersonalMemory(memory.memoryId);assert.doesNotMatch(JSON.stringify(await read()),/Silver Falcon/);
});

const render=require('../src/assistant-render');
test('waiting animation is indeterminate, width bounded, portable and erased exactly once',()=>{
 for(const columns of [1,4,8,16,24,32,80])for(const mode of ['none','16','256','truecolor']){
  const frame=render.waitingFrame({elapsed:2400,columns,mode});
  assert.ok(require('node:util').stripVTControlCharacters(frame).length<columns);
  assert.doesNotMatch(frame,/%|\n|running|Memory/);
  if(mode==='none')assert.doesNotMatch(frame,/\x1b/);
 }
 let elapsed=0,draw,cancelled=0,text='';
 const output={isTTY:true,columns:40,write:s=>text+=s},controller=new AbortController();
 const indicator=render.waiting(output,{env:{NO_COLOR:''},signal:controller.signal,now:()=>elapsed,schedule:fn=>{draw=fn;return 1;},unschedule:()=>cancelled++});
 elapsed=2400;draw();assert.match(text,/2\.4s/);assert.doesNotMatch(text,/\x1b\[(?:38|34|96)/);
 output.columns=8;draw();controller.abort();indicator.stop();
 assert.equal(cancelled,1);assert.ok(text.endsWith('\r\x1b[2K'));
 const stopped=text;draw();assert.equal(text,stopped);
 let interval;
 const reduced=render.waiting(output,{env:{AIRODROM_REDUCED_MOTION:'1'},schedule:(_,ms)=>{interval=ms;return 1;},unschedule:()=>{}});
 assert.equal(interval,1000);reduced.stop();
 const a=render.waitingFrame({elapsed:100,columns:80,reduced:true}),b=render.waitingFrame({elapsed:2400,columns:80,reduced:true});
 assert.equal(a.replace(/[\d.]+s$/,''),b.replace(/[\d.]+s$/,''));
 for(const [isTTY,env]of [[false,{}],[true,{TERM:'dumb'}]]){
  let wrote=false;render.waiting({isTTY,write:()=>wrote=true},{env,schedule:()=>assert.fail('No timer on a plain terminal')}).stop();assert.equal(wrote,false);
 }
});
test('ordinary chat returns a direct answer without registering a Work Mission',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,old=b.dataDir,home=path.join(f.root,'clean');local.privateDirectory(home,true);b.dataDir=local.privateDirectory(path.join(home,'data'),true);
 const server=new ControlServer(b,{port:0,conversationOptions:require('./fixtures/direct-conversation-fixture.cjs').conversationOptions()}),address=await server.start();local.writePrivate(path.join(b.dataDir,'ui.json'),{...address,pid:process.pid});fs.writeFileSync(path.join(b.dataDir,'bridge.lock'),String(process.pid),{mode:0o600});t.after(async()=>{await server.close();b.dataDir=old;});
 const output=new PassThrough();let text='';output.on('data',c=>text+=c);
 await interactive(home,{input:Readable.from(['Hi\n/quit\n']),output,env:{NO_COLOR:'1',TERM:'dumb'}});
 assert.match(text,/You › Hi\n\nAiro\nfixture result/);
 assert.doesNotMatch(text,/· running|Provider|Model|Memory:|Verification:|Review:|Settlement:|─|\x1b|fresh bounded Mission/);
 assert.equal(b.controlStore.listMissions({limit:1}).length,0);assert.equal(b.controlStore.db.prepare("SELECT count(*) n FROM cp_conversation_turns WHERE state='completed'").get().n,1);
});
test('TTY waiting fish is removed before answer, failure, admission failure and cancellation and never leaks a timer',async t=>{
 const originalStart=local.start,originalRequest=local.request;
 t.after(()=>{local.start=originalStart;local.request=originalRequest;});
 local.start=async()=>({default_runtime:'opencode'});
 for(const outcome of ['answer','failure','admission_failure','cancel']){
  const output=new PassThrough();output.isTTY=true;output.columns=32;let text='',cancelRequests=0;
  output.on('data',chunk=>{text+=chunk;if(outcome==='cancel'&&String(chunk).includes('Thinking'))queueMicrotask(()=>process.emit('SIGINT'));});
  local.request=async(_,route)=>{
   if(route==='/api/assistant/conversation/session')return {conversation_id:'synthetic-session'};
   if(route==='/api/assistant/input'){if(outcome==='admission_failure')throw Error('Synthetic admission failure');return {kind:'conversation',mission_id:'synthetic'};}
   if(route==='/api/interactive/cancel'){cancelRequests++;return {};}
   if(route.startsWith('/api/interactive/task')){await new Promise(r=>setTimeout(r,100));return outcome==='answer'?{state:'awaiting_acceptance',summary:'Hello.'}:outcome==='failure'?{state:'needs_rework',reason:'Synthetic failure'}:{state:'running'};}
   assert.fail('Ordinary conversation must not fetch the detail rail');
  };
  await interactive('/synthetic',{input:Readable.from(['Hi\n/quit\n']),output,env:{TERM:'xterm-256color'}});
  assert.match(text,/Thinking/);assert.match(text,/>\x1b\[[\d;]+m<\x1b\[[\d;]+mo\x1b\[[\d;]+m>/);
  assert.ok(text.includes('\r\x1b[2K'+(outcome==='answer'?'Hello.':'Airo: ')));
  assert.equal(cancelRequests,outcome==='cancel'?1:0);
  const stopped=text;await new Promise(r=>setTimeout(r,160));assert.equal(text,stopped);
 }
});
test('waiting fish preserves the original water frames and every palette sequence outside its footprint',()=>{
 const strip=require('node:util').stripVTControlCharacters;
 const originals=[
  [0,'⠿ Thinking  ⠶⣤⣤⣴⠶⠟⠛⠛⠒⠤⢤⣤⠤⠶⠛⠛⠻⠷⣦⣤  0.0s'],
  [800,'⠿ Thinking  ⠛⠛⠒⠢⠤⣤⡤⠶⠞⠛⠛⠷⢶⣤⣤⠤⠔⠒⠛⠓  0.8s'],
  [2400,'⠿ Thinking  ⠶⠦⣤⣤⠤⠖⠚⠛⠛⠶⣦⣤⣤⡶⠖⠛⠛⠒⠦⢤  2.4s']
 ];
 for(const [elapsed,original]of originals)assert.equal(render.waitingFrame({elapsed,fish:false}),original);
 for(const mode of ['none','16','256','truecolor'])for(const elapsed of [0,800,2240,3200,4000,4270,4800,6320,6400]){
  const baseline=render.waitingFrame({elapsed,mode,fish:false}),added=render.waitingFrame({elapsed,mode}),before=strip(baseline),after=strip(added);
  const body=after.match(/><o>|><ᵒ>|˃˂ᵒ˃/);assert.ok(body);
  assert.equal(after.length,before.length);
  assert.equal(after.slice(0,body.index),before.slice(0,body.index));
  assert.equal(after.slice(body.index+4),before.slice(body.index+4));
  assert.deepEqual(added.match(/\x1b\[[\d;]+m/g),baseline.match(/\x1b\[[\d;]+m/g));
 }
});
test('waiting fish swims right, rises and falls along its jump, and leaves only a brief dot splash',()=>{
 const strip=require('node:util').stripVTControlCharacters,frame=elapsed=>strip(render.waitingFrame({elapsed,mode:'truecolor'}));
 assert.match(frame(0),/><o>/);assert.ok(frame(1600).indexOf('><o>')>frame(0).indexOf('><o>'));
 assert.match(frame(2240),/><ᵒ>/);assert.match(frame(3200),/˃˂ᵒ˃/);assert.match(frame(4000),/><ᵒ>/);assert.match(frame(4270),/><o>/);
 const splash=frame(4400),base=strip(render.waitingFrame({elapsed:4400,fish:false})),position=splash.indexOf('><o>');
 for(let i=0;i<base.length;i++)if(i<position||i>=position+4){
  if(i===position-1||i===position+4){const mask=base.charCodeAt(i)-0x2800,dot=i===position-1?8:1;assert.equal(splash.charCodeAt(i)-0x2800,mask|dot);}
  else assert.equal(splash[i],base[i]);
 }
 assert.equal(frame(6320).indexOf('><o>'),'⠿ Thinking  '.length+16);
 assert.equal(frame(6400).indexOf('><o>'),frame(0).indexOf('><o>'));
});
test('waiting fish stays whole on resize, uses ASCII without color, and remains static with reduced motion',()=>{
 const strip=require('node:util').stripVTControlCharacters;
 let draw,elapsed=0,writes=[],schedules=0,clears=0;
 const output={isTTY:true,columns:80,write:s=>writes.push(s)},controller=new AbortController();
 const indicator=render.waiting(output,{env:{TERM:'xterm-256color'},signal:controller.signal,now:()=>elapsed,schedule:(fn,ms)=>{draw=fn;schedules++;assert.equal(ms,80);return 1;},unschedule:()=>clears++});
 for(const columns of [80,36,28,27,26,22,16,8,1,80]){
  output.columns=columns;elapsed=3200;draw();const frame=strip(writes.at(-1)).slice(1);
  assert.ok(frame.length<columns);assert.doesNotMatch(writes.at(-1),/\n|\x1b\[[\d;]*[AHJ]/);
  if(columns>=27)assert.match(frame,/˃˂ᵒ˃/);else assert.doesNotMatch(frame,/[<>˃˂ᵒ]/);
 }
 assert.equal(schedules,1);controller.abort();indicator.stop();assert.equal(clears,1);
 const count=writes.length;draw();assert.equal(writes.length,count);
 for(const elapsed of [0,2240,3200,4400,6400]){
  const mono=render.waitingFrame({elapsed,mode:'none'});assert.match(mono,/><o>/);assert.doesNotMatch(mono,/\x1b|˃|˂|ᵒ/);
  const reduced=strip(render.waitingFrame({elapsed,mode:'truecolor',reduced:true}));assert.match(reduced,/><o>/);
  assert.equal(reduced.replace(/[\d.]+s$/,''),strip(render.waitingFrame({mode:'truecolor',reduced:true})).replace(/[\d.]+s$/,''));
 }
 for(const env of [{AIRODROM_REDUCED_MOTION:'true'},{REDUCE_MOTION:'yes'}]){
  const still=render.waiting(output,{env,schedule:(_,ms)=>{assert.equal(ms,1000);return 1;},unschedule:()=>{}});still.stop();
 }
 const aborted=new AbortController();aborted.abort();render.waiting(output,{signal:aborted.signal,schedule:()=>assert.fail('No timer after abort')}).stop();
});
