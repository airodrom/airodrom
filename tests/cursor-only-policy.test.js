'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../src/cognitive-router'),P=require('../src/mission-worker-policy');
test('ordinary implementation and architecture narration select Cursor without special syntax',()=>{
 for(const text of ['Edit README.md.','Cursor should handle this: edit README.md.','OpenCode plans; edit README.md; OpenCode evaluates.','Edit only README.md and report READY.'])assert.equal(R.requestedWorker(text),'cursor');
 for(const text of ['Use OpenCode to edit README.md.','Edit README.md without Cursor.','Use host to edit README.md.'])assert.throws(()=>R.requestedWorker(text),/CURSOR_IMPLEMENTATION_REQUIRED/);
 assert.throws(()=>R.requestedWorker('Edit README.md.',{cursorDisabled:true}),/CURSOR_EXECUTION_DISABLED/);
});
test('all coding dispatch routes require Cursor and a sealed planning contract; read-only and noncoding remain allowed',()=>{
 const base={kind:'coding',preferred_agent:'cursor',fallback_agents:[],cognitive:{sealed:{},proposal:{tasks:[{operation:'edit',worker:'cursor'}]}}};P.assertImplementation(base);
 for(const worker of ['opencode','claude_code','codex','host'])assert.throws(()=>P.assertImplementation({...base,preferred_agent:worker}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 assert.throws(()=>P.assertImplementation({...base,fallback_agents:['opencode']}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 assert.throws(()=>P.assertImplementation({...base,cognitive:null}),/CURSOR_PLANNING_REQUIRED/);
 P.assertImplementation({kind:'coding',preferred_agent:'host',dispatch_policy:{native_actions:[{name:'file_read'}]}});
 assert.throws(()=>P.assertImplementation({kind:'coding',preferred_agent:'host',dispatch_policy:{native_actions:[{name:'file_write'}]}}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 P.assertImplementation({kind:'conversation'});
});
test('legacy routing cannot fall back when Cursor is unavailable or disabled',()=>{
 const e={version:2,requested_worker:'auto',eligible_workers:['host','cursor','opencode']},p={files:['README.md'],tasks:[{operation:'edit'}]};
 assert.equal(R.route(e,p,['cursor','opencode']),'cursor');
 assert.throws(()=>R.route(e,p,['opencode']),/cognitive_worker_unqualified:cursor/);
 assert.throws(()=>R.route(e,p,['cursor','opencode'],{cursorDisabled:true}),/CURSOR_EXECUTION_DISABLED/);
});

test('only passed evidence or ordinary registered failures permit another corrective worker',()=>{
 const allow=require('../src/specialist-gateway').repairVerificationAllows,m={envelope:{cognitive:{envelope:{verification:['fixture-test']}},criteria:[{id:'registered-checks',type:'registered_checks'}]}};
 assert.equal(allow(m,{status:'passed',checks:[{id:'scope',status:'passed'}]}),true);
 assert.equal(allow(m,{status:'failed',checks:[{id:'task:fixture-test',status:'failed'},{id:'registered-checks',status:'failed'},{id:'scope',status:'passed'}]}),true);
 for(const id of ['verifier_inputs_unchanged','protected_tests_unchanged','protected_files','requested_file_scope','runtime_provenance','security:secret_scan','task:unenrolled','unknown'])assert.equal(allow(m,{status:'failed',checks:[{id,status:'failed'}]}),false,id);
 assert.equal(allow(m,{status:'failed',checks:[{id:'task:fixture-test',status:'failed'},{id:'scope',status:'unavailable'}]}),false);
 assert.equal(allow(m,{status:'passed',checks:[]}),false);
});
