'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {privateJSON,lock,uiDiscovery,status}=require('../scripts/macos/control.cjs');
const Bridge=require('../src/bridge-controller');
const ControlServer=require('../src/control-server');
const {atomicJSON}=require('../src/config');
function dir(t) {const d=fs.mkdtempSync(path.join(os.tmpdir(),'pi-macos-'));fs.chmodSync(d,0o700);t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('control preserves live, malformed and unverified locks; only identifies a confirmed dead owner as stale', t=>{
  const dataDir=dir(t), file=path.join(dataDir,'bridge.lock');
  fs.writeFileSync(file,String(process.pid),{mode:0o600});assert.deepEqual(lock({dataDir}),{blocked:true,pid:process.pid});
  fs.writeFileSync(file,'invalid');assert.equal(lock({dataDir}).blocked,true);assert.equal(fs.readFileSync(file,'utf8'),'invalid');
  const child=spawnSync(process.execPath,['-e','process.exit(0)'],{encoding:'utf8'});assert.equal(child.status,0);const dead=child.pid;assert.ok(Number.isInteger(dead));assert.throws(()=>process.kill(dead,0),{code:'ESRCH'});
  fs.writeFileSync(file,String(dead));assert.equal(lock({dataDir}).blocked,false);assert.equal(fs.readFileSync(file,'utf8'),String(dead));
});
test('operator discovery rejects public files, links and non-loopback or mismatched endpoints',t=>{
  const dataDir=dir(t), c={dataDir,port:43117};
  atomicJSON(path.join(dataDir,'mcp.json'),{pid:process.pid,port:c.port,token:'a'.repeat(64)});
  const ui=path.join(dataDir,'ui.json');atomicJSON(ui,{pid:process.pid,port:c.port,url:`http://127.0.0.1:${c.port}/#token=${'b'.repeat(64)}`});
  assert.equal(uiDiscovery(c).mcp.pid,process.pid);
  fs.chmodSync(ui,0o644);assert.throws(()=>privateJSON(ui));fs.chmodSync(ui,0o600);
  atomicJSON(ui,{pid:process.pid,port:c.port,url:`http://evil.example:${c.port}/#token=${'b'.repeat(64)}`});assert.throws(()=>uiDiscovery(c));
  fs.rmSync(ui);fs.symlinkSync(path.join(dataDir,'mcp.json'),ui);assert.throws(()=>uiDiscovery(c));
});
test('status reports authenticated aggregate health without serializing credentials or task text',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-macos-')),dataDir=path.join(root,'data'),sourceProfile=path.join(root,'profile');fs.mkdirSync(sourceProfile);fs.writeFileSync(path.join(sourceProfile,'settings.json'),'{}');
  const bridge=await new Bridge({ defaultRuntime: 'pi',dataDir,sourceProfile}).initialize();const server=new ControlServer(bridge,{port:0});const address=await server.start();
  t.after(async()=>{await server.close();await bridge.shutdown();fs.rmSync(root,{recursive:true,force:true});});
  bridge.createTask('SENSITIVE_TASK_TITLE');
  atomicJSON(path.join(dataDir,'ui.json'),{...address,pid:process.pid});atomicJSON(path.join(dataDir,'mcp.json'),{port:address.port,pid:process.pid,token:server.mcpToken});
  const result=await status({dataDir,port:address.port});assert.equal(result.state,'Connected');assert.equal(result.mcp.ready,true);assert.equal(result.tasks.total,1);
  const output=JSON.stringify(result);for(const secret of [server.token,server.mcpToken,'SENSITIVE_TASK_TITLE',dataDir])assert(!output.includes(secret));
});
