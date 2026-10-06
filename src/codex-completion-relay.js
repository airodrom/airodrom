'use strict';
// Local, same-user evidence transport. Correlation is not a capability grant.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {object,identifier,text,fingerprint,redactValue}=require('./control-plane-store');
const {transaction,afterCommit}=require('./control-transaction');
const VERSION='codex-result-v1',MAX=24000;
function owned(file,directory=false){
 const s=fs.lstatSync(file);
 if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Unsafe relay path or owner');
 return s;
}
function location(runtime,runId){
 identifier(runId);if(!/^[a-zA-Z0-9_-]+$/.test(runId))throw Error('Unsafe relay run path');
 const root=path.join(fs.realpathSync(runtime),'codex-results');
 return {root,dir:path.join(root,runId),file:path.join(root,runId,'completion.json')};
}
function provision(runtime,runId){
 const p=location(runtime,runId);for(const d of [p.root,p.dir]){fs.mkdirSync(d,{recursive:true,mode:0o700});owned(d,true);}return p;
}
function readArtifact(runtime,runId){
 const p=location(runtime,runId);owned(p.root,true);owned(p.dir,true);owned(p.file);
 const fd=fs.openSync(p.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try {const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Unsafe relay file');if(s.size>MAX)throw Error('Result too large');const data=fs.readFileSync(fd,'utf8');if(Buffer.byteLength(data)>MAX)throw Error('Result too large');return JSON.parse(data);}finally{fs.closeSync(fd);}
}
function validateEnvelope(input,contract){
 object(input,['schema_version','mission_id','task_id','run_id','request_id','agent_id','transport','relay_nonce','result','timestamps','source_work_thread_ref','source_output_ref','publisher','content_hash']);
 if(input.schema_version!==VERSION||input.agent_id!=='codex'||input.transport!=='handoff')throw Error('Invalid result schema or transport');
 for(const k of ['mission_id','task_id','run_id','request_id','relay_nonce'])if(input[k]!==contract[k])throw Error('Handoff correlation mismatch');
 object(input.result,['status','summary','changed_files','tests','checks','artifacts','limitations','needs_operator','continuity_claimed']);
 const r=input.result;if(r.continuity_claimed!==undefined&&typeof r.continuity_claimed!=='boolean')throw Error('Invalid continuity claim');if(!['completed','failed','needs_operator','cancelled','termination_unverified','partial'].includes(r.status))throw Error('Invalid result status');
 text(r.summary,'result summary',8000);
 for(const k of ['changed_files','tests','artifacts','limitations'])if(!Array.isArray(r[k])||r[k].length>100)throw Error('Invalid result collection');
 if(r.checks!==undefined&&(!Array.isArray(r.checks)||r.checks.length>100))throw Error('Invalid checks');
 for(const file of r.changed_files){text(file,'changed file',300);if(path.isAbsolute(file)||file.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw Error('Unsafe changed file');}
 for(const check of [...r.tests,...(r.checks||[])]){object(check,['name','status','evidence_refs']);text(check.name,'check name',240);if(!['passed','failed','skipped','unknown'].includes(check.status)||!Array.isArray(check.evidence_refs))throw Error('Invalid check');}
 for(const ref of [...r.artifacts,...r.tests.flatMap(t=>t.evidence_refs),...(r.checks||[]).flatMap(t=>t.evidence_refs)]){text(ref,'evidence reference',1000);if(path.isAbsolute(ref)||ref.includes('..')||/^(?:file:|https?:|secret:)/i.test(ref))throw Error('Unsafe evidence reference');}
 if(r.status==='needs_operator'){
  object(r.needs_operator,['question','options','allow_free_text']);text(r.needs_operator.question,'decision question',3000);
  const d=r.needs_operator;if(!Array.isArray(d.options)||d.options.length>8||typeof d.allow_free_text!=='boolean'||(!d.options.length&&!d.allow_free_text))throw Error('Invalid Decision');
  const ids=new Set();for(const o of d.options){object(o,['id','label','description','recommended']);identifier(o.id);text(o.label,'option label',240);if(o.description!==undefined)text(o.description,'option description',1000);if(ids.has(o.id)||o.recommended!==undefined&&typeof o.recommended!=='boolean')throw Error('Invalid Decision options');ids.add(o.id);}
 }else if(r.needs_operator!==undefined)throw Error('Unexpected Decision payload');
 object(input.timestamps,['started_at','finished_at']);for(const k of ['started_at','finished_at'])if(!Number.isSafeInteger(input.timestamps[k])||input.timestamps[k]<0)throw Error('Invalid timestamps');
 if(input.timestamps.finished_at<input.timestamps.started_at)throw Error('Invalid timestamp ordering');
 for(const k of ['source_work_thread_ref','source_output_ref'])if(input[k]!==undefined)text(input[k],k,1000);if(input.source_output_ref!==undefined&&(path.isAbsolute(input.source_output_ref)||input.source_output_ref.includes('..')))throw Error('Unsafe source output reference');
 object(input.publisher,['identity','mode']);if(input.publisher.identity!=='codex-work'||input.publisher.mode!=='artifact')throw Error('Invalid publisher identity');
 const {content_hash,...body}=input;if(content_hash!==fingerprint(body))throw Error('Content hash mismatch');
 if(Buffer.byteLength(JSON.stringify(input))>MAX)throw Error('Result too large');
 const safe=redactValue(input);if(fingerprint(safe)!==fingerprint(input))throw Error('Sensitive result content');return safe;
}
class CodexCompletionRelay {
 constructor(bridge){this.bridge=bridge;this.store=bridge.controlStore;this.db=this.store.db;this.runtime=bridge.dataDir;this.watchers=new Map();this.closed=false;
  this.db.exec('CREATE TABLE IF NOT EXISTS cp_codex_relay(run_id TEXT PRIMARY KEY,state TEXT NOT NULL,result_hash TEXT,error_class TEXT,updated_at INTEGER NOT NULL)');
 }
 contract(runId){const p=provision(this.runtime,runId);const argv=[path.resolve(__dirname,'../scripts/publish-agent-result.cjs'),'--file','RESULT.json','--runtime',fs.realpathSync(this.runtime)];const quote=s=>"'"+s.replace(/'/g,"'\"'\"'")+"'";return{relay_nonce:randomUUID(),result_publication:{mode:'artifact',schema_version:VERSION,path:p.file,executable:process.execPath,argv,command:[process.execPath,...argv].map(quote).join(' '),max_bytes:MAX,hash:'sha256 canonical JSON excluding content_hash',hash_helper:path.resolve(__dirname,'control-plane-store.js'),authority:'evidence_only',termination_policy:'Operator must confirm actual Work termination; artifact arrival never releases leases'}};}
 watch(runId){if(this.closed||this.watchers.has(runId))return;const p=location(this.runtime,runId);try{owned(p.root,true);owned(p.dir,true);const watcher=fs.watch(p.dir,()=>{if(!this.closed)this.consume(runId);});watcher.unref();this.watchers.set(runId,watcher);}catch{this.reject(runId,'unsafe_path');}}
 start(){this.reconcile();}
 reject(runId,reason){const h=this.db.prepare('SELECT run_id FROM cp_codex_handoffs WHERE run_id=?').get(runId);if(!h)return;
  const old=this.db.prepare('SELECT state,error_class FROM cp_codex_relay WHERE run_id=?').get(runId);if(old?.state==='rejected'&&old.error_class===reason)return;
  transaction(this.db,()=>{this.db.prepare("INSERT INTO cp_codex_relay VALUES(?,'rejected',NULL,?,?) ON CONFLICT(run_id) DO UPDATE SET state='rejected',error_class=excluded.error_class,updated_at=excluded.updated_at").run(runId,reason,this.store.now());this.store.event(reason==='conflict'?'codex.result.conflict':'codex.result.rejected',null,{reason},{runId});});
 }
 consume(runId){
  if(this.closed)return;const row=this.db.prepare('SELECT * FROM cp_codex_handoffs WHERE run_id=?').get(runId);if(!row)return;
  const c=JSON.parse(row.contract);if(c.protocol!=='codex-handoff-v2')return;
  const p=location(this.runtime,runId);if(!fs.existsSync(p.file)){try{fs.lstatSync(p.file);}catch(e){if(e.code==='ENOENT')return;} }
  try {
   const safe=validateEnvelope(readArtifact(this.runtime,runId),c),hash=fingerprint(safe);
   const receipt=transaction(this.db,()=>{
    const run=this.store.run(runId);if(run?.agent_id!=='codex'||run.mission_id!==c.mission_id||run.task_id!==c.task_id)throw Error('correlation');
    const old=this.db.prepare('SELECT fingerprint FROM cp_codex_result_proposals WHERE run_id=?').get(runId);
    if(old){if(old.fingerprint!==hash)throw Error('conflict');return{duplicate:true};}
    if(row.state!=='awaiting_handoff'||this.store.getMission(c.mission_id).state==='cancelled')throw Error('stale');
    this.store.event('codex.result.publish_requested',c.mission_id,{publisher_mode:'artifact',result_hash:hash},{runId});
    this.db.prepare('INSERT INTO cp_codex_result_proposals VALUES(?,?,?,?)').run(runId,hash,JSON.stringify(safe),this.store.now());
    this.bridge.resultInbox.publishHandoff(c,safe);
    this.bridge.agentDispatch?.onCompletion(runId);
    if(safe.result.status==='needs_operator'){
      const m=this.store.getMission(c.mission_id);if(m.state==='ready')this.store.state(m.id,'dispatching');
      if(this.store.getMission(m.id).state==='dispatching')this.store.state(m.id,'running');
      this.store.createDecision(c.mission_id,{...safe.result.needs_operator,run_id:runId,agent_id:'codex'});
    }
    this.db.prepare("INSERT INTO cp_codex_relay VALUES(?,'published',?,NULL,?) ON CONFLICT(run_id) DO UPDATE SET state='published',result_hash=excluded.result_hash,error_class=NULL,updated_at=excluded.updated_at").run(runId,hash,this.store.now());
    this.store.event('codex.result.published',c.mission_id,{result_hash:hash,termination_verified:false,verification:'waiting_for_termination'},{runId});
    afterCommit(this.db,()=>this.bridge.missions?.schedule());return{duplicate:false};
   });
   if(receipt.duplicate)this.store.event('codex.result.duplicate',c.mission_id,{result_hash:hash},{runId});
   // The durable receipt wins if a crash happens before renaming. Recovery dedups.
   fs.renameSync(p.file,path.join(p.dir,'consumed.json'));return receipt;
  }catch(e){this.reject(runId,e.message==='conflict'?'conflict':e.message==='stale'?'stale':'invalid_artifact');return{rejected:true};}
 }
 reconcile(){if(this.closed)return;const now=Date.now();if(this.nextScan&&now<this.nextScan)return;this.nextScan=now+30000;for(const [id,w]of this.watchers){if(this.db.prepare('SELECT state FROM cp_codex_handoffs WHERE run_id=?').get(id)?.state==='settled'){w.close();this.watchers.delete(id);}}const rows=this.db.prepare("SELECT run_id,contract FROM cp_codex_handoffs WHERE state<>'settled' AND run_id>? ORDER BY run_id LIMIT 100").all(this.scanCursor||'');this.scanCursor=rows.length===100?rows.at(-1).run_id:'';for(const row of rows){const c=JSON.parse(row.contract);if(c.protocol==='codex-handoff-v2'){this.watch(row.run_id);this.consume(row.run_id);}}}
 close(){this.closed=true;for(const w of this.watchers.values())w.close();this.watchers.clear();}
}
module.exports={CodexCompletionRelay,validateEnvelope,readArtifact,location,owned,VERSION,MAX};
