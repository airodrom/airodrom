'use strict';
// Explicit local operator maintenance. Default is a read-only diff; never started by an agent/provider or daemon.
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const arch=require('../src/architecture-memory');
const {transaction}=require('../src/control-transaction');
async function main(){
 const args=process.argv.slice(2);if(args.some(a=>!['--apply','--dry-run'].includes(a))||args.includes('--apply')&&args.includes('--dry-run'))throw Error('Invalid bootstrap options');
 const apply=args.includes('--apply'),root=fs.realpathSync(path.resolve(__dirname,'..')),file=path.join(root,'.runtime/memory.sqlite');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'config/architecture-memory-sources-v1.json'),'utf8'));
 arch.validateManifest(root,manifest);
 const db=new DatabaseSync(file,{readOnly:!apply});
 try{
  const projects=db.prepare("SELECT project_id,repositories FROM projects WHERE status<>'archived'").all().filter(p=>JSON.parse(p.repositories).includes(root));
  if(projects.length>1)throw Error('Ambiguous project scope requires operator reconciliation');
  if(db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined')").get(root))throw Error('BLOCKED_BY_ACTIVE_WRITER');
  if(!apply)return console.log(JSON.stringify({project_creation_required:!projects.length,...arch.bootstrap({db,root,manifest,projectId:projects[0]?.project_id||'pending-repository-project',dryRun:true})}));
  process.umask(0o077);const snapshot=file+'.before-architecture-memory-'+Date.now()+'.bak';await backup(db,snapshot);fs.chmodSync(snapshot,0o600);
  const result=transaction(db,()=>{
   if(db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined')").get(root))throw Error('BLOCKED_BY_ACTIVE_WRITER');
   const projectId=projects[0]?.project_id||new(require('../src/project-orchestrator').ProjectMissionOrchestrator)({db}).createProject({name:require('../src/branding').name,repositories:[root],autonomyLevel:'observe',description:'Canonical Harness architecture memory; reference context only.',privacyPolicy:'Project-scoped canonical docs only; no personal history.',costPolicy:'No inference or external dispatch authorized.'}).projectId;
   return arch.bootstrap({db,root,manifest,projectId,dryRun:false});
  });
  const pack=arch.retrieve(db,result.project_id),active=arch.list(db,result.project_id).length;
  const repeated=arch.bootstrap({db,root,manifest,projectId:result.project_id,dryRun:false});
  console.log(JSON.stringify({...result,active_architecture_memories:active,repeat_additions:repeated.additions,repeat_retirements:repeated.retirements,context_hash:pack.context_hash,context_records:pack.records.length,integrity:Object.values(db.prepare('PRAGMA integrity_check').get())[0],fk_findings:db.prepare('PRAGMA foreign_key_check').all().length,snapshot:path.basename(snapshot)}));
 }finally{db.close();}
}
main().catch(error=>{const known=['BLOCKED_BY_ACTIVE_WRITER','Ambiguous project scope requires operator reconciliation','Canonical source hash changed; reconcile approved manifest'];console.error(known.includes(error.message)?error.message:'Architecture bootstrap failed safely; no raw diagnostic exported.');process.exitCode=1;});
