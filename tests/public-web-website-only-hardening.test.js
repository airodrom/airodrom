'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const profile=require('../src/research-profile');

function privateRoot(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airodrom-web-hard-')));
 fs.chmodSync(root,0o700);
 const dataDir=path.join(root,'data');
 fs.mkdirSync(dataDir,{mode:0o700});
 fs.chmodSync(dataDir,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,dataDir};
}

test('website-only staging rejects symlink path before any write or chmod',t=>{
 const {root,dataDir}=privateRoot(t);
 const target=path.join(root,'elsewhere');fs.mkdirSync(target,{mode:0o700});
 const link=path.join(root,'research-website-only');
 fs.symlinkSync(target,link);
 const before=fs.lstatSync(link);
 assert.throws(()=>profile.ensureWebsiteOnlyWorkspace(dataDir),/unsafe/i);
 const after=fs.lstatSync(link);
 assert.ok(after.isSymbolicLink());
 assert.equal(after.mtimeMs,before.mtimeMs);
 assert.equal(fs.readdirSync(target).length,0);
});

test('website-only staging rejects world-readable existing directory without modifying it',t=>{
 const {root,dataDir}=privateRoot(t);
 const staging=path.join(root,'research-website-only');
 fs.mkdirSync(staging,{mode:0o755});
 fs.chmodSync(staging,0o755);
 const modeBefore=fs.lstatSync(staging).mode;
 assert.throws(()=>profile.ensureWebsiteOnlyWorkspace(dataDir),/unsafe/i);
 assert.equal(fs.lstatSync(staging).mode,modeBefore);
 assert.equal(fs.readdirSync(staging).length,0);
});

test('WebsiteOnlyBaseline verify is integrity-bound against altered snapshots',t=>{
 const {dataDir}=privateRoot(t);
 const staging=profile.ensureWebsiteOnlyWorkspace(dataDir);
 const baseline=new profile.WebsiteOnlyBaseline(staging);
 const snapshot=baseline.capture();
 assert.equal(baseline.verify(snapshot),true);
 assert.throws(()=>baseline.verify({...snapshot,digest:'0'.repeat(64)}),/digest|provenance/i);
 assert.throws(()=>baseline.verify({...snapshot,id:randomUUID()}),/digest|provenance/i);
 assert.throws(()=>baseline.verify({...snapshot,features:[{id:'invented'}]}),/provenance|digest/i);
 assert.throws(()=>baseline.verify({...snapshot,workspace_identity:'a'.repeat(64)}),/identity|digest/i);
 assert.throws(()=>baseline.verify({version:1,project:'WebsiteOnly'}),/provenance/i);
});

test('WebsiteOnlyBaseline detect unexpected staging mutations',t=>{
 const {dataDir}=privateRoot(t);
 const staging=profile.ensureWebsiteOnlyWorkspace(dataDir);
 const baseline=new profile.WebsiteOnlyBaseline(staging);
 const snapshot=baseline.capture();
 fs.writeFileSync(path.join(staging,'extra.txt'),'mutation\n',{mode:0o600});
 assert.throws(()=>baseline.verify(snapshot),/staging changed/i);
 assert.throws(()=>baseline.workspaceSnapshot(),/staging changed/i);
});

test('comparison workspace rejects arbitrary git directories and symlink aliases',t=>{
 const {root}=privateRoot(t);
 const decoy=path.join(root,'decoy-repo');
 fs.mkdirSync(decoy,{mode:0o700});
 const git=(args)=>assert.equal(spawnSync('/usr/bin/git',['-C',decoy,...args],{stdio:'pipe'}).status,0);
 git(['init','-q']);
 fs.writeFileSync(path.join(decoy,'README.md'),'decoy\n');
 git(['add','.']);
 git(['-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','commit.gpgSign=false','commit','-qm','decoy']);
 assert.throws(()=>profile.verifyComparisonWorkspace(decoy,{configured:true}),/Repository comparison needs|verified product repository/);
 assert.doesNotThrow(()=>profile.verifyComparisonWorkspace(decoy,{configured:false}));
 const link=path.join(root,'link-repo');
 fs.symlinkSync(decoy,link);
 assert.throws(()=>profile.verifyComparisonWorkspace(link,{configured:false}),/Repository comparison needs|verified product repository/);
});

test('production comparison resolve ignores non-configured options.workspace',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t);
 const decoy=path.join(f.root,'other-git');
 fs.mkdirSync(decoy);const git=(args)=>spawnSync('/usr/bin/git',['-C',decoy,...args],{stdio:'pipe'});
 git(['init','-q']);fs.writeFileSync(path.join(decoy,'x.txt'),'x\n');git(['add','.']);git(['-c','user.name=F','-c','user.email=f@i','-c','commit.gpgSign=false','commit','-qm','x']);
 // Non-synthetic production-like options: must not accept the decoy as the product repository.
 f.bridge.options.researchMission={workspace:decoy,maxPages:2,maxActions:20,timeoutMs:30000};
 assert.throws(()=>f.bridge.missions.createResearch({
  request_id:randomUUID(),
  objective:'Research https://example.com and compare with Arecibo',
  entry_url:'https://example.com/'
 }),/Repository comparison needs|Public website research could not|verified product repository/);
});
