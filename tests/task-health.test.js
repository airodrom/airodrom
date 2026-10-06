'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { taskHealth } = require('../src/task-health');
const base = {active:true,now:200000,startedAt:100000,heartbeatAt:199000,eventAt:199000,outputAt:199000,processState:'alive',leaseState:'held',budgetMs:300000,phase:'running'};
test('fresh independent signals yield Healthy and 100, with no authority',()=>{
 const h=taskHealth(base);assert.equal(h.status,'Healthy');assert.equal(h.score,100);assert.equal(h.executionAuthority,false);
});
test('quiet live worker is suspicious, never declared dead by missing progress',()=>{
 const h=taskHealth({...base,eventAt:100000,outputAt:100000});assert.equal(h.status,'Possibly Stalled');assert(h.score<=65);assert.equal(h.processState,'alive');
});
test('dead, expired budget and quarantined ownership independently flag Stalled',()=>{
 for(const delta of [{processState:'dead'},{budgetMs:100000},{leaseState:'quarantined'}]){const h=taskHealth({...base,...delta});assert.equal(h.status,'Stalled');assert(h.score<=25);}
});
test('unknown signals and prior-run/future pulses are not fresh evidence',()=>{
 const h=taskHealth({active:true,now:200000,startedAt:100000,heartbeatAt:90000,eventAt:300000,outputAt:90000});
 assert.equal(h.heartbeatAgeMs,null);assert.equal(h.eventAgeMs,null);assert.equal(h.outputAgeMs,null);assert.equal(h.score,null);assert.equal(h.status,'Possibly Stalled');
 assert.equal(taskHealth({active:true,now:200000}).status,'Healthy');
});
test('intentional approval wait does not become stalled for lack of output',()=>{
 const h=taskHealth({...base,phase:'approval_wait',eventAt:100000,outputAt:100000});assert.equal(h.status,'Healthy');assert.equal(h.waiting,true);
});
test('Recovered requires released ownership and inactive run; no polling mutation',()=>{
 const input={...base,recovered:true,active:false,leaseState:'released'};const before=JSON.stringify(input);
 assert.equal(taskHealth(input).status,'Recovered');assert.equal(JSON.stringify(input),before);
 assert.equal(taskHealth({...input,active:true,leaseState:'quarantined'}).status,'Stalled');
 assert.equal(taskHealth({...input,leaseState:'held'}).status,'Healthy');
});
test('controller reports durable quarantined ownership and verified recovery',()=>{
 const Controller=require('../src/bridge-controller');
 let run={id:'r',created_at:100000,state:'interrupted',process_state:'unknown',termination_verified:0};let rows=[{state:'quarantined',expires_at:190000}];
 const bridge={leases:new Map(),runtimes:new Map(),options:{},controlStore:{db:{prepare:sql=>({get:()=>run,all:()=>rows})}}};
 const task={id:'t'};const inspect=()=>Controller.prototype.taskHealth.call(bridge,task,200000);
 assert.equal(inspect().status,'Stalled');rows=[{state:'released'}];run.termination_verified=1;assert.equal(inspect().status,'Recovered');
});
test('task API includes bounded health observations',t=>{
 const {controlPlaneRead}=require('../src/control-plane-api');
 const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const task={id:'t',status:'running',controlPlaneMissionId:'m'};
 const bridge={tasks:{get:()=>task,list:()=>[task]},controlStore:{db,missionForTask:()=>({id:'m'})},taskHealth:()=>taskHealth(base)};
 for(const section of ['task','tasks']){const result=controlPlaneRead(bridge,new URL(`http://localhost/api/control-v2/${section}?id=t`));assert.equal((result.items?.[0]||result).health.status,'Healthy');}
});
test('old runtime identity and telemetry cannot make a replacement run look healthy',()=>{
 const Controller=require('../src/bridge-controller');
 const run={id:'new',created_at:100000,updated_at:100000,state:'running',process_state:'unknown'};
 const bridge={leases:new Map([['t',{runId:'new',acquiredAt:100000,phase:'running'}]]),runtimes:new Map([['t',{runId:'old',rpc:{_workerStillAlive:()=>{throw Error('Must not inspect old runtime');}}}]]),options:{},controlStore:{db:{prepare:()=>({get:()=>run,all:()=>[]})}}};
 const health=Controller.prototype.taskHealth.call(bridge,{id:'t',healthRunId:'old',lastHeartbeatAt:199999,lastOutputAt:199999},200000);
 assert.equal(health.processState,'unknown');assert.equal(health.heartbeatAgeMs,null);assert.equal(health.outputAgeMs,null);assert.equal(health.status,'Possibly Stalled');
});
