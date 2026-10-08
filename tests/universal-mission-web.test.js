'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const hash=v=>createHash('sha256').update(v).digest('hex');
const {ResearchNetwork}=require('../src/research-network');
const {fixture}=require('./fixtures/mission-fixture.cjs');
function authority(repo){return {level:'development',expiresAt:Date.now()+600000,permissions:{repository:['read','write'],runtime:['diagnostic','test'],network:['localhost','internet'],secrets:[],data:['read','workspace_write']},filesystem:{read:[repo],write:[repo]}};}
function native(f,extra={}){return f.create({objective:'Read https://example.com/ and change the fixture as specified.',task_type:'local_files',authority:authority(f.repo),dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]},...extra});}
class Browser{
 constructor(o){Object.assign(this,o);fs.mkdirSync(o.evidenceDir,{recursive:true,mode:0o700});}
 async execute(a){if(a.type==='navigate'){this.url=a.url;return {state:'navigated'};}const id=randomUUID(),text='Public features and documentation.',row={id,url:this.url,title:'Public synthetic site',text,content:text,sha256:hash(text),classification:'observed',links:[{id:randomUUID(),text:'Public second source',url:'https://example.org/'}],forms:[],viewport:{width:1280,height:800},captured_at:Date.now(),authority:false,untrusted:true};if(a.type==='screenshot'){const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),file=path.join(this.evidenceDir,id+'.png');fs.writeFileSync(file,png,{mode:0o600,flag:'wx'});row.screenshot_ref={id,path:file,sha256:hash(png),mimeType:'image/png'};}const bytes=Buffer.from(JSON.stringify(row)+'\n'),file=path.join(this.evidenceDir,id+'.json');fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});row.evidence_ref={id,path:file,sha256:hash(bytes)};return row;}
 verify(row){return require('../src/research-browser').verifyEvidence(row,{evidenceDir:this.evidenceDir,scope:this.scope});}
 async close(){return {closed:true,termination_verified:true,owned_process_termination:'verified'};}
}
function synthetic(f){f.bridge.missions.web.options={synthetic:true,browserFactory:o=>new Browser(o)};}
test('public domain discovery remains bounded; redirects, mutation methods, auth paths and private DNS stay denied',async()=>{
 const n=new ResearchNetwork({scope:{origins:['https://example.com'],publicDiscovery:true,maxOrigins:2}});
 assert.equal(n.validate('https://example.org/docs'),'https://example.org/docs');assert.throws(()=>n.validate('https://third.example.com/'),/public_domain_budget/);
 for(const u of ['https://127.0.0.1/','https://private.local/','https://example.com/login','https://example.com/api/delete','https://example.com/?token=private','https://example.com/accounts','https://example.com/%64elete','https://example.com/%2564elete','https://example.com/%256cogin','https://example.com/docs/%252e%252e/%2564elete'])assert.throws(()=>n.validate(u));
 assert.throws(()=>n.validate('https://example.com/','POST'),/method_denied/);
 const pinned=new ResearchNetwork({scope:{origins:['https://example.com']},testing:{lookup:async()=>[{address:'127.0.0.1',family:4}]}});await assert.rejects(pinned.fetch({url:'https://example.com/'}),/private_dns_denied/);
 assert.throws(()=>require('../src/mission-web-policy').validate({mission_id:randomUUID(),action:{type:'authenticate'}}));
 assert.throws(()=>require('../src/mission-web-policy').validate({mission_id:randomUUID(),action:{type:'explore',url:'https://example.com/',headers:{}}}));
});
test('any qualified local coding Mission uses brokered web preflight, independently verifies evidence, and requires owner Acceptance',async t=>{
 const f=await fixture(t);synthetic(f);const m=native(f),web=f.bridge.missions.web;
 assert.equal(m.envelope.capability_scopes.includes('web_read'),false,'No default browser grant was added');
 assert.throws(()=>web.configure(m.id,{request_id:randomUUID(),mode:'all',entries:['https://example.com/'],confirmed:true},'mcp'));
 assert.throws(()=>web.assess(f.bridge.tasks.get(m.task_id),{mission_id:m.id,action:{type:'explore',url:'https://example.com/'}}),/mission_web_approval_required/);
 web.configure(m.id,{request_id:randomUUID(),mode:'on',entries:['https://example.com/'],confirmed:true});
 f.bridge.missions.dispatch(m.id,{request_id:randomUUID()});const done=await f.settle(m.id);assert.equal(done.state,'awaiting_acceptance');assert.equal(done.acceptance.length,0);assert.equal(f.inference(),0);
 const rows=web.rows(f.bridge.controlStore.requireMission(m.id));assert.equal(rows.length,1);assert.equal(web.read(rows[0]).authority,false);assert.equal(web.verify(f.bridge.controlStore.requireMission(m.id),f.bridge.controlStore.run(rows[0].run_id)).evidence_count,1);
 const invocation=f.bridge.controlStore.invocation(rows[0].invocation_id);assert.equal(invocation.state,'settled');assert.equal(invocation.result.capability,'mission_web');
 fs.appendFileSync(path.join(web.directory(f.bridge.tasks.get(m.task_id)),rows[0].id+'.json'),'tamper');assert.throws(()=>web.verify(f.bridge.controlStore.requireMission(m.id),f.bridge.controlStore.run(rows[0].run_id)),/web_evidence_integrity_denied/);
 assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:randomUUID(),verification_id:done.verifications[0].id,decision:'accept',rationale:'Reject tampered evidence'}));
});
test('missing grants stop automatic coding web work before worker dispatch, and no authority is inherited by ordinary tasks',async t=>{
 const f=await fixture(t),m=native(f);f.bridge.missions.dispatch(m.id,{request_id:randomUUID()});await f.settle(m.id,'blocked');assert.equal(f.bridge.missions.detail(m.id).runs.length,0);assert.equal(f.calls(),0);
 const task=f.bridge.tasks.get(m.task_id);const prepared=await f.host.prepare(task,'mission_web',{mission_id:m.id,action:{type:'explore',url:'https://example.com/'}});assert.equal(prepared.assessment.decision,'deny');
 const low=native(f,{objective:'Read https://example.com/ without external internet rights.',authority:{...authority(f.repo),permissions:{...authority(f.repo).permissions,network:['localhost']}}});assert.throws(()=>f.bridge.missions.web.configure(low.id,{mode:'all',entries:['https://example.com/'],confirmed:true,request_id:randomUUID()}),/network:internet/);
});
test('standalone multi-site Mission and synthetic search/browser report preserve Arecibo comparison and no inference',async t=>{
 const f=await fixture(t),b=f.bridge;synthetic(f);b.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 const legacy=b.missions.research.create({request_id:randomUUID(),objective:'Legacy public research scope.',entry_url:'https://example.com/'});assert.equal(b.missions.research.progress(b.controlStore.requireMission(legacy.mission_id)).downloads_allowed,true);
 const web=b.missions.web,created=web.createResearch({request_id:randomUUID(),objective:'Explore two synthetic public sites.',mode:'on',entries:['https://example.com/','https://example.org/'],confirmed:true});
 assert.equal(b.missions.research.progress(b.controlStore.requireMission(created.mission_id)).downloads_allowed,false);b.missions.dispatch(created.mission_id,{request_id:randomUUID()});const done=await f.settle(created.mission_id);assert.equal(done.state,'awaiting_acceptance');const report=await b.missions.research.report(created.mission_id);assert.match(report.markdown,/Arecibo/);assert.equal(report.screenshots.length,2);const image=await b.missions.research.evidence(created.mission_id,report.screenshots[0].id);assert.equal(image.mime,'image/png');assert.ok(image.buffer.length>0);await assert.rejects(b.missions.research.evidence(created.mission_id,report.screenshots[0].id,'mcp'));assert.equal(web.rows(b.controlStore.requireMission(created.mission_id)).length,2);assert.equal(f.inference(),0);
 web.options.searchSource='synthetic';web.options.search=async()=>({source_id:'synthetic-approved-search',source_url:'https://example.com/',source_sha256:hash('public result'),fetched_at:Date.now(),bytes:20,results:[{title:'Public synthetic result',url:'https://example.com/'}]});
 const search=web.createResearch({request_id:randomUUID(),objective:'Search public sources for product documentation.',mode:'all',entries:[],query:'public product documentation',confirmed:true});b.missions.dispatch(search.mission_id,{request_id:randomUUID()});await f.settle(search.mission_id);const result=await b.missions.research.report(search.mission_id);assert.match(result.markdown,/Documented search result/);assert.match(result.markdown,/https:\/\/example.com/);assert.equal(f.inference(),0);
});
test('missing search source fails honestly; fresh grants, revocation, expiry and worker binding cannot be forged',async t=>{
 const f=await fixture(t),b=f.bridge;b.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 const created=b.missions.web.createResearch({request_id:randomUUID(),objective:'Search public sites.',mode:'all',entries:[],query:'public sites',confirmed:true});b.missions.dispatch(created.mission_id,{request_id:randomUUID()});const done=await f.settle(created.mission_id,'blocked');assert.match(done.reason,/No approved search provider/);assert.equal(b.missions.web.rows(b.controlStore.requireMission(created.mission_id)).length,0);assert.equal(f.inference(),0);
 const m=native(f,{objective:'Change fixture only.'}),web=b.missions.web;web.configure(m.id,{mode:'all',entries:['https://example.com/'],confirmed:true,request_id:randomUUID()});
 assert.throws(()=>web.assess(b.tasks.get(created.task_id),{mission_id:m.id,action:{type:'explore',url:'https://example.com/'}}),/active_canonical/);
 web.configure(m.id,{mode:'off',request_id:randomUUID()});assert.throws(()=>web.grant(b.controlStore.requireMission(m.id)),/approval_required/);
 web.configure(m.id,{mode:'all',entries:['https://example.com/'],confirmed:true,request_id:randomUUID()});b.controlStore.db.prepare("UPDATE cp_mission_web_grants SET policy_hash='tampered' WHERE mission_id=? AND state='active'").run(m.id);assert.throws(()=>web.grant(b.controlStore.requireMission(m.id)),/integrity_denied/);
});
test('natural web routing offers explicit consent and leaves ordinary conversation unchanged',()=>{
 const parse=require('../src/assistant-intent').parse;
 assert.equal(parse('hello').kind,'conversation');assert.equal(parse('Airo, search the web for Canadian fintech competitors').kind,'public_web_offer');assert.equal(parse('explore monarch.com and example.com').entries.length,2);
 assert.equal(parse('inspect my authenticated Monarch account').kind,'research_session');assert.notEqual(parse('search the web for password=private-value').kind,'public_web_offer');
});
test('Monarch consent catalog is exact; static reads and verified root redirects never authorize identity POST, query URLs or inspect-time external pages',()=>{
 const p=require('../src/research-session-policy'),a={origin:'https://app.monarch.com',network_profile:p.MONARCH};const allowed=(url,o={})=>p.allowed(url,{authorization:a,phase:'login',method:'GET',kind:'document',navigation:true,...o},require('../src/research-session').allowedURL);
 assert.equal(allowed('https://monarch.com/'),'https://monarch.com/');assert.equal(allowed('https://www.monarch.com/'),'https://www.monarch.com/');assert.equal(allowed('https://static.monarch.com/static/js/main.abc.js',{kind:'script',navigation:false}),'https://static.monarch.com/static/js/main.abc.js');
 for(const url of ['https://accounts.monarch.com/','https://static.monarch.com/api/login','https://monarch.com/login','https://monarch.com/?token=private'])assert.throws(()=>allowed(url));
 assert.throws(()=>allowed('https://monarch.com/',{phase:'inspect'}));assert.throws(()=>allowed('https://static.monarch.com/static/js/main.js',{kind:'script',navigation:false,method:'POST'}));
 const meta=require('../src/research-session').blockedMetadata('https://app.monarch.com/private-user-id?token=private-value',{method:'POST',reason:'session_origin_or_query_denied'});assert.doesNotMatch(JSON.stringify(meta),/private-value|private-user-id/);assert.equal(meta.query_present,true);
});

test('transport budgets persist across browser instances and grants expire without broadening authority',async t=>{
 const f=await fixture(t),web=f.bridge.missions.web,m=native(f,{objective:'Fixture scoped public evidence.'});web.configure(m.id,{mode:'all',entries:['https://example.com/'],confirmed:true,request_id:randomUUID()});f.bridge.controlStore.state(m.id,'dispatching');f.bridge.controlStore.state(m.id,'running');const g=web.grant(f.bridge.controlStore.requireMission(m.id));
 for(let i=0;i<8;i++)web.network(g,new AbortController().signal).onRequest('https://site'+i+'.example.com');
 assert.throws(()=>web.network(g,new AbortController().signal).onRequest('https://extra.example.com'),/domain_budget/);
 web.transportUsage(g,{bytes:g.policy.max_bytes});assert.throws(()=>web.network(g,new AbortController().signal).onBytes(1),/transport_budget/);
 const q=require('../src/mission-web-policy').normalize({mode:'on',entries:['https://example.com/'],confirmed:true},{now:100,expiresAt:200});assert.equal(q.expires_at,200);
});
test('failed browser termination retains canonical run, quarantined ownership and erasure barrier',async t=>{
 const f=await fixture(t),b=f.bridge;b.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 let closes=0;b.missions.web.options={synthetic:true,browserFactory:()=>({execute:async()=>{throw Error('synthetic navigation failed');},close:async()=>++closes===1?{closed:false,termination_verified:false}:{closed:true,termination_verified:true,owned_process_termination:'verified'}})};
 const m=b.missions.web.createResearch({request_id:randomUUID(),objective:'Explore synthetic source.',mode:'on',entries:['https://example.com/'],confirmed:true});b.missions.dispatch(m.mission_id,{request_id:randomUUID()});const done=await f.settle(m.mission_id,'blocked');const run=done.runs.find(r=>r.agent_id==='host');assert.equal(run.state,'termination_unverified');assert.equal(run.termination_verified,0);assert.equal(b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE run_id=?').get(run.id).state,'quarantined');assert.equal(b.missions.web.isActiveTask(m.task_id),true);assert.equal(b.controlStore.db.prepare('SELECT state FROM cp_dispatches WHERE run_id=?').get(run.id).state,'unknown');
});
test('historical grant tampering invalidates factual report and Acceptance after successful capture',async t=>{
 const f=await fixture(t);synthetic(f);const web=f.bridge.missions.web,m=native(f);web.configure(m.id,{request_id:randomUUID(),mode:'on',entries:['https://example.com/'],confirmed:true});f.bridge.missions.dispatch(m.id,{request_id:randomUUID()});await f.settle(m.id);const row=web.rows(f.bridge.controlStore.requireMission(m.id))[0];f.bridge.controlStore.db.prepare("UPDATE cp_mission_web_grants SET seal='{}' WHERE id=?").run(row.grant_id);assert.throws(()=>web.verify(f.bridge.controlStore.requireMission(m.id),f.bridge.controlStore.run(row.run_id)),/web_grant_provenance_denied/);
});
test('typed worker evidence requests remain untrusted and cannot contain mutations or changed files',()=>{
 const parse=require('../src/apps/opencode-adapter').parseOutput,event=result=>JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'fixture',text:JSON.stringify(result)}});
 const input={status:'needs_web',summary:'Need approved source evidence.',changed_files:[],web_requests:[{type:'inspect',url:'https://example.com/'}]};assert.equal(parse(event(input),['fixture.txt']).result.web_requests.length,1);
 assert.throws(()=>parse(event({...input,changed_files:['fixture.txt']}),['fixture.txt']),/web_request_bound/);assert.throws(()=>parse(event({...input,web_requests:[{type:'authenticate'}]}),[]));assert.throws(()=>parse(event({...input,web_requests:[{type:'explore',url:'https://example.com/delete'}]}),[]));
});
test('worker receives bounded public excerpts while immutable full evidence stays verified',async t=>{
 const f=await fixture(t),web=f.bridge.missions.web,m=native(f);synthetic(f);web.configure(m.id,{request_id:randomUUID(),mode:'on',entries:['https://example.com/'],confirmed:true});f.bridge.missions.dispatch(m.id,{request_id:randomUUID()});await f.settle(m.id);
 const task=f.bridge.tasks.get(m.task_id),pack=f.bridge.controlContext.build(f.bridge.controlStore.requireMission(m.id));f.bridge.controlStore.db.prepare('UPDATE cp_mission_tasks SET context_pack_id=? WHERE task_id=?').run(pack.id,task.id);
 // A synthetic projection exercises the delivery size guard without changing immutable receipts.
 const original=web.context;web.context=()=>[{evidence_id:randomUUID(),classification:'documented',title:'Public document',text:'Public documentation. '.repeat(900),url:'https://example.com/',links:[{id:randomUUID(),text:'Public source',url:'https://example.org/'}],source:{source_id:'public_document',source_url:'https://example.com/',fetched_at:Date.now()},untrusted:true,authority:false}];try{const context=f.bridge.opencodeAdapter.authorizedContext({id:pack.id});assert.ok(Buffer.byteLength(JSON.stringify(context))<=8000);assert.ok(context.web[0].text.length<=1400);assert.equal(context.web[0].authority,false);}finally{web.context=original;}
});

test('browser storage budget is reserved before artifact write, including refused captures',async t=>{
 const f=await fixture(t),dir=path.join(f.root,'public-evidence'),{ResearchBrowser}=require('../src/research-browser');const browser=new ResearchBrowser({scope:{origins:['https://example.com']},evidenceDir:dir,signal:new AbortController().signal,onEvidenceBytes:()=>{throw Error('synthetic storage budget exhausted');}});const id=randomUUID();assert.throws(()=>browser.write(id+'.png',Buffer.alloc(10)),/storage budget/);assert.equal(fs.existsSync(path.join(dir,id+'.png')),false);await browser.close();
});

test('qualified web-assisted OpenCode builds a real bounded input with public URL/source/link metadata',async t=>{
 const r=require('./fixtures/opencode-fixture.cjs').runtime(t);const runtimeFile=r.options.executable;fs.writeFileSync(runtimeFile,fs.readFileSync(runtimeFile,'utf8').replace("if(o.includes('alpha to beta'))","if(o.includes('WEB_ROUND')&&!p.current_context.web.some(e=>e.url==='https://example.org/')){result.status='needs_web';result.web_requests=[{type:'inspect',url:'https://example.org/'}];}if(result.status!=='needs_web'&&o.includes('alpha to beta'))"));const f=await fixture(t,{opencode:r.options}),b=f.bridge;require('./fixtures/opencode-fixture.cjs').qualifyCanonical(b);synthetic(f);const m=f.create({objective:'WEB_ROUND Read https://example.com/ and change alpha to beta using public documentation.',preferred_agent:'opencode',fallback_agents:[],authority:authority(f.repo),dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],native_actions:[]}});b.missions.web.configure(m.id,{request_id:randomUUID(),mode:'all',entries:['https://example.com/'],confirmed:true});b.missions.dispatch(m.id,{request_id:randomUUID()});const done=await f.settle(m.id);assert.equal(done.state,'awaiting_acceptance');assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'beta\n');assert.equal(b.missions.web.rows(b.controlStore.requireMission(m.id)).length,2);
});
