'use strict';
// Secret values cross only the host Keychain port, via stdin/stdout private pipes.
const {randomUUID}=require('node:crypto'),path=require('node:path'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class SecretVault {
 #home; #port; #source=null;
 constructor(home,port=null,{restoreFromBackup=false,erasureSourceVault=null}={}){require('./local-bootstrap').privateDirectory(home);this.#home=fs.realpathSync(home);this.#port=port;if(restoreFromBackup){if(!(erasureSourceVault instanceof SecretVault)||erasureSourceVault.#home===this.#home||erasureSourceVault.#source)throw Error('Secret restore requires current independent dispositions');this.#source=erasureSourceVault;const destination=this.#state(),current=erasureSourceVault.#state();for(const [id,ref]of Object.entries(destination.refs))if(current.refs[id]?.state!=='active'||current.refs[id]?.purpose!==ref.purpose)ref.state='revoked';for(const [id,ref]of Object.entries(current.refs))if(ref.state==='revoked')destination.refs[id]={...ref};this.#save(destination);}}
 #state(){const file=path.join(this.#home,'vault-dispositions.json');const state=require('./private-json').privateFileExists(file)?require('./private-json').readPrivateJSON(file,256000):{version:1,refs:{}};if(state.version!==1||!state.refs||typeof state.refs!=='object'||Array.isArray(state.refs)||Object.entries(state.refs).some(([id,r])=>!ID.test(id)||!r||!['pending','active','revoked'].includes(r.state)||!['operator','gmail','whatsapp'].includes(r.purpose)))throw Error('Invalid vault dispositions');return state;}
 #locked(operation){const file=path.join(this.#home,'vault.lock');let fd;try{fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}catch{throw Error('Vault is busy; inspect the previous operation before retrying.');}try{return operation();}finally{fs.closeSync(fd);fs.unlinkSync(file);}}
 #save(state){require('./local-bootstrap').writePrivate(path.join(this.#home,'vault-dispositions.json'),state);const file=path.join(this.#home,'vault-dispositions.json'),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const dir=fs.openSync(this.#home,fs.constants.O_RDONLY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
 #call(op,id,value=''){
  if(this.#port)return this.#port(op,id,value);
  if(process.platform!=='darwin')throw Error('macOS Keychain is unavailable.');
  const helper=path.join(this.#home,'bin/airodrom-vault');const st=fs.lstatSync(helper);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o022))throw Error('Private Keychain helper unavailable.');
  const r=spawnSync(helper,[op,id],{input:value,encoding:'utf8',timeout:10000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin'}});if(r.status!==0)throw Error('Keychain operation unavailable; no credential diagnostics exported.');return r.stdout;
 }
 status(){const state=this.#state();return {backend:this.#port?'synthetic':'macOS Keychain',configured:!!this.#port||fs.existsSync(path.join(this.#home,'bin/airodrom-vault')),active_refs:Object.values(state.refs).filter(r=>r.state==='active').length,values_displayed:false,worker_access:false};}
 put(value,purpose='operator'){
  if(this.#source)throw Error('Restored vault views are read-only');
  if(!['operator','gmail','whatsapp'].includes(purpose)||typeof value!=='string'||!value||Buffer.byteLength(value)>8192||value.includes('\0'))throw Error('Invalid secure input');
  return this.#locked(()=>{const state=this.#state(),id=randomUUID();state.refs[id]={state:'pending',purpose};this.#save(state);
  this.#call('put',id,value);state.refs[id].state='active';this.#save(state);return {reference:id,stored:true,value_displayed:false};});
 }
 replace(id,value,purpose){
  if(this.#source)throw Error('Restored vault views are read-only');
  if(!ID.test(id)||!['operator','gmail','whatsapp'].includes(purpose)||typeof value!=='string'||!value||Buffer.byteLength(value)>8192||value.includes('\0'))throw Error('Invalid secure replacement');
  return this.#locked(()=>{const state=this.#state();if(state.refs[id]?.state!=='active'||state.refs[id].purpose!==purpose)throw Error('Secret reference is invalid or revoked');
   this.#call('read',id); // Independently persisted Keychain revocation also wins.
   const next=randomUUID();state.refs[id].state='revoked';state.refs[next]={state:'pending',purpose};this.#save(state);this.#call('revoke',id);
   this.#call('put',next,value);state.refs[next].state='active';this.#save(state);
   try{this.#call('delete',id);}catch{} // A durable revocation marker already prevents use.
   return {reference:next,stored:true,value_displayed:false};
  });
 }
 resolve(id,purpose){if(!ID.test(id))throw Error('Opaque secret reference required');const state=this.#state();if(this.#source&&(this.#source.#state().refs[id]?.state!=='active'||this.#source.#state().refs[id]?.purpose!==purpose))throw Error('Current secret disposition unavailable');if(state.refs[id]?.state!=='active'||state.refs[id].purpose!==purpose)throw Error('Secret reference is invalid or revoked');const value=this.#call('read',id);if(this.#state().refs[id]?.state!=='active'||this.#source&&(this.#source.#state().refs[id]?.state!=='active'||this.#source.#state().refs[id]?.purpose!==purpose))throw Error('Secret reference revoked');return value;}
 forget(id){if(this.#source)throw Error('Restored vault views are read-only');if(!ID.test(id))throw Error('Opaque secret reference required');return this.#locked(()=>{const state=this.#state();if(!state.refs[id])throw Error('Unknown secret reference');state.refs[id].state='revoked';this.#save(state);this.#call('revoke',id);this.#call('delete',id);return {reference:id,revoked:true};});}
}
module.exports={SecretVault};
