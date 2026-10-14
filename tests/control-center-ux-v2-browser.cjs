'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const engines=require(process.env.AIRODROM_PLAYWRIGHT_MODULE||'playwright-core'),engine=process.env.AIRODROM_BROWSER_ENGINE||'chromium';
const {fixture}=require('./fixtures/mission-fixture.cjs'),ControlServer=require('../src/control-server');
const display=require('../src/product-observability');
const outDir=process.env.AIRODROM_UX_CAPTURE_DIR||path.join(process.cwd(),'artifacts','control-center-ux-v2');
test('Control Center UX v2: missions pagination, archive, status, responsive themes',async t=>{
 const f=await fixture(t),b=f.bridge,server=new ControlServer(b,{port:0});await server.start();t.after(()=>server.close());
 // Ensure settlements table exists for organize eligibility.
 require('../src/mission-program');
 b.controlStore.db.exec(`CREATE TABLE IF NOT EXISTS cp_mission_settlements(
   mission_id TEXT PRIMARY KEY,review_id TEXT,state TEXT NOT NULL,recommendation TEXT NOT NULL,updated_at INTEGER NOT NULL)`);
 let settledCount=0;
 for(let i=0;i<40;i++){
  const objective=i===12?'Arecibo Financial Firewall':('History fixture '+i);
  const m=f.create({objective});
  const state=i<2?'running':i<5?'awaiting_acceptance':i<8?'needs_rework':'completed';
  b.controlStore.db.prepare('UPDATE cp_missions SET state=?,created_at=? WHERE id=?').run(state,Date.now()-i*60_000,m.id);
  if(state==='completed' && i%3===0){
   settledCount++;
   b.controlStore.db.prepare(`INSERT INTO cp_mission_settlements(mission_id,review_id,state,recommendation,updated_at)
     VALUES(?,?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET state=excluded.state,recommendation=excluded.recommendation,updated_at=excluded.updated_at`)
     .run(m.id,null,'settled','Synthetic settled history',Date.now()-i*60_000);
  }
 }
 fs.mkdirSync(outDir,{recursive:true});
 const browser=await engines[engine].launch({...(engine==='chromium'?{channel:process.env.AIRODROM_BROWSER_CHANNEL||'chrome'}:{}),headless:process.env.AIRODROM_BROWSER_HEADFUL!=='1',timeout:30000});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.addInitScript(token=>sessionStorage.setItem('airodromToken',token),server.token);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',async d=>d.accept());
 await page.goto(server.origin+'/');
 await page.getByRole('button',{name:'Missions',exact:true}).click();
 await page.getByRole('tab',{name:/Active/}).waitFor();
 await page.getByRole('tab',{name:/Needs Attention/}).click();
 await page.getByRole('status').filter({hasText:/matching/}).waitFor();
 assert.doesNotMatch(await page.locator('body').innerText(),/\bNaN\b|Active work:/);
 await page.getByRole('tab',{name:/History/}).click();
 await page.getByRole('status').filter({hasText:/matching/}).waitFor();
 await page.screenshot({path:path.join(outDir,'missions-desktop-dark.png'),fullPage:true});
 await page.getByLabel('Page size').selectOption('10');
 await page.getByRole('status').filter({hasText:/page 1 of/}).waitFor();
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByRole('status').filter({hasText:/page 2 of/}).waitFor();
 const search=page.getByRole('searchbox',{name:'Search Missions'});
 await search.fill('Arecibo');
 await page.getByText(/Arecibo Financial Firewall/).waitFor({timeout:10000});
 assert.match(await page.locator('body').innerText(),/Needs rework|Waiting for approval|Completed|Registered/);
 await page.getByRole('button',{name:'View Mission'}).first().click();
 await page.getByRole('button',{name:'← Back to Missions'}).waitFor();
 await page.screenshot({path:path.join(outDir,'mission-detail-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'← Back to Missions'}).click();
 await page.getByRole('searchbox',{name:'Search Missions'}).waitFor();
 await search.fill('');
 await page.getByRole('tab',{name:/History/}).click();
 await page.getByRole('button',{name:'Organize history…'}).click();
 await page.getByRole('tab',{name:/Archived/}).click();
 await page.getByRole('status').filter({hasText:/matching/}).waitFor();
 assert.ok(settledCount>0);
 assert.match(await page.getByRole('status').filter({hasText:/matching/}).innerText(),/[1-9]\d* matching/);
 await page.locator('details.nav-more > summary').click();
 await page.getByRole('button',{name:'Autonomous Goals',exact:true}).click();
 await page.getByText(/Continuous Autonomous Execution|Autonomous Goals|Outcome-first|Goals/).first().waitFor();
 await page.screenshot({path:path.join(outDir,'autonomous-goals.png'),fullPage:true});
 await page.getByLabel('Appearance').selectOption('light');
 await page.getByRole('button',{name:'Missions',exact:true}).click();
 await page.screenshot({path:path.join(outDir,'missions-desktop-light.png'),fullPage:true});
 await page.setViewportSize({width:375,height:812});
 await page.screenshot({path:path.join(outDir,'missions-mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.setViewportSize({width:320,height:780});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 assert.equal(errors.length,0,errors.join('\n'));
 assert.equal(display.missionHistory(b,new URL('http://local/api/product/missions?filter=History&limit=10')).limit,10);
});
