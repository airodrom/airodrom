#!/usr/bin/env node
'use strict';
// One-shot smoke: website-only public research against a real HTTPS origin.
// Does not touch the operator checkout or live install.
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const test=require('node:test');

async function main(){
 const {fixture}=require('../tests/fixtures/mission-fixture.cjs');
 const t={after(fn){(this._after||(this._after=[])).push(fn);},async cleanup(){for(const fn of this._after||[])await fn();}};
 const f=await fixture(t);
 // No researchMission.workspace override — production path must not need arecibo-core.
 delete f.bridge.options.researchMission;
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
 f.bridge.missions.dispatch(created.mission_id,{request_id:randomUUID()});
 const done=await f.settle(created.mission_id);
 assert.equal(done.state,'awaiting_acceptance');
 const report=await f.bridge.missions.research.report(created.mission_id);
 assert.match(report.markdown,/example\.com/i);
 assert.match(report.markdown,/Website-only research|public website research/i);
 assert.doesNotMatch(report.markdown,/## Arecibo comparison/);
 assert.doesNotMatch(JSON.stringify({created,report}),/ENOENT|\/Users\/|arecibo-core/);
 console.log(JSON.stringify({
  ok:true,
  mission_id:created.mission_id,
  research_mode:m.envelope.manifest.research_mode,
  pages:report.report?.sections?.overview?.pages_captured??null,
  markdown_chars:report.markdown.length,
  has_example_url:/https:\/\/example\.com/.test(report.markdown)
 },null,2));
 await t.cleanup();
}

main().catch(error=>{
 console.error(JSON.stringify({ok:false,error:String(error?.message||error).replace(/\/(?:Users|home|private|var|tmp)[^\s"']*/g,'[path]')}));
 process.exitCode=1;
});
