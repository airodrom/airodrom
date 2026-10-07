'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {redactText,safeValue}=require('../src/secret-observation');
const {redactValue}=require('../src/control-plane-store');
const seed='diagnosticSeedCredential7';
for(const [name,url] of Object.entries({
 token:`https://example.test/?token=${seed}`,
 access_token:`https://example.test/?access_token=${seed}`,
 signed:`https://example.test/private/${seed}?X-Amz-Signature=${seed}`,
 multiple:`https://example.test/?first=${seed}&second=${seed}`,
 fragment:`http://localhost:43117/#token=${seed}`,
 userinfo:`https://user:${seed}@example.test/`,
 websocket:`wss://example.test/${seed}?auth=${seed}`,
 local_websocket:`ws://127.0.0.1:43117/?a=${seed}`,
 relative_path:`/auth/${seed}`,
 relative:`/callback?access_token=${seed}#${seed}`,
 mixed_case:`https://example.test/?AcCeSs_ToKeN=${seed}`,
 encoded:encodeURIComponent(`http://localhost/#token=${seed}`),
 double_encoded:encodeURIComponent(encodeURIComponent(`https://example.test/?signed=${seed}`)),
 relative_encoded:encodeURIComponent(`/callback?token=${seed}`)
}))test(`outward URL sanitizer: ${name}`,()=>{
 const input=`Diagnostic link ${url} end`;
 assert.ok(!redactText(input).includes(seed));assert.ok(input.includes(seed));
});
test('nested fields and sensitive names redact without mutating runtime',()=>{
 const input={items:[{url:`https://example.test/?a=${seed}`,href:`/a?b=${seed}`,control_center_url:`http://localhost/#token=${seed}`,auth_url:`ws://localhost/?a=${seed}`,callback_url:`/c?x=${seed}`,websocket_url:`wss://example.test/?a=${seed}`,redirect:`/r#${seed}`,link:`https://example.test/${seed}`,endpoint:`https://example.test/?a=${seed}`,location:`/l?x=${seed}`,AcCeSs_ToKeN:seed,Signature:seed,private_key:seed,auth:seed,jwt:seed}]};
 assert.ok(!JSON.stringify(safeValue(input)).includes(seed));assert.ok(JSON.stringify(input).includes(seed));
 assert.ok(!JSON.stringify(redactValue(input)).includes(seed));
});
test('error and log serializers sanitize URL messages and causes',()=>{
 const error=Error(`failed http://localhost/#token=${seed}`,{cause:{url:`/cb?token=${seed}`}});
 assert.ok(!JSON.stringify(safeValue(error)).includes(seed));
 assert.ok(!redactText(`log ${error.message}`).includes(seed));
});
test('MCP text and structured response share secret-safe result',async()=>{
 const {McpStdio}=require('../src/mcp-stdio');
 const server=new McpStdio({tools:[{name:'probe',inputSchema:{type:'object'}}],callTool:async()=>({control_center_url:`http://localhost/#token=${seed}`})});
 await server.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}});
 await server.handle({jsonrpc:'2.0',method:'notifications/initialized'});
 const response=await server.handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'probe',arguments:{}}});
 assert.ok(response.result.structuredContent);assert.ok(!JSON.stringify(response).includes(seed));
});
test('evidence export contains no seeded secret',()=>{
 const {redactPayload}=require('../src/event-ledger');
 const exportValue={metadata:safeValue({url:`ws://localhost/#${seed}`}),payload:redactPayload(`visit /callback?token=${seed}`).value};
 assert.ok(!JSON.stringify(exportValue).includes(seed));
});
test('MCP public error cannot export a credential-bearing URL',async()=>{
 const {McpStdio}=require('../src/mcp-stdio');
 const server=new McpStdio({tools:[{name:'probe',inputSchema:{type:'object'}}],callTool:async()=>{const e=Error('private');e.publicMessage=`failed ws://localhost/#${seed}`;throw e;}});
 await server.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}});
 await server.handle({jsonrpc:'2.0',method:'notifications/initialized'});
 const response=await server.handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'probe',arguments:{}}});
 assert.equal(response.result.isError,true);assert.ok(!JSON.stringify(response).includes(seed));
});
test('bounded diagnostic log reads sanitize the outward file boundary',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sanitizer-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'sample.log'),`redirect /cb?x=${seed}\nURL ws://localhost/#${seed}`);
 const policy={_protected:()=>false,_diagnosticLog:()=>true};
 const reader=new (require('../src/safe-diagnostics').SafeDiagnostics)(policy);
 assert.ok(!reader.read({workspace:fs.realpathSync(root)},{op:'cat',path:'sample.log'}).includes(seed));
 assert.ok(fs.readFileSync(path.join(root,'sample.log'),'utf8').includes(seed));
});

test('relative opaque hex path is secret-safe',()=>{const value='a'.repeat(64);assert.ok(!redactText(`/download/${value}`).includes(value));});

test('Unicode credential object keys are denied by provider and safe observation boundaries',()=>{
 const record={ＰＡＳＳＷＯＲＤ:'synthetic-unicode-key-canary'},policy=require('../src/provider-policy'),observation=require('../src/secret-observation');
 assert.equal(policy.secretLike(record),true);assert.doesNotMatch(JSON.stringify(observation.safeValue(record)),/synthetic-unicode-key-canary/);
 assert.equal(policy.dataPolicy({data_class:'public',messages:[record]}, {id:'local',locality:'local'}).allow,false);
});
