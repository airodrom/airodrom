'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
async function hidden(input,output,{prompt='Secret (hidden; Enter saves, Ctrl+C cancels): ',maximum=8192,signal}={}){
 if(!input.isTTY||typeof input.setRawMode!=='function')throw Error('Secret entry requires an interactive operator terminal.');
 // A paused readline still receives raw bytes. The caller must close and detach
 // ordinary input before secure capture; another reader makes capture unsafe.
 if(input.listenerCount('data')||input.listenerCount('readable'))throw Error('Close ordinary terminal input before secure entry.');
 if(!Number.isInteger(maximum)||maximum<1||maximum>8192)throw Error('Invalid secure entry bound');
 if(signal?.aborted)throw Error('Secure entry cancelled');
 // Every prompt requires fresh input. Separate queued chunks from an earlier
 // menu must not become a later confirmation or credential value.
 input.pause();
 if(typeof input.read==='function')while(input.read()!==null){}
 const previousRaw=!!input.isRaw;
 return new Promise((resolve,reject)=>{
  let value='',finished=false;const decoder=new(require('node:string_decoder').StringDecoder)('utf8');
  const done=(error)=>{
   if(finished)return;finished=true;
   input.removeListener('data',read);input.removeListener('end',ended);input.removeListener('close',ended);input.removeListener('error',failed);signal?.removeEventListener('abort',cancel);
   try{input.pause();input.setRawMode(previousRaw);output.write('\n');}catch{error=Error('Secure terminal cleanup unavailable');}
   const result=value;value='';if(error)reject(error);else resolve(result);
  };
  const cancel=()=>done(Error('Secure entry cancelled'));
  const ended=()=>done(Error('Secure entry cancelled'));
  const failed=()=>done(Error('Secure terminal input unavailable'));
  const read=chunk=>{
   for(const c of decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))){
    if(c==='\x03'){cancel();return;}
    // Discard the remainder of a pasted chunk: it must never enter a later
    // secure prompt or a reconstructed ordinary conversation reader.
    if(c==='\r'||c==='\n'){done();return;}
    if(c==='\x7f'||c==='\b')value=Array.from(value).slice(0,-1).join('');
    else if(/[\u0000-\u001f\u007f-\u009f]/u.test(c)){done(Error('Secure entry contains unsupported control input'));return;}
    else value+=c;
    if(Buffer.byteLength(value)>maximum){done(Error('Secure entry bound exceeded'));return;}
   }
  };
  input.on('data',read);input.on('end',ended);input.on('close',ended);input.on('error',failed);signal?.addEventListener('abort',cancel,{once:true});
  try{input.setRawMode(true);output.write(prompt);input.resume();}catch{failed();}
 });
}
async function run(home,args,input,output){
 const local=require('./local-bootstrap');local.privateDirectory(home,true);home=local.privateDirectory(path.join(home,'data'),true);
 const vault=new (require('./secret-vault').SecretVault)(home);
 if(args[0]==='prepare'){
  if(process.platform!=='darwin')throw Error('macOS Keychain required');
  const dir=local.privateDirectory(path.join(home,'bin'),true),helper=path.join(dir,'airodrom-vault');
  if(fs.existsSync(helper))throw Error('Private helper already exists; remove only through a separately reviewed reinstall.');
  const r=spawnSync('/usr/bin/xcrun',['clang','-isysroot','/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk','-Wno-deprecated-declarations',path.join(__dirname,'../scripts/macos/vault-keychain-helper.c'),'-framework','Security','-framework','CoreFoundation','-o',helper],{stdio:'ignore',timeout:30000});if(r.status!==0)throw Error('Keychain helper compilation unavailable');fs.chmodSync(helper,0o700);output.write('Private Keychain helper prepared.\n');return;
 }
 if(args[0]==='put'){if(args.length>2)throw Error('Secret values must use hidden input, never command arguments');if(args[1]&&!['operator','gmail','whatsapp'].includes(args[1]))throw Error('Use secret put [operator|gmail|whatsapp]');let value=await hidden(input,output);try{output.write('Secret stored. Reference: '+vault.put(value,args[1]||'operator').reference+'\n');}finally{value='';}return;}
 if(args[0]==='forget'){if(args.length!==2)throw Error('Use secret forget <reference>; confirm in the operator terminal.');const confirmed=await hidden(input,output,{prompt:'Revoke this reference permanently? Type yes (hidden): ',maximum:3});if(confirmed!=='yes'){output.write('Revocation cancelled.\n');return;}output.write('Secret revoked. Reference: '+vault.forget(args[1]).reference+'\n');return;}
 if(args.some((v,i)=>!(i===0&&v==='status'||v==='--json')))throw Error('Use secret prepare|put [operator|gmail|whatsapp]|forget <ref>|status');
 output.write(args.includes('--json')?JSON.stringify(vault.status())+'\n':require('./assistant-render').vault(vault.status()));
}
module.exports={hidden,run};
