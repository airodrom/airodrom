'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process'),local=require('../../src/local-bootstrap');
function validateTree(directory){const stat=fs.lstatSync(directory);if(stat.uid!==process.getuid()||stat.isSymbolicLink()||stat.mode&0o077||!stat.isDirectory()&&!stat.isFile()||stat.isFile()&&stat.nlink!==1)throw Error('Existing native menu has unsafe ownership or links.');if(stat.isDirectory())for(const entry of fs.readdirSync(directory))validateTree(path.join(directory,entry));}
function prepare(home=local.localHome()){
 const version=process.versions.node.split('.').map(Number);if(version[0]!==22||version[1]<23||version[1]===23&&version[2]<3)throw Error('Native menu preparation requires supported Node 22.23.3 or later in the 22.x line.');
 local.privateDirectory(home,true);local.privateDirectory(path.join(home,'data'),true);
 const directory=local.privateDirectory(path.join(home,'menu'),true),app=path.join(directory,'Airodrom.app');
 if(fs.existsSync(app)||(()=>{try{fs.lstatSync(app);return true;}catch{return false;}})())validateTree(app);
 const staging=path.join(directory,'.staging-'+randomUUID()+'.app'),contents=path.join(staging,'Contents');
 try{
 fs.mkdirSync(path.join(contents,'MacOS'),{recursive:true,mode:0o700});
 const node=local.pin('node',process.execPath).path;
 require('./install.cjs').plist(path.join(contents,'Info.plist'),{CFBundleIdentifier:'io.airodrom.local.menu',CFBundleName:'Airodrom',CFBundleDisplayName:'Airodrom',CFBundleExecutable:'AirodromMenu',CFBundlePackageType:'APPL',CFBundleVersion:'2',CFBundleShortVersionString:require('../../package.json').version,LSUIElement:true,NSHighResolutionCapable:true,AirodromNode:node,AirodromControl:path.join(local.ROOT,'scripts/macos/product-control.cjs'),AirodromDataDir:path.join(home,'data'),AirodromHome:home});
 const compiled=spawnSync('/usr/bin/xcrun',['swiftc','-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos13.0`,'-module-cache-path',path.join(directory,'swift-cache'),path.join(local.ROOT,'macos/AirodromMenu.swift'),'-o',path.join(contents,'MacOS/AirodromMenu')],{stdio:'ignore',timeout:60000});
 if(compiled.status!==0)throw Error('Native menu compilation failed. Existing service remains unchanged.');
 const signed=spawnSync('/usr/bin/codesign',['--force','--sign','-',staging],{stdio:'ignore',timeout:10000});if(signed.status!==0)throw Error('Native menu signing failed.');
 // Generated bundle files are private too. Signing can create mode-644 files.
 const secure=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);fs.chmodSync(file,e.isDirectory()?0o700:fs.statSync(file).mode&0o111?0o700:0o600);if(e.isDirectory())secure(file);}};secure(staging);
 if(fs.existsSync(app)){validateTree(app);fs.renameSync(app,path.join(directory,'.previous-'+randomUUID()+'.app'));}
 fs.renameSync(staging,app);return app;
 }finally{fs.rmSync(staging,{recursive:true,force:true});}
}
if(require.main===module)try{prepare();console.log('Native Airodrom menu prepared. No service or login settings changed.');}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={prepare,validateTree};
