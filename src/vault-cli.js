'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
async function hidden(input,output){
 if(!input.isTTY||!input.setRawMode)throw Error('Secret entry requires an interactive operator terminal.');
 output.write('Secret (hidden; Enter saves, Ctrl+C cancels): ');input.setRawMode(true);input.resume();
 return new Promise((resolve,reject)=>{let value='';const done=(error)=>{input.removeListener('data',read);input.setRawMode(false);input.pause();output.write('\n');if(error)reject(error);else resolve(value);};const read=chunk=>{for(const c of String(chunk)){if(c==='\x03'){value='';done(Error('Secure entry cancelled'));return;}if(c==='\r'||c==='\n'){done();return;}if(c==='\x7f')value=value.slice(0,-1);else if(c>=' ')value+=c;if(Buffer.byteLength(value)>8192){value='';done(Error('Secure entry bound exceeded'));return;}}};input.on('data',read);});
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
 if(args[0]==='put'){if(args.length>2)throw Error('Secret values must use hidden input, never command arguments');const value=await hidden(input,output);output.write('Secret stored. Reference: '+vault.put(value,args[1]||'operator').reference+'\n');return;}
 if(args[0]==='forget'){output.write('Secret revoked. Reference: '+vault.forget(args[1]).reference+'\n');return;}
 if(args.some((v,i)=>!(i===0&&v==='status'||v==='--json')))throw Error('Use secret prepare|put [operator|gmail|whatsapp]|forget <ref>|status');
 output.write(args.includes('--json')?JSON.stringify(vault.status())+'\n':require('./assistant-render').vault(vault.status()));
}
module.exports={hidden,run};
