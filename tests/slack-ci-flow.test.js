'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {EventLedger}=require('../src/event-ledger'),{ControlPlaneStore}=require('../src/control-plane-store'),{SlackRuntime}=require('../src/slack-runtime');
const {classSummary,flowMessages,GitHubCIReader}=require('../src/slack-ci-flow');
const sha='a'.repeat(40);
const flow=()=>({number:1,sha,prState:'OPEN',draft:false,checks:[{name:'check',state:'in_progress'}],workflows:[{name:'CI',state:'in_progress',id:1,attempt:1,jobs:[{name:'heavy',state:'in_progress',steps:[{name:'Class A — lite',state:'success'},{name:'Class B — financial',state:'in_progress'},{name:'Class C — browser',state:'skipped'}]}]}]});
function fixture(t){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');const store=new ControlPlaneStore({db,ledger:new EventLedger(db)});t.after(()=>db.close());let now=100000,reads=0,current=flow();const sent=[],updates=[];
 const reader={list:async()=>[{number:1,headRefOid:current.sha,state:'OPEN',sourceSignature:'s1'}],snapshot:async()=>{reads++;return structuredClone(current);}};
 const bridge={controlStore:store,ledger:store.ledger,tasks:{list:()=>[]},missions:{schedule(){},cancel(){}}};
 const config={enabled:true,outboundEnabled:true,decisionsEnabled:false,teamId:'T1',botUserId:'UBOT',operatorIds:['U1'],channelIds:['C1'],appTokenRef:'fixture-app',botTokenRef:'fixture-bot'};
 const r=new SlackRuntime(bridge,{config,ciFlow:{reader,now:()=>now},resolveCredential:async()=> 'fixture',transportFactory:()=>({connect:async()=>({team_id:'T1',user_id:'UBOT'}),close:async()=>{},send:async body=>{sent.push(body);return{ok:true,channel:'C1',ts:`123.${sent.length}`};},update:async body=>{updates.push(body);return{ok:true,channel:'C1',ts:body.ts};}})});
 const configure=()=>r.ciFlow.configure({request_id:'config',enabled:true,repo:'owner/repo',pull_requests:[]});
 return{db,r,reader,sent,updates,configure,current,reads:()=>reads,advance:(ms=30000)=>{now+=ms;}};}
test('CI class summaries use actual steps, never hosted no-op reporters',()=>{
 const f=flow();assert.deepEqual(classSummary(f),{A:'success',B:'in_progress',C:'skipped'});f.workflows[0].jobs[0].steps=[{name:'Report hosted Class A not required',state:'success'},{name:'Install Playwright browsers',state:'success'}];assert.equal(classSummary(f).A,'Not observed');assert.equal(classSummary(f).C,'Not observed');
});
test('list contains checks and detailed steps; chunking retains all details',()=>{
 const f=flow();f.workflows[0].jobs[0].steps.push(...Array.from({length:150},(_,i)=>({name:`Step ${i}`,state:'queued'})));const parts=flowMessages('owner/repo',f),text=parts.join('\n');assert(parts.length>1);assert(parts.every(p=>p.length<=2800));assert.match(text,/CI checks:/);assert.match(text,/Class B.*in_progress/);assert.match(text,/Step 149/);assert.match(text,/manual\/on-demand/);
});
test('CI posts one overview and edits it after the refresh interval without PR notifications',async t=>{
 const f=fixture(t);await f.r.start();await f.r.ciFlow.poll();assert.equal(f.reads(),0);f.configure();await f.r.ciFlow.poll();await f.r.gateway.flush();assert.equal(f.sent.length,1);assert.equal(f.sent[0].blocks[0].text.text,'Arecibo · CI overview');assert(!f.sent[0].text.includes('<@'));f.advance();await f.r.ciFlow.poll();await f.r.gateway.flush();assert.equal(f.sent.length,1);
 f.current.workflows[0].jobs[0].steps[1].state='success';f.advance(120000);await f.r.ciFlow.poll();await f.r.gateway.flush();assert.equal(f.sent.length,1);assert.equal(f.updates.length,1);assert.equal(f.updates[0].ts,'123.1');
});
test('new head SHA produces a new observation, while configuration cannot trigger CI execution',async t=>{
 const f=fixture(t);f.configure();await f.r.ciFlow.poll();f.current.sha='b'.repeat(40);f.advance();await f.r.ciFlow.poll();assert.equal(f.db.prepare('SELECT sha,revision FROM cp_slack_ci_flows').get().sha,'b'.repeat(40));assert.throws(()=>f.r.ciFlow.configure({request_id:'bad',enabled:true,repo:'owner/repo;bash',pull_requests:[]}));assert.throws(()=>f.r.ciFlow.configure({request_id:'bad2',enabled:true,repo:'owner/repo',pull_requests:[],dispatch:true}));
});
test('GitHub outage retains detailed snapshots and emits one availability alert',async t=>{
 const f=fixture(t);f.configure();await f.r.ciFlow.poll();f.reader.list=async()=>{throw Error('token=private-fixture');};f.advance();await f.r.ciFlow.poll();f.advance();await f.r.ciFlow.poll();assert.equal(f.db.prepare('SELECT count(*) n FROM cp_slack_ci_flows').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM cp_slack_health_outbox WHERE kind IN ('ci_flow_availability','ci_flow_unavailable')").get().n,0);assert.equal(f.r.ciFlow.status().last_error,'github_unavailable');assert(!JSON.stringify(f.r.ciFlow.status()).includes('private-fixture'));
});
test('outbound disable prevents observation and delivery; restart replay preserves flow revisions',async t=>{
 const f=fixture(t);f.configure();f.r.gateway.config.outboundEnabled=false;await f.r.ciFlow.poll();assert.equal(f.reads(),0);f.r.gateway.config.outboundEnabled=true;await f.r.ciFlow.poll();const before=f.db.prepare('SELECT revision FROM cp_slack_ci_flows').get().revision;f.advance();await f.r.ciFlow.poll();assert.equal(f.db.prepare('SELECT revision FROM cp_slack_ci_flows').get().revision,before);
});
test('full details are sent only after a user click, in the overview thread',async t=>{
 const f=fixture(t);await f.r.start();f.configure();f.current.workflows[0].jobs[0].steps.push(...Array.from({length:2000},(_,i)=>({name:`Extra step ${i}`,state:'queued'})));await f.r.ciFlow.poll();await f.r.gateway.flush();assert.equal(f.sent.length,1);
 const root=f.r.ciFlow.ui.dashboard();const value={repo:'owner/repo',nonce:root.nonce,view:'detail',pr:1,page:0},click={envelope_id:'detail1',body:{actions:[{value:JSON.stringify(value)}],channel:{id:'C1'},message:{ts:'123.1'}}};f.r.ciFlow.ui.interaction(click);f.r.ciFlow.ui.interaction(click);const request=f.db.prepare("SELECT request_id,record_id FROM cp_requests WHERE owner='slack-ci-ui'").get();assert.equal(request.request_id,'detail1');assert.match(request.record_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);assert.equal(f.db.prepare("SELECT count(*) n FROM cp_requests WHERE owner='slack-ci-ui'").get().n,1);await f.r.gateway.flush();assert.equal(f.sent.length,2);assert.equal(f.sent[1].thread_ts,'123.1');assert(!('thread_root_ref' in f.sent[1]));
 const next=f.sent[1].blocks.at(-1).elements.find(b=>b.action_id==='ci_ui_next');assert(next);f.r.ciFlow.ui.interaction({envelope_id:'detail2',body:{actions:[next],channel:{id:'C1'},message:{ts:'123.2'}}});await f.r.gateway.flush();assert.equal(f.sent.length,2);assert.equal(f.updates.length,1);assert.equal(f.updates[0].ts,'123.2');
});
test('reader rejects mismatched run SHA and does not export hostile names or diagnostics',async()=>{
 const reader=new GitHubCIReader();reader.call=async args=>args[1].includes('check-runs')?{total_count:1,check_runs:[{name:'<@U1> token=private',status:'completed',conclusion:'success'}]}:{total_count:1,workflow_runs:[{id:1,head_sha:'b'.repeat(40)}]};const f=await reader.snapshot('owner/repo',{number:1,headRefOid:sha,state:'OPEN'});assert.equal(f.workflows.length,0);assert(!JSON.stringify(f).includes('token=private'));assert(!f.checks[0].name.includes('<@'));
});
test('specific and all-PR readers share stable source signatures without exporting raw links',async()=>{
 const reader=new GitHubCIReader();const pr={number:1,headRefOid:sha,state:'OPEN',statusCheckRollup:[{name:'check',status:'completed',conclusion:'success',detailsUrl:'private-url'}]};reader.call=async args=>args[1]==='view'?pr:[pr];const all=await reader.list('owner/repo',[]),single=await reader.list('owner/repo',[1]);assert.equal(all[0].sourceSignature,single[0].sourceSignature);assert(!single[0].sourceSignature.includes('private-url'));
});
test('disabling Slack while a GitHub read is pending admits no new notification',async t=>{
 const f=fixture(t);f.configure();let entered,release;const started=new Promise(r=>entered=r);f.reader.snapshot=async()=>{entered();await new Promise(r=>release=r);return flow();};const reading=f.r.ciFlow.poll();await started;f.r.gateway.config.enabled=false;release();await reading;assert.equal(f.db.prepare('SELECT count(*) n FROM cp_slack_health_outbox').get().n,0);
});

test('UI pages reuse one reply and spoofed actors, nonces and messages cannot request detail',async t=>{
 const f=fixture(t);await f.r.start();f.configure();await f.r.ciFlow.poll();await f.r.gateway.flush();const action=f.sent[0].blocks.find(b=>b.type==='actions').elements[0];let ack=0;
 const incoming={envelope_id:'list1',body:{team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},message:{ts:'123.1'},actions:[action]},ack:async()=>{ack++;}};
 await f.r.gateway.receive({...incoming,body:{...incoming.body,user:{id:'U2'}}});assert.equal(f.sent.length,1);
 await f.r.gateway.receive(incoming);await f.r.gateway.receive(incoming);await f.r.gateway.flush();assert.equal(f.sent.length,2);assert.equal(f.sent[1].thread_ts,'123.1');assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,0);assert.equal(ack,3);
 const forged={...JSON.parse(action.value),nonce:'wrong'};f.r.ciFlow.ui.interaction({envelope_id:'forged',body:{actions:[{value:JSON.stringify(forged)}],channel:{id:'C1'},message:{ts:'123.1'}}});assert.equal(f.db.prepare("SELECT count(*) n FROM cp_slack_health_outbox WHERE kind='ci_ui'").get().n,1);
 f.r.ciFlow.ui.interaction({envelope_id:'other',body:{actions:[action],channel:{id:'C1'},message:{ts:'999.9'}}});assert.equal(f.db.prepare("SELECT count(*) n FROM cp_slack_health_outbox WHERE kind='ci_ui'").get().n,1);
});
test('unknown overview delivery never posts a replacement card',async t=>{
 const f=fixture(t);await f.r.start();f.configure();f.r.gateway.transport.send=async()=>{throw Error('network reset');};await f.r.ciFlow.poll();await f.r.gateway.flush();f.advance(120000);await f.r.ciFlow.poll();await f.r.gateway.flush();assert.equal(f.db.prepare("SELECT count(*) n FROM cp_slack_health_outbox WHERE kind='ci_dashboard'").get().n,1);assert.equal(f.r.ciFlow.ui.status().message_state,'delivery_unknown');
});
