'use strict';
// Run as this user, never with sudo. Runtime/memory/session files are never removed.
const BRANDING=require('../../src/branding');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {action}=require('./control.cjs');
async function main() {
  if(process.platform!=='darwin') throw new Error();
  const mode=process.argv[2]; if(!['--disable','--uninstall'].includes(mode)) throw new Error();
  const s=await action('stop'); if(s.state!=='Stopped') throw new Error();
  const domain=`gui/${process.getuid()}`;
  for(const label of ['local.pi-chatgpt-bridge','local.pi-chatgpt-bridge.menubar']) {
    if(spawnSync('/bin/launchctl',['disable',`${domain}/${label}`],{stdio:'ignore'}).status!==0) throw new Error();
    spawnSync('/bin/launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});
    if(mode==='--uninstall') fs.rmSync(path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'),{force:true});
  }
  if(mode==='--uninstall') fs.rmSync(path.join(os.homedir(),'Library/Application Support/Pi Bridge/Pi Bridge.app'),{recursive:true,force:true});
  console.log(mode==='--disable'?`${BRANDING.name} login startup disabled.`:`${BRANDING.name} login agents and menu helper uninstalled.`);
  console.log('All task state, sessions, SQLite memory, source profiles, and MCP registration are preserved.');
}
main().catch(()=>{console.error('Could not complete macOS removal. Existing runtime data was preserved; inspect service ownership and permissions.');process.exitCode=1;});
