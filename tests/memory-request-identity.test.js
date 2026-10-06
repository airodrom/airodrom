'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const {randomUUID,createHash}=require('node:crypto');
const {AuthorityStore}=require('../src/authority-store'),{EventLedger}=require('../src/event-ledger');
const identity=require('../src/memory-identity');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fixture(t,{personal=false}={}){const db=new DatabaseSync(':memory:');new AuthorityStore(db);const ledger=new EventLedger(db);t.after(()=>db.close());
 const task=randomUUID(),request=createHash('sha256').update('fixture personal request violet').digest('hex'),suffix=createHash('sha256').update(task+':'+request).digest('hex').slice(0,32);
 let memory=null,primary=null;if(personal){memory=new(require('../src/personal-memory').PersonalMemory)({db});primary=memory.remember({domain:'session',taskId:task,type:'note',subject:'fixture request',content:'fixture personal request violet',source:'user_explicit'});}
 const health=createHash('sha256').update(JSON.stringify('task-health-test:'+request)).digest('hex');
 db.exec('CREATE TABLE cp_invocations(request_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
 ledger.record({eventType:'orchestrator.invocation.persisted',agent:'bridge',direction:'internal',taskId:task,requestId:request,metadata:{request_id:request},protected:true});
 ledger.record({eventType:'capability.complete',agent:'bridge',direction:'internal',taskId:task,requestId:request,idempotencyKey:'orchestrator-capability:'+suffix,metadata:{tool_call_id:'orchestrator:'+suffix},protected:true});
 db.prepare('INSERT INTO cp_invocations VALUES(?,?,?,?,?,?,?)').run(request,task,'fixture-digest','settled',JSON.stringify({tool_call_id:'orchestrator:'+suffix,outbox_id:health}),1,2);
 return{db,task,request,suffix,health,memory,primary};}
function allText(db){const strings=[];for(const {name}of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())for(const row of db.prepare('SELECT * FROM "'+name+'"').all())for(const v of Object.values(row))if(typeof v==='string')strings.push(v);return strings;}
test('request migration removes hidden tool-call and health descendants from every retained reference',t=>{const f=fixture(t);identity.migrate(f.db);identity.assertReadable(f.db);for(const old of[f.request,f.suffix,f.health])assert.equal(allText(f.db).some(v=>v.includes(old)),false);const row=f.db.prepare('SELECT * FROM cp_invocations').get();assert.match(row.request_id,UUID);assert.match(JSON.parse(row.result).tool_call_id,/^orchestrator:[a-f0-9-]{36}$/);assert.match(JSON.parse(row.result).outbox_id,UUID);});
test('request descendant allocation is stable after interrupted rewrite and duplicate retry',t=>{const f=fixture(t);assert.throws(()=>identity.migrate(f.db,{afterRewrite:()=>{throw Error('fixture interruption');}}),/incomplete/);const first=f.db.prepare('SELECT record_class,anchor_id,identity FROM memory_identity_lineage ORDER BY record_class,anchor_id').all();identity.migrate(f.db);assert.deepEqual(f.db.prepare('SELECT record_class,anchor_id,identity FROM memory_identity_lineage ORDER BY record_class,anchor_id').all(),first);assert.equal(identity.migrate(f.db).migrated_records,0);});
test('unanchored hashed request has no fabricated restore mapping or readable disposition',t=>{const f=fixture(t);f.db.prepare('DELETE FROM event_ledger_events').run();assert.throws(()=>identity.migrate(f.db),/incomplete/);assert.throws(()=>identity.assertReadable(f.db),/incomplete/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_identity_lineage').get().n,0);});
test('new hashed request writes are rejected after identity migration',t=>{const f=fixture(t);identity.migrate(f.db);assert.throws(()=>f.db.prepare('INSERT INTO cp_invocations(request_id,task_id,fingerprint,state,result,created_at,updated_at,origin_event_id) VALUES(?,?,?,?,?,?,?,?)').run(f.request,randomUUID(),'fixture-digest','settled','{}',3,4,randomUUID()),/Legacy|identity/);});

test('legacy lifecycle backup uses authoritative opaque origins before erasure and cannot rebuild old correlations',t=>{
 const fs=require('node:fs'),path=require('node:path'),root=fs.mkdtempSync('/private/tmp/request-identity-restore-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const f=fixture(t,{personal:true}),session=randomUUID(),{ChatGPTEvents}=require('../src/chatgpt-events');new ChatGPTEvents(f.db);
 const h=createHash('sha256').update(f.task+':'+session+':'+f.request+':completed').digest('hex'),old=h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);
 f.db.prepare('INSERT INTO chatgpt_events(task_id,event_id,fingerprint,payload,received_at,delivery) VALUES(?,?,?,?,?,?)').run(f.task,old,'fixture-fingerprint',JSON.stringify({version:1,task_id:f.task,session_id:session,request_id:f.request,event_id:old,event_type:'completed',summary:'Pi task completed.',untrusted:true,grants_approval:false}),10,'inbox_only');
 new(require('../src/project-memory-v2').ProjectMemoryV2)({db:f.db});const file=path.join(root,'old.sqlite');f.db.exec("VACUUM INTO '"+file+"'");const target=new DatabaseSync(file);t.after(()=>target.close());
 identity.migrate(f.db);f.memory.erase(f.primary.memoryId);assert.equal(allText(f.db).some(x=>x.includes(old)),false);
 const {RestrictedMemoryVault}=require('../src/restricted-memory-vault');fs.mkdirSync(path.join(root,'vault'),{mode:0o700});fs.mkdirSync(path.join(root,'restored-vault'),{mode:0o700});const vault=new RestrictedMemoryVault(path.join(root,'vault'));vault.prepare();new RestrictedMemoryVault(path.join(root,'restored-vault')).prepare();
 const restored=require('../src/memory-restore').prepareMemoryRestore({db:target,erasureSourceDb:f.db,vaultDirectory:path.join(root,'restored-vault'),erasureSourceVault:vault});
 for(const value of[f.request,f.suffix,f.health,old,'fixture personal request violet'])assert.equal(allText(target).some(x=>x.includes(value)),false);
 assert.equal(restored.personal.get(f.primary.memoryId),null);assert.throws(()=>new ChatGPTEvents(target).list(f.task),/erased|unavailable/);
 identity.assertReadable(target);
});
test('ambiguous distinct source references in a single origin fail closed without collapsed allocations',t=>{
 const f=fixture(t),a='operator_text:'+createHash('sha256').update('fixture alpha').digest('hex'),b='operator_text:'+createHash('sha256').update('fixture beta').digest('hex');
 f.db.exec('CREATE TABLE host_reasoning_admissions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,mission_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,record TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(task_id,request_id))');
 f.db.prepare('INSERT INTO host_reasoning_admissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.task,randomUUID(),randomUUID(),randomUUID(),randomUUID(),'fixture-fingerprint',JSON.stringify({context_pack:{refs:[{id:a},{id:b}]}}),99999,'settled');
 assert.throws(()=>identity.migrate(f.db),/incomplete/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_identity_lineage').get().n,0);
});
