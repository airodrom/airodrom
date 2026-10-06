'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const BRANDING=require('../../src/branding');
const {atomicJSON}=require('../../src/config');
const project=path.resolve(__dirname,'../..');
const home=os.homedir();
const build=path.join(project,'work/macos');
const support=path.join(home,'Library/Application Support/Pi Bridge');
const agents=path.join(home,'Library/LaunchAgents');
const labels=['local.pi-chatgpt-bridge','local.pi-chatgpt-bridge.menubar'];
function xml(v) {
  const escape=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
  if(typeof v==='boolean') return v?'<true/>':'<false/>';
  if(typeof v==='number') return `<integer>${v}</integer>`;
  if(typeof v==='string') return `<string>${escape(v)}</string>`;
  if(Array.isArray(v)) return `<array>${v.map(xml).join('')}</array>`;
  return `<dict>${Object.entries(v).map(([k,x])=>`<key>${escape(k)}</key>${xml(x)}`).join('')}</dict>`;
}
function plist(file,value) { fs.writeFileSync(file,`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(value)}</plist>\n`,{mode:0o600}); }
function run(exe,args) {
  const r=spawnSync(exe,args,{stdio:'inherit'}); if(r.status!==0) throw new Error('Build or macOS service command failed.');
}
function prepare() {
  if(process.platform!=='darwin') throw new Error('macOS is required.');
  const configuredNode=process.env.AIRODROM_NODE||process.env.PI_BRIDGE_NODE;
  const candidates=configuredNode?[configuredNode]:['/opt/homebrew/opt/node@22/bin/node','/usr/local/opt/node@22/bin/node',process.execPath];
  const node=candidates.find(p=>path.isAbsolute(p)&&spawnSync(p,['--experimental-sqlite','-e',"new(require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE f USING fts5(content)')"],{stdio:'ignore'}).status===0);
  if(!node) throw new Error('Select an absolute Node executable with SQLite FTS5.');
  const existingFile=path.join(project,'.runtime/macos.json');
  const existing=fs.existsSync(existingFile)?JSON.parse(fs.readFileSync(existingFile,'utf8')):{};
  const dataDir=path.resolve(process.env.PI_BRIDGE_DATA_DIR || existing.dataDir || path.join(project,'.runtime'));
  const profile=path.resolve(process.env.PI_BRIDGE_SOURCE_PROFILE || process.env.PI_CODING_AGENT_DIR || existing.profile || path.join(home,'.pi/profiles/local-dev'));
  const port=Number(process.env.PI_BRIDGE_PORT || existing.port || 43117);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid local port.');
  if(!fs.existsSync(path.join(profile,'settings.json'))) throw new Error('Existing Pi source profile is required.');
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  const dataStat=fs.lstatSync(dataDir);
  if(!dataStat.isDirectory() || dataStat.isSymbolicLink() || dataStat.uid!==process.getuid() || (dataStat.mode&0o077) || Buffer.byteLength(path.join(dataDir,'policy.sock'))>100) throw new Error('Runtime directory must be private, owned, real, and short enough for its socket.');
  fs.mkdirSync(build,{recursive:true,mode:0o700});
  const app=path.join(build,'Pi Bridge.app'); const contents=path.join(app,'Contents');
  fs.mkdirSync(path.join(contents,'MacOS'),{recursive:true,mode:0o700});
  const helper=path.join(support,'Pi Bridge.app/Contents/MacOS/PiBridgeMenu');
  const config={project,node,dataDir,profile,port,agent:path.join(agents,labels[0]+'.plist'),helper};
  plist(path.join(contents,'Info.plist'),{CFBundleIdentifier:'local.pi-chatgpt-bridge.menubar',CFBundleName:BRANDING.name,CFBundleDisplayName:BRANDING.name,CFBundleExecutable:'PiBridgeMenu',CFBundlePackageType:'APPL',CFBundleVersion:'1',CFBundleShortVersionString:'1.0',LSUIElement:true,NSHighResolutionCapable:true,PiBridgeNode:node,PiBridgeControl:path.join(project,'scripts/macos/control.cjs'),PiBridgeDataDir:dataDir});
  run('/usr/bin/xcrun',['swiftc','-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos13.0`,'-module-cache-path',path.join(build,'swift-cache'),path.join(project,'macos/PiBridgeMenu.swift'),'-o',path.join(contents,'MacOS/PiBridgeMenu')]);
  run('/usr/bin/codesign',['--force','--sign','-',app]);
  const env={HOME:home,PATH:[path.dirname(node),path.join(home,'.local/npm/bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),PI_BRIDGE_DATA_DIR:dataDir,PI_BRIDGE_SOURCE_PROFILE:profile,PI_BRIDGE_PORT:String(port),PI_BRIDGE_BACKGROUND:'1',PI_BRIDGE_LOG_FILE:path.join(dataDir,'background-service.log')};
  for(const key of ['PI_BRIDGE_WEB','PI_BRIDGE_WEB_HOSTS']) {
    if(process.env[key]!==undefined) env[key]=process.env[key]; else if(existing.environment?.[key]!==undefined) env[key]=existing.environment[key];
  }
  const trustedDeveloperMode=process.env.PI_TRUSTED_DEV_MODE ?? existing.environment?.PI_TRUSTED_DEV_MODE;
  if(trustedDeveloperMode!==undefined) {
    if(trustedDeveloperMode!=='1') throw new Error('PI_TRUSTED_DEV_MODE must be exactly 1 when enabled.');
    env.PI_TRUSTED_DEV_MODE='1';
  }
  config.environment=env;
  const common={RunAtLoad:true,WorkingDirectory:project,ProcessType:'Background',Umask:63,StandardOutPath:'/dev/null',StandardErrorPath:'/dev/null',ExitTimeOut:20};
  plist(path.join(build,labels[0]+'.plist'),{...common,Label:labels[0],ProgramArguments:[node,'--experimental-sqlite',path.join(project,'src/index.js')],EnvironmentVariables:env,KeepAlive:{SuccessfulExit:false},ThrottleInterval:15});
  plist(path.join(build,labels[1]+'.plist'),{...common,Label:labels[1],ProgramArguments:[helper],ProcessType:'Interactive',EnvironmentVariables:{HOME:home,PATH:env.PATH},KeepAlive:false});
  atomicJSON(path.join(build,'macos.json'),config);
  for(const label of labels) run('/usr/bin/plutil',['-lint',path.join(build,label+'.plist')]);
  console.log('Prepared signed native helper and validated login agents. No service or login setting was changed.');
}
function install() {
  const c=JSON.parse(fs.readFileSync(path.join(build,'macos.json'),'utf8'));
  for(const label of labels) {
    const r=spawnSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{stdio:'ignore'});
    if(r.status===0) throw new Error('Stop the bridge and quit/unload the helper before reinstalling. Existing jobs were preserved.');
  }
  fs.mkdirSync(support,{recursive:true,mode:0o700}); fs.mkdirSync(agents,{recursive:true,mode:0o700});
  fs.cpSync(path.join(build,'Pi Bridge.app'),path.join(support,'Pi Bridge.app'),{recursive:true});
  for(const label of labels) { const dest=path.join(agents,label+'.plist'); fs.copyFileSync(path.join(build,label+'.plist'),dest); fs.chmodSync(dest,0o600); }
  atomicJSON(path.join(project,'.runtime/macos.json'),c);
  run('/bin/launchctl',['enable',`gui/${process.getuid()}/${labels[0]}`]);
  run('/bin/launchctl',['enable',`gui/${process.getuid()}/${labels[1]}`]);
  const started=[];
  try {
    for(const label of labels) { run('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,path.join(agents,label+'.plist')]); started.push(label); }
  } catch(error) {
    for(const label of started.reverse()) spawnSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{stdio:'ignore'});
    throw error;
  }
  console.log(`Installed ${BRANDING.name} and menu-bar helper for this user. Both start after login.`);
}
if(require.main===module) {
  try { if(process.argv[2]==='--prepare') prepare(); else if(process.argv[2]==='--install-prepared') install(); else {prepare();install();} }
  catch {console.error('macOS setup did not complete. Check paths, permissions, and whether the service is already installed. Prepared files remain under work/macos.');process.exitCode=1;}
}
module.exports={xml,plist};
