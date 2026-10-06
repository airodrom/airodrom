'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {OpenAICompatibleProvider}=require('../src/openai-compatible-provider');
const {initialProfiles}=require('../src/provider-profiles');
const {ProviderSecrets}=require('../src/provider-secrets');
const {ProviderGateway}=require('../src/provider-gateway');
const {CapabilityBroker}=require('../src/capability-broker');
const SafetyPolicy=require('../src/safety-policy');
const {SafeDiagnostics}=require('../src/safe-diagnostics');
const req=()=>({request_id:'http-fixture',run_id:'fixture-run',messages:[{role:'user',content:'Synthetic public fixture.'}],data_class:'public',project_policy:{approved_external:{public:['deepseek']}},reasoning_mode:'disabled',max_output:16});
const body={choices:[{finish_reason:'stop',message:{role:'assistant',content:'fixture reply'}}]};
test('generic adapter executes deterministic HTTP fixture and maps bearer privately',async t=>{
 let observed=false;const server=http.createServer((q,r)=>{let text='';q.on('data',c=>text+=c);q.on('end',()=>{observed=q.method==='POST'&&q.headers.authorization==='Bearer fixture-http-only'&&JSON.parse(text).thinking.type==='disabled';r.writeHead(200,{'Content-Type':'application/json'});r.end('\n\n'+JSON.stringify(body));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const profile=initialProfiles().find(p=>p.id==='deepseek');const a=new OpenAICompatibleProvider({profile,baseUrl:'https://api.deepseek.com',secret:new ProviderSecrets({references:{deepseek:'fixture/ref'},read:async()=> 'fixture-http-only'}).forProvider('deepseek'),request:(_url,options)=>fetch('http://127.0.0.1:'+server.address().port+'/chat/completions',options)});
 const result=await a.execute(req(),a.models()[0]);assert.equal(result.status,'completed');assert.equal(observed,true);assert.equal(result.text,'fixture reply');assert.ok(!JSON.stringify(result).includes('fixture-http-only'));
});
test('timeout bounded on real HTTP fixture',async t=>{
 const server=http.createServer(()=>{});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const profile={...initialProfiles()[0],models:initialProfiles().find(p=>p.id==='deepseek').models};const a=new OpenAICompatibleProvider({profile,baseUrl:'http://127.0.0.1:'+server.address().port,timeoutMs:25});const result=await a.execute({...req(),reasoning_mode:'disabled'},a.models()[0]);assert.equal(result.error_class,'temporary_failure');
});
test('response byte bound rejects oversized payload',async()=>{const profile=initialProfiles()[0],a=new OpenAICompatibleProvider({profile,baseUrl:'http://127.0.0.1:11434/v1',request:async()=>new Response(' '.repeat(1048577))});const result=await a.execute({...req(),reasoning_mode:undefined},a.models()[0]);assert.equal(result.error_class,'invalid_response');});
test('actual Capability Broker denies candidate execution under reasoning admission',async()=>{
 const profile=initialProfiles().find(p=>p.id==='deepseek'),tools=[{name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}];
 const a=new OpenAICompatibleProvider({profile,baseUrl:'https://api.deepseek.com',secret:new ProviderSecrets({references:{deepseek:'fixture/ref'},read:async()=> 'fixture-http-only'}).forProvider('deepseek'),request:async()=>new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:'read',arguments:'{"path":"fixture.txt"}'}}]}}]}))});
 const result=await a.execute({...req(),tools},a.models()[0]);const c=result.tool_requests[0],task={id:'fixture-task',sessionId:'fixture-session',status:'running',reasoningMode:'reasoning_only',workspace:process.cwd(),mission:{id:'fixture-mission'}};
 const policy=new SafetyPolicy();policy.registerTask(task);const broker=new CapabilityBroker({policy,diagnostics:new SafeDiagnostics(policy),getTask:()=>task});
 const denied=await broker.execute(task.id,{toolName:c.toolName,toolCallId:c.toolCallId,input:c.input});assert.equal(denied.allow,false);assert.equal(denied.decision.kind,'reasoning_execution_denied');assert.equal(task.mission.id,'fixture-mission');
});
test('authorization input frozen across async admission',async()=>{const g=new ProviderGateway({authorize:async input=>{assert.equal(Object.isFrozen(input.messages),true);return false;}});assert.equal((await g.execute(req())).error_class,'reasoning_admission_denied');});
test('unknown HTTP error body cannot leak secrets',async()=>{const profile=initialProfiles().find(p=>p.id==='deepseek');const a=new OpenAICompatibleProvider({profile,baseUrl:'https://api.deepseek.com',secret:new ProviderSecrets({references:{deepseek:'fixture/ref'},read:async()=> 'fixture-http-only'}).forProvider('deepseek'),request:async()=>new Response('Bearer fixture-http-only https://api.test/?token=fixture-http-only',{status:418})});const r=await a.execute(req(),a.models()[0]);assert.equal(r.error_class,'unknown_error');assert.ok(!JSON.stringify(r).includes('fixture-http-only'));});
test('provider operations require operator auth and cannot reset active inference',async t=>{
 const {DatabaseSync}=require('node:sqlite'),{EventLedger}=require('../src/event-ledger'),{ControlPlaneStore}=require('../src/control-plane-store'),ControlServer=require('../src/control-server');
 const db=new DatabaseSync(':memory:'),ledger=new EventLedger(db);db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');const store=new ControlPlaneStore({db,ledger}),g=new ProviderGateway({db});
 const bridge={controlStore:store,providerGateway:g,ledger,closed:false,policy:{list:()=>[]}},server=new ControlServer(bridge,{port:0,token:'operator-fixture',mcpToken:'mcp-fixture'});await server.start();t.after(async()=>{await new Promise(r=>server.server.close(r));db.close();});
 const post=(action,value,token='operator-fixture')=>fetch(server.origin+'/api/control-v2/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(value)});
 const observe={id:'deepseek',state:'available',request_id:'observe-fixture'};
 assert.equal((await post('provider-observe',observe,'mcp-fixture')).status,401);assert.equal((await post('provider-observe',observe)).status,200);assert.equal(g.registry.get('deepseek').adapter.health().state,'auth_required');
 const reset={id:'deepseek',profile:'deepseek-flash:disabled',request_id:'reset-fixture'};
 db.prepare('INSERT INTO cp_provider_requests(run_id,request_id,state,record_id) VALUES(?,?,?,?)').run('fixture-run','fixture-request','consumed',require('node:crypto').randomUUID());assert.equal((await post('provider-circuit-reset',reset)).status,400);
 db.prepare("UPDATE cp_provider_requests SET state='settled'").run();assert.equal((await post('provider-circuit-reset',reset)).status,200);
 const view=await(await fetch(server.origin+'/api/control-v2/providers',{headers:{Authorization:'Bearer operator-fixture'}})).json();assert.equal(view.items.find(p=>p.id==='deepseek').auth_state,'auth_required');assert.equal(view.execution_authority,false);
});
