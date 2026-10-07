'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{createHash,randomUUID}=require('node:crypto');
const display=require('../src/product-observability'),brand=require('../src/terminal-brand'),local=require('../src/local-bootstrap');
const {fixture}=require('./fixtures/mission-fixture.cjs'),{runtime}=require('./fixtures/opencode-fixture.cjs'),ControlServer=require('../src/control-server');
test('terminal mark uses canonical cutouts and portable color/width modes',()=>{
 assert.equal(brand.inside(128,200),false);assert.equal(brand.inside(128,128),false);assert.equal(brand.inside(20,218),true);
 for(const [env,expected]of [[{TERM:'xterm-256color',COLORTERM:'truecolor'},'truecolor'],[{TERM:'xterm-256color'},'256'],[{TERM:'xterm'},'16'],[{NO_COLOR:'',TERM:'xterm'},'none'],[{TERM:'dumb'},'none']]){
 const mode=brand.colorMode({tty:true,env});assert.equal(mode,expected);const output=brand.intro({mode,columns:80});assert.match(output,/AIRODROM/);assert.match(output,/PRE-RELEASE/);if(mode==='none')assert.doesNotMatch(output,/\x1b/);else assert.match(output,/\x1b/);
 }
 assert.equal(brand.mark().length,18);assert.equal(brand.mark({compact:true}).length,11);assert.equal(brand.colorMode({tty:false,env:{COLORTERM:'truecolor'}}),'none');
 const strip=require('node:util').stripVTControlCharacters;
 for(const mode of ['truecolor','256','16'])assert.deepEqual(brand.mark({mode}).map(row=>strip(row).replace(/[▀▄]/g,'#')),brand.mark({unicode:false}).map(row=>row.replace(/[+.]/g,'#')),'colored empty cells and canonical cutouts remain transparent');
 for(const width of [20,28,40,77,78,80])for(const mode of ['none','16','256','truecolor'])for(const unicode of [false,true]){
  const output=brand.intro({mode,columns:width,unicode});for(const row of strip(output).trimEnd().split('\n'))assert.ok(row.length<=width,'intro fits '+width+' columns');
  if(!unicode)assert.doesNotMatch(output,/[▀▄█▓░]/,'ASCII fallback uses no block glyphs');
 }
 for(const rows of [20,24,28,36])assert.ok(strip(brand.intro({mode:'truecolor',columns:80,rows})).trimEnd().split('\n').length<=rows-12,'intro leaves room for readiness and composer');
});
test('timeline deduplicates canonical identities, preserves order and excludes untrusted content',()=>{
 const first={event_id:randomUUID(),sequence:1,timestamp_ms:1,event_type:'mission.created',metadata:{prompt:'PRIVATE_PROMPT',reasoning:'PRIVATE_REASONING',token:'PRIVATE_TOKEN'}};
 const last={event_id:randomUUID(),sequence:3,timestamp_ms:3,event_type:'acceptance.passed',metadata:{evaluation_only:true,requires_acceptance:true}};
 const timeline=display.timeline([last,first,first,{...first,event_id:randomUUID(),sequence:2,event_type:'private.secret'}]);assert.equal(timeline.length,2);assert.equal(timeline[0].sequence,1);assert.match(timeline[1].label,/decision still required/);assert.doesNotMatch(JSON.stringify(timeline),/PRIVATE_|secret|metadata|prompt|reasoning/);
 assert.equal(display.eventView({...first,event_type:'verification.completed',metadata:{status:'operator_review'}}).outcome,'operator_review');
});
test('progress never converts phase, time, actions or unknown denominators into completion',()=>{
 assert.equal(display.progress({state:'running'}).mode,'indeterminate');for(const state of ['blocked','waiting_for_operator','paused','awaiting_acceptance','cancelled','needs_rework'])assert.equal(display.progress({state}).mode,'paused');
 assert.deepEqual(display.progress({state:'verifying',checks:[{status:'passed'},{status:'pending'}],declaredChecks:3}),{mode:'determinate',label:'Declared verification checks',value:1,maximum:3});assert.equal(display.progress({state:'running',declaredChecks:0}).mode,'indeterminate');
});
test('safe product HTTP has no prompts, payloads, memory, paths or reasoning; MCP cannot read it',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,server=new ControlServer(b,{port:0});await server.start();t.after(()=>server.close());
 const get=async(route,credential=server.token)=>{const response=await fetch(server.origin+route,{headers:{Authorization:'Bearer '+credential}});return{response,value:await response.json()};};
 const m=b.missions.createConversation({request_id:randomUUID(),message:'PRIVATE_PROMPT_CANARY',include_memory:true});b.ledger.record({eventType:'mission.created',agent:'bridge',direction:'internal',missionId:m.mission_id,metadata:{objective:'PRIVATE_OBJECTIVE',environment:'PRIVATE_ENV',argv:'PRIVATE_ARGV',reasoning:'PRIVATE_REASONING',path:'/Users/private/PRIVATE_PATH'},payload:'PRIVATE_PAYLOAD'});
 assert.equal((await get('/api/product/overview',server.mcpToken)).response.status,401);
 for(const route of ['/api/product/overview','/api/product/events','/api/product/mission?id='+m.mission_id]){const result=await get(route);assert.equal(result.response.status,200);assert.doesNotMatch(JSON.stringify(result.value),/PRIVATE_|\/Users\/|payload|envelope|argv|environment/);}
 const detail=(await get('/api/product/mission?id='+m.mission_id)).value;assert.equal(detail.verification.status,'not_observed');assert.equal(detail.acceptance.status,'pending');assert.equal(detail.settlement.status,'not_observed');
 assert.equal((await get('/api/product/events?after=-1')).response.status,400);assert.equal((await get('/api/product/events?category=PRIVATE')).response.status,400);
});
test('canonical conversation delivery, verification, Acceptance, Settlement and correction stay separate',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge;
 b.rememberPersonalMemory({domain:'personal',type:'fact',subject:'test codename',content:'My test codename is Silver Falcon.',source:'user_explicit',sensitivity:'normal'});
 const m=b.missions.createConversation({request_id:randomUUID(),message:'What is my test codename?',include_memory:true});b.missions.dispatch(m.mission_id,{request_id:randomUUID()});await f.settle(m.mission_id);
 const before=display.missionView(b,b.controlStore.requireMission(m.mission_id));assert.equal(before.verification.status,'operator_review');assert.equal(before.acceptance.status,'pending');assert.equal(before.settlement.status,'waiting_acceptance');assert.equal(before.memory.selected_count,1);assert.equal(before.memory.delivery,'delivered this turn');assert.match(before.memory.used_this_turn,/not observable/);assert.ok(before.timeline.some(e=>e.label==='OpenCode executing'));
 b.missions.accept(m.mission_id,{request_id:randomUUID(),verification_id:before.verification.id,decision:'accept',rationale:'Synthetic answer reviewed',evidence:'Synthetic codename matched the current canonical record.'});
 const after=display.missionView(b,b.controlStore.requireMission(m.mission_id));assert.equal(after.acceptance.status,'accept');assert.equal(after.settlement.status,'settled');assert.equal(after.termination.verified,true);
 b.rememberPersonalMemory({domain:'personal',type:'fact',subject:'test codename',content:'My test codename is Golden Finch.',source:'user_explicit',sensitivity:'normal'});const invalidated=display.missionView(b,b.controlStore.requireMission(m.mission_id));assert.equal(invalidated.memory.selected_count,null);assert.equal(invalidated.memory.delivery,'unavailable or invalidated');assert.doesNotMatch(JSON.stringify(invalidated),/Silver Falcon|Golden Finch/);
});
test('safe diagnostics never export the private configuration or launcher paths',async t=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-doctor-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.chmodSync(home,0o700);
 const diagnostic=await require('../src/product-diagnostics').doctor(home);assert.equal(diagnostic.control,'Stopped');const text=require('../src/product-diagnostics').summary(diagnostic);assert.doesNotMatch(text,/\/private\/|\/Users\/|token=|Bearer|argv/);
 const launcher=require('../scripts/macos/product-control.cjs').launcher(home);assert.equal(fs.statSync(launcher).mode&0o777,0o700);assert.match(fs.readFileSync(launcher,'utf8'),/^#!\/bin\/sh\nexec env AIRODROM_HOME=/);fs.unlinkSync(launcher);fs.symlinkSync('/etc/passwd',launcher);assert.throws(()=>require('../scripts/macos/product-control.cjs').launcher(home),/Unsafe launcher/);
});
function qualificationFixture(t){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-requalify-')));fs.chmodSync(home,0o700);t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const executable=path.join(home,'fixture');fs.writeFileSync(executable,'synthetic executable',{mode:0o700});const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 let probes=0,onProbe=async()=>{};class Adapter{executable(){return executable;}async readiness(){return{ready:true,version:'2.0.20'};}async execute(){probes++;await onProbe();return{result:{summary:'Airodrom local qualification passed'},changes:[],provenance:{termination_verified:true}};}}
 const evidence={platform:process.platform+'-'+process.arch,model:'ollama/qwen3-coder:30b',executable_sha256:sha(executable),execution_qualified:true,runtime_version:'2.0.20'};
 const realRequire=require('node:module').createRequire(require.resolve('../src/local-bootstrap'));const sandboxModule={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/local-bootstrap'),'utf8'),{require:name=>name==='./opencode-adapter'?{OpenCodeAdapter:Adapter,VERSION:'2.0.20'}:name==='../config/agent-runtime-qualification-v1.json'?{opencode:evidence}:realRequire(name),module:sandboxModule,exports:sandboxModule.exports,process,__dirname:path.dirname(require.resolve('../src/local-bootstrap')),Buffer,URL,fetch,AbortSignal,AbortController,setTimeout});const l=sandboxModule.exports;
 const pins={version:1,platform:evidence.platform,model:evidence.model,runtime_version:'2.0.20',executables:[{id:'node',path:path.join(home,'removed-node'),sha256:'0'.repeat(64)},l.pin('sandbox-exec','/usr/bin/sandbox-exec'),l.pin('opencode',executable)]};l.writePrivate(path.join(home,'runtime-pins.json'),pins);
 return{home,l,executable,get probes(){return probes;},set onProbe(fn){onProbe=fn;}};
}
test('supported host pin drift requires a fresh probe, private atomic replacement and concurrent refusal',async t=>{
 const f=qualificationFixture(t);let release,started;const gate=new Promise(r=>release=r),begin=new Promise(r=>started=r);f.onProbe=()=>{started();return gate;};const first=f.l.requalify(f.home);await begin;await assert.rejects(f.l.requalify(f.home),/already running/);release();assert.equal((await first).qualified,true);assert.equal(f.probes,1);assert.equal(fs.statSync(path.join(f.home,'runtime-pins.json')).mode&0o777,0o600);assert.equal(f.l.validatePins(f.l.ownedJSON(path.join(f.home,'runtime-pins.json'))).executables[0].path,fs.realpathSync(process.execPath));
});
test('unsupported executable drift and replacement during probe preserve pins and fail closed',async t=>{
 const f=qualificationFixture(t),file=path.join(f.home,'runtime-pins.json'),before=fs.readFileSync(file,'utf8');fs.appendFileSync(f.executable,' changed');await assert.rejects(f.l.requalify(f.home));assert.equal(f.probes,0);assert.equal(fs.readFileSync(file,'utf8'),before);
 const g=qualificationFixture(t),original=fs.readFileSync(path.join(g.home,'runtime-pins.json'),'utf8');g.onProbe=()=>fs.appendFileSync(g.executable,' changed during probe');await assert.rejects(g.l.requalify(g.home));assert.equal(fs.readFileSync(path.join(g.home,'runtime-pins.json'),'utf8'),original);
});
test('current Mission pagination and native summaries remain truthful beyond retained recent history',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge;
 const oldest=b.missions.createConversation({request_id:randomUUID(),message:'Synthetic older work'});
 b.controlStore.db.prepare("UPDATE cp_missions SET state='running',created_at=1 WHERE id=?").run(oldest.mission_id);
 for(let i=0;i<55;i++)b.missions.createConversation({request_id:randomUUID(),message:'Synthetic registration '+i});
 const first=await display.overview(b),next=await display.overview(b,{currentOffset:50}),native=await display.nativeStatus(b);
 assert.equal(first.counts.active,1);assert.equal(native.active_missions,1);assert.equal(native.mission.id,oldest.mission_id);assert.ok(first.current_mission_ids.includes(oldest.mission_id));assert.equal(first.counts.current_has_more,true);assert.equal(next.counts.current_has_more,false);assert.equal(new Set([...first.current_mission_ids,...next.current_mission_ids]).size,56);
 assert.ok(Buffer.byteLength(JSON.stringify(native))<4000);assert.doesNotMatch(JSON.stringify(first),/Synthetic older work|Synthetic registration|repositories|\/private\//);await assert.rejects(display.overview(b,{currentOffset:-1}));
 b.ledger.health=()=>({healthy:false,state:'degraded'});assert.equal((await display.overview(b)).status,'Degraded');
});
test('safe mutation receipts withhold Acceptance rationale, content and bound envelopes',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,server=new ControlServer(b,{port:0});await server.start();t.after(()=>server.close());
 const m=b.missions.createConversation({request_id:randomUUID(),message:'PRIVATE_RECEIPT_PROMPT'});b.missions.dispatch(m.mission_id,{request_id:randomUUID()});await f.settle(m.mission_id);
 const original=display.missionView(b,b.controlStore.requireMission(m.mission_id));
 const post=async body=>{const response=await fetch(server.origin+'/api/product/accept-mission',{method:'POST',headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json'},body:JSON.stringify(body)});return{response,value:await response.json()};};
 const body={id:m.mission_id,request_id:randomUUID(),verification_id:original.verification.id,decision:'accept',rationale:'PRIVATE_RATIONALE',evidence:'PRIVATE_EVIDENCE'};
 const invalid=await post({...body,raw_prompt:'PRIVATE_EXTRA'});assert.equal(invalid.response.status,400);assert.doesNotMatch(JSON.stringify(invalid.value),/PRIVATE_/);
 const result=await post(body);assert.equal(result.response.status,200);assert.deepEqual(Object.keys(result.value).sort(),['mission_id','receipt','state']);assert.doesNotMatch(JSON.stringify(result.value),/PRIVATE_|evidence|envelope|rationale/);
 const complete=display.missionView(b,b.controlStore.requireMission(m.mission_id));assert.equal(complete.verification.current,true);assert.equal(complete.acceptance.status,'accept');assert.equal(complete.settlement.status,'settled');
 b.controlStore.db.prepare('UPDATE cp_verifications SET run_id=? WHERE id=?').run(randomUUID(),original.verification.id);assert.equal(display.missionView(b,b.controlStore.requireMission(m.mission_id)).verification.current,false);
});
test('stale revisions never offer Acceptance and approval branches project only fixed metadata',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge;
 const m=b.missions.createConversation({request_id:randomUUID(),message:'Synthetic review'});b.missions.dispatch(m.mission_id,{request_id:randomUUID()});await f.settle(m.mission_id);
 b.controlStore.db.prepare('UPDATE cp_verifications SET revision=revision-1 WHERE mission_id=?').run(m.mission_id);
 const stale=display.missionView(b,b.controlStore.requireMission(m.mission_id));assert.equal(stale.verification.current,false);assert.equal(stale.actions.accept,false);assert.equal(stale.actions.dispatch,false);
 for(const type of ['approval.requested','approval.revoked','approval.approved','approval.rejected','approval.expired','capability.denied','capability.failed']){const event=display.eventView({event_id:randomUUID(),sequence:1,timestamp_ms:Date.now(),event_type:type,metadata:{args:'PRIVATE_ARGS',command:'PRIVATE_COMMAND',prompt:'PRIVATE_PROMPT'}});assert.ok(event);assert.doesNotMatch(JSON.stringify(event),/PRIVATE_/);}
});
test('interrupted requalification preserves pins and releases the exclusive lock',async t=>{
 const f=qualificationFixture(t),before=fs.readFileSync(path.join(f.home,'runtime-pins.json'),'utf8'),controller=new AbortController();f.onProbe=()=>controller.abort();await assert.rejects(f.l.requalify(f.home,process.env,{signal:controller.signal}),/interrupted/);assert.equal(fs.readFileSync(path.join(f.home,'runtime-pins.json'),'utf8'),before);assert.equal(fs.existsSync(path.join(f.home,'qualification.lock')),false);
 fs.chmodSync(path.join(f.home,'runtime-pins.json'),0o644);await assert.rejects(f.l.requalify(f.home));assert.equal(fs.readFileSync(path.join(f.home,'runtime-pins.json'),'utf8'),before);
});
test('explicit Memory actions preserve canonical scope, clear freshness and return only safe receipts',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,server=new ControlServer(b,{port:0});await server.start();t.after(()=>server.close());
 const headers={Authorization:'Bearer '+server.token,'Content-Type':'application/json'},post=async(action,body)=>{const response=await fetch(server.origin+'/api/product/'+action,{method:'POST',headers,body:JSON.stringify(body)});return{status:response.status,value:await response.json()};};
 const older=b.rememberPersonalMemory({domain:'personal',type:'fact',subject:'older searched record',content:'Synthetic older cobalt',source:'user_explicit',sensitivity:'normal'});
 for(let i=0;i<25;i++)b.rememberPersonalMemory({domain:'personal',type:'fact',subject:'newer '+i,content:'Synthetic newer '+i,source:'user_explicit',sensitivity:'normal'});
 const before=display.memoryStatus(b),correct=await post('correct-memory',{id:older.memoryId,content:'Synthetic older amber'});assert.equal(correct.status,200);assert.doesNotMatch(JSON.stringify(correct.value),/amber|subject|source_hash|content/);assert.notEqual(display.memoryStatus(b).generation,before.generation);
 const retrieved=await fetch(server.origin+'/api/product/memory?query=older',{headers}).then(r=>r.json());assert.equal(retrieved.items[0].content,'Synthetic older amber');assert.equal(retrieved.generation,display.memoryStatus(b).generation);
 const forgotten=await post('forget-memory',{id:correct.value.memory_id});assert.equal(forgotten.status,200);assert.equal(b.personalMemory.get(correct.value.memory_id),null);
 const sensitive=b.rememberPersonalMemory({domain:'personal',type:'fact',subject:'private sensitivity',content:'Synthetic restricted reference',source:'user_explicit',sensitivity:'sensitive'});assert.equal((await post('correct-memory',{id:sensitive.memoryId,content:'Replacement'})).status,400);
 const archived=await post('archive-project',{id:b.projects.listProjects()[0].projectId,request_id:randomUUID()});assert.equal(archived.status,200);assert.deepEqual(Object.keys(archived.value).sort(),['project_id','status']);
});
test('canonical Memory overview switches to the enabled governed backend and respects expiry',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,a=b.authorityRuntime;
 require('./fixtures/opencode-fixture.cjs').qualifyCanonical(b);
 const item=b.rememberPersonalMemory({domain:'personal',type:'fact',subject:'governed-ui-count',content:'Synthetic governed violet',source:'user_explicit',sensitivity:'normal'});
 const current=display.memoryStatus(b);assert.equal(current.backend,'Governed canonical');assert.ok(current.active_records>=1);assert.doesNotMatch(JSON.stringify(current),/violet|source_hash|content_hash/);
 b.forgetPersonalMemory(item.id);const after=display.memoryStatus(b);assert.equal(after.active_records,current.active_records-1);assert.notEqual(after.generation,current.generation);
 const clock=a.store.now,now=clock();const candidate=a.memory.propose({kind:'personal_preference',operator_id:a.store.operatorId,scope:'global',subject_key:'expiry-ui-count',value:'Synthetic expiry lavender',source_hash:'a'.repeat(64),source_refs:[],metadata:{}},a.store.operator);a.memory.promote(candidate.id,{source_type:'operator_decision',expires_at:now+1000},a.store.operator);
 const beforeExpiry=display.memoryStatus(b);a.store.now=()=>now+1001;
 const afterExpiry=display.memoryStatus(b);assert.equal(afterExpiry.active_records,beforeExpiry.active_records-1);assert.equal(afterExpiry.expired_records,beforeExpiry.expired_records+1);assert.notEqual(afterExpiry.generation,beforeExpiry.generation);a.store.now=clock;
});
test('stopped requalification refuses retained or uncertain writers before and after its probe',async t=>{
 function durable(f,{run=null,lease=null}={}){const directory=path.join(f.home,'data');fs.mkdirSync(directory,{mode:0o700});const file=path.join(directory,'memory.sqlite'),db=new(require('node:sqlite').DatabaseSync)(file);db.exec('CREATE TABLE cp_runs(state TEXT,process_state TEXT);CREATE TABLE cp_leases(state TEXT)');if(run)db.prepare('INSERT INTO cp_runs VALUES(?,?)').run(run,'unknown');if(lease)db.prepare('INSERT INTO cp_leases VALUES(?)').run(lease);db.close();fs.chmodSync(file,0o600);return file;}
 for(const state of [{run:'termination_unverified'},{run:'running'},{lease:'held'},{lease:'quarantined'}]){const f=qualificationFixture(t);durable(f,state);const before=fs.readFileSync(path.join(f.home,'runtime-pins.json'),'utf8');await assert.rejects(f.l.requalify(f.home),/Durable writer/);assert.equal(f.probes,0);assert.equal(fs.readFileSync(path.join(f.home,'runtime-pins.json'),'utf8'),before);}
 const raced=qualificationFixture(t),file=durable(raced),before=fs.readFileSync(path.join(raced.home,'runtime-pins.json'),'utf8');raced.onProbe=()=>{const db=new(require('node:sqlite').DatabaseSync)(file);db.exec("INSERT INTO cp_leases VALUES('quarantined')");db.close();};await assert.rejects(raced.l.requalify(raced.home),/Durable writer/);assert.equal(raced.probes,1);assert.equal(fs.readFileSync(path.join(raced.home,'runtime-pins.json'),'utf8'),before);
 const unsafe=qualificationFixture(t),dbFile=durable(unsafe);fs.chmodSync(dbFile,0o644);await assert.rejects(unsafe.l.requalify(unsafe.home),/Durable writer/);assert.equal(unsafe.probes,0);
 const empty=qualificationFixture(t);durable(empty);assert.equal((await empty.l.requalify(empty.home)).qualified,true);
});
