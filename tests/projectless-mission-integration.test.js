'use strict';
// Projectless V1 scope/approval contracts remain inspectable, but current
// implementation requires a sealed OpenCode plan; approval alone is insufficient.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs'),{McpTools}=require('../src/mcp-tools');
const sandbox=require('../src/projectless-sandbox'),permissions=require('../src/mission-permissions');
const work=worker=>({version:1,worker,files:[{path:'first.txt',content:'one\n'},{path:'nested/second.txt',content:'two\n'}]});
for(const worker of ['opencode','cursor'])test(worker+': host verifier reads stay separate from worker write scope',t=>{
 const spec=work(worker),{workspace}=sandbox.allocate();t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));sandbox.seedWork(workspace,spec);
 const input=sandbox.workMissionInput(workspace,randomUUID(),spec,{externalConfirmed:worker==='cursor'}),authority=permissions.normalizeAuthority(input.authority,{workspace,operator:true});
 for(const name of ['git_status','git_diff','vscode_run_task'])assert.equal(permissions.checkAuthority(authority,permissions.callRequirements({toolName:'capability',input:{name,input:{repo:workspace}}},workspace)).allow,true);
 for(const file of ['TASK.md','tests/projectless-files.test.cjs','.vscode/tasks.json','unlisted.txt'])assert.equal(permissions.checkAuthority(authority,{filesystem:{write:[path.join(workspace,file)]}}).allow,false);
 assert.equal(permissions.checkAuthority(authority,{filesystem:{read:[path.dirname(workspace)]}}).allow,false);
});
for(const natural of [false,true])test('unplanned projectless '+(natural?'natural language':'WORK_V1')+' cannot issue approval or start a Cursor writer',async t=>{
 const f=await fixture(t),b=f.bridge,mcp=new McpTools(b),spec=work('cursor'),request_id=randomUUID();b.hostExecutionPolicy.enableCursor({confirmed:true,request_id:randomUUID()},'operator');
 const objective=natural?'Use Cursor only in a new disposable workspace to create exactly two files:\n'+spec.files.map(f=>f.path+': '+JSON.stringify(f.content)).join('\n'):sandbox.WORK_MARKER+'\n'+JSON.stringify(spec);
 const prepared=await mcp.call('prepare_mission',{request_id,objective}),record=b.zeroSetupWork.read(request_id);t.after(()=>fs.rmSync(record.workspace,{recursive:true,force:true}));
 assert.equal(prepared.state,'BLOCKED');assert.equal(prepared.code,'CURSOR_PLANNING_REQUIRED');assert.equal(prepared.execution_authorized,false);
 const inspected=await mcp.call('inspect_mission_proposal',{request_id});assert.deepEqual(inspected.proposal.files,spec.files.map(f=>f.path));assert.equal(inspected.proposal.worker,'cursor');assert.equal(inspected.approval.standard_approval_supported,false);
 await assert.rejects(b.zeroSetupWork.approve({request_id,confirmed:true,channel:'control_center',subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:10000}},'operator'),/not awaiting approval/);
 assert.equal((await mcp.call('prepare_mission',{request_id,objective})).code,'CURSOR_PLANNING_REQUIRED');
 for(const table of ['cp_missions','cp_mission_approvals','cp_runs','cp_dispatches','cp_leases'])assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
 assert.equal(fs.existsSync(path.join(record.workspace,'first.txt')),false);
});
test('legacy projectless contract still binds every exact file and refuses borrowed or changed approval scope',async t=>{
 const f=await fixture(t),b=f.bridge,spec=work('cursor'),{workspace}=sandbox.allocate();t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));sandbox.seedWork(workspace,spec);
 b.hostExecutionPolicy.enableCursor({confirmed:true,request_id:randomUUID()},'operator');
 const m=b.missions.create(sandbox.workMissionInput(workspace,randomUUID(),spec,{externalConfirmed:true}),'operator'),c=m.envelope.contract;
 assert.equal(m.project_id,null);assert.equal(m.goal_id,null);assert.equal(c.execution.preferred_worker,'cursor');assert.equal(c.execution.fallback_worker,null);
 assert.deepEqual(c.permissions.allowed_write_paths,spec.files.map(f=>f.path).sort());assert.equal(c.permissions.personal_memory.mode,'none');assert.equal(c.permissions.vault_access.mode,'none');
 const digest=v=>createHash('sha256').update(v).digest('hex');assert.deepEqual(c.verification.acceptance_criteria.map(c=>[c.path,c.bytes,c.content_sha256]),spec.files.map(f=>[f.path,Buffer.byteLength(f.content),digest(f.content)]));
 const approval=b.missionApprovals.issue({request_id:randomUUID(),channel:'control_center',contract:c,confirmed:true,subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:10000}},'operator');
 const changed=structuredClone(c);changed.verification.acceptance_criteria[1].content_sha256=digest('wrong\n');changed.scope_fingerprint=require('../src/mission-contract').fingerprintOf(changed);
 assert.throws(()=>b.missionApprovals.assertBindable(approval.approval_id,{contract:changed,workspace}),/scope_mismatch/);
 assert.throws(()=>b.missionApprovals.assertBindable(approval.approval_id,{contract:c,workspace:path.dirname(workspace)}),/scope_mismatch/);
 b.missionApprovals.bind(approval.approval_id,m.id,'operator');assert.throws(()=>b.missions.dispatch(m.id,{request_id:randomUUID()}),/CURSOR_PLANNING_REQUIRED/);
 assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_runs').get().n,0);
});
