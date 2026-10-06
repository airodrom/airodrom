'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{randomUUID}=require('node:crypto');
const identity=require('../src/memory-identity'),erasure=require('../src/memory-erasure'),content=require('../src/memory-content-erasure'),{transaction}=require('../src/control-transaction');
const DENIED=/identity|migration|legacy|unavailable|incomplete|unclassified|changed|generation/i;
const BAD='sha256:'+'e'.repeat(64);
function fixture(t,{file=false}={}){
  const dir=file?fs.mkdtempSync(path.join(os.tmpdir(),'identity-read-memo-')):null,db=new DatabaseSync(dir?path.join(dir,'current.sqlite'):':memory:');erasure.migrate(db);
  db.exec('CREATE TABLE cp_context_packs(id TEXT PRIMARY KEY,refs TEXT,selection TEXT,content_hash TEXT,created_at INTEGER)');const id=randomUUID();db.prepare('INSERT INTO cp_context_packs VALUES(?,?,?,?,?)').run(id,'[]','{}','fixture-digest',1);
  const others=[];t.after(()=>{others.forEach(d=>d.close());db.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
  return{db,id,dir,open(){const other=new DatabaseSync(path.join(dir,'current.sqlite'));others.push(other);return other;},copy(){const file=path.join(dir,'copy-'+others.length+'.sqlite');db.prepare('VACUUM INTO ?').run(file);const copy=new DatabaseSync(file);others.push(copy);return copy;}};
}
function observe(db){const original=db.prepare.bind(db),queries=[];db.prepare=(sql,...args)=>{queries.push(sql);return original(sql,...args);};return{queries,restore(){db.prepare=original;}};}
function scans(q){return q.filter(sql=>/^PRAGMA table_(?:xinfo|info)|SELECT .* FROM "cp_context_packs"/i.test(sql));}
test('unchanged reads reuse validity only and never reselect stored payload',t=>{
  const f=fixture(t),o=observe(f.db);identity.assertReadable(f.db);assert.ok(scans(o.queries).length>0);o.queries.length=0;for(let i=0;i<20;i++)identity.assertReadable(f.db);assert.equal(scans(o.queries).length,0);o.restore();
});
for(const mutation of ['insert','update','json_reference'])test('same-connection raw '+mutation+' invalidates successful read validation',t=>{
  const f=fixture(t);identity.assertReadable(f.db);if(mutation==='insert')f.db.prepare('INSERT INTO cp_context_packs VALUES(?,?,?,?,?)').run(BAD,'[]','{}','fixture',1);else if(mutation==='update')f.db.prepare('UPDATE cp_context_packs SET id=?').run(BAD);else f.db.prepare('UPDATE cp_context_packs SET refs=?').run(JSON.stringify([{memory_id:BAD}]));assert.throws(()=>identity.assertReadable(f.db),DENIED);
});
test('second connection commits invalidate identity validity even when own total_changes is unchanged',t=>{
  const f=fixture(t,{file:true});identity.assertReadable(f.db);const before=f.db.prepare('SELECT total_changes() n').get().n,other=f.open();other.prepare('UPDATE cp_context_packs SET id=?').run(BAD);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.throws(()=>identity.assertReadable(f.db),DENIED);
});
test('raw transaction DDL and rollback clear memo despite reused schema version',t=>{
  const f=fixture(t),o=observe(f.db);identity.assertReadable(f.db);f.db.exec('BEGIN; ALTER TABLE cp_context_packs ADD COLUMN unknown_copy TEXT');assert.throws(()=>identity.assertReadable(f.db),DENIED);f.db.exec('ROLLBACK');o.queries.length=0;identity.assertReadable(f.db);assert.ok(scans(o.queries).length>0);o.restore();
});
test('committed unknown DDL cannot reuse a deliberately restored schema counter',t=>{
  const f=fixture(t);identity.assertReadable(f.db);const before=f.db.prepare('PRAGMA schema_version').get().schema_version,changes=f.db.prepare('SELECT total_changes() n').get().n;f.db.exec('BEGIN; ALTER TABLE cp_context_packs ADD COLUMN unknown_copy TEXT; PRAGMA schema_version='+before+'; COMMIT');assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(f.db.prepare('PRAGMA schema_version').get().schema_version,before);assert.throws(()=>identity.assertReadable(f.db),DENIED);
});
test('a rolled-back host transaction cannot reuse validation of its transient contents',t=>{
  const f=fixture(t),o=observe(f.db);identity.assertReadable(f.db);assert.throws(()=>transaction(f.db,()=>{f.db.prepare('UPDATE cp_context_packs SET id=?').run(BAD);assert.throws(()=>identity.assertReadable(f.db),DENIED);throw Error('fixture rollback');}),/fixture rollback/);o.queries.length=0;identity.assertReadable(f.db);assert.ok(scans(o.queries).length>0);o.restore();
});
test('raw and host transaction reads never populate the autocommit memo',t=>{
  const f=fixture(t),o=observe(f.db);f.db.exec('BEGIN');identity.assertReadable(f.db);o.queries.length=0;identity.assertReadable(f.db);assert.ok(scans(o.queries).length>0);f.db.exec('ROLLBACK');transaction(f.db,()=>{identity.assertReadable(f.db);o.queries.length=0;identity.assertReadable(f.db);assert.ok(scans(o.queries).length>0);});o.restore();
});
test('pending identity state and an interrupted migration invalidate prior successful reads',t=>{
  const f=fixture(t);identity.assertReadable(f.db);f.db.prepare("UPDATE memory_identity_progress SET state='pending'").run();assert.throws(()=>identity.assertReadable(f.db),DENIED);f.db.prepare("UPDATE memory_identity_progress SET state='complete'").run();identity.assertReadable(f.db);assert.throws(()=>identity.migrate(f.db,{beforeApply(){assert.throws(()=>identity.assertReadable(f.db),DENIED);throw Error('fixture migration interruption');}}),DENIED);assert.throws(()=>identity.assertReadable(f.db),DENIED);
});
test('pending content propagation remains denied after an identity memo was populated',t=>{
  const f=fixture(t);content.assertReadable(f.db);erasure.mark(f.db,{store:'personal',identity:randomUUID(),scope_hash:erasure.scopeHash(['personal',null,null,null]),action:'operator_erasure',erased_at:1});assert.throws(()=>content.assertReadable(f.db),/incomplete/);assert.equal(erasure.packetUsable(f.db,{records:[{memory_id:f.id}]}),false);
});
test('a cached recovered identity still checks fresh independent source disposition before returning',t=>{
  const f=fixture(t,{file:true}),copy=f.copy();identity.migrate(f.db);identity.migrate(copy,{sourceDb:f.db});identity.assertReadable(copy);identity.assertReadable(copy);erasure.mark(f.db,{store:'personal',identity:randomUUID(),scope_hash:erasure.scopeHash(['personal',null,null,null]),action:'operator_erasure',erased_at:1});assert.throws(()=>identity.assertReadable(copy),/Stale identity\/erasure generation/);
});
test('full validation reads narrow event correlations without fetching ledger payload history',t=>{
  const f=fixture(t),{EventLedger}=require('../src/event-ledger'),ledger=new EventLedger(f.db);for(let i=0;i<30;i++)ledger.record({eventType:'fixture.history',payload:'Synthetic private fixture '.repeat(1000),requestId:randomUUID()});const o=observe(f.db);identity.assertReadable(f.db);assert.equal(o.queries.some(sql=>/SELECT \* FROM "event_ledger_events"/.test(sql)),false);assert.ok(o.queries.some(sql=>/SELECT "idempotency_key","request_id","event_type" FROM "event_ledger_events"/.test(sql)||/SELECT "request_id","idempotency_key","event_type" FROM "event_ledger_events"/.test(sql)));o.restore();
});
test('a foreign mutation during full validation cannot install or return a mixed-snapshot success',t=>{
  const f=fixture(t,{file:true}),other=f.open(),original=f.db.prepare.bind(f.db);let injected=false;f.db.prepare=(sql,...args)=>{if(!injected&&/^SELECT "id" value FROM "cp_context_packs"/.test(sql)){injected=true;other.prepare('UPDATE memory_identity_progress SET state=?').run('pending');}return original(sql,...args);};assert.throws(()=>identity.assertReadable(f.db),DENIED);f.db.prepare=original;assert.throws(()=>identity.assertReadable(f.db),DENIED);
});
test('unknown generated content column invalidates cached identity and erasure qualification',t=>{
  const f=fixture(t);identity.assertReadable(f.db);f.db.exec("ALTER TABLE cp_context_packs ADD COLUMN unknown_personal TEXT GENERATED ALWAYS AS ('Synthetic generated private copy') VIRTUAL");assert.throws(()=>identity.assertReadable(f.db),DENIED);const marker=erasure.mark(f.db,{store:'governed',identity:f.id,scope_hash:erasure.scopeHash(['fixture-scope']),action:'operator_erasure',erased_at:1});assert.throws(()=>content.propagate(f.db,marker),/incomplete/);assert.equal(content.qualification(f.db).pending_generations,1);
});
test('a foreign write during a warm-cache stamp cannot return earlier validity',t=>{
  const f=fixture(t,{file:true}),other=f.open();identity.assertReadable(f.db);const original=f.db.prepare.bind(f.db);let injected=false;f.db.prepare=(sql,...args)=>{if(!injected&&/SELECT name,sql FROM sqlite_master/.test(sql)){injected=true;other.prepare('UPDATE cp_context_packs SET refs=?').run(JSON.stringify([{memory_id:BAD}]));}return original(sql,...args);};assert.throws(()=>identity.assertReadable(f.db),DENIED);f.db.prepare=original;assert.throws(()=>identity.assertReadable(f.db),DENIED);
});
