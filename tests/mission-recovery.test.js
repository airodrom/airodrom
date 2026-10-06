'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{EventLedger}=require('../src/event-ledger'),{ControlPlaneStore}=require('../src/control-plane-store');
const {migrateMissionSchema}=require('../src/mission-schema');
test('historical V1 migration is atomic; actual close/reopen preserves Decisions, intents and ledger sequence',t=>{
 const root=fs.mkdtempSync('/private/tmp/mission-recovery-'),file=path.join(root,'state.sqlite');let db=new DatabaseSync(file);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 db.exec('CREATE TABLE project_missions(mission_id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER)');let ledger=new EventLedger(db),store=new ControlPlaneStore({db,ledger});store.registerMission({id:'m',taskId:'t',owner:'operator',envelope:{objective:'Historical fixture'},ceiling:{}});const decision=store.createDecision('m',{question:'Choose',options:[{id:'B',label:'B'}]});const event=ledger.record({eventType:'historical.event',agent:'bridge',direction:'internal'});
 db.exec('DROP TABLE cp_slack_pending_events; DROP TABLE cp_slack_config; DROP TABLE cp_mission_tasks; DROP TABLE cp_dispatches; DROP TABLE cp_run_results; DROP TABLE cp_gateway_cursors; ALTER TABLE cp_runs DROP COLUMN provider_id; ALTER TABLE cp_runs DROP COLUMN last_heartbeat_at; UPDATE control_plane_meta SET version=1');
 const exec=db.exec.bind(db);db.exec=sql=>exec(sql.includes('CREATE TABLE cp_dispatches')?sql.replace('CREATE TABLE cp_dispatches','INVALID MIGRATION'):sql);assert.throws(()=>migrateMissionSchema(db));db.exec=exec;assert.equal(db.prepare('SELECT version FROM control_plane_meta').get().version,1);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='cp_mission_tasks'").get().n,0);db.close();
 const reopen=()=>{db=new DatabaseSync(file);ledger=new EventLedger(db);store=new ControlPlaneStore({db,ledger});store.recover();};reopen();assert.equal(db.prepare('SELECT version FROM control_plane_meta').get().version,3);assert.equal(store.decision(decision.id).state,'waiting_for_operator');assert.equal(ledger.get(event.event_id).sequence,event.sequence);
 store.answerDecision(decision.id,{option_id:'B',actor:'operator',surface:'operator'});db.close();reopen();assert.equal(store.decision(decision.id).answer.option_id,'B');assert.equal(db.prepare("SELECT count(*) n FROM cp_continuations WHERE state='queued'").get().n,1);store.answerDecision(decision.id,{option_id:'B',actor:'operator',surface:'operator'});assert.equal(db.prepare('SELECT count(*) n FROM cp_continuations').get().n,1);
 db.prepare("INSERT INTO cp_dispatches VALUES('uncertain','m','t','dispatching',NULL,NULL,NULL,1,1)").run();db.close();reopen();assert.equal(db.prepare("SELECT state FROM cp_dispatches WHERE id='uncertain'").get().state,'unknown');assert.equal(ledger.get(event.event_id).sequence,event.sequence);
});

test('V2 Slack migration rollback preserves records and rejects future schema versions',()=>{
 const db=new DatabaseSync(':memory:');try{
 const ledger=new EventLedger(db);new ControlPlaneStore({db,ledger});
 db.exec('DROP TABLE cp_slack_pending_events;DROP TABLE cp_slack_config;UPDATE control_plane_meta SET version=2');
 const original=db.exec.bind(db);db.exec=sql=>original(sql.includes('CREATE TABLE cp_slack_pending_events')?sql.replace('CREATE TABLE cp_slack_pending_events','INVALID MIGRATION'):sql);
 assert.throws(()=>new ControlPlaneStore({db,ledger}));db.exec=original;
 assert.equal(db.prepare('SELECT version FROM control_plane_meta').get().version,2);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='cp_slack_config'").get().n,0);
 new ControlPlaneStore({db,ledger});new ControlPlaneStore({db,ledger});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 db.exec('UPDATE control_plane_meta SET version=999');assert.throws(()=>new ControlPlaneStore({db,ledger}),/Unsupported/);
 }finally{db.close();}
});
