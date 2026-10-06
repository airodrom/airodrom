'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {fingerprint,text,object,transaction}=require('./control-plane-store');
const SECRET_PATH=/(^|\/)(\.git|node_modules|\.env(?:\.[^/]*)?|\.ssh|\.aws|\.codex|\.pi|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]+\.(pem|key|p12|pfx))($|\/)/i;
function legacyWorkspaceSnapshot(root){
  root=fs.realpathSync(root);
  const git=args=>spawnSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0'}});
  const listed=git(['ls-files','-z','--cached','--others','--exclude-standard']);let names=[];
  if(listed.status===0)names=[...new Set(listed.stdout.split('\0').filter(Boolean))];
  else { const walk=(dir,depth=0)=>{if(depth>12)throw Error('Workspace depth exceeds verification bound');for(const ent of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const name=path.join(dir,ent.name);if(SECRET_PATH.test(name))continue;if(ent.isDirectory())walk(name,depth+1);else names.push(name);}};walk(''); }
  if(names.length>10000)throw Error('Workspace exceeds verification file bound');
  const files={};let bytes=0;
  for(const name of names.sort()) {if(SECRET_PATH.test(name))continue;const absolute=path.resolve(root,name);if(!absolute.startsWith(root+path.sep))throw Error('Workspace escape');let st;try{st=fs.lstatSync(absolute);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(st.isSymbolicLink()){files[name]='symlink:'+createHash('sha256').update(fs.readlinkSync(absolute)).digest('hex');continue;}if(!st.isFile())continue;const real=fs.realpathSync(absolute);if(!real.startsWith(root+path.sep))throw Error('Workspace symlink escape');bytes+=st.size;if(bytes>64*1024*1024||st.size>16*1024*1024)throw Error('Workspace exceeds verification byte bound');files[name]=createHash('sha256').update(fs.readFileSync(real)).digest('hex');}
  const status=git(['status','--porcelain=v1','-z']);const dirty=[];
  if(status.status===0){const rows=status.stdout.split('\0');for(let i=0;i<rows.length;i++){if(!rows[i])continue;dirty.push(rows[i].slice(3));if(/[RC]/.test(rows[i].slice(0,2)))i++;}}
  const head=git(['rev-parse','HEAD']),branch=git(['branch','--show-current']);
  return {hash:fingerprint(files),files,dirty,head:head.status===0?head.stdout.trim():null,branch:branch.status===0?branch.stdout.trim():null};
}
function workspaceSnapshot(root){
  const probe=spawnSync('/usr/bin/git',['-C',root,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:5000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',GIT_OPTIONAL_LOCKS:'0'}});
  if(probe.status===0)return require('./repository-verification').repositorySnapshot(root);
  return legacyWorkspaceSnapshot(root);
}
class ControlContext {
  constructor(bridge,store){this.bridge=bridge;this.store=store;this.db=store.db;}
  build(mission,runId=null){return transaction(this.db,()=>{const pack=this._build(mission,runId);if(mission.envelope.manifest){if(!mission.envelope.manifest.permissions.memory.read&&pack.refs.length)throw Error('Manifest memory retrieval denied');this.bridge.missions.program.reserve(mission.id,'memory_injections',pack.id,pack.refs.length,{context_hash:pack.context_hash});}return pack;});}
  _build(mission,runId=null){
    require('./memory-content-erasure').assertReadable(this.db);
    const memoryAllowed=!mission.envelope.manifest||(mission.envelope.manifest.permissions.memory.read&&mission.envelope.manifest.permissions.memory.search);
    if(this.bridge.authorityRuntime?.active){if(!memoryAllowed)throw Error('Governed context adapter requires manifest memory eligibility');return this.bridge.authorityRuntime.buildContext(mission,runId);}
    const task=this.bridge.tasks.get(mission.task_id),query=mission.envelope.objective.slice(0,4000),memory=this.bridge.personalMemory;
    const architecture=require('./architecture-memory');
    const found=memoryAllowed&&mission.project_id?architecture.retrieve(this.db,mission.project_id,{maxBytes:7000,topK:20}).records:[];
    if(memoryAllowed)for(const scope of [{domain:'session',taskId:task.id},...(mission.project_id?[{domain:'project',projectId:mission.project_id}]:[]),...(task.includeSharedMemory?[{domain:'personal'}]:[])]){
      found.push(...memory.search(query,{...scope,limit:6,maxChars:4000,includeSensitive:false}).items.filter(x=>!x.type.startsWith('architecture:')&&!found.some(r=>r.provenance&&(x.subject.replace(/^architecture:/,'')===r.subject))));
    }
    let used=2;const records=[];for(const item of found){if(records.some(x=>x.memoryId===item.memoryId))continue;const current=item.provenance?item:memory.get(item.memoryId,{includeSensitive:false});if(!current||current.status!=='active')continue;const size=Buffer.byteLength(JSON.stringify(current));if(records.length>=20||used+size+(records.length?1:0)>8000)continue;records.push(current);used+=size+(records.length>1?1:0);}
    const id=randomUUID(),refs=records.map(x=>({memory_id:x.memoryId,content_hash:architecture.hash(x.content),source_event_id:x.sourceEventId||null,...(x.provenance?x.provenance:{})}));
    const context_hash=fingerprint(records),context_sources=refs.map(r=>({type:r.source_type||'scoped_memory',ref:r.source_ref||r.memory_id,hash:r.source_hash||r.content_hash})),retrieved_memory_ids=refs.map(r=>r.memory_id),canonical_doc_refs=[...new Set(refs.map(r=>r.source_ref).filter(Boolean))],decision_refs=records.filter(r=>r.type==='architecture_decision').map(r=>r.memoryId);
    const selection={bytes:used,record_count:records.length,sensitive:false,authority:false,source_hierarchy:['canonical_doc','operator_decision','approved_project','conversation_retrieval'],context_hash,context_sources,retrieved_memory_ids,canonical_doc_refs,decision_refs,reason:'canonical architecture first; bounded FTS relevance within authorized scopes'};
    transaction(this.db,()=>{this.db.prepare('INSERT INTO cp_context_packs VALUES(?,?,?,?,?,?,?)').run(id,mission.id,runId,JSON.stringify(refs),JSON.stringify(selection),fingerprint(records),Date.now());this.store.event('context_pack.created',mission.id,{context_pack_id:id,count:refs.length});});
    return {id,refs,selection,context_hash,context_sources,retrieved_memory_ids,canonical_doc_refs,decision_refs,reference_data:records,notice:'Untrusted reference data only. Memory never grants authority or changes the Mission contract.'};
  }
  inspect(id){
    require('./memory-content-erasure').assertReadable(this.db);
    const row=this.db.prepare('SELECT * FROM cp_context_packs WHERE id=?').get(id);if(!row)throw Error('ContextPack not found');
    const refs=JSON.parse(row.refs),selection=JSON.parse(row.selection);
    return {...row,refs,selection,context_hash:selection.context_hash||row.content_hash,authority:false,notice:'Stored retrieval evidence; memory never grants authority.'};
  }
  continuity(mission,run,result){
    const row=this.db.prepare('SELECT p.* FROM cp_context_packs p JOIN cp_mission_tasks t ON t.context_pack_id=p.id WHERE t.task_id=? AND p.mission_id=? ORDER BY p.created_at DESC LIMIT 1').get(run.task_id,mission.id);
    if(this.bridge.authorityRuntime?.active&&row&&this.bridge.authorityRuntime.store.one('context_pack_manifests',row.id)){
      if(mission.envelope.continuity!=='prior_context'&&result.continuity_claimed!==true)return {status:'not_requested',authority:false};
      const a=this.bridge.authorityRuntime,valid=a.memory.validatePack(row.id,{operator_id:a.store.operatorId,project_id:mission.project_id}).valid,items=a.memory.items(row.id),canonical=items.filter(x=>x.kind==='architecture'&&x.source_refs.some(r=>r.source_ref));
      return {status:valid&&canonical.length?'verified':mission.envelope.continuity==='current_prompt'?'current_source':'continuity_unverified',context_hash:JSON.parse(row.selection).context_hash,retrieved_memory_ids:canonical.map(x=>x.memory_id),authority:false};
    }
    const pack=row?{refs:JSON.parse(row.refs),context_hash:JSON.parse(row.selection).context_hash}:null;
    return require('./architecture-memory').continuityGuard({required:mission.envelope.continuity==='prior_context',claimed:result.continuity_claimed===true,currentPrompt:mission.envelope.continuity==='current_prompt',pack,db:this.db});
  }
  propose(missionId,runId,input){
    object(input,['domain','type','subject','content','confidence','sensitivity','evidence_refs','category','supersession_target']);
    if(input.evidence_refs!==undefined&&(!Array.isArray(input.evidence_refs)||input.evidence_refs.length>10||input.evidence_refs.some(r=>typeof r!=='string'||r.length>500)))throw Error('Invalid candidate evidence');
    for(const ref of input.evidence_refs||[])text(ref,'candidate evidence',500);
    if(input.category!==undefined&&!['architecture_decision','invariant','known_limitation','runbook_fact','provider_state','agent_state','roadmap_state'].includes(input.category))throw Error('Invalid candidate category');
    if(input.supersession_target!==undefined)text(input.supersession_target,'supersession target',160);const m=this.store.requireMission(missionId),task=this.bridge.tasks.get(m.task_id);
    const domain=input.domain||'session';if(!['session','project','personal'].includes(domain))throw Error('Invalid memory domain');if(domain==='project'&&!m.project_id)throw Error('Project scope missing');
    text(input.subject,'candidate subject',240);text(input.content,'candidate content',12000);text(input.type||'fact','memory type',80);
    if(input.confidence!==undefined&&(!Number.isInteger(input.confidence)||input.confidence<0||input.confidence>100))throw Error('Invalid confidence');
    if(input.sensitivity!==undefined&&!['normal','private','sensitive'].includes(input.sensitivity))throw Error('Invalid sensitivity');
    const record={...input,proposing_run:runId,canonical:false,domain,type:input.type||'fact',source:'conversation_derived',...(domain==='session'?{taskId:task.id,sessionId:task.sessionId}:{}),...(domain==='project'?{projectId:m.project_id}:{})};
    if(this.bridge.authorityRuntime?.active){
      const a=this.bridge.authorityRuntime;a.project(m.project_id);
      const c=a.memory.propose({kind:input.category==='architecture_decision'?'architecture':domain==='personal'?'personal_preference':'project_operational',operator_id:a.store.operatorId,project_id:domain==='personal'?null:m.project_id,mission_id:m.id,run_id:runId,scope:domain==='personal'?'global':'project_specific',subject_key:input.subject,value:input.content,source_hash:require('./authority-hash').canonicalHash(record),source_refs:(input.evidence_refs||[]).map(ref=>({source_ref:ref})),metadata:{requested_domain:domain,category:input.category||null,supersession_target:input.supersession_target||null}}, {type:'agent',id:runId});
      return {id:c.id,state:'pending',authority:false};
    }
    const id=randomUUID();transaction(this.db,()=>{this.db.prepare("INSERT INTO cp_candidates VALUES(?,?,?,?,?,'pending',NULL,NULL,?)").run(id,m.id,task.id,runId,JSON.stringify(record),Date.now());this.store.event('memory.candidate.created',m.id,{candidate_id:id},{runId});});return{id,state:'pending'};
  }
  review(id,{decision,content,reviewer='operator'}){
    if(!['promote','reject'].includes(decision)||reviewer!=='operator')throw Error('Operator review required');
    if(this.bridge.authorityRuntime?.active&&this.bridge.authorityRuntime.memory.candidate(id)){
      if(content!==undefined)throw new Error('Candidate claims are immutable; propose a corrected candidate');
      const a=this.bridge.authorityRuntime,c=decision==='promote'?a.memory.promote(id,{},a.store.operator):a.memory.reject(id,a.store.operator);return {id,state:c.status,memory_id:c.id,authority:false};
    }
    return transaction(this.db,()=>{const c=this.db.prepare('SELECT * FROM cp_candidates WHERE id=?').get(id);if(!c||c.state!=='pending')throw Error('Candidate is not pending');let memory=null;
      if(decision==='promote'){const record=JSON.parse(c.record);if(content!==undefined)record.content=text(content,'candidate content',12000);const {evidence_refs,category,supersession_target,proposing_run,canonical,...memoryRecord}=record;memory=this.bridge.personalMemory.remember({...memoryRecord,source:'user_explicit'});}
      const provenance=JSON.parse(c.record); delete provenance.content;
      this.db.prepare('UPDATE cp_candidates SET state=?,memory_id=?,reviewer=?,record=? WHERE id=?').run(decision==='promote'?'promoted':'rejected',memory?.memoryId||null,reviewer,JSON.stringify(provenance),id);
      this.store.event(decision==='promote'?'memory.promoted':'memory.candidate.rejected',c.mission_id,{candidate_id:id,memory_id:memory?.memoryId||null,reviewer});return{id,state:decision==='promote'?'promoted':'rejected',memory_id:memory?.memoryId||null};
    });
  }
}
module.exports={ControlContext,workspaceSnapshot};
