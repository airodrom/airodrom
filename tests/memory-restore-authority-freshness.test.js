'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const erasure=require('../src/memory-erasure');
function database(t){const db=new DatabaseSync(':memory:');erasure.migrate(db);t.after(()=>db.close());return db;}
function erase(db){erasure.mark(db,{store:'personal',identity:'freshness-fixture',scope_hash:erasure.scopeHash(['fixture-scope']),action:'operator_erasure',erased_at:1000});}
test('a known stale restored copy cannot supply current erasure authority',t=>{
  const source=database(t),copy=database(t),target=database(t);erasure.reconcile(copy,source);erase(source);
  assert.throws(()=>erasure.reconcile(target,copy),/stale erasure generation/);
  assert.equal(target.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
});
test('nested restored reads reject a later generation in the original authority',t=>{
  const source=database(t),copy=database(t),target=database(t);erasure.reconcile(copy,source);erasure.reconcile(target,copy);erase(source);
  assert.throws(()=>erasure.assertCurrent(target),/stale erasure generation/);
});
test('recovery copies cannot form a cyclic source of erasure authority',t=>{
  const first=database(t),second=database(t);erasure.reconcile(first,second);
  assert.throws(()=>erasure.reconcile(second,first),/Cyclic recovery authority/);
});
function wholeRestoreFixture(t,{missing=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaque-source-lineage-')),source=new DatabaseSync(':memory:');
  new (require('../src/personal-memory').PersonalMemory)({db:source});
  new (require('../src/project-memory-v2').ProjectMemoryV2)({db:source});
  new (require('../src/authority-store').AuthorityStore)(source);
  new (require('../src/event-ledger').EventLedger)(source);
  require('../src/memory-identity').install(source);
  const anchor=randomUUID(),identity=randomUUID();
  if(!missing)source.prepare('INSERT INTO memory_identity_lineage VALUES(?,?,?,?,?,?)').run('authority_memories.id',anchor,identity,null,'local-operator',1);
  const file=path.join(dir,'recovery.sqlite');source.prepare('VACUUM INTO ?').run(file);const db=new DatabaseSync(file);
  if(missing)db.prepare('INSERT INTO memory_identity_lineage VALUES(?,?,?,?,?,?)').run('authority_memories.id',anchor,identity,null,'local-operator',1);
  else {db.exec('DROP TRIGGER memory_identity_lineage_no_update');db.prepare('UPDATE memory_identity_lineage SET identity=?').run(randomUUID());}
  const vaultDir=path.join(dir,'source-vault'),recoveryVault=path.join(dir,'recovery-vault');fs.mkdirSync(vaultDir,{mode:0o700});fs.mkdirSync(recoveryVault,{mode:0o700});
  const vault=new (require('../src/restricted-memory-vault').RestrictedMemoryVault)(vaultDir);vault.prepare();
  t.after(()=>{db.close();source.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {db,source,vault,recoveryVault};
}
test('whole restore rejects changed already-opaque lineage before returning services',t=>{
  const f=wholeRestoreFixture(t);
  assert.throws(()=>require('../src/memory-restore').prepareMemoryRestore({db:f.db,erasureSourceDb:f.source,vaultDirectory:f.recoveryVault,erasureSourceVault:f.vault}),/lineage is stale or unauthoritative/);
});
test('whole restore rejects missing authoritative lineage for an already-opaque copy',t=>{
  const f=wholeRestoreFixture(t,{missing:true});
  assert.throws(()=>require('../src/memory-restore').prepareMemoryRestore({db:f.db,erasureSourceDb:f.source,vaultDirectory:f.recoveryVault,erasureSourceVault:f.vault}),/lineage is stale or unauthoritative/);
});
