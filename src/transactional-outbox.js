'use strict';
const {randomUUID}=require('node:crypto');
const {transaction,inTransaction}=require('./control-transaction');
const {fingerprint,identifier,redactValue}=require('./control-plane-store');
const PERMANENT=new Set(['policy','auth','schema','unsupported_destination']);
class TransactionalOutbox {
 constructor(store,{random=Math.random,maxAttempts=8}={}){this.store=store;this.db=store.db;this.random=random;this.maxAttempts=maxAttempts;this.handlers=new Map();this.busy=false;this.db.exec(`CREATE TABLE IF NOT EXISTS cp_effect_outbox(id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,destination_type TEXT NOT NULL,destination_ref TEXT NOT NULL,event_type TEXT NOT NULL,correlation TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','dispatching','sent','failed','dead_letter','delivery_unknown')),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,sent_at INTEGER,error_class TEXT,receipt TEXT,claim TEXT);CREATE INDEX IF NOT EXISTS cp_effect_due ON cp_effect_outbox(status,next_at);`);}
 register(type,handler,{idempotent=false}={}){identifier(type);this.handlers.set(type,{handler,idempotent});}
 enqueue({key,destination,ref,eventType,correlation={},payload={}}){identifier(key);identifier(destination);identifier(ref);if(/^(?:crsr_|xox[baprs]-|xapp-|sk-ant-|sk-proj-|gh[pousr]_)/.test(ref))throw Error('Sensitive destination ref');identifier(eventType);const safe=redactValue(payload),ids=redactValue(correlation);if(Buffer.byteLength(JSON.stringify(safe))>24000)throw Error('Outbox payload too large');const shape={destination,ref,eventType,correlation:ids,payload:safe};return transaction(this.db,()=>{const old=this.db.prepare('SELECT * FROM cp_effect_outbox WHERE event_key=?').get(key);if(old){if(fingerprint({destination:old.destination_type,ref:old.destination_ref,eventType:old.event_type,correlation:JSON.parse(old.correlation),payload:JSON.parse(old.payload)})!==fingerprint(shape))throw Error('Outbox idempotency conflict');return old.id;}const id=randomUUID(),now=this.store.now();this.db.prepare("INSERT INTO cp_effect_outbox VALUES(?,?,?,?,?,?,?,'pending',0,?,?,?,NULL,NULL,NULL,NULL)").run(id,key,destination,ref,eventType,JSON.stringify(ids),JSON.stringify(safe),now,now,now);this.audit('enqueued',id,ids,{destination});return id;});}
 audit(kind,id,correlation,metadata={}){this.store.event(`outbox.${kind}`,correlation.mission_id||null,{outbox_id:id,...metadata},{runId:correlation.run_id||null,taskId:correlation.task_id||null});}
 recover(){transaction(this.db,()=>{for(const row of this.db.prepare("SELECT * FROM cp_effect_outbox WHERE status='dispatching'").all()){const retry=this.handlers.get(row.destination_type)?.idempotent===true;this.db.prepare('UPDATE cp_effect_outbox SET status=?,claim=NULL,updated_at=? WHERE id=?').run(retry?'pending':'delivery_unknown',this.store.now(),row.id);}});}
 async dispatch(){
  if(this.stopped||this.busy||inTransaction(this.db))return;
  const readable=()=>require('./memory-content-erasure').assertReadable(this.db);
  const erased=id=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_erasure_content_rows'").get()&&!!this.db.prepare("SELECT 1 FROM memory_erasure_content_rows WHERE table_name='cp_effect_outbox' AND row_key=?").get(JSON.stringify([id]));
  readable();this.busy=true;
  try{
   const destinations=[...this.handlers.keys()];if(!destinations.length)return;
   // Keep only opaque row identities across awaits. Never retain a preselected
   // personal payload for delivery after a concurrent erasure or migration.
   const selected=this.db.prepare(`SELECT id FROM cp_effect_outbox WHERE status IN ('pending','failed') AND next_at<=? AND destination_type IN (${destinations.map(()=>'?').join(',')}) ORDER BY created_at LIMIT 50`).all(this.store.now(),...destinations);
   for(const {id}of selected){
    if(this.stopped)break;readable();if(erased(id))continue;
    const row=this.db.prepare("SELECT * FROM cp_effect_outbox WHERE id=? AND status IN ('pending','failed') AND next_at<=?").get(id,this.store.now());if(!row)continue;
    const entry=this.handlers.get(row.destination_type);if(!entry)continue;const claim=randomUUID();
    const changed=transaction(this.db,()=>this.db.prepare("UPDATE cp_effect_outbox SET status='dispatching',attempts=attempts+1,claim=?,updated_at=? WHERE id=? AND status IN ('pending','failed') AND attempts=? AND next_at<=?").run(claim,this.store.now(),row.id,row.attempts,this.store.now()).changes);if(!changed)continue;
    const ids=JSON.parse(row.correlation);let receiptReturned=false;
    try{
     readable();if(erased(id))continue;
     const receipt=await entry.handler({...row,correlation:ids,payload:JSON.parse(row.payload),idempotency_key:row.event_key});
     // A delivered effect cannot be recalled here. Its returned receipt may
     // contain personal content, so it must not repopulate a now-erased row.
     readable();if(erased(id))continue;
     if(!receipt)throw Object.assign(Error('Unconfirmed receipt'),{failureClass:'delivery_unknown'});
     receiptReturned=true;
     transaction(this.db,()=>{this.db.prepare("UPDATE cp_effect_outbox SET status='sent',sent_at=?,updated_at=?,receipt=?,claim=NULL WHERE id=? AND claim=?").run(this.store.now(),this.store.now(),JSON.stringify(redactValue(receipt)),row.id,claim);this.audit('sent',row.id,ids,{destination:row.destination_type});});
    }catch(error){
     // Failed privacy state must not write cached correlation/receipt content.
     readable();if(erased(id))continue;
     const cls=receiptReturned&&!entry.idempotent?'delivery_unknown':PERMANENT.has(error.failureClass)?error.failureClass:error.failureClass==='delivery_unknown'?'delivery_unknown':'transient',attempt=row.attempts+1,dead=PERMANENT.has(cls)||attempt>=this.maxAttempts,status=cls==='delivery_unknown'?'delivery_unknown':dead?'dead_letter':'failed';
     transaction(this.db,()=>{this.db.prepare('UPDATE cp_effect_outbox SET status=?,next_at=?,updated_at=?,error_class=?,claim=NULL WHERE id=? AND claim=?').run(status,this.store.now()+Math.min(300000,1000*2**Math.min(attempt,12))*(0.75+this.random()*0.5),this.store.now(),cls,row.id,claim);this.audit(dead?'dead_letter':'failed',row.id,ids,{error_class:cls,attempts:attempt});});
    }
   }
  }finally{this.busy=false;}
 }

 async stop(){this.stopped=true;while(this.busy)await new Promise(resolve=>setTimeout(resolve,20));}
 health(){const counts=Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM cp_effect_outbox GROUP BY status').all().map(r=>[r.status,r.n]));const oldest=this.db.prepare("SELECT min(created_at) at FROM cp_effect_outbox WHERE status IN ('pending','failed')").get().at;return{counts,oldest_pending_age_ms:oldest==null?null:this.store.now()-oldest,last_success_at:this.db.prepare('SELECT max(sent_at) at FROM cp_effect_outbox').get().at,destinations:this.db.prepare('SELECT destination_type,status,count(*) count FROM cp_effect_outbox GROUP BY destination_type,status').all()};}
}
module.exports={TransactionalOutbox};
