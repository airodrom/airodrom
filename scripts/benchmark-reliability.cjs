#!/usr/bin/env node
'use strict';
const {performance}=require('node:perf_hooks'),{fixture}=require('../tests/fixtures/mission-fixture.cjs'),{manifest}=require('../tests/fixtures/opencode-fixture.cjs');
async function main(){
 const cleanup=[],t={after:f=>cleanup.push(f)};let report;
 try{const f=await fixture(t),b=f.bridge,m=f.create({task_type:'local_files',manifest:manifest(f.repo),dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]}});
 const start=performance.now(),g=b.missions.goalPlanner.create({request_id:'benchmark-goal',goal_id:m.goal_id,max_runtime_hours:1,max_attempts:1,stages:[{id:'one',depends_on:[],mission_id:m.id,objective:'Synthetic performance',acceptance_criteria:['Host check'],verification_requirements:['Registered test']}]});const planning=performance.now()-start;
 const sample=fn=>{const times=[];for(let i=0;i<20;i++){const a=performance.now();fn();times.push(performance.now()-a);}times.sort((a,b)=>a-b);return{p50_ms:times[10],p95_ms:times[19]};};
 const context=sample(()=>b.controlContext.build(b.controlStore.requireMission(m.id))),continuation=sample(()=>b.missions.goalPlanner.inspect(g.id));
 const db=b.controlStore.db,bytes=()=>db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;const before=bytes();
 for(let i=0;i<100;i++)b.controlStore.event('provider.request.failed',m.id,{error_class:'provider_unavailable',authority:false});
 const after=bytes(),trace=sample(()=>require('../src/mission-flight-recorder').flightRecorder(b,{missionId:m.id,limit:200}));
 report={evidence_class:'DISPOSABLE_FIXTURE',planning_ms:planning,goal_inspection:continuation,context_assembly:context,trace_projection:trace,trace_storage_bytes_per_event:(after-before)/100,database_bytes:after,process_rss_bytes:process.memoryUsage().rss,worker_peak_memory_bytes:null,model_invocations:0,model_execution_cost:0,recurring_services_added:0,budgets:{milestones:40,trace_page_events:200,evaluation_timeout_ms:120000,evaluation_output_bytes:1048576}};
 }finally{for(const fn of cleanup.reverse())await fn();}
 console.log(JSON.stringify(report,null,2));
}
main().catch(()=>{console.error('Synthetic performance benchmark failed');process.exitCode=1;});
