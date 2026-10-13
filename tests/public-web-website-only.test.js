'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');

test('website-only research creates without sibling arecibo-core',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'airodrom-web-only-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dataDir=path.join(root,'data');fs.mkdirSync(dataDir,{mode:0o700});
 // Install layout without arecibo-core sibling — the failure mode from the live install.
 const install=path.join(root,'install');fs.mkdirSync(install,{mode:0o700});
 const profile=require('../src/research-profile');
 assert.throws(()=>profile.comparisonWorkspace(),/Repository comparison needs|verified product repository/);
 const staging=profile.ensureWebsiteOnlyWorkspace(dataDir);
 const realData=fs.realpathSync(dataDir);
 assert.equal(path.dirname(staging),path.dirname(realData));
 assert.ok(!staging.startsWith(realData+path.sep));
 assert.doesNotMatch(staging,/arecibo-core/);
 const baseline=new profile.WebsiteOnlyBaseline(staging);
 const snapshot=baseline.capture();
 assert.equal(snapshot.project,'WebsiteOnly');
 assert.equal(snapshot.features.length,0);
 assert.equal(baseline.verify(snapshot),true);
});

test('explore website and ordinary public URL route to public_web_offer',()=>{
 const guide=require('../src/mission-web-guide');
 const browser=require('../src/browser-research');
 const explore=guide.parse('explore website https://arecibo.ca');
 assert.equal(explore.kind,'public_web_offer');
 assert.ok(explore.entries.some(e=>e.includes('arecibo.ca')));
 assert.equal(guide.parse('I approved')?.kind,'clarify');
 assert.match(guide.parse('I approved').message,/Terminal permission prompt/);
 const look=browser.parse('look at https://example.com');
 assert.equal(look.kind,'public_web_offer');
 assert.ok(look.entries[0].includes('example.com'));
 const compare=browser.parse('Research https://example.com and compare with Arecibo');
 assert.equal(compare.kind,'research');
 assert.equal(compare.entry_url,'https://example.com/');
});

test('public_web createResearch does not require comparison repository',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t);
 // Point research profile workspace at a missing sibling to reproduce the live ENOENT.
 f.bridge.options.researchMission={workspace:path.join(f.bridge.dataDir,'missing-arecibo-core'),synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 const created=f.bridge.missions.web.createResearch({
  request_id:randomUUID(),
  objective:'explore website https://example.com',
  mode:'on',
  entries:['https://example.com/'],
  confirmed:true
 });
 const m=f.bridge.controlStore.requireMission(created.mission_id);
 assert.equal(m.envelope.manifest.research_mode,'website_only');
 assert.equal(m.envelope.research_baseline.project,'WebsiteOnly');
 assert.ok(m.envelope.workspace.includes('research-website-only'));
 assert.doesNotMatch(m.envelope.workspace,/arecibo-core/);
 assert.doesNotMatch(JSON.stringify(created),/ENOENT|\/Users\//);
});

test('comparison research still requires verified repository',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t);
 f.bridge.options.researchMission={workspace:path.join(f.bridge.dataDir,'missing-arecibo-core'),synthetic:true,baselineFiles:['docs/README.md'],maxPages:2,maxActions:20,timeoutMs:30000};
 assert.throws(()=>f.bridge.missions.createResearch({
  request_id:randomUUID(),
  objective:'Research https://example.com and compare with Arecibo',
  entry_url:'https://example.com/'
 }),/Repository comparison needs|Public website research could not|verified product repository/);
});
