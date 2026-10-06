'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {EventLedger}=require('../src/event-ledger');const {ControlPlaneStore}=require('../src/control-plane-store');const {Orchestrator}=require('../src/orchestrator');const {LeaseRegistry}=require('../src/execution-lease');
test('new orchestrator recovers durable redacted results without another execution or inference',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');const ledger=new EventLedger(db),store=new ControlPlaneStore({db,ledger});const task={id:'t1'};let executions=0;
 const bridge={controlStore:store,tasks:{get:()=>task,list:()=>[task],save:()=>{}},leases:new LeaseRegistry(),capabilityHost:{taskScopes:()=>['system_readonly']},policy:{approvals:new Map()},emit:()=>{},_ledgerContext:()=>({taskId:'t1'}),_ledgerRecord:e=>ledger.record(e),capabilityBroker:{execute:async()=>{executions++;return{allow:true,output:JSON.stringify({result:{answer:42,secret:'must not persist',job_id:'job1'}})};}},prompt:()=>{throw Error('Inference forbidden');}};
 const first=await new Orchestrator(bridge).invoke('t1',{name:'fixture',input:{},requestId:'req1'});assert.equal(first.result.answer,42);
 task.capabilityInvocations={};const restarted=new Orchestrator(bridge);store.recover();const replay=await restarted.invoke('t1',{name:'fixture',input:{},requestId:'req1'});assert.equal(replay.result.answer,42);assert.equal(replay.result.job_id,'job1');assert.equal(replay.result.secret,'[redacted]');assert.equal(executions,1);
 await assert.rejects(restarted.invoke('t1',{name:'different',input:{},requestId:'req1'}),/conflict/);assert.equal(executions,1);
 const {createHash}=require('node:crypto'),{canonical}=require('../src/orchestrator');store.beginInvocation('t1','req2',createHash('sha256').update(canonical(['t1','fixture',{}])).digest('hex'));store.recover();assert.equal((await restarted.invoke('t1',{name:'fixture',input:{},requestId:'req2'})).status,'unknown');assert.equal(executions,1);
});
