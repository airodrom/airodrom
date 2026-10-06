'use strict';
// Publishes evidence only. Does not issue grants, release leases or accept work.
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {fingerprint,redactValue,object,identifier}=require('../src/control-plane-store');
function publish(file,{runtime=path.resolve(__dirname,'../.runtime')}={}){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>24000)throw Error('Bounded regular result file required');
 const input=JSON.parse(fs.readFileSync(file,'utf8'));
 if(input.schema_version){
  const {validateEnvelope,location,owned}=require('../src/codex-completion-relay');
  const database=path.join(runtime,'memory.sqlite');owned(database);
  const db=new DatabaseSync(database,{readOnly:true});let h;
  try{h=db.prepare('SELECT contract,state FROM cp_codex_handoffs WHERE run_id=?').get(identifier(input.run_id));}finally{db.close();}
  if(!h)throw Error('Unknown handoff');const contract=JSON.parse(h.contract);validateEnvelope(input,contract);
  if(h.state!=='awaiting_handoff')throw Error('Stale handoff');
  const p=location(runtime,input.run_id);owned(p.root,true);owned(p.dir,true);
  const body=JSON.stringify(input),existing=[p.file,path.join(p.dir,'consumed.json')].find(f=>fs.existsSync(f));
  if(existing){owned(existing);const old=JSON.parse(fs.readFileSync(existing,'utf8'));if(fingerprint(old)!==fingerprint(input))throw Error('Immutable result conflict');return{run_id:input.run_id,published:true,duplicate:true,state:'artifact_staged',accepted:false};}
  const tmp=path.join(p.dir,`completion-${require('node:crypto').randomUUID()}.tmp`);const fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(tmp,p.file);}catch(e){if(e.code!=='EEXIST')throw e;owned(p.file);if(fingerprint(JSON.parse(fs.readFileSync(p.file,'utf8')))!==fingerprint(input))throw Error('Immutable result conflict');}finally{fs.unlinkSync(tmp);}
  return{run_id:input.run_id,published:true,duplicate:false,state:'artifact_staged',accepted:false};
 }
 object(input,['mission_id','task_id','run_id','request_id','agent_id','result']);for(const k of ['mission_id','task_id','run_id','request_id','agent_id'])identifier(input[k]);if(input.agent_id!=='codex')throw Error('Codex handoff publisher only');const safe=redactValue(input),hash=fingerprint(safe);
 const database=path.join(runtime,'memory.sqlite'),databaseStat=fs.lstatSync(database);if(!databaseStat.isFile()||databaseStat.isSymbolicLink()||(databaseStat.mode&0o077))throw Error('Unsafe result database');
 const db=new DatabaseSync(database);try{db.exec('PRAGMA busy_timeout=3000');db.exec('BEGIN IMMEDIATE');
 const h=db.prepare('SELECT * FROM cp_codex_handoffs WHERE run_id=?').get(input.run_id);if(!h)throw Error('Unknown handoff');const c=JSON.parse(h.contract);for(const k of ['mission_id','task_id','run_id','request_id'])if(input[k]!==c[k])throw Error('Handoff correlation mismatch');
 if(c.protocol!=='codex-handoff-v1')throw Error('Versioned relay envelope required');
 const old=db.prepare('SELECT fingerprint FROM cp_codex_result_proposals WHERE run_id=?').get(input.run_id);if(old&&old.fingerprint!==hash)throw Error('Immutable result conflict');if(!old){if(h.state==='settled')throw Error('Run already settled');db.prepare('INSERT INTO cp_codex_result_proposals VALUES(?,?,?,?)').run(input.run_id,hash,JSON.stringify(safe),Date.now());}db.exec('COMMIT');return{run_id:input.run_id,published:true,duplicate:!!old,state:'awaiting_termination_reconciliation',accepted:false};
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
if(require.main===module){try{if(process.argv[2]!=='--file'||![4,6].includes(process.argv.length)||(process.argv.length===6&&process.argv[4]!=='--runtime'))throw Error('Use --file RESULT.json [--runtime PATH]');console.log(JSON.stringify(publish(path.resolve(process.argv[3]),process.argv.length===6?{runtime:path.resolve(process.argv[5])}:{})));}catch{console.error('Result publication failed; inspect correlation and runtime readiness.');process.exitCode=1;}}
module.exports={publish};
