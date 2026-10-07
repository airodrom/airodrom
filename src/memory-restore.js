'use strict';
// Application-controlled restore barrier. The host quarantines a copied SQLite
// database and vault directory and supplies the CURRENT independent disposition
// sources. Nothing is returned until every canonical store has reconciled.
const { transaction } = require('./control-transaction');
const { PersonalMemory } = require('./personal-memory');
const { ProjectMemoryV2 } = require('./project-memory-v2');
const { AuthorityStore } = require('./authority-store');
const { AuthorityMemory } = require('./authority-memory');
const { RestrictedMemoryVault } = require('./restricted-memory-vault');
const { MemoryStore } = require('./memory-store');
function assertAuthoritativeIdentityLineage(db,source) {
  const exists=(database,table)=>!!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if(!exists(db,'memory_identity_lineage'))return;
  for(const row of db.prepare('SELECT * FROM memory_identity_lineage').all()) {
    if(!exists(source,'memory_identity_lineage'))throw Error('Restore requires current authoritative identity lineage');
    const current=source.prepare('SELECT identity,project_id,operator_id FROM memory_identity_lineage WHERE record_class=? AND anchor_id=?').get(row.record_class,row.anchor_id);
    if(!current||['identity','project_id','operator_id'].some(key=>current[key]!==row[key]))throw Error('Restored identity lineage is stale or unauthoritative');
  }
}
function prepareMemoryRestore({db,erasureSourceDb,vaultDirectory,erasureSourceVault,retainedDataDir=null,now=Date.now,operatorId='local-operator'}={}){
  if(!db||!erasureSourceDb||db===erasureSourceDb)throw Error('Restore requires current independent erasure evidence');
  if(!vaultDirectory||!(erasureSourceVault instanceof RestrictedMemoryVault))throw Error('Restore requires independent vault disposition');
  db.exec('PRAGMA foreign_keys=ON');
  require('./memory-erasure').assertCurrent(erasureSourceDb);
  if(retainedDataDir)require('./retained-context-files').attachRetainedFiles(db,retainedDataDir);
  // Quarantined legacy identities must be resolved against current authoritative
  // metadata before any constructor can reconcile markers or expose content.
  require('./memory-identity').migrate(db,{sourceDb:erasureSourceDb,now:now()});
  assertAuthoritativeIdentityLineage(db,erasureSourceDb);
  // Vault tombstones are durable before key cleanup. A later database failure
  // cannot make erased ciphertext readable; the entire restore stays quarantined.
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='cp_mcp_handoff_sessions'").get())db.prepare('DELETE FROM cp_mcp_handoff_sessions').run();
  const vault=new RestrictedMemoryVault(vaultDirectory,{restoreFromBackup:true,erasureSourceVault});
  return transaction(db,()=>{
    const personal=new PersonalMemory({db,now,restoreFromBackup:true,erasureSourceDb});
    const scratch=new MemoryStore(':memory:',{db,restoreFromBackup:true,erasureSourceDb});
    const project=new ProjectMemoryV2({db,now,restoreFromBackup:true,erasureSourceDb});
    const authority=new AuthorityStore(db,{now,operatorId,restoreFromBackup:true,erasureSourceDb});
    const governed=new AuthorityMemory(authority);
    for(const row of db.prepare("SELECT identity FROM memory_erasure_markers WHERE store='governed' AND action='operator_erasure'").all())if(db.prepare('SELECT 1 FROM authority_memories WHERE id=?').get(row.identity))governed.erase(row.identity,authority.operator);
    require('./memory-content-erasure').assertReadable(db);
    require('./memory-identity').assertReadable(db);
    assertAuthoritativeIdentityLineage(db,erasureSourceDb);
    return{personal,scratch,project,authority,governed,vault,logicalSuppression:true,physicalErasure:false,immutableContentRetained:false,authorityRestored:false};
  });
}
module.exports={prepareMemoryRestore};
