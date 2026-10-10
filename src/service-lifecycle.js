'use strict';
// ADR 0026. Admission interlock on the existing canonical store, not authority.
const {transaction}=require('./control-transaction');
const {randomUUID}=require('node:crypto');
class ServiceLifecycle {
 constructor(bridge){
  this.bridge=bridge;this.db=bridge.controlStore.db;this.requests=0;this.epoch=randomUUID();this.reconciled=false;
  this.db.exec("CREATE TABLE IF NOT EXISTS cp_service_lifecycle(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL CHECK(state IN ('open','draining','stopping','booting')),epoch TEXT NOT NULL)");
  transaction(this.db,()=>{
   const old=this.db.prepare('SELECT state,epoch FROM cp_service_lifecycle WHERE id=1').get();
   // A new writer-owner always replaces durable admission with booting + fresh epoch.
   // Orphaned stopping/draining/booting from a dead prior process cannot survive this
   // ownership transfer; resume still requires idle blockers and current-epoch auth.
   this.priorState=old?.state||null;
   this.priorEpoch=old?.epoch||null;
   // Initial activation has no prior open epoch. Recovery alone cannot grant
   // admission: retain the maintenance hold until authenticated operator resume.
   this.autoOpen=old?.state==='open' && bridge.startClosed!==true;
   this.db.prepare("INSERT INTO cp_service_lifecycle VALUES(1,'booting',?) ON CONFLICT(id) DO UPDATE SET state='booting',epoch=excluded.epoch").run(this.epoch);
  });
 }
 state(){const row=this.db.prepare('SELECT * FROM cp_service_lifecycle WHERE id=1').get();if(row?.epoch!==this.epoch)throw Error('Service lifecycle ownership changed');return row.state;}
 assertOpen(){if(this.state()!=='open'||this.bridge.closed)throw Error('Service admission is closed for maintenance');}
 blockers(){
  const count=sql=>this.db.prepare(sql).get().n,b=this.bridge;
  return {
   requests:this.requests,
   supervisor:b.supervisor?.busy?1:0,
   chatgpt_delivery:b.chatgptEvents?.running?1:0,
   chatgpt_uncertain:this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chatgpt_events'").get()?count("SELECT count(*) n FROM chatgpt_events WHERE (delivery='pending' AND attempts>0) OR delivery='needs_review'"):0,
   runs:count(require('./run-settlement').UNRESOLVED_RUNS_SQL),
   leases:count("SELECT count(*) n FROM cp_leases WHERE state IS NULL OR state <> 'released'"),
   invocations:count("SELECT count(*) n FROM cp_invocations WHERE state IN ('running','unknown')"),
   dispatches:count("SELECT count(*) n FROM cp_dispatches WHERE state IN ('dispatching','running','unknown')"),
   continuations:count("SELECT count(*) n FROM cp_continuations WHERE state IN ('dispatching','unknown')"),
   slack_effects:count("SELECT count(*) n FROM cp_slack_outbox WHERE state IN ('sending','delivery_unknown')"),
   effects:count("SELECT count(*) n FROM cp_effect_outbox WHERE status IN ('dispatching','delivery_unknown')"),
   execution_leases:b.leases?.size||0,
   conversations:b.controlServer?.conversationEngine?.active?.size||0,
   google_reads:b.controlServer?.googleWorkspace?.active||0,
   mission_tick:b.missions?.busy?1:0,
   next_actions:b.boundedNextActions?.reconciling||b.boundedNextActions?.busy?1:0,
   agent_dispatch:b.agentDispatch?.busy?1:0,
   outbox:b.controlStore.outbox.busy?1:0,
   external_jobs:b.capabilityHost?.jobs?.jobs? [...b.capabilityHost.jobs.jobs.values()].filter(j=>!['completed','failed','cancelled'].includes(j.status)).length:0
  };
 }
 status(){const blockers=this.blockers();return {version:1,closed_startup:this.bridge.startClosed===true,state:this.state(),epoch:this.epoch,prior_state:this.priorState,prior_epoch:this.priorEpoch,reconciled:this.reconciled,blockers,idle:Object.values(blockers).every(n=>n===0)};}
 drain(){return transaction(this.db,()=>{if(this.state()==='stopping')throw Error('Service is stopping');this.db.prepare("UPDATE cp_service_lifecycle SET state='draining' WHERE id=1").run();return this.status();});}
 finishRecovery(){this.reconciled=true;const status=this.status();if(this.autoOpen&&status.idle)return this.resume(this.epoch);return status;}
 resume(epoch){return transaction(this.db,()=>{
  if(epoch!==this.epoch||!this.reconciled||this.bridge.closed||this.state()==='stopping')throw Error('Current reconciled service epoch required');
  if(!this.status().idle)throw Error('Canonical work or termination is unresolved; admission remains closed');
  this.db.prepare("UPDATE cp_service_lifecycle SET state='open' WHERE id=1").run();return this.status();
 });}
 prepareStop(){return transaction(this.db,()=>{
  if(this.state()!=='draining'||!this.reconciled||!this.status().idle)throw Error('Drain is not idle; service and ownership preserved');
  this.db.prepare("UPDATE cp_service_lifecycle SET state='stopping' WHERE id=1").run();return this.status();
 });}
}
module.exports={ServiceLifecycle};
