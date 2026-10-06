'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'.runtime/slack-keychain'),dest=path.join(dir,'airodrom-slack-keychain');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw Error('Unsafe helper directory');
// Never replace a trusted binary implicitly. Rebuild requires deliberate removal
// after reviewing source and repeating trust approval.
if(fs.existsSync(dest))throw Error('Existing helper preserved; rebuild requires explicit operator action');
const tmp=path.join(dir,`build-${process.pid}`);
function run(cmd,args){if(spawnSync(cmd,args,{stdio:'ignore'}).status!==0)throw Error('Helper build failed');}
try{run('/usr/bin/xcrun',['clang','-Werror','-Wno-deprecated-declarations','-O2','-isysroot','/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',path.join(__dirname,'slack-keychain-helper.c'),'-framework','Security','-framework','CoreFoundation','-o',tmp]);fs.chmodSync(tmp,0o700);run('/usr/bin/codesign',['--sign','-','--identifier','local.pi-chatgpt-bridge.slack-keychain',tmp]);fs.renameSync(tmp,dest);console.log('Dedicated helper built (local ad-hoc signature; no developer identity).');}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
