'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {RestrictedMemoryVault}=require('../src/restricted-memory-vault');
const {controlPlaneWrite}=require('../src/control-plane-api');
const DUMMY='Harmless fictional appointment preference: a quiet room.';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restricted-memory-test-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,v:new RestrictedMemoryVault(dir),id:randomUUID()};}
test('authenticated operator path stores encrypted content with private files and no plaintext snapshots',t=>{
 const {dir,v,id}=fixture(t),receipt=controlPlaneWrite({dataDir:dir},'restricted-memory-save',{id,content:DUMMY});
 assert.equal(receipt.encrypted,true);assert.equal(receipt.model_access,false);assert.equal(receipt.authority,false);
 assert.equal(v.read({id}).content,DUMMY);const snapshot=v.snapshot({id});assert.equal(snapshot.encrypted,true);
 for(const name of fs.readdirSync(path.join(v.root,'snapshots'))){const p=path.join(v.root,'snapshots',name);assert.equal(fs.readFileSync(p).includes(Buffer.from(DUMMY)),false);assert.equal(fs.statSync(p).mode&0o077,0);}
 assert.equal(fs.statSync(v.file('keys',id)).mode&0o077,0);
});
test('forget removes only the record key, invalidates all snapshots and survives reopening',t=>{
 const {dir,v,id}=fixture(t),other=randomUUID();v.save({id,content:DUMMY});v.save({id:other,content:'Another dummy record'});v.snapshot({id});const receipt=v.forget({id});
 assert.equal(receipt.key_removed,true);assert.equal(receipt.physical_erasure_verified,false);assert.equal(fs.existsSync(v.file('keys',id)),false);
 const reopened=new RestrictedMemoryVault(dir);assert.throws(()=>reopened.read({id}),/unavailable/);assert.throws(()=>reopened.snapshot({id}),/unavailable/);assert.throws(()=>reopened.save({id,content:DUMMY}),/forgotten/);assert.equal(reopened.read({id:other}).content,'Another dummy record');assert.equal(reopened.forget({id}).key_removed,true);
});
test('ciphertext backup without its deleted key cannot be decrypted',t=>{
 const {v,id}=fixture(t),other=fixture(t);v.save({id,content:DUMMY});other.v.prepare();fs.copyFileSync(v.file('snapshots',id+'.json'),other.v.file('snapshots',id+'.json'));fs.chmodSync(other.v.file('snapshots',id+'.json'),0o600);v.forget({id});assert.throws(()=>other.v.read({id}),/unavailable/);
});
test('tampering and relaxed permissions fail closed',t=>{
 const {v,id}=fixture(t);v.save({id,content:DUMMY});const file=v.file('snapshots',id+'.json'),e=JSON.parse(fs.readFileSync(file));e.ciphertext=Buffer.from('tampered').toString('base64');fs.writeFileSync(file,JSON.stringify(e));assert.throws(()=>v.read({id}),/unavailable/);
 fs.chmodSync(v.file('keys',id),0o644);assert.throws(()=>v.read({id}),/unavailable/);
});
test('symlink and hardlink keys cannot be read',t=>{
 const {v,id}=fixture(t);v.save({id,content:DUMMY});const key=v.file('keys',id),copy=key+'.copy';fs.renameSync(key,copy);fs.symlinkSync(copy,key);assert.throws(()=>v.read({id}),/unavailable/);fs.unlinkSync(key);fs.linkSync(copy,key);assert.throws(()=>v.read({id}),/unavailable/);
});
test('key deletion failure leaves a tombstone and can be retried without allowing reads',t=>{
 const {v,id}=fixture(t);v.save({id,content:DUMMY});const rm=fs.rmSync;try{fs.rmSync=(file,opts)=>{if(file===v.file('keys',id))throw Error('Dummy failure');return rm(file,opts);};assert.throws(()=>v.forget({id}),/incomplete/);assert.throws(()=>v.read({id}),/unavailable/);}finally{fs.rmSync=rm;}assert.equal(v.forget({id}).key_removed,true);
});
test('credentials, path traversal and unknown operator fields are rejected',t=>{
 const {dir,v,id}=fixture(t);assert.throws(()=>v.save({id,content:'password=dummy-not-a-real-secret'}),/rejected/);assert.throws(()=>v.read({id:'../outside'}),/Invalid/);assert.throws(()=>controlPlaneWrite({dataDir:dir},'restricted-memory-save',{id,content:DUMMY,provider:'anthropic_subscription'}));assert.equal(fs.existsSync(v.root),false);
});
test('live loopback controls deny MCP credentials and expose content only to the operator',async t=>{
 const {dir,v,id}=fixture(t),ControlServer=require('../src/control-server');
 const server=new ControlServer({dataDir:dir,conversationEngine:{close:async()=>{}}},{port:0,token:'operator-dummy',mcpToken:'mcp-dummy'});await server.start();t.after(()=>server.close());
 const post=(op,body,token)=>fetch(server.origin+'/api/control-v2/restricted-memory-'+op,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('save',{id,content:DUMMY},'mcp-dummy')).status,401);assert.equal(fs.existsSync(v.root),false);
 const save=await post('save',{id,content:DUMMY},'operator-dummy');assert.equal(save.status,200);assert.equal(JSON.stringify(await save.json()).includes(DUMMY),false);
 assert.equal((await post('read',{id},'mcp-dummy')).status,401);assert.equal((await(await post('read',{id},'operator-dummy')).json()).content,DUMMY);
 assert.equal((await post('forget',{id},'operator-dummy')).status,200);assert.equal((await post('read',{id},'operator-dummy')).status,400);
});
