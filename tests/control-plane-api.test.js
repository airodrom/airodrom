'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {EventLedger}=require('../src/event-ledger');
const {ControlPlaneStore}=require('../src/control-plane-store');
const ControlServer=require('../src/control-server');
test('operator API denies MCP credential, bounds cursors, and renders only static shell',async t=>{
 const db=new DatabaseSync(':memory:'),ledger=new EventLedger(db);db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');const store=new ControlPlaneStore({db,ledger});
 const bridge={controlStore:store,ledger,closed:false,policy:{list:()=>[]}},server=new ControlServer(bridge,{port:0,token:'operator-fixture',mcpToken:'mcp-fixture'});
 await server.start();t.after(async()=>{await new Promise(r=>server.server.close(r));db.close();});
 const get=(p,token='operator-fixture')=>fetch(server.origin+p,{headers:{Authorization:`Bearer ${token}`}});
 assert.equal((await get('/api/control-v2/health','mcp-fixture')).status,401);
 assert.equal((await get('/api/control-v2/health')).status,200);
 for(let i=0;i<4;i++)ledger.record({eventType:'fixture.event',agent:'bridge',direction:'internal',payload:'<script>untrusted</script>'});
 const page=await(await get('/api/control-v2/events?limit=2')).json();assert.equal(page.events.length,2);
 const next=await(await get('/api/control-v2/events?afterSequence='+page.events.at(-1).sequence)).json();assert.equal(next.events.length,2);assert.ok(next.events[0].sequence>page.events.at(-1).sequence);
 assert.equal((await get('/api/control-v2/runs?limit=10000')).status,400);
 const html=await(await get('/hub')).text();assert.match(html,/<dialog/);assert.doesNotMatch(html,/<script>untrusted/);
 const script=await(await get('/control-hub.js')).text();assert.doesNotMatch(script,/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
});
test('health collections expose providers separately and bounded outbox metadata',async t=>{
 const db=new DatabaseSync(':memory:'),ledger=new EventLedger(db);db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');const store=new ControlPlaneStore({db,ledger});
 const bridge={controlStore:store,ledger,closed:false,policy:{list:()=>[]}},server=new ControlServer(bridge,{port:0,token:'operator-fixture',mcpToken:'mcp-fixture'});
 await server.start();t.after(async()=>{await new Promise(r=>server.server.close(r));db.close();});
 store.outbox.enqueue({key:'test-health',destination:'fixture',ref:'local',eventType:'fixture.test',payload:{token:'private'}});
 const get=async p=>(await fetch(server.origin+'/api/control-v2/'+p,{headers:{Authorization:'Bearer operator-fixture'}})).json();
 const out=await get('outbox');assert.equal(out.items.length,1);assert.equal(out.health.counts.pending,1);assert.ok(!JSON.stringify(out).includes('private'));
 const providers=await get('providers');assert.ok(providers.items.every(p=>p.kind==='provider'&&p.execution_authority===false));assert.equal((await get('next-action')).execution_enabled,false);
});
