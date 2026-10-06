'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {secretLike:containsSecret}=require('./provider-policy');
const {transaction}=require('./control-transaction');
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const CATEGORIES=new Set(['architecture_decision','invariant','known_limitation','runbook_fact','provider_state','agent_state','roadmap_state']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exists=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='architecture_memory_versions'").get();
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Malformed architecture manifest');}
function safeId(v){if(typeof v!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(v))throw Error('Invalid architecture identifier');return v;}
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS architecture_memory_versions(
 project_id TEXT NOT NULL,subject_key TEXT NOT NULL,version_hash TEXT NOT NULL,memory_id TEXT NOT NULL UNIQUE REFERENCES personal_memories(memory_id),
 source_ref TEXT NOT NULL,source_hash TEXT NOT NULL,source_type TEXT NOT NULL,trust TEXT NOT NULL,category TEXT NOT NULL,tags TEXT NOT NULL,
 supersedes TEXT,indexed_at INTEGER NOT NULL,origin_event_id TEXT REFERENCES event_ledger_events(event_id),PRIMARY KEY(project_id,subject_key,version_hash));
 CREATE TABLE IF NOT EXISTS architecture_memory_bootstraps(project_id TEXT PRIMARY KEY,manifest_hash TEXT NOT NULL,indexed_at INTEGER NOT NULL,record_count INTEGER NOT NULL);`);
 if(!db.prepare('PRAGMA table_info(architecture_memory_versions)').all().some(c=>c.name==='origin_event_id'))db.exec('ALTER TABLE architecture_memory_versions ADD COLUMN origin_event_id TEXT REFERENCES event_ledger_events(event_id)');
 db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS architecture_identity_origin_unique ON architecture_memory_versions(origin_event_id);
  CREATE TRIGGER IF NOT EXISTS architecture_origin_ref_immutable BEFORE UPDATE OF origin_event_id ON architecture_memory_versions
   WHEN old.origin_event_id IS NOT NULL AND old.origin_event_id IS NOT new.origin_event_id BEGIN SELECT RAISE(ABORT,'Architecture origin reference is immutable');END;
  CREATE TRIGGER IF NOT EXISTS architecture_origin_event_immutable BEFORE UPDATE ON event_ledger_events
   WHEN old.event_type='architecture.identity_origin' BEGIN SELECT RAISE(ABORT,'Architecture origin event is immutable');END;
  CREATE TRIGGER IF NOT EXISTS architecture_origin_event_no_delete BEFORE DELETE ON event_ledger_events
   WHEN old.event_type='architecture.identity_origin' BEGIN SELECT RAISE(ABORT,'Architecture origin event is durable');END;`);
}
function recordOrigin(db,projectId,now=Date.now()) {
 const {EventLedger}=require('./event-ledger'),id=randomUUID();
 new EventLedger(db,{now:()=>now}).record({eventId:id,eventType:'architecture.identity_origin',agent:'bridge',direction:'internal',status:'recorded',protected:true,
  idempotencyKey:'architecture-origin:'+id,metadata:{version:1,project_id:projectId,record_class:'architecture_memory_version'}});
 return id;
}
// Explicit host maintenance only. Old archives must not invent fresh origins
// during recovery: independent authoritative lineage must already contain them.
function prepareIdentityMigration(db,{now=Date.now()}={}) {
 if(!exists(db))return {origin_events_added:0,authority:false};
 return transaction(db,()=>{
  new(require('./event-ledger').EventLedger)(db,{now:()=>now});migrate(db);
  let count=0;
  for(const row of db.prepare('SELECT rowid,project_id,origin_event_id FROM architecture_memory_versions ORDER BY rowid').all()){
   if(row.origin_event_id){
    if(!UUID.test(row.origin_event_id))throw Error('Unknown architecture identity origin');
    const event=db.prepare('SELECT event_type,metadata,payload,payload_sha256 FROM event_ledger_events WHERE event_id=?').get(row.origin_event_id);
    let metadata;try{metadata=event&&JSON.parse(event.metadata);}catch{throw Error('Unknown architecture identity origin');}
    if(event?.event_type!=='architecture.identity_origin'||event.payload!==null||event.payload_sha256!==null||metadata?.version!==1||Object.keys(metadata).length!==3||metadata?.project_id!==row.project_id||metadata?.record_class!=='architecture_memory_version')throw Error('Architecture identity origin scope mismatch');
    continue;
   }
   const origin=recordOrigin(db,row.project_id,now);
   db.prepare('UPDATE architecture_memory_versions SET origin_event_id=? WHERE rowid=?').run(origin,row.rowid);count++;
  }
  return {origin_events_added:count,authority:false};
 });
}
function assertOpaqueVersions(db,projectId=null) {
 require('./memory-identity').assertReadable(db);
 if(!exists(db))return;
 const rows=db.prepare('SELECT version_hash FROM architecture_memory_versions WHERE (? IS NULL OR project_id=?)').all(projectId,projectId);
 if(rows.some(r=>!UUID.test(r.version_hash)))throw Error('Architecture version identity requires opaque migration');
}
function assertBootstrapNotErased(db,projectId) {
 if(!exists(db))return;
 if(db.prepare("SELECT 1 FROM architecture_memory_versions a JOIN memory_erasure_markers e ON e.store='personal' AND e.identity=a.memory_id AND e.action='operator_erasure' WHERE a.project_id=? LIMIT 1").get(projectId))throw Error('Erased architecture source cannot be indexed again');
}
// Manifest is operator-maintained repository configuration. No agent/provider input is accepted here.
function validateManifest(root,manifest){
 exact(manifest,['schema_version','sources','facts']);if(manifest.schema_version!==1||!Array.isArray(manifest.sources)||!Array.isArray(manifest.facts)||manifest.sources.length>40||manifest.facts.length>100)throw Error('Malformed architecture manifest');
 root=fs.realpathSync(root);const sources=new Map();
 for(const s of manifest.sources){exact(s,['path','source_hash','source_type','trust']);
  if(typeof s.path!=='string'||!/^docs\/harness\/[a-z0-9-]+\.md$/.test(s.path)||sources.has(s.path)||s.source_type!=='canonical_doc'||s.trust!=='canonical'||!/^[a-f0-9]{64}$/.test(s.source_hash))throw Error('Unapproved architecture source');
  const file=path.join(root,s.path),real=fs.realpathSync(file);if(real!==file||!real.startsWith(root+path.sep)||!fs.statSync(real).isFile()||fs.statSync(real).size>200000)throw Error('Unsafe architecture source path');
  const content=fs.readFileSync(real,'utf8');if(hash(content)!==s.source_hash)throw Error('Canonical source hash changed; reconcile approved manifest');
  sources.set(s.path,{...s,content});
 }
 const seen=new Set();return manifest.facts.map(f=>{exact(f,['key','category','source_ref','content','tags']);safeId(f.key);
  const s=sources.get(f.source_ref);if(seen.has(f.key)||!s||!CATEGORIES.has(f.category)||typeof f.content!=='string'||!f.content.trim()||Buffer.byteLength(f.content)>3000||!s.content.includes(f.content)||!Array.isArray(f.tags)||f.tags.length>10||f.tags.some(t=>typeof t!=='string'||!/^[a-z0-9_-]{1,40}$/.test(t)))throw Error('Invalid canonical fact');
  if(containsSecret(f.content)||containsSecret(f.key))throw Error('Secret-like canonical text rejected');seen.add(f.key);
  return {...f,source_hash:s.source_hash,source_type:s.source_type,trust:s.trust};
 }).sort((a,b)=>a.key.localeCompare(b.key,'en'));
}
function bootstrap({db,memory,root,manifest,projectId,dryRun=true}){
 safeId(projectId);assertOpaqueVersions(db,projectId);assertBootstrapNotErased(db,projectId);const facts=validateManifest(root,manifest),manifestHash=hash(manifest);
 const inspect=()=>{
  const versions=exists(db)?db.prepare('SELECT a.*,p.status,p.content FROM architecture_memory_versions a JOIN personal_memories p USING(memory_id) WHERE a.project_id=?').all(projectId):[];
  // Idempotency examines erasable payload while available. A forgotten subject
  // remains suppressed without retaining its old content/version fingerprint.
  const matches=(v,f)=>v.subject_key===f.key&&v.category===f.category&&v.source_ref===f.source_ref&&v.source_hash===f.source_hash&&v.content===f.content&&v.tags===JSON.stringify(f.tags);
  const suppressed=new Set(versions.filter(v=>v.status==='forgotten'||v.status==='expired').map(v=>v.subject_key));
  const additions=facts.filter(f=>!suppressed.has(f.key)&&!versions.some(v=>matches(v,f)));
  const retired=versions.filter(v=>v.status==='active'&&!facts.some(f=>matches(v,f)));
  return {facts,versions,additions,retired};
 };
 const summary=plan=>({project_id:projectId,manifest_hash:manifestHash,validated_records:facts.length,additions:plan.additions.length,retirements:plan.retired.length,secret_findings:0,dry_run:dryRun,authority:false});
 if(dryRun)return summary(inspect());
 return transaction(db,()=>{
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_leases'").get()&&db.prepare("SELECT 1 FROM cp_leases WHERE mode='write' AND state IN ('held','quarantined') AND resource=?").get(fs.realpathSync(root)))throw Error('BLOCKED_BY_ACTIVE_WRITER');
  const project=db.prepare('SELECT repositories,status FROM projects WHERE project_id=?').get(projectId);
  if(!project||project.status==='archived'||!JSON.parse(project.repositories).includes(fs.realpathSync(root)))throw Error('Architecture project repository scope mismatch');
  new(require('./event-ledger').EventLedger)(db);migrate(db);const plan=inspect();
  for(const f of plan.additions){
   const prior=plan.versions.find(v=>v.subject_key===f.key&&v.status==='active');
   const memoryId=randomUUID(),versionId=randomUUID(),origin=recordOrigin(db,projectId);
   const item={memoryId};
   db.prepare(`INSERT INTO personal_memories(memory_id,domain,type,subject,content,content_hash,source,source_event_id,task_id,project_id,session_id,created_at,updated_at,last_used_at,confidence,sensitivity,status,superseded_by,expires_at) VALUES(?,'project',?,?,?,?, 'project_derived',NULL,NULL,?,NULL,?,?,NULL,100,'normal','active',NULL,NULL)`).run(memoryId,'architecture:'+f.category,'architecture:'+f.key,f.content,hash(f.content),projectId,Date.now(),Date.now());
   if(prior)db.prepare("UPDATE personal_memories SET status='superseded',superseded_by=?,updated_at=? WHERE memory_id=? AND status='active'").run(memoryId,Date.now(),prior.memory_id);
   db.prepare('INSERT INTO architecture_memory_versions(project_id,subject_key,version_hash,memory_id,source_ref,source_hash,source_type,trust,category,tags,supersedes,indexed_at,origin_event_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(projectId,f.key,versionId,item.memoryId,f.source_ref,f.source_hash,f.source_type,f.trust,f.category,JSON.stringify(f.tags),prior?.memory_id||null,Date.now(),origin);
  }
  for(const v of plan.retired)db.prepare("UPDATE personal_memories SET status='superseded',updated_at=? WHERE memory_id=? AND status='active'").run(Date.now(),v.memory_id);
  // Unchanged/forgotten versions are never resurrected by replay, including older manifest rollback.
  if(plan.additions.length||plan.retired.length||!db.prepare('SELECT 1 FROM architecture_memory_bootstraps WHERE project_id=?').get(projectId))db.prepare('INSERT INTO architecture_memory_bootstraps VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET manifest_hash=excluded.manifest_hash,indexed_at=excluded.indexed_at,record_count=excluded.record_count').run(projectId,manifestHash,Date.now(),facts.length);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='authority_activation'").get()&&db.prepare("SELECT 1 FROM authority_activation WHERE memory_state='enabled'").get()){
   const {AuthorityStore}=require('./authority-store'),{AuthorityMemory}=require('./authority-memory'),s=new AuthorityStore(db),governed=new AuthorityMemory(s);require('./authority-migration').importProject(s,projectId);
   for(const f of facts){const old=db.prepare("SELECT id,source_hash,value_json FROM authority_memories WHERE kind='architecture' AND project_id=? AND subject_key=? AND status='active'").get(projectId,f.key);if(old?.source_hash===f.source_hash&&JSON.parse(old.value_json)===f.content)continue;
    const c=governed.propose({kind:'architecture',operator_id:s.operatorId,project_id:projectId,scope:'project_specific',subject_key:f.key,value:f.content,source_hash:f.source_hash,source_refs:[{source_ref:f.source_ref}],metadata:{category:f.category}},s.operator);
    governed.promote(c.id,{...(old?{supersedes_id:old.id}:{}),source_type:'canonical_doc',canonical_confirmation:{reference:f.source_ref,source_hash:f.source_hash},assurance:3,canonical_priority:100,domains:f.tags.length?f.tags:['architecture']},s.operator);
   }
  }
  return summary(plan);
 });
}
function list(db,projectId,{history=false,limit=100}={}){
 safeId(projectId);assertOpaqueVersions(db,projectId);if(!exists(db))return [];if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid architecture limit');
 return db.prepare(`SELECT a.*,p.content,p.status,p.sensitivity,p.superseded_by,p.expires_at FROM architecture_memory_versions a JOIN personal_memories p USING(memory_id) WHERE a.project_id=? AND p.project_id=a.project_id AND p.domain='project' ${history?'':"AND p.status='active' AND p.sensitivity='normal' AND (p.expires_at IS NULL OR p.expires_at>?)"} ORDER BY a.subject_key,a.version_hash LIMIT ?`).all(projectId,...(history?[]:[Date.now()]),limit).flatMap(r=>{const marker=require('./memory-erasure').marker(db,'personal',r.memory_id);if(marker)return history?[{memory_id:r.memory_id,status:marker.action==='expiry'?'expired':'forgotten',content:null,contentRemoved:true,authority:false}]:[];return[{...r,tags:JSON.parse(r.tags),authority:false,...(r.sensitivity!=='normal'?{content:null}:{})}];});
}
function retrieve(db,projectId,{maxBytes=6000,topK=20,domains=[]}={}){
 if(!Number.isInteger(maxBytes)||maxBytes<0||maxBytes>8000||!Number.isInteger(topK)||topK<0||topK>40||!Array.isArray(domains)||domains.some(d=>typeof d!=='string'))throw Error('Invalid architecture budget');
 const records=[];let bytes=0;for(const r of list(db,projectId)){
  if(domains.length&&!r.tags.some(t=>domains.includes(t)))continue;
  const item={memoryId:r.memory_id,domain:'project',projectId,subject:r.subject_key,type:r.category,content:r.content,status:r.status,sensitivity:r.sensitivity,provenance:{source_ref:r.source_ref,source_hash:r.source_hash,source_type:r.source_type,trust:r.trust,version_hash:r.version_hash,supersedes:r.supersedes},authority:false};
  const size=Buffer.byteLength(JSON.stringify(item))+(records.length?1:0);if(records.length>=topK||bytes+size+2>maxBytes)continue;records.push(item);bytes+=size;
 }
 return {records,bytes:bytes+2,context_hash:hash(records),authority:false};
}
function packet(pack){return {id:pack.id,refs:pack.refs,selection:pack.selection,records:pack.reference_data,context_hash:pack.context_hash,context_sources:pack.context_sources,retrieved_memory_ids:pack.retrieved_memory_ids,canonical_doc_refs:pack.canonical_doc_refs,decision_refs:pack.decision_refs,authority:false,notice:pack.notice};}
function continuityGuard({required=false,claimed=false,currentPrompt=false,pack=null,db=null}){
 if(!required&&!claimed)return {status:'not_requested',authority:false};
 // Source evidence is host-built, never accepted from an agent result.
 if(db)assertOpaqueVersions(db);
 const refs=pack?.refs||[],canonical=refs.filter(r=>r.source_ref&&r.source_hash);
 const valid=canonical.length&&db&&canonical.every(r=>{const row=db.prepare("SELECT p.content,p.status,a.source_hash,a.source_ref FROM architecture_memory_versions a JOIN personal_memories p USING(memory_id) WHERE a.memory_id=?").get(r.memory_id);return row?.status==='active'&&row.source_hash===r.source_hash&&row.source_ref===r.source_ref&&hash(row.content)===r.content_hash;});
 return {status:valid?'verified':currentPrompt?'current_source':'continuity_unverified',context_hash:pack?.context_hash||null,retrieved_memory_ids:valid?canonical.map(r=>r.memory_id):[],authority:false};
}
module.exports={bootstrap,validateManifest,list,retrieve,packet,continuityGuard,hash,exists,prepareIdentityMigration};
