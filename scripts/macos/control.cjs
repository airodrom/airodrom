'use strict';
// Trusted local operator control, deliberately separate from the MCP tool surface.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { discovery } = require('../../src/mcp-client');
const project = path.resolve(__dirname, '../..');
const configFile = path.join(project, '.runtime/macos.json');
const label = 'local.pi-chatgpt-bridge';
const domain = `gui/${process.getuid()}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function privateJSON(file, limit = 16384) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit) throw new Error('Private configuration invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function config() {
  const c = privateJSON(configFile);
  if (c.project !== project || !path.isAbsolute(c.dataDir) || !path.isAbsolute(c.agent) || !path.isAbsolute(c.node) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error('Configuration invalid');
  return c;
}
function launch(args) { return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 }); }
function job() {
  const r = launch(['print', `${domain}/${label}`]);
  if (r.status !== 0) return { loaded: false, pid: null, running: false };
  return { loaded: true, pid: Number(r.stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || null, running: /^\s*state = running$/m.test(r.stdout) };
}
function lock(c) {
  try {
    const file = path.join(c.dataDir, 'bridge.lock');
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.size > 32) return { blocked: true, pid: null };
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) return { blocked: true, pid: null };
    try { process.kill(pid, 0); return { blocked: true, pid }; }
    catch (e) { return e.code === 'ESRCH' ? { blocked: false, pid: null } : { blocked: true, pid }; }
  } catch (e) { return { blocked: e.code !== 'ENOENT', pid: null }; }
}
function request(port, token, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({hostname:'127.0.0.1', port, path:route, headers:{authorization:`Bearer ${token}`}}, res => {
      let size = 0; const parts = [];
      res.on('data', p => { size += p.length; if (size > 32768) res.destroy(); else parts.push(p); });
      res.on('error', reject);
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('Health refused'); resolve(JSON.parse(Buffer.concat(parts))); } catch (e) { reject(e); } });
    });
    req.setTimeout(1800, () => req.destroy(new Error('Health timeout'))); req.on('error', reject);
  });
}
function uiDiscovery(c) {
  // Validate directory ownership and mode with the same rules as MCP discovery.
  const mcp = discovery(c.dataDir);
  const ui = privateJSON(path.join(c.dataDir, 'ui.json'), 4096);
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=([a-f0-9]{64})$/.exec(ui.url);
  if (!match || Number(match[1]) !== c.port || ui.port !== c.port || mcp.port !== c.port || !Number.isInteger(ui.pid) || ui.pid < 1 || mcp.pid !== ui.pid) throw new Error('Discovery mismatch');
  return { ui, mcp, token: match[2] };
}
const time = n => Number.isFinite(n) && n > 0 ? n : null;
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const statuses = ['idle','starting','thinking','running_tool','compacting','approval_required','blocked','completed','cancelled','interrupted','error'];
async function status(c) {
  const j = job(); const locked = lock(c);
  const base = {state:'Stopped', managed:j.loaded, pid:null, endpoint:`http://127.0.0.1:${c.port}`, now:Date.now(), mcp:{ready:false,lastCallAt:null}, tasks:{active:0,connected:0,total:0,counts:{}},lastActivityAt:null,lastHeartbeatAt:null};
  try {
    const { ui, mcp, token } = uiDiscovery(c);
    const [s, m, product] = await Promise.all([request(c.port, token, '/api/status'), request(c.port, mcp.token, '/api/mcp/health').catch(()=>({ready:false})), request(c.port,token,'/api/product/native-status').catch(()=>null)]);
    if (s.pid !== ui.pid || !s.healthy) throw new Error('Health mismatch');
    return {...base, state:'Connected', pid:s.pid, managed:j.loaded && j.pid === s.pid, now:time(s.now) || base.now,
      mcp:{ready:m.ready === true && m.pid === s.pid,lastCallAt:time(s.mcp?.lastCallAt)},
      tasks:{active:count(s.tasks?.active),connected:count(s.tasks?.connected),total:count(s.tasks?.total),counts:Object.fromEntries(statuses.filter(k=>count(s.tasks?.counts?.[k])).map(k=>[k,count(s.tasks.counts[k])]))},
      lastActivityAt:time(s.lastActivityAt),lastHeartbeatAt:time(s.lastHeartbeatAt),product};
  } catch {
    if (locked.blocked && (!j.pid || locked.pid !== j.pid)) return {...base,state:'Error',message:'Existing lock is in use or cannot be verified. No process was changed.'};
    if (j.loaded) return {...base,state:j.running ? 'Starting' : 'Error',pid:j.pid,message:j.running ? 'Waiting for local health.' : 'Login service is waiting or failed. Check the private service log.'};
    return base;
  }
}
async function start(c) {
  const before = await status(c);
  if (before.state === 'Connected') return before;
  if (lock(c).blocked && !job().loaded) throw new Error('A valid or unverifiable bridge lock prevents startup.');
  if (!job().loaded) {
    const r = launch(['bootstrap',domain,c.agent]);
    if (r.status !== 0 && !job().loaded) throw new Error('Could not load the login service. Run the macOS installer.');
  } else if (!job().running) launch(['kickstart',`${domain}/${label}`]);
  for (let i=0;i<35;i++) { const s=await status(c); if (s.state === 'Connected') return s; await sleep(200); }
  throw new Error('Bridge did not become healthy. Check the private service log.');
}
async function stop(c) {
  const j=job();
  if (!j.loaded) {
    if (lock(c).blocked) throw new Error('Bridge is not owned by this login service. Stop it in its original terminal.');
    return status(c);
  }
  const existing = lock(c);
  if (existing.blocked && (!j.pid || existing.pid !== j.pid)) throw new Error('Existing bridge lock does not belong to the login service.');
  const r=launch(['bootout',`${domain}/${label}`]);
  if (r.status !== 0 && job().loaded) throw new Error('Could not stop the login service.');
  for (let i=0;i<50;i++) { if (!lock(c).blocked && !job().loaded) return status(c); await sleep(200); }
  throw new Error('Bridge has not finished stopping. Its lock was preserved.');
}
async function open(c) {
  const s=await status(c); if (s.state !== 'Connected') throw new Error('Start the bridge before opening Control Center.');
  const {ui}=uiDiscovery(c);
  // NSWorkspace opens the private URL in memory, never via command arguments.
  const app = path.join(project, 'work/macos/Pi Bridge.app/Contents/MacOS/AirodromMenu');
  const r=spawnSync(c.helper || app, ['--open-control-center'],{stdio:'ignore',timeout:5000});
  if (r.status !== 0) throw new Error('Could not open Control Center.');
  return s;
}
async function action(command) {
  const c=config();
  if (command === 'status' || command === 'doctor') return status(c);
  if (command === 'open') return open(c);
  if (!['start','stop','restart'].includes(command)) throw new Error('Unknown bridge action.');
  if(!process.argv.includes('--control-locked')) {
    const r=spawnSync(c.helper,['--action',command],{encoding:'utf8',timeout:35000,maxBuffer:32768});
    if(!r.stdout) throw new Error('Could not run the native bridge controller.');
    const result=JSON.parse(r.stdout); if(result.state==='Error') throw new Error('Could not complete the bridge control action. Check the menu status.'); return result;
  }
  if(command === 'stop') return stop(c);
  if(command === 'restart') await stop(c);
  return start(c);
}
if (require.main === module) action(process.argv[2] || 'status').then(s=>console.log(JSON.stringify(s))).catch(e=>{
  // Only fixed operator-facing messages from this module may reach the helper.
  const allowed = /^(A valid or unverifiable|Could not |Bridge did not |Bridge is not owned|Existing bridge lock|Bridge has not |Start the bridge|Unknown bridge|Another bridge control)/;
  console.log(JSON.stringify({state:'Error',message:allowed.test(e.message)?e.message:'Private startup configuration is unavailable or invalid.',managed:false,now:Date.now(),mcp:{ready:false,lastCallAt:null},tasks:{active:0,connected:0,total:0,counts:{}},lastActivityAt:null,lastHeartbeatAt:null})); process.exitCode=1;
});
module.exports={privateJSON,config,lock,status,action,uiDiscovery,request};
