'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {containsSecret}=require('./personal-memory');
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Operator-only storage. No provider, worker, ContextPack or SQLite value copies.
class RestrictedMemoryVault {
 constructor(dataDir,{restoreFromBackup=false,erasureSourceVault=null}={}){
  if(typeof restoreFromBackup!=='boolean')throw Error('Invalid vault restore policy');
  this.base=path.resolve(dataDir);this.root=path.join(this.base,'restricted-memory');
  if(restoreFromBackup)this.reconcileErasureFrom(erasureSourceVault);
 }
 reconcileErasureFrom(source){
  if(!(source instanceof RestrictedMemoryVault)||source.root===this.root)throw Error('Vault restore requires current independent erasure source');
  source.directory(source.base);source.directory(source.root);source.directory(source.file('forgotten',''));
  if(fs.realpathSync(source.root)===fs.realpathSync(this.root))throw Error('Independent vault source required');
  const ids=fs.readdirSync(source.file('forgotten',''));for(const id of ids){source.id(id);if(source.readFile(source.file('forgotten',id),32).toString()!=='forgotten\n')throw Error('Invalid vault erasure source');}
  this.prepare();for(const id of ids)this.forget({id});
  return{reconciled:ids.length,logicalSuppression:true,physicalErasure:false,authority:false};
 }
 directory(dir,create=false){
  if(create&&!fs.existsSync(dir))fs.mkdirSync(dir,{mode:0o700});
  const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Restricted storage permissions denied');
 }
 prepare(){this.directory(this.base);this.directory(this.root,true);for(const name of ['keys','snapshots','forgotten'])this.directory(path.join(this.root,name),true);}
 id(id){if(typeof id!=='string'||!ID.test(id))throw Error('Invalid restricted memory reference');return id;}
 file(dir,name){return path.join(this.root,dir,name);}
 readFile(file,max){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size>max)throw Error('Restricted file denied');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}}
 write(file,bytes){const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 syncDirectory(dir){const fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 denied(id){return fs.existsSync(this.file('forgotten',id));}
 save({id,content}){
  this.id(id);if(typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>12000||containsSecret(content))throw Error('Restricted memory content rejected');
  this.prepare();if(this.denied(id))throw Error('Restricted memory was forgotten');
  const keyFile=this.file('keys',id),snapshot=this.file('snapshots',id+'.json');
  if(fs.existsSync(keyFile)||fs.existsSync(snapshot))throw Error('Restricted memory reference already exists');
  const key=crypto.randomBytes(32),iv=crypto.randomBytes(12);let keyWritten=false;
  try{const c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('restricted-memory-v1:'+id));const ciphertext=Buffer.concat([c.update(content,'utf8'),c.final()]);
   this.write(keyFile,key);keyWritten=true;this.syncDirectory(this.file('keys',''));this.write(snapshot,JSON.stringify({version:1,id,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));this.syncDirectory(this.file('snapshots',''));
   // Verify both private-file permissions and authenticated round-trip before success.
   if(this.read({id}).content!==content)throw Error('Restricted storage verification failed');
   return {id,status:'stored',privacy:'restricted_security',encrypted:true,model_access:false,authority:false};
  }catch{if(keyWritten)fs.rmSync(keyFile,{force:true});fs.rmSync(snapshot,{force:true});throw Error('Restricted storage write failed');}finally{key.fill(0);}
 }
 read({id}){
  this.id(id);try{this.prepare();if(this.denied(id))throw Error('Forgotten');const key=this.readFile(this.file('keys',id),32);try{if(key.length!==32)throw Error('Invalid key');const e=JSON.parse(this.readFile(this.file('snapshots',id+'.json'),20000));if(e.version!==1||e.id!==id)throw Error('Invalid envelope');const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));d.setAAD(Buffer.from('restricted-memory-v1:'+id));d.setAuthTag(Buffer.from(e.tag,'base64'));const content=Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64')),d.final()]).toString('utf8');return {id,content,privacy:'restricted_security',model_access:false,authority:false};}finally{key.fill(0);}}catch{throw Error('Restricted memory unavailable');}
 }
 snapshot({id}){
  this.id(id);this.read({id});const version=crypto.randomUUID();this.write(this.file('snapshots',id+'.'+version+'.json'),this.readFile(this.file('snapshots',id+'.json'),20000));this.syncDirectory(this.file('snapshots',''));return {id,version,encrypted:true,model_access:false,authority:false};
 }
 forget({id}){
  this.id(id);this.prepare();if(!this.denied(id))this.write(this.file('forgotten',id),'forgotten\n');this.syncDirectory(this.file('forgotten',''));
  // Tombstone blocks reads even if key removal fails. Retry can finish key removal.
  try{fs.rmSync(this.file('keys',id),{force:true});this.syncDirectory(this.file('keys',''));}catch{throw Error('Restricted key deletion incomplete');}
  const destroyed=!fs.existsSync(this.file('keys',id));if(!destroyed)throw Error('Restricted key deletion incomplete');
  // Ciphertext-only history can be retained: its record key is no longer available.
  return {id,status:'forgotten',key_removed:true,snapshots_accessible:false,physical_erasure_verified:false,external_copies_revoked:false,authority:false};
 }
}
module.exports={RestrictedMemoryVault};
