'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {PassThrough,Readable}=require('node:stream');
const intent=require('../src/assistant-intent'),service=require('../src/assistant-service'),local=require('../src/local-bootstrap');
const {interactive}=require('../src/interactive-cli'),render=require('../src/assistant-render');
const EXACT='Airo, open an authenticated browser session for app.monarch.com. I will sign in manually.';
const ORIGIN='https://app.monarch.com/';
test('exact installed failure and natural authenticated requests reach a valueless manual-login offer',async()=>{
 const server={conversationEngine:{nickname:()=> 'Nova',start(){throw Error('Authentication cannot enter model chat');}}};
 for(const message of [EXACT,'Airo, explore my Monarch account and compare it with Arecibo.',"I'm already logged in to Monarch; inspect my account",'Open an authenticated session for https://app.monarch.com/','Please open a dedicated browser session for app.monarch.com','Nova, open an authenticated browser session for app.monarch.com. I will sign in manually.','Log into https://app.monarch.com/','I can sign in to Monarch myself.','Airo, use my authenticated Monarch account for research.','Airo, open an authenticated browser session for app.monarch.com. I will enter my password manually in the browser.','Airo, research https://app.monarch.com/; I will sign in manually.']){
  const offer=await service.submit(server,{message,request_id:randomUUID()});assert.equal(offer.kind,'research_session',message);assert.equal(offer.entry_url,ORIGIN);assert.equal(offer.authority,false);assert.match(offer.message,/not inherited/);
 }
 assert.equal(require('../src/provider-policy').operatorSecretLike(EXACT),false);
 // Display/provider policies stay conservative; this is operator syntax only.
 assert.notEqual(require('../src/secret-observation').redactText(EXACT),EXACT);
 assert.equal(require('../src/provider-policy').secretLike(EXACT),true);
 assert.equal(intent.secret('Send a draft to reader@example.com'),false,'Ordinary email addresses are not bare credential URLs');
 const manual='I will enter my password manually in the browser.';assert.equal(intent.secret(manual),false);assert.equal(require('../src/provider-policy').secretLike(manual),true);assert.notEqual(require('../src/secret-observation').redactText(manual),manual);
});
test('whole mixed submissions retain strict secret screening before browser routing',()=>{
 const values=['password=synthetic-canary','password is synthetic-canary','token: synthetic-canary','api_key=synthetic-canary','session=synthetic-canary','browser session synthetic-canary','Authorization: Bearer synthetic-canary','Cookie: session=synthetic-canary','sk-proj-syntheticcanaryvalue','https://user:synthetic-canary@app.monarch.com/','https://app.monarch.com/?token=synthetic-canary','https://app.monarch.com/?next=synthetic-canary','https://app.monarch.com/auth/synthetic-canary','https://app.monarch.com/%61uth/synthetic-canary','https://app.monarch.com/#access_token=synthetic-canary','ＰＡＳＳＷＯＲＤ=synthetic-canary'];
 for(const value of values){const result=intent.parse(EXACT+' '+value);assert.equal(result.kind,'secret',value);assert.doesNotMatch(JSON.stringify(result),/synthetic-canary|syntheticcanaryvalue/);}
 for(const message of ['session for app.monarch.com','session synthetic-canary','authenticated session=synthetic-canary'])assert.equal(intent.parse(message).kind,'secret');
 for(const suffix of ['password is synthetic-canary','password=synthetic-canary','password: synthetic-canary','token=synthetic-canary','Cookie: session=synthetic-canary','Authorization: Bearer synthetic-canary','https://user:synthetic-canary@app.monarch.com/','unknown value synthetic-canary'])assert.equal(intent.parse('Open an authenticated browser session for app.monarch.com. I will enter my password manually in the browser. '+suffix).kind,'secret');
 for(const message of ['Open an authenticated browser session for=synthetic-canary app.monarch.com','Open an authenticated session to=synthetic-canary app.monarch.com','Open a browser session for synthetic-canary app.monarch.com','Open an authenticated browser session for "synthetic-canary" app.monarch.com','Open an authenticated browser session for <synthetic-canary> app.monarch.com'])assert.equal(intent.parse(message).kind,'secret');
});
test('manual-login follow-ups use only fresh host operator domain context, with no automatic consent',async t=>{
 t.mock.method(require('../src/assistant-missions'),'newMission',async()=>({kind:'mission',state:'draft'}));
 const one=randomUUID(),two=randomUUID(),server={conversationEngine:{requireSession:id=>({id}),start:async()=>({kind:'chat'})}};
 const submit=(message,conversation_id=one)=>service.submit(server,{message,conversation_id,request_id:randomUUID()});
 await submit('Research https://app.monarch.com/ and compare it with Arecibo');
 const follow=await submit('I will sign in manually.');assert.equal(follow.kind,'research_session');assert.equal(follow.entry_url,ORIGIN);assert.equal(follow.authority,false);
 assert.equal((await submit('I will sign in manually.',two)).kind,'clarify');
 assert.equal((await submit('I will sign in manually. Use https://other.example/')).entry_url,'https://other.example/');
 await submit('Hello');assert.equal((await submit('I will sign in manually.')).kind,'clarify');
 await submit(EXACT);server.pendingResearch.get(one).expires=Date.now()-1;assert.equal((await submit('I will sign in manually.')).kind,'clarify');
 await submit(EXACT);assert.equal((await submit('I will sign in manually. password=synthetic-canary')).kind,'secret');assert.equal((await submit('I will sign in manually.')).kind,'clarify');
 assert.equal((await service.submit(server,{message:'I will sign in manually.',request_id:randomUUID()})).kind,'clarify');
});
test('authentication scope and mixed action instructions cannot broaden the approved read-only domain',()=>{
 for(const message of ['Open an authenticated browser for https://app.monarch.com/ and https://other.example/','Open an authenticated browser for https://app.monarch.com/ and other.example','Open an authenticated browser for https://app.monarch.com/settings','Open an authenticated browser for http://app.monarch.com/','Open an authenticated browser for https://127.0.0.1/','Open an authenticated browser for https://app.monarch.com/ and export my data','Open an authenticated browser for https://app.monarch.com/ and change account settings','Open an authenticated browser for https://app.monarch.com/ and bypass MFA']){
  const parsed=intent.parse(message);assert.equal(parsed.kind,'clarify',message);assert.equal(parsed.entry_url,undefined);
 }
 for(const address of ['user:synthetic-canary@app.monarch.com','app.monarch.com?next=synthetic-canary','app.monarch.com:8080','app.monarch.com#private-route','user%3Asynthetic-canary@app.monarch.com','ftp://app.monarch.com','app.monarch.com/%64ashboard','app.monarch.com/auth/synthetic-canary']){const parsed=intent.parse('Open an authenticated browser session for '+address);assert.ok(['secret','clarify'].includes(parsed.kind),address);assert.equal(parsed.entry_url,undefined);assert.doesNotMatch(JSON.stringify(parsed),/synthetic-canary|private-route/);}
});
function cliFixture(t,request){
 const input=new PassThrough(),output=new PassThrough(),calls=[];let text='';output.on('data',chunk=>text+=chunk);
 t.mock.method(local,'start',async()=>({default_runtime:'opencode'}));
 t.mock.method(local,'request',async(home,route,body)=>{if(route==='/api/interactive/memory?query=name')return {items:[]};calls.push({route,body});return request(route,body);});
 const wait=needle=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{output.off('data',check);reject(Error('Synthetic terminal output unavailable'));},3000);const check=()=>{if(text.includes(needle)){clearTimeout(timer);output.off('data',check);resolve();}};output.on('data',check);check();});
 return {input,output,calls,text:()=>text,wait};
}
test('exact natural terminal request opens detached visible consent and cancel performs no browser operation',async t=>{
 const server={conversationEngine:{requireSession:id=>({id}),start(){throw Error('No model');}}};
 const f=cliFixture(t,(route,body)=>{if(route==='/api/assistant/conversation/session')return {conversation_id:randomUUID()};assert.equal(route,'/api/assistant/input');return service.submit(server,body);});
 f.input.isTTY=true;f.input.isRaw=false;f.input.setRawMode=v=>f.input.isRaw=v;f.output.isTTY=true;
 const running=interactive('synthetic',{input:f.input,output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});
 await f.wait('You › ');f.input.write(EXACT+'\npasted-private-canary\n');await f.wait('Choose [1/2]');assert.equal(f.input.listenerCount('data'),1,'Only native consent reader owns input');
 f.input.write('2\n');await f.wait('authorization cancelled');await new Promise(resolve=>setImmediate(resolve));f.input.write('/quit\n');await running;
 assert.match(f.text(),/AUTHENTICATED PRODUCT RESEARCH\nhttps:\/\/app.monarch.com/);assert.doesNotMatch(f.text(),/Credentials typed|pasted-private-canary|Mission .*dispatching/);
 assert.equal(f.calls.filter(c=>c.route==='/api/assistant/input').length,1);assert.equal(f.calls.some(c=>c.route==='/api/assistant/research/session'),false);assert.equal(f.input.isRaw,false);assert.equal(f.input.listenerCount('data'),0);
});
const REPORT={markdown:'# Example — competitor research\n\n## Survey coverage\n\n- **Transactions — unknown**. Not established. [E1](<https://research.example/features>) [B1](#b1)\n\n## Evidence and screenshots\n\n### E1\n\n[Public \\[features\\]](<https://research.example/features>)\n\n### B1\n\ndocs/product\\_scope.md:1–2',report:{sections:{comparison:[{status:'unknown'}]},references:[{url:'https://research.example/features'}]},authority:false};
test('verified report display preserves evidence labels and readable URLs while removing generated Markdown',()=>{
 const original=JSON.stringify(REPORT),text=render.researchReport(REPORT);
 assert.match(text,/Survey coverage\n\n• Transactions — unknown/);assert.match(text,/\[E1\] https:\/\/research.example\/features \[B1\]/);assert.match(text,/Public \[features\] — https:\/\/research.example\/features/);assert.match(text,/docs\/product_scope.md/);
 assert.doesNotMatch(text,/^#+ |\*\*|\]\(<|\]\(#|\\[\[\]_*]/m);assert.equal(JSON.stringify(REPORT),original);
 assert.doesNotMatch(render.researchReport({markdown:'# Test\u001b]52;c;canary\u0007\n\n- Value\u0000'}),/\u001b|canary|\u0000/);
});
test('automatic terminal reports render prose; explicit report --json retains structured developer evidence',async t=>{
 const f=cliFixture(t,(route,body)=>{
  if(route==='/api/assistant/conversation/session')return {conversation_id:randomUUID()};
  if(route==='/api/assistant/input')return {kind:'mission',mission_id:'synthetic-mission',state:'dispatching',browser_research_available:true};
  if(route.startsWith('/api/interactive/task?'))return {state:'awaiting_acceptance'};
  assert.equal(route,'/api/assistant/research/report?mission_id=synthetic-mission');return REPORT;
 });
 await interactive('synthetic',{input:Readable.from(['Research https://research.example/\n/research report\n/research report --json\n/quit\n']),output:f.output,env:{NO_COLOR:'1',TERM:'dumb'}});
 const split=f.text().indexOf('{\n  "markdown"');assert.ok(split>0);const prose=f.text().slice(0,split),developer=f.text().slice(split);
 assert.match(prose,/• Transactions — unknown/);assert.doesNotMatch(prose,/^#+ |\*\*|\]\(<|\]\(#/m);assert.match(developer,/"sections"/);assert.match(developer,/"references"/);assert.match(developer,/"markdown"/);assert.equal(f.calls.filter(c=>c.route.startsWith('/api/assistant/research/report?')).length,3);
});
