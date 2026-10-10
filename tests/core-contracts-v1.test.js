'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const path=require('node:path');
const contracts=require('../src/core-contracts');
const security=require('../src/runtime-security-conformance');
const install=require('../src/installation-compatibility');
const {fixture}=require('./fixtures/mission-fixture.cjs');

test('core contract manifest and validators reject invalid inputs while preserving historical records',()=>{
 assert.equal(contracts.intact(),true);
 const conversation=contracts.stamp('Conversation',{conversation_id:randomUUID(),channel:'browser',operator_id:'operator',include_memory:true});
 assert.equal(contracts.validate('Conversation',conversation).ok,true);
 assert.throws(()=>contracts.validate('Conversation',{...conversation,channel:'sms'}),/channel/i);
 assert.throws(()=>contracts.validate('ModelRequest',contracts.stamp('ModelRequest',{request_id:randomUUID(),model:'ollama/qwen',messages:[{role:'user',content:'hi'}],privacy:'local_only',mission_id:randomUUID()})),/agent|workspace|authority/i);
 const historical=contracts.annotateHistorical('Mission',{mission_id:randomUUID(),state:'completed',kind:'work'});
 assert.equal(historical.status,'historical_unversioned');
 assert.equal(historical.compatibility,'readable_without_rewrite');
 const mission=contracts.stamp('Mission',{mission_id:randomUUID(),state:'ready',kind:'work'});
 assert.equal(contracts.validate('Mission',mission).ok,true);
 assert.throws(()=>contracts.validate('VerificationEvidence',contracts.stamp('VerificationEvidence',{verification_id:randomUUID(),mission_id:randomUUID(),status:'passed',provenance:'worker_self_report'})),/self-report/i);
});

test('runtime security classifications are host-owned and fail closed on unproven properties',()=>{
 const report=security.evaluate(null);
 const ollama=report.items.find(i=>i.adapter==='ollama');
 assert.equal(ollama.kind,'model_provider');
 assert.equal(ollama.properties.workspace_confinement.state,'UNSUPPORTED');
 const opencode=report.items.find(i=>i.adapter==='opencode');
 assert.ok(['VERIFIED','UNVERIFIED'].includes(opencode.properties.cancellation.state));
 const blocked=security.failClosed(opencode,['credential_isolation']);
 assert.equal(blocked.allowed,false);
 const assignment=security.assignmentFromConformance(randomUUID(),'opencode','ollama/qwen3-coder:30b',opencode);
 assert.equal(assignment.contract.id,'airodrom.worker_assignment');
 assert.throws(()=>security.assignmentFromConformance(randomUUID(),'opencode','ollama/qwen3-coder:30b',opencode,{required:['credential_isolation']}),/verified credential_isolation/i);
});

test('installation compatibility detects components and blocks incompatible mutations',async t=>{
 const f=await fixture(t);
 const root=path.resolve(__dirname,'..');
 const status=install.evaluate(f.bridge,{root});
 assert.ok(['compatible','compatible_outdated','missing_evidence','mixed_source','incompatible'].includes(status.overall));
 assert.equal(status.readonly_diagnostics,true);
 assert.equal(status.recovery_access,true);
 assert.ok(status.components.some(c=>c.component==='mcp_contract'));
 assert.ok(status.components.some(c=>c.component==='core_daemon'&&c.state!=='missing_evidence'));
 assert.equal(install.compatiblePackage('1.0.0-rc.1','1.0.0-rc.1'),'compatible');
 assert.equal(install.compatiblePackage('0.9.0','1.0.0-rc.1'),'incompatible');
});

test('product overview and compatibility API expose contracts without credentials',async t=>{
 const f=await fixture(t);
 const overview=await require('../src/product-observability').overview(f.bridge,{includeMissions:false});
 assert.equal(overview.core_contracts.family,'airodrom.core_contracts');
 assert.ok(overview.runtime_security.items.length>=3);
 assert.ok(overview.installation_compatibility.components.length>=5);
 assert.doesNotMatch(JSON.stringify(overview.installation_compatibility),/token|password|sk-|Bearer/i);
 const ControlServer=require('../src/control-server');
 const server=new ControlServer(f.bridge,{port:0});await server.start();t.after(()=>server.close());
 const response=await fetch(server.origin+'/api/product/compatibility',{headers:{Authorization:'Bearer '+server.token}});
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.authority,false);
 assert.equal(body.contracts.schema_version,1);
 assert.ok(body.runtime_security.items.find(i=>i.adapter==='host'));
});
