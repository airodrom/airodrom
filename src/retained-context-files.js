'use strict';
// Host-only filesystem erasure port for the existing task/session/audit layout.
// No runtime path, content or cleanup instructions come from a model packet.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {atomicJSON}=require('./config');
const {afterCommit,afterRollback}=require('./control-transaction');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESULT_FILE=/^(?:consumed\.json|completion\.json|work-return\.tmp)(?:\.identity-[0-9a-f-]{36}\.tmp|\.tmp)?$/;
function realDirectory(root) {
  const resolved=path.resolve(root),st=fs.lstatSync(resolved);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('Retained context directory unavailable');
  return fs.realpathSync(resolved);
}
function containsAlias(text,aliases){return [...aliases.keys()].some(alias=>text.includes(alias));}
function rewriteValue(value,aliases) {
  if(typeof value==='string') {for(const [old,next]of aliases)value=value.split(old).join(next);return value;}
  if(Array.isArray(value))return value.map(item=>rewriteValue(item,aliases));
  if(value&&typeof value==='object') {
    const result={};
    for(const [key,item]of Object.entries(value)) {
      const next=rewriteValue(key,aliases);
      if(Object.hasOwn(result,next))throw Error('Retained identity key collision');
      Object.defineProperty(result,next,{value:rewriteValue(item,aliases),enumerable:true,writable:true,configurable:true});
    }
    return result;
  }
  return value;
}
function replaceFile(file,bytes) {
  const temp=file+'.identity-'+randomUUID()+'.tmp';
  try {fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
  finally {if(fs.existsSync(temp))fs.rmSync(temp,{force:true});}
}
function redactRetainedResults(db,root,taskId,marker) {
  if(!Number.isSafeInteger(marker?.generation)||marker.generation<1)throw Error('Retained result erasure generation unavailable');
  const results=path.join(root,'codex-results');if(!fs.existsSync(results))return;
  realDirectory(results);const plans=[];let total=0;
  for(const item of fs.readdirSync(results,{withFileTypes:true})) {
    if(!UUID.test(item.name)||!item.isDirectory()||item.isSymbolicLink())throw Error('Retained result directory denied');
    let owner=null;
    for(const table of ['cp_runs','authority_runs'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      const run=db.prepare(`SELECT task_id,mission_id FROM ${table} WHERE id=?`).get(item.name);
      if(!run)continue;
      if(!UUID.test(run.task_id||'')||!UUID.test(run.mission_id||'')||owner&&['task_id','mission_id'].some(key=>owner[key]!==run[key]))throw Error('Retained result ownership mismatch');
      owner=run;
    }
    if(!owner)throw Error('Retained result ownership unavailable');
    const dir=path.join(results,item.name);realDirectory(dir);
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(entry.isSymbolicLink()||!entry.isFile())throw Error('Retained result file type denied');
      if(!RESULT_FILE.test(entry.name))throw Error('Unsupported retained result copy');
      const file=path.join(dir,entry.name),stat=fs.lstatSync(file);
      total+=stat.size;if(stat.isSymbolicLink()||!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1||(stat.mode&0o077)||stat.size>24000||total>64*1024*1024)throw Error('Retained result file ownership or bound denied');
      const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let value;
      try {
        const opened=fs.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size!==stat.size)throw Error('Retained result file changed');
        value=JSON.parse(fs.readFileSync(fd,'utf8'));
      }catch{throw Error('Unknown retained result shape');}finally{fs.closeSync(fd);}
      if(!value||Array.isArray(value)||value.schema_version!=='codex-result-v1'||value.run_id!==item.name||value.task_id!==owner.task_id||value.mission_id!==owner.mission_id||value.agent_id!=='codex'||value.transport!=='handoff')throw Error('Retained result correlation mismatch');
      if(owner.task_id!==taskId)continue;
      if(value.content_state==='erased'&&(!Number.isSafeInteger(value.erasure_generation)||value.erasure_generation>marker.generation))throw Error('Retained result generation mismatch');
      const bytes=Buffer.from(JSON.stringify({schema_version:'codex-result-v1',mission_id:owner.mission_id,task_id:owner.task_id,run_id:item.name,agent_id:'codex',transport:'handoff',content_state:'erased',erasure_generation:marker.generation,authority:false})+'\n');
      plans.push({file,bytes});
    }
  }
  // Preflight every canonical result copy before writing. Partial replacement is
  // safe to retry: only content-free markers are written, never retained backups.
  for(const plan of plans){replaceFile(plan.file,plan.bytes);if(!fs.readFileSync(plan.file).equals(plan.bytes))throw Error('Retained result redaction incomplete');}
}
function migrateRetainedFiles(db,root,aliases,{taskIds=[]}={},options) {
  if(!(aliases instanceof Map))throw Error('Host identity aliases required');
  for(const [old,next]of aliases)if(typeof old!=='string'||!old||typeof next!=='string'||!/^[0-9a-f-]{36}$/.test(next))throw Error('Invalid host identity aliases');
  if(!aliases.size)return {rewritten_files:0};
  const plans=[],affectedTasks=new Set(taskIds),updates=new Map();let bytes=0;
  const add=(file,taskId=null,canonicalTask=false,resultOwned=false)=>{
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()||!stat.isFile())throw Error('Retained identity file type denied');
    bytes+=stat.size;if(stat.size>16*1024*1024||bytes>64*1024*1024)throw Error('Retained identity files exceed bound');
    const prior=fs.readFileSync(file),text=prior.toString('utf8'),hasAlias=containsAlias(text,aliases);
    if(hasAlias&&resultOwned&&!taskId)throw Error('Retained result identity ownership unavailable');
    if(!hasAlias&&!canonicalTask)return;
    if(!Buffer.from(text,'utf8').equals(prior))throw Error('Unknown retained identity encoding');
    let next,task;
    if(canonicalTask) {
      if(!hasAlias&&!affectedTasks.has(taskId))return;
      const row=db.prepare('SELECT snapshot FROM task_states WHERE id=?').get(taskId);
      if(!row)throw Error('Retained identity task missing');
      try{task=JSON.parse(row.snapshot);}catch{throw Error('Unknown retained task shape');}
      if(!task||Array.isArray(task)||task.id!==taskId)throw Error('Unknown retained task shape');
      next=JSON.stringify(rewriteValue(task,aliases),null,2)+'\n';
      updates.set(taskId,rewriteValue(task,aliases));
    }else if(path.extname(file)==='.json'||resultOwned&&RESULT_FILE.test(path.basename(file))) {
      try{next=JSON.stringify(rewriteValue(JSON.parse(text),aliases),null,2)+'\n';}catch{throw Error('Unknown retained identity JSON shape');}
    }else if(path.extname(file)==='.jsonl'||/^audit\.jsonl(?:\.1)?$/.test(path.basename(file))) {
      try{next=text.split('\n').filter(Boolean).map(line=>JSON.stringify(rewriteValue(JSON.parse(line),aliases))).join('\n')+(text.trim()?'\n':'');}catch{throw Error('Unknown retained identity JSONL shape');}
    }else throw Error('Unsupported retained identity content shape');
    if(containsAlias(next,aliases))throw Error('Retained identity alias remains');
    if(taskId)affectedTasks.add(taskId);
    if(next!==text)plans.push({file,prior,next:Buffer.from(next)});
  };
  const walk=(dir,taskId=null,resultOwned=false)=>{
    realDirectory(dir);
    for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
      if(taskId&&item.name==='workspace')continue;
      if(containsAlias(item.name,aliases)||item.isSymbolicLink())throw Error('Retained identity path denied');
      const file=path.join(dir,item.name);
      if(item.isDirectory())walk(file,taskId,resultOwned);
      else if(item.isFile())add(file,taskId,taskId&&item.name==='task.json'&&path.dirname(file)===path.join(root,'tasks',taskId),resultOwned);
      else throw Error('Retained identity file type denied');
    }
  };
  const tasks=path.join(root,'tasks');
  if(fs.existsSync(tasks)) {
    realDirectory(tasks);
    for(const item of fs.readdirSync(tasks,{withFileTypes:true})) {
      if(!/^[0-9a-f-]{36}$/.test(item.name)||!item.isDirectory()||item.isSymbolicLink())throw Error('Retained identity task directory denied');
      walk(path.join(tasks,item.name),item.name);
    }
  }
  const results=path.join(root,'codex-results');
  if(fs.existsSync(results)) {
    realDirectory(results);
    for(const item of fs.readdirSync(results,{withFileTypes:true})) {
      if(!/^[0-9a-f-]{36}$/.test(item.name)||!item.isDirectory()||item.isSymbolicLink())throw Error('Retained result identity directory denied');
      let owner=null;
      for(const table of ['cp_runs','authority_runs'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        const run=db.prepare(`SELECT task_id FROM ${table} WHERE id=?`).get(item.name);
        if(run?.task_id){if(owner&&owner!==run.task_id)throw Error('Retained result identity ownership mismatch');owner=run.task_id;}
      }
      walk(path.join(results,item.name),owner,true);
    }
  }
  for(const name of ['audit.jsonl','audit.jsonl.1'])if(fs.existsSync(path.join(root,name)))add(path.join(root,name));
  for(const id of affectedTasks) {
    if(!/^[0-9a-f-]{36}$/.test(id)||!fs.existsSync(path.join(tasks,id,'task.json')))throw Error('Retained identity task sidecar missing');
    if(options.isActive(id))throw Error('Active retained task identity migration denied');
  }
  // No aliases or preimages are persisted. SQL rollback restores the canonical
  // sidecars from transient preimages; committed task updates happen afterward.
  const applied=[];
  const undo=()=>{for(const plan of [...applied].reverse())replaceFile(plan.file,plan.prior);};
  afterRollback(db,undo);
  try {for(const plan of plans){replaceFile(plan.file,plan.next);applied.push(plan);if(containsAlias(fs.readFileSync(plan.file,'utf8'),aliases))throw Error('Retained identity alias remains');}}
  catch {try{undo();applied.length=0;}catch{}throw Error('Retained identity file rewrite incomplete');}
  afterCommit(db,()=>{for(const [id,task]of updates)options.onTaskRedacted(id,task);});
  return {rewritten_files:plans.length};
}
function attachRetainedFiles(db,dataDir,{isActive=()=>false,onTaskRedacted=()=>{}}={}) {
  const root=realDirectory(dataDir),content=require('./memory-content-erasure');
  require('./memory-identity').attach(db,'files',(aliases,metadata)=>migrateRetainedFiles(db,root,aliases,metadata,{isActive,onTaskRedacted}));
  content.attach(db,'task-files',(id,marker)=>{
    if(!/^[0-9a-f-]{36}$/.test(id)||isActive(id))throw Error('Retained task unavailable for erasure');
    const tasks=path.join(root,'tasks'),dir=path.join(tasks,id);
    realDirectory(tasks);realDirectory(dir);
    const row=db.prepare('SELECT snapshot FROM task_states WHERE id=?').get(id);
    if(!row)throw Error('Retained task disposition missing');
    const task=JSON.parse(row.snapshot);
    if(task.content_state!=='erased')throw Error('Retained task redaction missing');
    redactRetainedResults(db,root,id,marker);
    for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,item.name);
      if(item.isSymbolicLink())throw Error('Retained context symlink denied');
      if(item.name!=='workspace'&&item.name!=='task.json')fs.rmSync(file,{recursive:true,force:true});
    }
    fs.mkdirSync(path.join(dir,'sessions'),{recursive:true,mode:0o700});atomicJSON(path.join(dir,'task.json'),task);onTaskRedacted(id,task);
  });
  content.attach(db,'audit-files',()=>{
    // Audit JSONL is diagnostic, not the authoritative ordered event chain.
    // Free-form fields are discarded for every entry: no provenance guess can
    // justify retaining an unlinked personal string in a diagnostic copy.
    const allowed=['event_id','task_id','taskId','run_id','runId','mission_id','missionId','timestamp','at','agent','source','event_type','status','allowed','outcome'];
    for(const name of ['audit.jsonl','audit.jsonl.1']) {
      const file=path.join(root,name);if(!fs.existsSync(file))continue;
      if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Retained audit file type denied');
      const rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>{
        let row;try{row=JSON.parse(line);}catch{throw Error('Retained audit shape unknown');}
        if(!row||Array.isArray(row)||typeof row!=='object')throw Error('Retained audit shape unknown');
        return {...Object.fromEntries(Object.entries(row).filter(([key])=>allowed.includes(key))),content_state:'redacted'};
      });
      const temp=file+'.redaction.tmp';fs.writeFileSync(temp,rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':''),{mode:0o600});fs.renameSync(temp,file);
    }
  });
}
module.exports={attachRetainedFiles};
