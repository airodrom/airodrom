'use strict';
// This service owns only the outbound ChatGPT MCP tunnel, never the bridge.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const LABEL='local.pi-chatgpt-bridge.mcp-tunnel';
const ASSETS=['tunnel-client','LICENSE','NOTICE','tunnel-client-v0.0.15-darwin-arm64-licenses.txt','tunnel-client-v0.0.15-darwin-arm64.spdx.json'];
const PROFILE='pi-chatgpt-bridge-managed.yaml';
const project=path.resolve(__dirname,'../..');

function assertMetadata(file,{directory=false,privateMode=false,executable=false,uid=process.getuid()}={}) {
  const st=fs.lstatSync(file);
  if(st.isSymbolicLink() || (directory?!st.isDirectory():!st.isFile()) || st.uid!==uid || (st.mode & (privateMode?0o077:0o022)) || (executable && !(st.mode&0o100))) {
    throw new Error('A required path has unsafe ownership, permissions, or type.');
  }
  return st;
}
function assertNoLinks(file) {
  let current=path.resolve(file);
  for(;;) {
    try {if(fs.lstatSync(current).isSymbolicLink())throw new Error('A required path contains a symbolic link.');}
    catch(error) {if(error.code!=='ENOENT')throw error;}
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
}
function safeRead(file,options={}) {
  assertNoLinks(file);
  assertMetadata(file,options);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const st=fs.fstatSync(fd);
    if(!st.isFile()||st.uid!==(options.uid??process.getuid())||(st.mode&(options.privateMode?0o077:0o022))) throw new Error('A required file changed ownership or permissions.');
    return fs.readFileSync(fd);
  } finally {fs.closeSync(fd);}
}
function privateDirectory(dir,{privateMode=true}={}) {
  assertNoLinks(dir);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  assertMetadata(dir,{directory:true,privateMode});
}
function atomicWrite(file,data,mode=0o600) {
  assertNoLinks(file);
  if(fs.existsSync(file)) assertMetadata(file,{privateMode:true});
  const tmp=file+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  try {fs.writeFileSync(tmp,data,{mode,flag:'wx'});fs.renameSync(tmp,file);}
  finally {try {fs.unlinkSync(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function xml(value) {
  const escape=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
  if(typeof value==='boolean')return value?'<true/>':'<false/>';
  if(typeof value==='number')return `<integer>${value}</integer>`;
  if(typeof value==='string')return `<string>${escape(value)}</string>`;
  if(Array.isArray(value))return `<array>${value.map(xml).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key,v])=>`<key>${escape(key)}</key>${xml(v)}`).join('')}</dict>`;
}
function plist(value) {return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(value)}</plist>\n`;}
function quote(arg) {return "'"+arg.replace(/'/g,"'\\''")+"'";}
function absolute(value) {if(typeof value!=='string'||!path.isAbsolute(value)||/[\r\n\0]/.test(value))throw new Error('All configured paths must be absolute.');return path.normalize(value);}
function digest(bytes) {return crypto.createHash('sha256').update(bytes).digest('hex');}
function parseJSON(bytes) {try {return JSON.parse(bytes);}catch {throw new Error('A required JSON configuration is malformed.');}}

function buildPlan(options) {
  const home=absolute(options.home),root=absolute(options.project),source=absolute(options.sourceDir),node=absolute(options.node),dataDir=absolute(options.dataDir);
  for(const dir of [home,root,source,dataDir]) {assertNoLinks(dir);assertMetadata(dir,{directory:true,privateMode:dir===dataDir});}
  // Homebrew's stable Node path may deliberately contain a symlink. Resolve and
  // verify its executable target, retaining the stable path for future upgrades.
  const nodeReal=fs.realpathSync(node),nodeUid=fs.statSync(nodeReal).uid;
  if(nodeUid!==0&&nodeUid!==process.getuid())throw new Error('The Node executable must be owned by this user or root.');
  assertMetadata(nodeReal,{executable:true,uid:nodeUid});
  assertMetadata(path.join(root,'src/mcp.js'));
  const sourceProfile=parseJSON(safeRead(path.join(source,'profiles',PROFILE)).toString('utf8'));
  const cp=sourceProfile.control_plane;
  const sourceKey=path.join(source,'runtime-api-key');
  if(sourceProfile.config_version!==1||!cp||cp.base_url!=='https://api.openai.com'||!/^tunnel_[a-f0-9]{32}$/.test(cp.tunnel_id)||cp.api_key!=='file:'+sourceKey) throw new Error('The source must be a version 1 OpenAI tunnel profile using its private runtime key file.');
  assertNoLinks(sourceKey);assertMetadata(sourceKey,{privateMode:true});
  const assets=ASSETS.map(name=>({name,sha256:digest(safeRead(path.join(source,'bin',name),{executable:name==='tunnel-client'}))}));
  const support=path.join(home,'Library/Application Support/Pi Bridge/MCP Tunnel');
  const agent=path.join(home,'Library/LaunchAgents',LABEL+'.plist');
  const configPath=path.join(support,'profile.yaml');
  const environment={HOME:home,PATH:[path.dirname(node),'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),AIRODROM_DATA_DIR:dataDir};
  const config={config_version:1,admin_ui:{open_browser:false},control_plane:{api_key:'file:'+path.join(support,'runtime-api-key'),base_url:'https://api.openai.com',tunnel_id:cp.tunnel_id},health:{listen_addr:'127.0.0.1:0',url_file:path.join(support,'health.url')},log:{file:path.join(support,'tunnel.log'),format:'json',level:'warn'},mcp:{commands:[{channel:'main',command:[node,path.join(root,'src/mcp.js')].map(quote).join(' ')}],stdio_send_initialized_notification:true}};
  const launchAgent={Label:LABEL,ProgramArguments:['/usr/bin/env','-i',...Object.entries(environment).map(([key,value])=>key+'='+value),path.join(support,'bin/tunnel-client'),'run','--config',configPath],EnvironmentVariables:environment,WorkingDirectory:root,RunAtLoad:true,KeepAlive:true,ThrottleInterval:15,ProcessType:'Background',Umask:63,StandardOutPath:'/dev/null',StandardErrorPath:path.join(support,'launcher.stderr.log'),ExitTimeOut:20};
  return {version:1,label:LABEL,home,project:root,sourceDir:source,node,dataDir,support,agent,configPath,assets,config,launchAgent};
}
function command(exe,args,{quiet=false}={}) {
  const result=spawnSync(exe,args,{stdio:quiet?'ignore':'inherit'});
  if(result.status!==0)throw new Error('A macOS validation or tunnel service command failed.');
}
function prepare({sourceDir,root=project}={}) {
  if(process.platform!=='darwin')throw new Error('macOS is required.');
  if(!sourceDir)throw new Error('--source-dir is required for preparation.');
  const existing=parseJSON(safeRead(path.join(root,'.runtime/macos.json'),{privateMode:true}));
  const plan=buildPlan({home:os.homedir(),project:root,sourceDir:path.resolve(sourceDir),node:existing.node,dataDir:existing.dataDir});
  const build=path.join(root,'work/mcp-tunnel');privateDirectory(build);
  atomicWrite(path.join(build,'plan.json'),JSON.stringify(plan,null,2)+'\n');
  atomicWrite(path.join(build,'profile.yaml'),JSON.stringify(plan.config,null,2)+'\n');
  atomicWrite(path.join(build,LABEL+'.plist'),plist(plan.launchAgent));
  command('/usr/bin/plutil',['-lint',path.join(build,LABEL+'.plist')],{quiet:true});
  console.log('Prepared the independent MCP tunnel login agent under work/mcp-tunnel. No credentials were copied and no service was changed.');
  return plan;
}
function installPrepared({root=project}={}) {
  if(process.platform!=='darwin')throw new Error('macOS is required.');
  const build=path.join(root,'work/mcp-tunnel');
  const prepared=parseJSON(safeRead(path.join(build,'plan.json'),{privateMode:true}));
  if(prepared.project!==root||prepared.home!==os.homedir())throw new Error('Prepared paths do not match this project and user.');
  const plan=buildPlan(prepared);
  if(JSON.stringify(prepared)!==JSON.stringify(plan)||safeRead(path.join(build,'profile.yaml'),{privateMode:true}).toString()!==JSON.stringify(plan.config,null,2)+'\n'||safeRead(path.join(build,LABEL+'.plist'),{privateMode:true}).toString()!==plist(plan.launchAgent)) throw new Error('Prepared files or source assets changed; prepare and review them again.');
  const target=`gui/${process.getuid()}/${LABEL}`;
  if(spawnSync('/bin/launchctl',['print',target],{stdio:'ignore'}).status===0)throw new Error('The MCP tunnel job is already loaded; it was preserved.');
  // Validate every destination before copying the credential or changing launchd.
  for(const dir of [path.dirname(plan.support),plan.support,path.join(plan.support,'bin'),path.dirname(plan.agent)])privateDirectory(dir,{privateMode:dir!==path.dirname(plan.agent)});
  const destinations=[plan.agent,plan.configPath,...ASSETS.map(name=>path.join(plan.support,'bin',name)),...['runtime-api-key','health.url','tunnel.log','tunnel.pid','launcher.stderr.log'].map(name=>path.join(plan.support,name))];
  for(const dest of destinations) {assertNoLinks(dest);if(fs.existsSync(dest))assertMetadata(dest,{privateMode:true});}
  for(const asset of plan.assets) {
    const bytes=safeRead(path.join(plan.sourceDir,'bin',asset.name),{executable:asset.name==='tunnel-client'});
    if(digest(bytes)!==asset.sha256)throw new Error('A source asset changed; prepare and review again.');
    atomicWrite(path.join(plan.support,'bin',asset.name),bytes,asset.name==='tunnel-client'?0o700:0o600);
  }
  const key=safeRead(path.join(plan.sourceDir,'runtime-api-key'),{privateMode:true});
  if(key.length<16||key.length>16384)throw new Error('The runtime credential file has an invalid size.');
  try {atomicWrite(path.join(plan.support,'runtime-api-key'),key);}finally {key.fill(0);}
  atomicWrite(plan.configPath,JSON.stringify(plan.config,null,2)+'\n');
  // Validate the real client schema before registering the login service.
  command(path.join(plan.support,'bin/tunnel-client'),['doctor','--config',plan.configPath,'--json'],{quiet:true});
  atomicWrite(plan.agent,plist(plan.launchAgent));
  // launchd creates this before the child sets its umask; create it privately.
  for(const name of ['tunnel.log','launcher.stderr.log']) {const file=path.join(plan.support,name);if(!fs.existsSync(file))atomicWrite(file,'');}
  command('/usr/bin/plutil',['-lint',plan.agent],{quiet:true});
  command('/bin/launchctl',['enable',target]);
  command('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plan.agent]);
  console.log('Installed the independent MCP tunnel login agent. The bridge and menu-bar services were preserved.');
  return plan;
}
// Narrow recovery for the invalid v0.0.15 profile generated by the old installer.
// The already-loaded login agent retries automatically; no service is stopped.
function repairProfile({root=project}={}) {
  if(process.platform!=='darwin')throw new Error('macOS is required.');
  const build=path.join(root,'work/mcp-tunnel');
  const prepared=parseJSON(safeRead(path.join(build,'plan.json'),{privateMode:true}));
  if(prepared.project!==root||prepared.home!==os.homedir())throw new Error('Prepared paths do not match this project and user.');
  const plan=buildPlan(prepared);
  const before=safeRead(plan.configPath,{privateMode:true});
  const current=parseJSON(before);
  if(current.pid && JSON.stringify(current.pid)!==JSON.stringify({file:path.join(plan.support,'tunnel.pid')}))throw new Error('Unexpected pid configuration; preserved.');
  delete current.pid;
  if(JSON.stringify(current)!==JSON.stringify(plan.config))throw new Error('Runtime profile differs from the reviewed plan; preserved.');
  const candidate=path.join(build,'profile-fixed.yaml');
  atomicWrite(candidate,JSON.stringify(current,null,2)+'\n');
  command(path.join(plan.support,'bin/tunnel-client'),['doctor','--config',candidate,'--json'],{quiet:true});
  if(!safeRead(plan.configPath,{privateMode:true}).equals(before))throw new Error('Runtime profile changed during validation; preserved.');
  atomicWrite(plan.configPath,JSON.stringify(current,null,2)+'\n');
  console.log('Removed unsupported pid configuration. The existing login agent will retry automatically; verify health before acceptance.');
}
if(require.main===module) {
  try {
    const args=process.argv.slice(2);
    if(args[0]==='--prepare'&&args[1]==='--source-dir'&&args.length===3)prepare({sourceDir:args[2]});
    else if(args[0]==='--install-prepared'&&args.length===1)installPrepared();
    else if(args[0]==='--repair-profile'&&args.length===1)repairProfile();
    else throw new Error('Usage: mcp-tunnel.cjs --prepare --source-dir /absolute/tunnel-client; then --install-prepared. For the existing invalid profile use --repair-profile.');
  } catch(error) {console.error('MCP tunnel setup did not complete: '+error.message);process.exitCode=1;}
}
module.exports={LABEL,ASSETS,buildPlan,assertMetadata,assertNoLinks,safeRead,plist,prepare,installPrepared,repairProfile};
