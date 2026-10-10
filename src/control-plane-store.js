'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { backup } = require('node:sqlite');
const { transaction } = require('./control-transaction');
const { containsSecret } = require('./personal-memory');
const { redactPayload } = require('./event-ledger');
const VERSION = 3;
const {migrateMissionSchema}=require('./mission-schema');
const {assertTransition}=require('./mission-lifecycle');
const TERMINAL = new Set(['completed','failed','cancelled','interrupted']);
const STATES = new Set(['draft','planned','dispatching','verifying','awaiting_acceptance','ready','running','waiting_for_operator','waiting_for_dependency','waiting_for_agent','verification','awaiting_orchestrator_acceptance','needs_rework','blocked','paused','cancelled','completed']);
const json = JSON.stringify;
function fingerprint(value) {
  const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
  return createHash('sha256').update(json(stable(value))).digest('hex');
}
function text(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0') || containsSecret(value) || /\b(?:xox[baprs]-|xapp-|crsr_|sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}/.test(value)) throw new Error(`Invalid or sensitive ${label}`);
  return value.trim();
}
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new Error('Invalid identifier'); return value; }
function object(value, fields) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new Error('Unexpected input fields'); return value; }
function redactValue(value, depth = 0) {
  if (depth > 12) return '[bounded]';
  if (typeof value === 'string') return redactPayload(require('./secret-observation').redactText(value)).value.replace(/\b(?:xox[baprs]-|xapp-|crsr_|sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}/g,'[redacted-secret]').slice(0, 24000);
  if (Array.isArray(value)) return value.slice(0, 200).map(v => redactValue(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 128).map(([k,v]) => [k, require('./secret-observation').sensitiveKey(k) ? '[redacted]' : redactValue(v,depth+1)]));
  return value;
}
function prepareRequestIdentitySchema(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_requests'").get()) return;
  if (!db.prepare('PRAGMA table_info(cp_requests)').all().some(field => field.name === 'record_id')) db.exec('ALTER TABLE cp_requests ADD COLUMN record_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cp_request_record_identity ON cp_requests(record_id) WHERE record_id IS NOT NULL');
}
function prepareLegacyRequestIdentities(db) {
  // Explicit source preparation only. Recovery must use an existing opaque
  // origin; an external request label can never identify a backup's lineage.
  return transaction(db, () => {
    prepareRequestIdentitySchema(db);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_requests'").get()) return { assigned_records: 0, authority: false };
    const rows = db.prepare('SELECT owner,request_id,record_id FROM cp_requests ORDER BY owner,request_id').all();
    if (rows.some(row => row.record_id !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.record_id))) throw new Error('Unsupported request identity origin');
    let assigned = 0;
    for (const row of rows) if (row.record_id === null) {
      db.prepare('UPDATE cp_requests SET record_id=? WHERE owner=? AND request_id=? AND record_id IS NULL').run(randomUUID(), row.owner, row.request_id);
      assigned++;
    }
    return { assigned_records: assigned, authority: false };
  });
}
const INVOCATION_ORIGIN_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function prepareInvocationIdentitySchema(db) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_invocations'").get())return;
  if(!db.prepare('PRAGMA table_info(cp_invocations)').all().some(field=>field.name==='origin_event_id'))db.exec('ALTER TABLE cp_invocations ADD COLUMN origin_event_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cp_invocation_origin_identity ON cp_invocations(origin_event_id) WHERE origin_event_id IS NOT NULL');
}
function prepareLegacyInvocationOrigins(db,{sourceDb=null}={}) {
  // Only an archived, independent host event can establish historical origin.
  // Recovery must bind that exact event to the current source's invocation.
  if(sourceDb===db)throw Error('Invocation recovery requires independent origin evidence');
  return transaction(db,()=>{
    prepareInvocationIdentitySchema(db);
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_invocations'").get())return {assigned_records:0,verified_origins:0,authority:false};
    const invocations=db.prepare('SELECT request_id,task_id,created_at,origin_event_id FROM cp_invocations ORDER BY created_at,request_id').all();
    if(!invocations.length)return {assigned_records:0,verified_origins:0,authority:false};
    const archived=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_ledger_events'").get()?db.prepare("SELECT * FROM event_ledger_events WHERE event_type='orchestrator.invocation.persisted' ORDER BY seq").all():[];
    if(sourceDb&&(!sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_invocations'").get()||!sourceDb.prepare('PRAGMA table_info(cp_invocations)').all().some(field=>field.name==='origin_event_id')||!sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_ledger_events'").get()))throw Error('Current invocation origin evidence unavailable');
    const safeFields=['event_id','event_type','timestamp','timestamp_ms','task_id','run_id','mission_id','session_id','trace_id','span_id','parent_event_id','agent','direction','status','protected'];
    const seen=new Set(),plans=[];
    for(const row of invocations) {
      let matches;
      if(row.origin_event_id!==null){if(!INVOCATION_ORIGIN_UUID.test(row.origin_event_id||''))throw Error('Unsupported invocation identity origin');matches=archived.filter(event=>event.event_id===row.origin_event_id);}
      else matches=archived.filter(event=>{
        if(event.task_id!==row.task_id)return false;
        let metadata;try{metadata=JSON.parse(event.metadata);}catch{throw Error('Unknown invocation origin metadata shape');}
        if(!metadata||Array.isArray(metadata)||typeof metadata!=='object')throw Error('Unknown invocation origin metadata shape');
        return event.request_id===row.request_id||metadata.request_id===row.request_id;
      });
      if(matches.length!==1)throw Error('Invocation requires unique archived origin evidence');
      const event=matches[0];
      if(!INVOCATION_ORIGIN_UUID.test(event.event_id||'')||event.task_id!==row.task_id||event.agent!=='bridge'||event.direction!=='internal'||seen.has(event.event_id))throw Error('Invocation origin scope or identity mismatch');
      seen.add(event.event_id);
      if(sourceDb){
        const current=sourceDb.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(event.event_id),owners=sourceDb.prepare('SELECT task_id,created_at FROM cp_invocations WHERE origin_event_id=?').all(event.event_id);
        if(!current||safeFields.some(key=>current[key]!==event[key])||owners.length!==1||owners[0].task_id!==row.task_id||owners[0].created_at!==row.created_at)throw Error('Current invocation origin scope mismatch');
      }
      if(row.origin_event_id===null)plans.push({request_id:row.request_id,origin:event.event_id});
    }
    for(const plan of plans)db.prepare('UPDATE cp_invocations SET origin_event_id=? WHERE request_id=? AND origin_event_id IS NULL').run(plan.origin,plan.request_id);
    return {assigned_records:plans.length,verified_origins:seen.size,authority:false};
  });
}
async function backupBeforeMigration(db, databasePath) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='control_plane_meta'").get();
  const version = table ? db.prepare("SELECT version FROM control_plane_meta").get()?.version : 0;
  if (version > VERSION) throw new Error('Control plane database is newer than this bridge');
  const harness=db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_effect_outbox'").get();
  if ((version === VERSION && harness) || !databasePath || databasePath === ':memory:') return;
  const file = `${databasePath}.before-control-v${VERSION}-${Date.now()}-${randomUUID()}.bak`;
  await backup(db, file); fs.chmodSync(file, 0o600);
}
class ControlPlaneStore {
  constructor({ db, ledger, now = Date.now }) { this.db=db;this.ledger=ledger;this.now=now;transaction(db,()=>{this.migrate();prepareRequestIdentitySchema(db);prepareInvocationIdentitySchema(db);migrateMissionSchema(db);require('./slack-schema').migrateSlackSchema(db);}); this.outbox=new (require('./transactional-outbox').TransactionalOutbox)(this); }
  migrate() {
    const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='control_plane_meta'").get();
    if (exists) { const v=this.db.prepare('SELECT version FROM control_plane_meta').get()?.version; if(v!==1 && v!==2 && v!==VERSION) throw new Error('Unsupported control plane schema version'); return; }
    transaction(this.db,()=>{this.db.exec(`
      CREATE TABLE control_plane_meta(version INTEGER NOT NULL); INSERT INTO control_plane_meta VALUES(1);
      CREATE TABLE cp_missions(id TEXT PRIMARY KEY, project_id TEXT, goal_id TEXT, task_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, envelope TEXT NOT NULL, grant_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reason TEXT, acceptance_strength TEXT NOT NULL DEFAULT 'criteria');
      CREATE INDEX cp_missions_owner ON cp_missions(owner,updated_at DESC,id);
      CREATE TABLE cp_grants(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,ceiling TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TRIGGER cp_grants_update BEFORE UPDATE ON cp_grants BEGIN SELECT RAISE(ABORT,'Immutable grant ceiling'); END;
      CREATE TRIGGER cp_grants_delete BEFORE DELETE ON cp_grants BEGIN SELECT RAISE(ABORT,'Immutable grant ceiling'); END;
      CREATE TABLE cp_runs(id TEXT PRIMARY KEY,mission_id TEXT,task_id TEXT NOT NULL,agent_id TEXT NOT NULL,generation INTEGER NOT NULL,
        state TEXT NOT NULL,process_state TEXT NOT NULL,liveness_state TEXT NOT NULL,termination_verified INTEGER NOT NULL DEFAULT 0,
        native_session_id TEXT,native_job_id TEXT,pid INTEGER,resolution TEXT,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,ended_at INTEGER,
        CHECK(state NOT IN ('completed','failed','cancelled','interrupted') OR process_state <> 'alive'),
        CHECK(state NOT LIKE 'waiting%' OR resolution IS NOT NULL));
      CREATE INDEX cp_runs_task ON cp_runs(task_id,created_at DESC,id); CREATE INDEX cp_runs_mission ON cp_runs(mission_id,created_at DESC,id);
      CREATE TABLE cp_leases(id TEXT PRIMARY KEY,resource TEXT NOT NULL,run_id TEXT NOT NULL,mission_id TEXT,mode TEXT NOT NULL,
        state TEXT NOT NULL,acquired_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,baseline TEXT NOT NULL);
      CREATE UNIQUE INDEX cp_writer ON cp_leases(resource) WHERE state IN ('held','quarantined') AND mode='write';
      CREATE TABLE cp_invocations(request_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,origin_event_id TEXT);
      CREATE TABLE cp_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,record_id TEXT,PRIMARY KEY(owner,request_id));
      CREATE TABLE cp_decisions(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT,agent_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'question',question TEXT NOT NULL,options TEXT NOT NULL,free_text INTEGER NOT NULL,state TEXT NOT NULL,
        answer TEXT,actor TEXT,surface TEXT,nonce TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,answered_at INTEGER);
      CREATE INDEX cp_decisions_mission ON cp_decisions(mission_id,state,created_at);
      CREATE TABLE cp_continuations(id TEXT PRIMARY KEY,decision_id TEXT NOT NULL UNIQUE,mission_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE cp_verifications(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,run_id TEXT NOT NULL,revision INTEGER NOT NULL,workspace_hash TEXT NOT NULL,
        result TEXT NOT NULL,evidence TEXT NOT NULL,checker TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE cp_acceptances(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,verification_id TEXT NOT NULL,decision TEXT NOT NULL,actor TEXT NOT NULL,rationale TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE cp_context_packs(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,run_id TEXT,refs TEXT NOT NULL,selection TEXT NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE cp_candidates(id TEXT PRIMARY KEY,mission_id TEXT,task_id TEXT,run_id TEXT,record TEXT NOT NULL,state TEXT NOT NULL,memory_id TEXT,reviewer TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE cp_agent_health(id TEXT PRIMARY KEY,kind TEXT NOT NULL,observation TEXT NOT NULL,checked_at INTEGER NOT NULL);
      CREATE TABLE cp_pending_events(id TEXT PRIMARY KEY,event TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE cp_artifacts(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,metadata TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE cp_approval_refs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT,state TEXT NOT NULL,fingerprint TEXT,descriptor TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE cp_slack_threads(mission_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL);
      CREATE TABLE cp_slack_inbox(id TEXT PRIMARY KEY,receipt TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE cp_slack_outbox(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,remote_ts TEXT);
      CREATE INDEX cp_outbox_due ON cp_slack_outbox(state,next_at);
      CREATE TRIGGER IF NOT EXISTS control_ledger_no_update BEFORE UPDATE ON event_ledger_events BEGIN SELECT RAISE(ABORT,'Append-only ledger'); END;
      CREATE TRIGGER IF NOT EXISTS control_ledger_no_delete BEFORE DELETE ON event_ledger_events BEGIN SELECT RAISE(ABORT,'Append-only ledger'); END;
    `);
    const check=this.db.prepare('PRAGMA integrity_check').get();if(Object.values(check)[0]!=='ok')throw new Error('Control plane integrity check failed');
    });
  }
  event(type, missionId, metadata={}, extra={}) { return transaction(this.db,()=>{const m=missionId?this.getMission(missionId):null;const event=this.ledger.record({ eventType:type,agent:'bridge',direction:'internal',missionId:missionId||null,taskId:m?.task_id||extra.taskId||null,metadata:{ ...(['mission.paused','mission.resumed','mission.cancelled','mission.created'].includes(type)?{dispatch_path:'native_workflow'}:{}),...metadata,...(m?{mission_revision:m.revision}:{}) },...extra });
    if(this.outbox&&m?.envelope.kind!=='work_request'&&m?.envelope.control_version===2&&require('./slack-runtime').ROUTES[type])this.outbox.enqueue({key:`ledger:${event.event_id}`,destination:'slack_event',ref:missionId,eventType:type,correlation:{mission_id:missionId,task_id:m.task_id,run_id:extra.runId||null},payload:{event_id:event.event_id,decision_id:metadata.decision_id||null}});return event;}); }

  getMission(id) {require('./memory-content-erasure').assertReadable(this.db); const r=this.db.prepare('SELECT * FROM cp_missions WHERE id=?').get(id);if(!r)return null;const canonical=this.authorityRuntime?.active?this.authorityRuntime.store.getMission(id):null;return {...r,...(canonical?{revision:canonical.current_revision,state:canonical.current_state,task_id:canonical.task_id}:{}),envelope:JSON.parse(r.envelope)}; }
  requireMission(id,owner=null) { const m=this.getMission(identifier(id));if(!m || (owner && m.owner!==owner))throw new Error('Mission not found in this caller context');return m; }
  missionForTask(taskId) { const r=this.db.prepare('SELECT id FROM cp_missions WHERE task_id=? UNION SELECT mission_id AS id FROM cp_mission_tasks WHERE task_id=?').get(taskId,taskId);return r?this.getMission(r.id):null; }
  listMissions({owner=null,limit=100,after=0}={}) { if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(after)||after<0)throw new Error('Invalid mission page');return this.db.prepare(`SELECT id FROM cp_missions ${owner?'WHERE owner=?':''} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(...(owner?[owner]:[]),limit,after).map(r=>this.getMission(r.id)); }
  registerMission({id,projectId=null,goalId=null,taskId,owner,envelope,ceiling,legacy=false}) {
    return transaction(this.db,()=>{
      if(this.getMission(id))return this.getMission(id);
      const grant=randomUUID(),now=this.now();
      this.db.prepare('INSERT INTO cp_grants VALUES(?,?,?,?)').run(grant,id,json(ceiling),now);
      this.db.prepare('INSERT INTO cp_missions(id,project_id,goal_id,task_id,owner,state,envelope,grant_id,created_at,updated_at,acceptance_strength) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,goalId,taskId,owner,'ready',json(envelope),grant,now,now,legacy?'runtime_only':'criteria');
      if(this.authorityRuntime?.active)this.authorityRuntime.registerMission(this.getMission(id));
      this.event('mission.request_received',id);this.event('mission.created',id,{legacy,grant_id:grant});this.event('mission.authority_registered',id);return this.getMission(id);
    });
  }
  state(id,state,reason=null) { if(!STATES.has(state))throw new Error('Invalid Mission state');return transaction(this.db,()=>{
    const m=this.requireMission(id);if(m.envelope.kind==='work_request'&&!['draft','cancelled'].includes(state))throw Error('Work request draft grants no execution authority');if(m.envelope.control_version===2)assertTransition(m.state,state);if(['completed','cancelled'].includes(m.state)&&state!==m.state)throw new Error('Terminal Mission cannot resume');
    if(this.authorityRuntime?.active)this.authorityRuntime.store.setState(id,state);
    this.db.prepare(`UPDATE cp_missions SET state=?,reason=?,updated_at=?,revision=revision+${this.authorityRuntime?.active?0:1} WHERE id=?`).run(state,reason?text(reason,'state reason',1000):null,this.now(),id);
    this.db.prepare('UPDATE project_missions SET status=?,updated_at=? WHERE mission_id=?').run(['completed','cancelled'].includes(state)?state:['blocked','needs_rework'].includes(state)?'blocked':'active',this.now(),id);
    this.event(`mission.${state}`,id,{previous:m.state,state});return this.getMission(id);
  }); }
  run(id){require('./memory-content-erasure').assertReadable(this.db);const r=this.db.prepare('SELECT * FROM cp_runs WHERE id=?').get(id);return r?{...r,result:r.result?JSON.parse(r.result):null}:null;}
  startRun({id,taskId,missionId=null,agentId='host',generation=1,nativeSessionId=null,role='worker'}) {require('./removed-runtime').assertExecutable(agentId);return transaction(this.db,()=>{this.lifecycle?.assertOpen();
    if(missionId&&this.requireMission(missionId).envelope.kind==='work_request')throw Error('Work request draft grants no execution authority');
    if(this.run(id))return this.run(id);
    const now=this.now();this.db.prepare("INSERT INTO cp_runs(id,mission_id,task_id,agent_id,generation,state,process_state,liveness_state,native_session_id,created_at,updated_at) VALUES(?,?,?,?,?,'starting','not_started','unknown',?,?,?)").run(id,missionId,taskId,agentId,generation,nativeSessionId,now,now);
    if(this.authorityRuntime?.active&&missionId){const a=this.authorityRuntime.store,m=a.getMission(missionId);a.startRun({id,task_id:taskId,mission_id:missionId,mission_revision:m.current_revision,agent_id:agentId});}
    this.event('run.started',missionId,{agent_id:agentId,generation,execution_role:role},{taskId,runId:id});return this.run(id);
  });}
  updateRun(id,{state,processState,liveness='unknown',verified=false,resolution=null,result=null,jobId=null,pid=null,deferAudit=false}={}) { return transaction(this.db,()=>{
    const run=this.run(id);if(!run)throw new Error('Run not found');if(TERMINAL.has(run.state)&&run.state!==state)throw new Error('Run already settled');
    if(!['starting','running','verifying','waiting_for_operator','waiting_for_permission','completed','failed','cancelled','interrupted','termination_unverified'].includes(state)||!['not_started','starting','alive','terminating','exited','idle','unknown'].includes(processState))throw new Error('Invalid run transition');
    if(TERMINAL.has(state)&&processState==='alive')throw new Error('Terminal run cannot be alive');
    if(state.startsWith('waiting')&&!resolution)throw new Error('Waiting run requires a resolution');
    const terminal=TERMINAL.has(state),safe=result?redactValue(result):null;
    this.db.prepare('UPDATE cp_runs SET state=?,process_state=?,liveness_state=?,termination_verified=?,resolution=?,result=COALESCE(?,result),native_job_id=COALESCE(?,native_job_id),pid=COALESCE(?,pid),updated_at=?,ended_at=? WHERE id=?').run(state,processState,liveness,verified?1:0,resolution,safe?json(safe):null,jobId,pid,this.now(),terminal?this.now():null,id);
    if(this.authorityRuntime?.active){const a=this.authorityRuntime.store;if(a.one('runs',id)){this.db.prepare('UPDATE authority_runs SET status=?,updated_at=?,finished_at=? WHERE id=?').run(state,this.now(),terminal?this.now():null,id);a.referenceEvent('runtime.updated',id,{state,termination_verified:verified},{missionId:run.mission_id,revision:a.one('runs',id).mission_revision,projectId:a.getMission(run.mission_id).project_id||require('./authority-store').LOCAL_PROJECT,runId:id});}}
    if(terminal&&verified)this.db.prepare("UPDATE cp_leases SET state='released' WHERE run_id=? AND state='held'").run(id);
    const event = { type:`run.${state}`, mission:run.mission_id, metadata:{process_state:processState,termination_verified:verified}, extra:{runId:id,taskId:run.task_id} };
    try { this.event(event.type,event.mission,event.metadata,event.extra); }
    catch(error) {
      if(!deferAudit)throw error;
      this.db.prepare('INSERT INTO cp_pending_events VALUES(?,?,?)').run(randomUUID(),json(event),this.now());
    }
    return this.run(id);
  }); }
  acquireLease({resource,runId,missionId=null,baseline={},mode='write',ttlMs=120000}) {
    const canonical=fs.realpathSync(resource);if(!['read','write'].includes(mode))throw new Error('Invalid lease mode');
    return transaction(this.db,()=>{this.lifecycle?.assertOpen();if(this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND state IN ('held','quarantined') AND (?='write' OR mode='write')").get(canonical,mode))throw new Error('Workspace has an active or unverified writer lease or protected reader lease');
      const id=randomUUID();this.db.prepare('INSERT INTO cp_leases VALUES(?,?,?,?,?,?,?,?,?)').run(id,canonical,runId,missionId,mode,'held',this.now(),this.now()+ttlMs,json(baseline));this.event('workspace.lease_acquired',missionId,{lease_id:id,mode},{runId});return id;});
  }
  invocation(requestId){require('./memory-content-erasure').assertReadable(this.db);const r=this.db.prepare('SELECT * FROM cp_invocations WHERE request_id=?').get(requestId);return r?{...r,result:r.result?JSON.parse(r.result):null}:null;}
  beginInvocation(taskId,requestId,hash){return transaction(this.db,()=>{this.lifecycle?.assertOpen();identifier(taskId);identifier(requestId);const prior=this.invocation(requestId);if(prior){if(prior.task_id!==taskId||prior.fingerprint!==hash)throw new Error('Idempotency conflict');return prior;}const now=this.now(),origin=randomUUID();this.event('orchestrator.invocation.persisted',this.missionForTask(taskId)?.id,{request_id:requestId},{taskId,eventId:origin,protected:true});this.db.prepare("INSERT INTO cp_invocations(request_id,task_id,fingerprint,state,result,created_at,updated_at,origin_event_id) VALUES(?,?,?,'running',NULL,?,?,?)").run(requestId,taskId,hash,now,now,origin);return this.invocation(requestId);});}
  finishInvocation(requestId,result){return transaction(this.db,()=>{const r=this.invocation(requestId);if(!r)throw new Error('Invocation not found');this.db.prepare("UPDATE cp_invocations SET state='settled',result=?,updated_at=? WHERE request_id=?").run(json(redactValue(result)),this.now(),requestId);this.event('orchestrator.invocation.settled',this.missionForTask(r.task_id)?.id,{request_id:requestId},{taskId:r.task_id});});}
  request(owner,requestId,input,operation) {require('./memory-content-erasure').assertReadable(this.db); identifier(requestId);const hash=fingerprint(input);const row=this.db.prepare('SELECT * FROM cp_requests WHERE owner=? AND request_id=?').get(owner,requestId);if(row){if(row.fingerprint!==hash)throw new Error('Idempotency conflict');return row.state==='settled'?{...JSON.parse(row.result),duplicate:true}:{status:'unknown',request_id:requestId,duplicate:true};}return transaction(this.db,()=>{this.db.prepare("INSERT INTO cp_requests(owner,request_id,fingerprint,state,result,record_id) VALUES(?,?,?,'running',NULL,?)").run(owner,requestId,hash,randomUUID());const result=operation();if(result?.then)throw new Error('Use durable dispatch intents for asynchronous operations');this.db.prepare("UPDATE cp_requests SET state='settled',result=? WHERE owner=? AND request_id=?").run(json(result),owner,requestId);return result;});}
  decision(id){require('./memory-content-erasure').assertReadable(this.db);const r=this.db.prepare('SELECT * FROM cp_decisions WHERE id=?').get(id);return r?{...r,options:JSON.parse(r.options),answer:r.answer?JSON.parse(r.answer):null}:null;}
  decisions(missionId=null){return this.db.prepare(`SELECT id FROM cp_decisions ${missionId?'WHERE mission_id=?':''} ORDER BY created_at DESC LIMIT 200`).all(...(missionId?[missionId]:[])).map(r=>this.decision(r.id));}
  createDecision(missionId,{question,options=[],allow_free_text=true,expires_at=null,run_id=null,agent_id='host'}) {
    text(question,'decision question');if(!Array.isArray(options)||options.length>8||typeof allow_free_text!=='boolean'||(!options.length&&!allow_free_text))throw new Error('Invalid decision options');
    const ids=new Set();for(const o of options){object(o,['id','label','description','recommended']);if(o.description!==undefined)text(o.description,'option description',1000);identifier(o.id);text(o.label,'option',240);if(ids.has(o.id))throw new Error('Duplicate option');ids.add(o.id);}
    if(expires_at!==null&&(!Number.isSafeInteger(expires_at)||expires_at<=this.now()))throw new Error('Invalid decision expiry');
    return transaction(this.db,()=>{const m=this.requireMission(missionId);if(['cancelled','completed'].includes(m.state))throw new Error('Mission is terminal');const id=randomUUID();
      this.db.prepare("INSERT INTO cp_decisions(id,mission_id,task_id,run_id,agent_id,question,options,free_text,state,nonce,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'waiting_for_operator',?,?,?)").run(id,missionId,m.task_id,run_id,identifier(agent_id),question,json(options),allow_free_text?1:0,randomUUID(),this.now(),expires_at);
      if(m.state!=='waiting_for_operator')this.state(missionId,'waiting_for_operator','Answer the pending DecisionRequest');this.event('decision.requested',missionId,{decision_id:id},{runId:run_id});return this.decision(id);});
  }
  supersedeDecision(id,question,actor) {
    text(actor,'actor',160);
    return transaction(this.db,()=>{
      const old=this.decision(id);if(!old||old.state!=='waiting_for_operator'||(old.expires_at&&old.expires_at<=this.now()))throw Error('Only a current unanswered Decision can be superseded');
      this.db.prepare("UPDATE cp_decisions SET state='superseded' WHERE id=?").run(id);
      const replacement=this.createDecision(old.mission_id,{...question,run_id:old.run_id,agent_id:old.agent_id});
      this.event('decision.superseded',old.mission_id,{decision_id:id,superseded_by:replacement.id,actor});
      return{decision:this.decision(id),replacement};
    });
  }
  expireDecisions() {
    return transaction(this.db,()=>{
      const rows=this.db.prepare("SELECT id,mission_id FROM cp_decisions WHERE state='waiting_for_operator' AND expires_at IS NOT NULL AND expires_at<=?").all(this.now());
      for(const d of rows){this.db.prepare("UPDATE cp_decisions SET state='expired' WHERE id=?").run(d.id);this.event('decision.expired',d.mission_id,{decision_id:d.id});}
      return rows.length;
    });
  }
  cancelDecisions(missionId) {
    return transaction(this.db,()=>{
      for(const d of this.db.prepare("SELECT id FROM cp_decisions WHERE mission_id=? AND state='waiting_for_operator'").all(missionId)){
        this.db.prepare("UPDATE cp_decisions SET state='cancelled' WHERE id=?").run(d.id);this.event('decision.cancelled',missionId,{decision_id:d.id});
      }
    });
  }
  answerDecision(id,{option_id=null,free_text=null,actor,surface}){text(actor,'actor',160);if(!['operator','mcp','slack'].includes(surface))throw new Error('Invalid decision surface');return transaction(this.db,()=>{
    const d=this.decision(id);if(!d)throw new Error('Decision not found');if(d.state!=='waiting_for_operator'){this.event('decision.duplicate_rejected',d.mission_id,{decision_id:id});return{...d,already_answered:true};}
    const m=this.requireMission(d.mission_id);if(m.state==='cancelled')throw new Error('Mission is cancelled');
    if(d.expires_at&&d.expires_at<=this.now()){this.db.prepare("UPDATE cp_decisions SET state='expired' WHERE id=?").run(id);this.event('decision.expired',d.mission_id,{decision_id:id});return this.decision(id);}
    if((option_id===null)===(free_text===null))throw new Error('Provide one answer');
    if(option_id!==null&&!d.options.some(o=>o.id===option_id))throw new Error('Unknown option');if(free_text!==null){if(!d.free_text)throw new Error('Free text is disabled');text(free_text,'answer',4000);}
    const answer={option_id,free_text};this.db.prepare("UPDATE cp_decisions SET state='answered',answer=?,actor=?,surface=?,answered_at=? WHERE id=? AND state='waiting_for_operator'").run(json(answer),actor,surface,this.now(),id);
    this.db.prepare("INSERT INTO cp_continuations VALUES(?,?,?,'queued',?)").run(randomUUID(),id,d.mission_id,this.now());
    this.event('decision.answered',d.mission_id,{decision_id:id,actor,surface,dispatch_path:'decision_resume_native'});return this.decision(id);
  });}
  flushPendingEvents() {
    return transaction(this.db,()=>{
      for(const row of this.db.prepare('SELECT * FROM cp_pending_events ORDER BY created_at LIMIT 200').all()) {
        const e=JSON.parse(row.event);this.event(e.type,e.mission,{...e.metadata,recorded_after_recovery:true,occurred_at:row.created_at},e.extra);
        this.db.prepare('DELETE FROM cp_pending_events WHERE id=?').run(row.id);
      }
    });
  }
  recover(){return transaction(this.db,()=>{
    this.flushPendingEvents();
    for(const run of this.db.prepare("SELECT * FROM cp_runs WHERE state NOT IN ('completed','failed','cancelled','interrupted')").all()){
      const dispatchTable=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_agent_dispatch_intents'").get();
      const dispatch=dispatchTable?this.db.prepare('SELECT record FROM cp_agent_dispatch_intents WHERE run_id=?').get(run.id):null;
      if(dispatch){const intent=JSON.parse(dispatch.record);if(intent.no_side_effects===true&&run.process_state==='not_started'&&['dispatch_pending_external','retry_wait','waiting','failed'].includes(intent.status)&&!this.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state IN ('held','quarantined') AND (state='quarantined' OR expires_at<=?)").get(run.id,this.now()))continue;}
      this.updateRun(run.id,{state:'interrupted',processState:'unknown',resolution:'reconcile_process'});
      this.db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=? AND state='held'").run(run.id);
      const m=run.mission_id?this.getMission(run.mission_id):null;if(m&&!['waiting_for_operator','paused','cancelled','completed','blocked'].includes(m.state))this.state(m.id,'blocked','Interrupted run requires process reconciliation');
    }
    this.db.prepare("UPDATE cp_dispatches SET state='unknown' WHERE state='dispatching'").run();
    this.db.prepare("UPDATE cp_invocations SET state='unknown' WHERE state='running'").run();this.db.prepare("UPDATE cp_continuations SET state='unknown' WHERE state='dispatching'").run();
    this.db.prepare("UPDATE cp_slack_outbox SET state='delivery_unknown' WHERE state='sending'").run();
    this.db.prepare("UPDATE cp_approval_refs SET state='expired',updated_at=? WHERE state IN ('pending','approved')").run(this.now());
  });}
  observeAgent(id,kind,observation){this.db.prepare('INSERT INTO cp_agent_health VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET observation=excluded.observation,checked_at=excluded.checked_at').run(identifier(id),kind,json(redactValue(observation)),this.now());}
  agents(){return this.db.prepare('SELECT * FROM cp_agent_health ORDER BY id').all().map(r=>({...r,observation:JSON.parse(r.observation)}));}
}
module.exports={ControlPlaneStore,backupBeforeMigration,prepareRequestIdentitySchema,prepareLegacyRequestIdentities,prepareInvocationIdentitySchema,prepareLegacyInvocationOrigins,transaction,fingerprint,text,identifier,object,redactValue,VERSION};
