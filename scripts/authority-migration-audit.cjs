'use strict';
// Read-only live source. All migration/rollback exercises use private disposable copies.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync,backup}=require('node:sqlite');
const {AuthorityStore}=require('../src/authority-store');
const {inventory,migrateLegacy}=require('../src/authority-migration');
const {canonicalHash}=require('../src/authority-hash');
async function audit(source,directory){
 if(!path.isAbsolute(source)||!path.isAbsolute(directory)||fs.existsSync(directory))throw Error('Fresh absolute audit directory required');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const original=new DatabaseSync(source,{readOnly:true}),snapshot=path.join(directory,'before.sqlite');await backup(original,snapshot);original.close();fs.chmodSync(snapshot,0o600);
 const candidate=path.join(directory,'candidate.sqlite');fs.copyFileSync(snapshot,candidate);let db=new DatabaseSync(candidate);const before=inventory(db),store=new AuthorityStore(db),migration=migrateLegacy(store),after=inventory(db);assert.deepEqual(before,after);assert.equal(migrateLegacy(store).migrated,false);
 for(const m of db.prepare('SELECT id FROM authority_missions').all())store.getCurrentMissionProjection(m.id);
 const architecture=db.prepare("SELECT count(*) n FROM authority_memories WHERE kind='architecture' AND status='active'").get().n;
 const integrity=store.integrity();assert.equal(integrity.ok,true);db.close();
 db=new DatabaseSync(candidate);const recovered=new AuthorityStore(db);assert.equal(migrateLegacy(recovered).migrated,false);assert.equal(recovered.integrity().ok,true);db.close();
 const rollback=path.join(directory,'rollback.sqlite');fs.copyFileSync(snapshot,rollback);db=new DatabaseSync(rollback,{readOnly:true});assert.deepEqual(inventory(db),before);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='authority_meta'").get().n,0);db.close();
 return {source_read_only:true,snapshot,clone:candidate,rollback_copy:rollback,migration:migration.migrated,inventory_before:before,inventory_after:after,preserved:canonicalHash(before)===canonicalHash(after),architecture_active:architecture,integrity,reopen_idempotent:true,rollback_verified:true};
}
if(require.main===module)audit(process.argv[2],process.argv[3]).then(result=>{fs.writeFileSync(path.join(process.argv[3],'report.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));}).catch(error=>{console.error(require('../src/secret-observation').redactText(error.message));process.exitCode=1;});
module.exports={audit};
