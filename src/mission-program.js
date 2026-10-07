'use strict';
const {randomUUID}=require('node:crypto');
const {transaction}=require('./control-transaction');
const {object,identifier,fingerprint}=require('./control-plane-store');
const {workspaceSnapshot}=require('./control-context');
const {spawnSync}=require('node:child_process');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function prepareBudgetIdentitySchema(db){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_mission_budget_usage'").get())return;
 if(!db.prepare('PRAGMA table_info(cp_mission_budget_usage)').all().some(c=>c.name==='record_id'))db.exec('ALTER TABLE cp_mission_budget_usage ADD COLUMN record_id TEXT');
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cp_mission_budget_record_identity ON cp_mission_budget_usage(record_id) WHERE record_id IS NOT NULL');
}
function prepareLegacyBudgetIdentities(db){return transaction(db,()=>{
 prepareBudgetIdentitySchema(db);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cp_mission_budget_usage'").get())return{assigned_records:0,authority:false};
 const rows=db.prepare('SELECT mission_id,kind,request_id,record_id FROM cp_mission_budget_usage ORDER BY mission_id,kind,request_id').all();
 if(rows.some(r=>r.record_id!==null&&!UUID.test(r.record_id)))throw Error('Unsupported Mission budget identity origin');
 let count=0;
 for(const r of rows)if(r.record_id===null){db.prepare('UPDATE cp_mission_budget_usage SET record_id=? WHERE mission_id=? AND kind=? AND request_id=? AND record_id IS NULL').run(randomUUID(),r.mission_id,r.kind,r.request_id);count++;}
 return{assigned_records:count,authority:false};
});}
class MissionProgram {
 constructor(service){this.service=service;this.bridge=service.bridge;this.store=service.store;this.db=service.db;this.now=()=>this.store.now();this.db.exec(`
 CREATE TABLE IF NOT EXISTS cp_mission_contracts(mission_id TEXT PRIMARY KEY,manifest TEXT NOT NULL,manifest_hash TEXT NOT NULL,seal TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cp_mission_budget_usage(mission_id TEXT NOT NULL,kind TEXT NOT NULL,request_id TEXT NOT NULL,amount INTEGER NOT NULL,fingerprint TEXT NOT NULL,record_id TEXT,PRIMARY KEY(mission_id,kind,request_id));
 CREATE TABLE IF NOT EXISTS cp_mission_reviews(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,verification_id TEXT NOT NULL UNIQUE,manifest_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,result TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cp_mission_settlements(mission_id TEXT PRIMARY KEY,review_id TEXT,state TEXT NOT NULL,recommendation TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cp_mission_programs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,graph TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,request_id TEXT NOT NULL,UNIQUE(owner,request_id));
 CREATE TABLE IF NOT EXISTS cp_mission_program_nodes(program_id TEXT NOT NULL,node_id TEXT NOT NULL,mission_id TEXT UNIQUE,input TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(program_id,node_id));
 `);prepareBudgetIdentitySchema(this.db);}
 register(mission){const m=mission.envelope.manifest;if(!m)return;const hash=fingerprint(m),seal=this.bridge.missionAuthority.sealManifest?.({mission_id:mission.id,manifest_hash:hash})||null;
 this.db.prepare('INSERT INTO cp_mission_contracts VALUES(?,?,?,?,?)').run(mission.id,JSON.stringify(m),hash,seal?JSON.stringify(seal):null,this.now());this.store.event('manifest.registered',mission.id,{manifest_hash:hash,signed:!!seal});}
 contract(id){require('./memory-content-erasure').assertReadable(this.db);const row=this.db.prepare('SELECT * FROM cp_mission_contracts WHERE mission_id=?').get(id);if(!row)return null;const m=this.store.requireMission(id);if(fingerprint(m.envelope.manifest)!==row.manifest_hash||fingerprint(JSON.parse(row.manifest))!==row.manifest_hash)throw Error('Mission Manifest integrity mismatch');if(row.seal&&!this.bridge.missionAuthority.verifyManifestSeal(JSON.parse(row.seal),{mission_id:id,manifest_hash:row.manifest_hash}))throw Error('Mission Manifest signature unavailable or invalid');return{...row,manifest:JSON.parse(row.manifest),signed:!!row.seal};}
 assert(mission){const c=this.contract(mission.id);if(!c)return;if(mission.envelope.kind==='conversation'){require('./conversation-mission').assertContract(this.service,mission);return;}const program=this.db.prepare('SELECT p.expires_at,p.state FROM cp_mission_programs p JOIN cp_mission_program_nodes n ON n.program_id=p.id WHERE n.mission_id=?').get(mission.id);if(program&&(this.now()>=program.expires_at||['budget_exhausted','cancelled'].includes(program.state)))throw Error('Mission Program budget or boundary halted');const m=c.manifest;if(this.now()>=m.expires_at)throw Error('Mission Manifest runtime budget expired');
 const branch=spawnSync('/usr/bin/git',['-C',m.repository.root,'symbolic-ref','--quiet','--short','HEAD'],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0'}});if(branch.status!==0||branch.stdout.trim()!==m.repository.branch)throw Error('Mission Manifest branch changed');
 const current=workspaceSnapshot(m.repository.root),changed=[...new Set([...Object.keys(current.files),...Object.keys(mission.envelope.baseline.files)])].filter(f=>current.files[f]!==mission.envelope.baseline.files[f]);if(changed.length>m.budget.max_files_changed)throw Error('Mission file budget exceeded');
 if(current.head!==mission.envelope.baseline.head)throw Error('Mission HEAD changed; commit reconciliation required');
 for(const [kind,key]of [['commits','max_commits'],['external_reasoning','max_external_reasoning_calls'],['memory_injections','max_memory_injections']])if(this.used(mission.id,kind)>m.budget[key])throw Error('Mission budget exceeded: '+kind);
 }
 guardTask(task,call){const m=this.store.missionForTask(task.id);if(!m?.envelope.manifest){if(task.mission?.manifest)throw Error('Manifest Mission missing');return;}if(fingerprint(task.mission?.manifest)!==fingerprint(m.envelope.manifest)||fingerprint(this.bridge.tasks.get(task.id).mission?.manifest)!==fingerprint(m.envelope.manifest))throw Error('Manifest Task binding mismatch');this.assert(m);const req=require('./mission-permissions').callRequirements(call,task.workspace);for(const target of req.filesystem?.write||[]){if(call.toolName==='capability'&&call.input.name==='vscode_run_task')continue;const canonical=require('./mission-manifest-paths').canonical(target);if(!m.envelope.allowed_files.some(f=>require('node:path').resolve(m.envelope.workspace,f)===canonical))throw Error('Exact Mission write scope exceeded');}}
 used(id,kind){require('./memory-content-erasure').assertReadable(this.db);return this.db.prepare('SELECT COALESCE(sum(amount),0) n FROM cp_mission_budget_usage WHERE mission_id=? AND kind=?').get(id,kind).n;}
 reserve(id,kind,requestId,amount=1,details={}){require('./memory-content-erasure').assertReadable(this.db);if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_erasure_content_rows'").get()&&this.db.prepare("SELECT 1 FROM cp_mission_budget_usage b JOIN memory_erasure_content_rows e ON e.table_name='cp_mission_budget_usage' AND e.row_key=json_array(b.record_id) WHERE b.mission_id=?").get(id))throw Error('Mission budget context erased; replay unavailable');const c=this.contract(id);if(!c)return;const keys={commits:'max_commits',external_reasoning:'max_external_reasoning_calls',memory_injections:'max_memory_injections'};if(!keys[kind]||!Number.isSafeInteger(amount)||amount<0)throw Error('Invalid Mission budget reservation');identifier(requestId);const hash=fingerprint({amount,details});return transaction(this.db,()=>{const prior=this.db.prepare('SELECT * FROM cp_mission_budget_usage WHERE mission_id=? AND kind=? AND request_id=?').get(id,kind,requestId);if(prior){if(prior.fingerprint!==hash)throw Error('Mission budget reservation conflict');return;}if(this.now()>=c.manifest.expires_at||this.used(id,kind)+amount>c.manifest.budget[keys[kind]])throw Error('Mission budget exhausted: '+kind);this.db.prepare('INSERT INTO cp_mission_budget_usage(mission_id,kind,request_id,amount,fingerprint,record_id) VALUES(?,?,?,?,?,?)').run(id,kind,requestId,amount,hash,randomUUID());});}
 review(mission,run,result,verificationId){const c=this.contract(mission.id);if(!c)return null;return transaction(this.db,()=>{
 const prior=this.db.prepare('SELECT * FROM cp_mission_reviews WHERE verification_id=?').get(verificationId);if(prior)return prior.id;
 const failures=[];try{this.assert(this.store.requireMission(mission.id));}catch(e){failures.push(e.message);}
 if(!run.termination_verified)failures.push('Execution termination is unverified');
 const byId=new Map(result.checks.map(x=>[x.id,x]));
 for(const kind of c.manifest.evidence?.required||[]){const labels=kind==='diff_check'?[mission.envelope.verification.diff_check]:mission.envelope.verification[kind]||[];for(const label of labels)if(byId.get('task:'+label)?.status!=='passed')failures.push('Missing or failed evidence: '+kind+':'+label);}
 for(const key of mission.envelope.kind==='conversation'?['read_only_boundary']:['protected_files','verification_workspace_stable'])if(byId.get(key)?.status!=='passed')failures.push('Missing or failed evidence: '+key);
 if(!['passed','operator_review'].includes(result.status))failures.push('Independent verification '+result.status);
 const outcome=failures.length?'failed':result.status==='operator_review'?'operator_review':'passed',id=randomUUID();
 const evidence={failures,run_id:run.id,verification_id:verificationId,required:c.manifest.evidence?.required||['read_only_boundary'],optional:c.manifest.evidence?.optional||[],budget:Object.fromEntries(['commits','external_reasoning','memory_injections'].map(k=>[k,this.used(mission.id,k)])),authority:false};
 this.db.prepare('INSERT INTO cp_mission_reviews VALUES(?,?,?,?,?,?,?,?)').run(id,mission.id,verificationId,c.manifest_hash,result.workspace_hash,outcome,JSON.stringify(evidence),this.now());
 const state=outcome==='failed'?'needs_rework':'waiting_acceptance',recommendation=outcome==='failed'?'Repair failed validation before continuing':'Review verified changes for operator Acceptance; merge and deploy forbidden';
 this.db.prepare('INSERT INTO cp_mission_settlements VALUES(?,?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET review_id=excluded.review_id,state=excluded.state,recommendation=excluded.recommendation,updated_at=excluded.updated_at').run(mission.id,id,state,recommendation,this.now());
 if(outcome==='failed'&&this.store.requireMission(mission.id).state==='awaiting_acceptance')this.store.state(mission.id,'needs_rework','Mission Review Broker failed');
 this.store.event('mission.review.'+outcome,mission.id,{review_id:id,verification_id:verificationId,authority:false});return id;
 });}
 assertAcceptance(mission,verificationId){if(!mission.envelope.manifest)return;this.assert(mission);const r=this.db.prepare('SELECT * FROM cp_mission_reviews WHERE mission_id=? AND verification_id=?').get(mission.id,verificationId);if(!r||!['passed','operator_review'].includes(r.result)||r.workspace_hash!==workspaceSnapshot(mission.envelope.workspace).hash)throw Error('Mission Review Broker evidence missing, failed or stale');}
 settle(id,decision){
 const work=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_work_bindings'").get()&&this.db.prepare('SELECT 1 FROM cp_work_bindings WHERE mission_id=?').get(id);
 if(!this.contract(id)&&!work)return;
 if(!this.db.prepare('SELECT 1 FROM cp_acceptances WHERE mission_id=? AND decision=?').get(id,decision))throw Error('Settlement requires canonical Acceptance');
 if(this.store.requireMission(id).state!==(decision==='accept'?'completed':'needs_rework'))throw Error('Settlement requires accepted mission state');
 if(work&&decision==='accept')this.bridge.workExecution.assertEvidence(id);
 if(work)this.db.prepare("INSERT OR IGNORE INTO cp_mission_settlements VALUES(?,NULL,'waiting_acceptance','Work evidence requires Acceptance',?)").run(id,this.now());
 this.db.prepare('UPDATE cp_mission_settlements SET state=?,recommendation=?,updated_at=? WHERE mission_id=?').run(decision==='accept'?'settled':'needs_rework',decision==='accept'?'Accepted locally; no merge or deployment performed':'Operator requested rework',this.now(),id);
 this.store.event('mission.settled',id,{state:decision==='accept'?'settled':'needs_rework'});
 }
 dependencyReady(id,state,target){
 const work=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_work_bindings'").get()&&this.db.prepare('SELECT 1 FROM cp_work_bindings WHERE mission_id=?').get(id);
 if(work)return state==='settled'&&this.store.requireMission(id).state==='completed'&&!!this.db.prepare("SELECT 1 FROM cp_acceptances WHERE mission_id=? AND decision='accept'").get(id);
 if(state==='settled')return true;
 if(state!=='validated')return false;
 return !!target&&require('node:fs').realpathSync(target)!==this.store.requireMission(id).envelope.workspace;
 }
 detail(id){const c=this.contract(id);if(!c)return null;return{manifest:c.manifest,manifest_hash:c.manifest_hash,signed:c.signed,budgets:Object.fromEntries(['commits','external_reasoning','memory_injections'].map(k=>[k,this.used(id,k)])),reviews:this.db.prepare('SELECT * FROM cp_mission_reviews WHERE mission_id=? ORDER BY created_at DESC').all(id).map(r=>({...r,evidence:JSON.parse(r.evidence)})),settlement:this.db.prepare('SELECT * FROM cp_mission_settlements WHERE mission_id=?').get(id)||null,graph:this.graph(id)};}
 graph(id){
  const mission=this.store.requireMission(id);
  const membership=this.db.prepare('SELECT program_id,node_id FROM cp_mission_program_nodes WHERE mission_id=?').get(id);
  const stageId=membership?'stage:'+membership.program_id+':'+membership.node_id:'stage:'+id+':implementation';
  const nodes=[{id:'mission:'+id,type:'mission'},{id:'goal:'+mission.goal_id,type:'goal'},{id:stageId,type:'stage'}];
  const edges=[{from:'goal:'+mission.goal_id,to:'mission:'+id},{from:'mission:'+id,to:stageId}];
  for(const task of this.db.prepare('SELECT task_id FROM cp_mission_tasks WHERE mission_id=?').all(id)){
   nodes.push({id:'task:'+task.task_id,type:'task'});edges.push({from:stageId,to:'task:'+task.task_id});
  }
  for(const verification of this.db.prepare('SELECT id,run_id FROM cp_verifications WHERE mission_id=?').all(id)){
   const run=this.store.run(verification.run_id);
   nodes.push({id:'evidence:'+verification.id,type:'evidence',run_id:verification.run_id});
   edges.push({from:run?'task:'+run.task_id:stageId,to:'evidence:'+verification.id});
   const review=this.db.prepare('SELECT id FROM cp_mission_reviews WHERE verification_id=?').get(verification.id);
   if(review){
    nodes.push({id:'review:'+review.id,type:'review'},{id:'settlement:'+review.id,type:'settlement'});
    edges.push({from:'evidence:'+verification.id,to:'review:'+review.id});
    const acceptances=this.db.prepare('SELECT id,decision FROM cp_acceptances WHERE mission_id=? AND verification_id=?').all(id,verification.id);
    if(!acceptances.length)edges.push({from:'review:'+review.id,to:'settlement:'+review.id});
    for(const acceptance of acceptances){nodes.push({id:'acceptance:'+acceptance.id,type:'acceptance',decision:acceptance.decision});edges.push({from:'review:'+review.id,to:'acceptance:'+acceptance.id},{from:'acceptance:'+acceptance.id,to:'settlement:'+review.id});}
   }
  }
  return{nodes,edges};
 }

 create(input,owner='operator'){
 if(owner!=='operator')throw Error('Only authenticated operator may register Mission Programs');object(input,['request_id','stages','max_runtime_hours']);identifier(input.request_id);
 if(!Number.isFinite(input.max_runtime_hours)||input.max_runtime_hours<=0||input.max_runtime_hours>24||!Array.isArray(input.stages)||!input.stages.length||input.stages.length>40)throw Error('Invalid Mission Program budget or stages');
 const replay=this.db.prepare('SELECT id,fingerprint FROM cp_mission_programs WHERE owner=? AND request_id=?').get(owner,input.request_id);if(replay){if(replay.fingerprint!==fingerprint(input))throw Error('Mission Program idempotency conflict');return this.inspect(replay.id);}
 const ids=new Set();for(const s of input.stages){object(s,['id','depends_on','mission_id','mission']);identifier(s.id);if((s.mission_id!==undefined)===(s.mission!==undefined))throw Error('Stage requires one Mission reference or deferred input');if(s.mission_id!==undefined)identifier(s.mission_id);if(ids.has(s.id)||!Array.isArray(s.depends_on)||new Set(s.depends_on).size!==s.depends_on.length)throw Error('Invalid Mission Program node');ids.add(s.id);if(s.mission_id){const m=this.service.require(s.mission_id,owner);if(!m.envelope.manifest||m.state!=='ready')throw Error('Program stages require ready manifested Missions');}else{if(!s.mission||!s.mission.manifest||s.mission.authority||s.mission.fixture_auto_acceptance)throw Error('Deferred stages require manifest and cannot introduce authority or fixture automatic Acceptance');}}
 const visited=new Set(),visiting=new Set();const visit=id=>{if(visiting.has(id))throw Error('Mission Graph cycle');if(visited.has(id))return;const s=input.stages.find(s=>s.id===id);if(!s)throw Error('Mission Graph dependency missing');visiting.add(id);s.depends_on.forEach(visit);visiting.delete(id);visited.add(id);};ids.forEach(visit);
 const hash=fingerprint(input);return transaction(this.db,()=>{const prior=this.db.prepare('SELECT * FROM cp_mission_programs WHERE owner=? AND request_id=?').get(owner,input.request_id);if(prior){if(prior.fingerprint!==hash)throw Error('Mission Program idempotency conflict');return this.inspect(prior.id);}const id=randomUUID(),now=this.now();this.db.prepare('INSERT INTO cp_mission_programs VALUES(?,?,?,?,?,?,?,?)').run(id,owner,JSON.stringify(input.stages),hash,'running',now,now+input.max_runtime_hours*3600000,input.request_id);for(const s of input.stages)this.db.prepare('INSERT INTO cp_mission_program_nodes VALUES(?,?,?,?,?)').run(id,s.id,s.mission_id||null,JSON.stringify(s),'pending');return this.inspect(id);});
 }
 inspect(id){require('./memory-content-erasure').assertReadable(this.db);identifier(id);const p=this.db.prepare('SELECT * FROM cp_mission_programs WHERE id=?').get(id);if(!p)throw Error('Mission Program not found');return{...p,graph:JSON.parse(p.graph),edges:JSON.parse(p.graph).flatMap(s=>s.depends_on.map(d=>({from:d,to:s.id,type:'requires_validation'}))),stages:this.db.prepare('SELECT node_id,mission_id,state FROM cp_mission_program_nodes WHERE program_id=?').all(id)};}
 tick(){for(const p of this.db.prepare("SELECT * FROM cp_mission_programs WHERE state IN ('running','waiting_acceptance')").all())transaction(this.db,()=>{
 if(this.now()>=p.expires_at){this.db.prepare("UPDATE cp_mission_programs SET state='budget_exhausted' WHERE id=?").run(p.id);return;}
 const stages=JSON.parse(p.graph),states=new Map();let blocked=false,waiting=false;
 for(const s of stages){const node=this.db.prepare('SELECT state,mission_id FROM cp_mission_program_nodes WHERE program_id=? AND node_id=?').get(p.id,s.id);if(!node.mission_id){states.set(s.id,'pending');continue;}const m=this.store.requireMission(node.mission_id);const r=this.db.prepare('SELECT * FROM cp_mission_reviews WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(m.id);let state=node.state;
 if(m.state==='completed')state='settled';else if(['cancelled','blocked','needs_rework'].includes(m.state)){state=m.state;blocked=true;}else if(m.state==='awaiting_acceptance'){if(r?.result==='passed'){try{this.assert(m);if(r.workspace_hash!==workspaceSnapshot(m.envelope.workspace).hash)throw Error('stale');state='validated';waiting=true;}catch{state='blocked';blocked=true;}}else{state='waiting_review';blocked=true;}}else if(m.state==='waiting_for_operator'){state='waiting_operator';blocked=true;}else if(['dispatching','running','verifying'].includes(m.state)){state='dispatched';}
 states.set(s.id,state);this.db.prepare('UPDATE cp_mission_program_nodes SET state=? WHERE program_id=? AND node_id=?').run(state,p.id,s.id);
 }
 if(!blocked){for(const s of stages){if(states.get(s.id)!=='pending'||!s.depends_on.every(d=>{const dependency=this.db.prepare('SELECT mission_id FROM cp_mission_program_nodes WHERE program_id=? AND node_id=?').get(p.id,d);if(!dependency?.mission_id)return false;const target=s.mission?.workspace||(s.mission_id?this.store.requireMission(s.mission_id).envelope.workspace:null);return this.dependencyReady(dependency.mission_id,states.get(d),target);}))continue;
 try{let node=this.db.prepare('SELECT mission_id FROM cp_mission_program_nodes WHERE program_id=? AND node_id=?').get(p.id,s.id);let m;if(node.mission_id)m=this.store.requireMission(node.mission_id);else{m=this.service.create({...s.mission,request_id:'program:'+p.id+':'+s.id},p.owner);this.db.prepare('UPDATE cp_mission_program_nodes SET mission_id=? WHERE program_id=? AND node_id=?').run(m.id,p.id,s.id);}this.assert(m);this.service.queue(m.id);this.db.prepare("UPDATE cp_mission_program_nodes SET state='dispatched' WHERE program_id=? AND node_id=?").run(p.id,s.id);}catch{blocked=true;this.db.prepare("UPDATE cp_mission_program_nodes SET state='blocked' WHERE program_id=? AND node_id=?").run(p.id,s.id);}break;}}
 const terminal=[...states.values()].every(s=>s==='settled');this.db.prepare('UPDATE cp_mission_programs SET state=? WHERE id=?').run(terminal?'settled':blocked?'blocked':waiting?'waiting_acceptance':'running',p.id);
 });}
 cancel(id,requestId){identifier(requestId);return this.store.request('operator',requestId,{op:'cancel_program',id},()=>{const p=this.inspect(id);if(p.state==='settled')throw Error('Program is settled');this.db.prepare("UPDATE cp_mission_programs SET state='cancelled' WHERE id=?").run(id);for(const s of p.stages){if(!s.mission_id)continue;const m=this.store.requireMission(s.mission_id);if(!['completed','cancelled'].includes(m.state))this.service.cancel(m.id,{request_id:'program-stop:'+id+':'+s.node_id});}return this.inspect(id);});}
 resume(id){return transaction(this.db,()=>{const p=this.inspect(id);if(p.state!=='blocked'||this.now()>=p.expires_at)throw Error('Program cannot resume');for(const s of p.stages){if(!s.mission_id)continue;const m=this.store.requireMission(s.mission_id);if(['blocked','needs_rework','cancelled'].includes(m.state))throw Error('Resolve stage before resuming program');if(m.state==='ready')this.db.prepare("UPDATE cp_mission_program_nodes SET state='pending' WHERE program_id=? AND node_id=?").run(id,s.node_id);}this.db.prepare("UPDATE cp_mission_programs SET state='running' WHERE id=?").run(id);return this.inspect(id);});}
}
module.exports={MissionProgram,prepareBudgetIdentitySchema,prepareLegacyBudgetIdentities};
