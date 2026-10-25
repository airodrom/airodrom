'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
function simulate(t, scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-sim-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['src','config']) fs.mkdirSync(path.join(root, dir));
  for (const file of ['src/capability-policy.js','src/autonomy-policy.js','config/capability-policy-v2.json','config/trusted-routine-actions-v1.json'])
    fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
  fs.copyFileSync(path.join(__dirname,'fixtures/policy-simulator.cjs'),path.join(root,'simulator.cjs'));
  fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({scenario}));
  const profile = require('../src/sandbox-policy').makeProfile({
    readRoots:[root,'/System','/usr/lib','/opt/homebrew'], writeRoots:[root],
    denyFork:true, execPaths:[process.execPath],
  });
  const r = spawnSync('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'--experimental-permission',
    '--allow-fs-read='+root,'--allow-fs-write='+root,path.join(root,'simulator.cjs')],{
    cwd:root,env:{HOME:root,TMPDIR:root,AIRODROM_POLICY_SIMULATION_FIXTURE:'isolated-v1',NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,JSON.stringify({signal:r.signal,error:r.error?.code,stderr:r.stderr})); const result=JSON.parse(r.stdout);
  assert.deepEqual(result.containment,{outside_read_denied:true,child_process_denied:true,network_denied:true});
  assert.equal(result.authority,false);assert.equal(result.accepted,false);assert.equal(result.execution_permitted,false);
  return result;
}
test('sandboxed synthetic dispute explains a specific overrestrictive rule', t => {
  const r=simulate(t,'overrestrictive-read'); assert.equal(r.current.decision,'deny'); assert.equal(r.proposed.decision,'auto_allow');
  assert.equal(r.difference_rule,'capabilities.file_read.decision');
});
test('simulation keeps missing scope, always-deny and protected classes closed', t => {
  const missing=simulate(t,'missing-scope'); assert.equal(missing.current.decision,'deny');assert.equal(missing.proposed.decision,'deny');
  for(const scenario of ['always-deny','protected-class'])assert.equal(simulate(t,scenario).proposed.valid,false);
});
test('simulator has no release endpoint, import or package path', () => {
  const pkg=require('../package.json'); assert.ok(!pkg.files.some(f=>f.includes('policy-simulator')));
  for(const file of fs.readdirSync(path.join(__dirname,'../src')).filter(f=>f.endsWith('.js')))
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'), /policy-simulator/);
  const r=spawnSync(process.execPath,[path.join(__dirname,'fixtures/policy-simulator.cjs')],{env:{},encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/isolated synthetic fixture required/);
});
