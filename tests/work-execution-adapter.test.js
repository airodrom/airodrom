'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { WorkExecutionAdapter, REQUIRED, hash, surfaceDescriptor } = require('../src/work-execution-adapter');
const { fingerprint } = require('../src/control-plane-store');
const count = (f, table) => f.bridge.controlStore.db.prepare('SELECT count(*) n FROM ' + table).get().n;
const policy = { privacy: 'cloud_allowed', providers: ['codex_openai'], billing_classes: ['subscription'], task_category: 'focused_coding' };
const seal = value => { delete value.content_hash; value.content_hash = fingerprint(value); return value; };
async function setup(t, extra = {}) {
  const f = await fixture(t), calls = { launch: 0, collect: 0, cancel: 0, observe: 0 }, controls = { state: 'exited', response: { accepted: true, receipt: { thread_id: '12345678-1234-1234-1234-123456789abc' } }, ...extra };
  const m = f.create({ preferred_agent: 'codex', fallback_agents: [], dispatch_policy: policy });
  const surface = {
    descriptor: { id: 'work-test-surface', protocol: 'airodrom-work-surface-v1', runtime_id: 'work', mode: 'fixture', documentation: 'https://learn.chatgpt.com/docs/get-started-with-work', capabilities: [...REQUIRED] },
    resolveWorkspace: ({ handle, project_id, owner }) => ({ handle, project_id, owner, local_root: f.repo, private: true, approved: true }),
    launch: async packet => { calls.launch++; controls.packet = packet; if (controls.hang) return new Promise(() => {}); if (controls.response.accepted) fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'beta\n'); return controls.response; },
    collect: async () => { calls.collect++; return controls.returnValue || returned(controls.packet); },
    observe: async locator => { calls.observe++; return { runtime_id: 'work', run_id: locator.run_id, dispatch_id:locator.dispatch_id, attempt_id:locator.attempt_id, workspace_handle: locator.workspace.handle, surface_id: 'work-test-surface', state: controls.state, receipt: controls.lifecycleReceipt || 'lifecycle-fixture-1' }; },
    cancel: async () => { calls.cancel++; if (controls.cancelError) throw Error(controls.cancelError); if (controls.confirmCancel) controls.state = 'cancelled'; }
  };
  const adapter = new WorkExecutionAdapter(f.bridge, { surface }); f.bridge.workExecution = adapter;
  const input = { mission_id: m.id, request_id: 'work-test-request', workspace_handle: 'approved-fixture', timeout_ms: 60000, context_files: ['fixture.txt'] };
  return { f, m, adapter, surface, controls, calls, input };
}
function returned(p) {
  const artifact = { id: 'result-note', path: 'note.txt', type: 'text/plain', content: 'Harmless bounded fixture output\n', origin: { runtime_id: 'work', mission_id: p.mission_id, task_id: p.task_id, run_id: p.run_id, workspace_handle: p.workspace.handle, surface_id: 'work-test-surface' } };
  artifact.size = Buffer.byteLength(artifact.content); artifact.sha256 = hash(artifact.content);
  return seal({ version: 1, runtime_id: 'work', mission_id: p.mission_id, task_id: p.task_id, run_id: p.run_id, request_id: p.request_id, dispatch_id:p.dispatch_id, attempt_id:p.attempt_id, workspace: structuredClone(p.workspace), surface_id: 'work-test-surface', context_hash: p.context_hash, result: { status: 'completed', summary: 'Isolated Work transport fixture completed', changed_files: ['fixture.txt'], tests: [], limitations: [] }, artifacts: [artifact] });
}
test('default Work adapter reports implemented and unsupported; discovery does not mistake a named tool or unit fixture for live proof', async t => {
  const f = await fixture(t), c = f.bridge.workExecution.capabilities();
  assert.equal(c.runtime_id, 'work'); assert.equal(c.adapter_implemented, true); assert.equal(c.launcher_available, false); assert.equal(c.live_qualification_complete, false);
  assert.equal(c.transport_contract_ready,true);assert.equal(c.live_qualified,false);assert.equal(c.support_tier,'OPTIONAL');
  assert.equal(f.bridge.codexAdapter.health().work_execution.launcher_available, false);
  assert.throws(() => f.bridge.workExecution.prepare({ mission_id: f.create().id, request_id: 'unsupported', workspace_handle: 'private', timeout_ms: 10, context_files: [] }), /surface_unavailable/);
  assert.equal(count(f, 'cp_codex_handoffs'), 0); assert.equal(count(f, 'cp_work_bindings'), 0);
  assert.equal(surfaceDescriptor({ descriptor: { id: 'create_thread' } }), null);
});
test('return before dispatch, wrong mission and stale artifact attempt cannot enter the inbox',async t=>{
 const {f,adapter,input,controls}=await setup(t);const b=adapter.prepare(input);await assert.rejects(adapter.collect(b.run_id),/not_dispatched/);await adapter.dispatch(b.run_id);
 for(const change of [v=>v.mission_id='other-mission',v=>v.attempt_id='stale-attempt',v=>v.dispatch_id='wrong-dispatch']){const value=returned(controls.packet);change(value);controls.returnValue=seal(value);await assert.rejects(adapter.collect(b.run_id));assert.equal(count(f,'cp_result_inbox'),0);}
});
test('transport rejection, duplicate report and stale report retain canonical outcome rules',async t=>{
 const {f,adapter,input,controls,calls}=await setup(t,{response:{accepted:false,code:'rejected_by_transport'}});const b=adapter.prepare(input);
 assert.throws(()=>f.bridge.agentDispatch.report({dispatch_id:b.run_id,attempt_id:'unclaimed',outcome:{accepted:true}}),/Unknown/);
 await adapter.dispatch(b.run_id);const d=f.bridge.agentDispatch.get(b.run_id);assert.equal(d.last_outcome.classification,'rejected_by_transport');
 assert.equal(f.bridge.agentDispatch.report({dispatch_id:d.dispatch_id,attempt_id:d.active_attempt_id,outcome:controls.response}).duplicate,true);
 assert.throws(()=>f.bridge.agentDispatch.report({dispatch_id:d.dispatch_id,attempt_id:d.active_attempt_id,outcome:{accepted:true}}),/conflict/);assert.equal(calls.launch,1);
});
test('supported port discovery separates launcher, workspace, return, lifecycle, cancel, and live qualification', async t => {
  const { adapter, surface } = await setup(t);
  const c = adapter.capabilities(); assert.deepEqual(c.missing, []); assert.equal(c.live_qualification_complete, false);
  delete surface.collect; assert.equal(adapter.capabilities().artifact_return_available, false); assert.equal(adapter.capabilities().launcher_available, true);
  assert.throws(() => adapter.requireSurface(), /unavailable/);
});
test('opaque approved workspace binds project and owner; outbound packet includes only selected bounded context and no host paths', async t => {
  const { f, adapter, surface, input } = await setup(t);
  assert.throws(() => adapter.prepare(input, 'mcp'), /operator/);
  for (const delta of [{ private: false }, { approved: false }, { project_id: 'other' }, { owner: 'other' }, { local_root: f.root }, { handle: 'other' }]) {
    surface.resolveWorkspace = () => ({ handle: input.workspace_handle, project_id: f.bridge.projects.listProjects()[0].projectId, owner: 'operator', local_root: f.repo, private: true, approved: true, ...delta });
    assert.throws(() => adapter.prepare(input), /workspace_not_approved/);
  }
  surface.resolveWorkspace = ({ handle, project_id, owner }) => ({ handle, project_id, owner, local_root: f.repo, private: true, approved: true });
  assert.throws(() => adapter.prepare({ ...input, context_files: ['tests/fixture.test.cjs'] }), /scope/);
  const b = adapter.prepare(input); assert.equal(b.packet.context.files.length, 1); assert.equal(b.packet.context.files[0].content, 'alpha\n');
  assert.equal(JSON.stringify(b.packet).includes(f.root), false); assert.equal(JSON.stringify(b.packet).includes('result_publication'), false); assert.equal(JSON.stringify(b.packet).includes('policy_ref'), false);
});
test('artifact round-trip enters canonical untrusted inbox; trusted termination then independent verification then Acceptance then Settlement', async t => {
  const { f, m, adapter, input, controls } = await setup(t, { state: 'running' });
  const b = adapter.prepare(input); assert.equal((await adapter.dispatch(b.run_id)).state, 'accepted');
  assert.equal((await adapter.collect(b.run_id)).state, 'termination_unverified');
  assert.equal(count(f, 'cp_result_inbox'), 1); assert.equal(count(f, 'cp_artifacts'), 1); assert.equal(count(f, 'cp_acceptances'), 0); assert.equal(count(f, 'cp_mission_settlements'), 0);
  assert.equal(f.bridge.controlStore.run(b.run_id).termination_verified, 0);
  assert.throws(() => f.bridge.missions.program.settle(m.id, 'accept'), /Acceptance/);
  controls.state = 'exited'; await adapter.observe(b.run_id); const ready = await f.settle(m.id);
  assert.equal(ready.verifications[0].result, 'passed'); assert.equal(count(f, 'cp_acceptances'), 0); adapter.assertEvidence(m.id);
  const resolver = adapter.surface.resolveWorkspace; adapter.surface.resolveWorkspace = args => ({ ...resolver(args), approved: false });
  assert.throws(() => adapter.assertEvidence(m.id), /workspace/); adapter.surface.resolveWorkspace = resolver;
  assert.equal(f.bridge.missions.program.dependencyReady(m.id, 'validated', f.root), false);
  const done = f.bridge.missions.accept(m.id, { request_id: 'work-fixture-accept', verification_id: ready.verifications[0].id, decision: 'accept', rationale: 'Explicit isolated fixture Acceptance after independent checks' });
  assert.equal(done.state, 'completed'); assert.equal(count(f, 'cp_acceptances'), 1);
  assert.equal(f.bridge.missions.program.dependencyReady(m.id, 'settled', f.root), true);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT state FROM cp_mission_settlements WHERE mission_id=?').get(m.id).state, 'settled');
  assert.equal(adapter.capabilities().live_qualification_complete, false); assert.equal(f.inference(), 0);
  surfaceModeCannotPromote(adapter, f, b);
});
function surfaceModeCannotPromote(adapter, f, b) {
  assert.throws(() => f.bridge.controlStore.db.prepare("UPDATE cp_work_bindings SET mode='live' WHERE run_id=?").run(b.run_id), /Immutable/);
  adapter.surface.descriptor.mode = 'live';
  assert.equal(new WorkExecutionAdapter(f.bridge, { surface: adapter.surface }).capabilities().live_qualification_complete, false);
  adapter.surface.descriptor.mode = 'fixture';
}
test('artifact origin, hash, type, size, duplicates, traversal, and unsupported metadata fail closed without retaining content', async t => {
  const { f, adapter, input, controls } = await setup(t); const b = adapter.prepare(input); await adapter.dispatch(b.run_id);
  const changes = [v => v.workspace.handle = 'other', v => v.run_id = 'other', v => v.runtime_id = 'pi', v => v.context_hash = 'other', v => v.artifacts[0].sha256 = '0'.repeat(64), v => v.artifacts[0].size++, v => v.artifacts[0].type = 'application/octet-stream', v => delete v.artifacts[0].origin, v => v.artifacts[0].origin.workspace_handle = 'other', v => v.artifacts.push(v.artifacts[0]), v => v.artifacts[0].path = '../outside', v => v.accepted = true, v => v.result.changed_files = ['outside.txt']];
  for (const change of changes) { const v = returned(controls.packet); change(v); controls.returnValue = seal(v); await assert.rejects(adapter.collect(b.run_id)); assert.equal(count(f, 'cp_artifacts'), 0); assert.equal(count(f, 'cp_result_inbox'), 0); }
  controls.returnValue = { ...returned(controls.packet), content_hash: 'wrong' }; await assert.rejects(adapter.collect(b.run_id), /hash/);
});
test('minimum context and returned secret or credential argument reject before persistence or relay; raw launch errors never persist', async t => {
  const { f, adapter, surface, input, controls } = await setup(t);
  const seed = 'crsr_fixtureSecretOnly987654321'; fs.writeFileSync(path.join(f.repo, 'fixture.txt'), seed);
  assert.throws(() => adapter.prepare(input), /sensitive/); assert.equal(count(f, 'cp_work_bindings'), 0); fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'alpha\n');
  // The canonical snapshot includes file metadata. Freeze the restored fixture
  // in a new mission rather than weakening the existing preservation guard.
  const clean = f.create({ objective: 'Clean restored bounded Work fixture', preferred_agent: 'codex', fallback_agents: [], dispatch_policy: policy });
  const b = adapter.prepare({ ...input, mission_id: clean.id }); assert.equal((await adapter.dispatch(b.run_id)).state, 'accepted');
  for (const content of [seed, '--api-key fixturePlainSecret', '/Users/owner/private/credentials.json']) {
    const v = returned(controls.packet); v.artifacts[0].content = content; v.artifacts[0].size = Buffer.byteLength(content); v.artifacts[0].sha256 = hash(content); controls.returnValue = seal(v);
    await assert.rejects(adapter.collect(b.run_id));
  }
  assert.equal(count(f, 'cp_artifacts'), 0); assert.equal(count(f, 'cp_result_inbox'), 0);
  surface.resolveWorkspace = () => { throw Error(seed); };
  await assert.rejects(adapter.collect(b.run_id), error => error.message === 'work_workspace_not_approved');
  const persisted = f.bridge.controlStore.db.prepare('SELECT packet FROM cp_work_bindings').all().map(r => r.packet).join(''); assert.equal(persisted.includes(seed), false);
  const source = fs.readFileSync(require.resolve('../src/apps/work-execution-adapter'), 'utf8'); assert.equal(/(?:spawn|execFile|execSync)\s*\(/.test(source), false);
  assert.equal(source.includes('process.env.CURSOR'), false); assert.equal(source.includes('process.env.OPENAI'), false);
});
test('retry reuses canonical idempotency key; duplicate prepare conflicts and unknown transport outcome cannot relaunch', async t => {
  const { f, adapter, input, controls, calls } = await setup(t, { response: { accepted: false, code: 'temporarily_unavailable', message: 'credential diagnostic must be discarded' } });
  const b = adapter.prepare(input); assert.equal(adapter.prepare(input).duplicate, true);
  assert.throws(() => adapter.prepare({ ...input, context_files: [] }), /idempotency/);
  assert.equal((await adapter.dispatch(b.run_id)).state, 'retry_wait'); const key = controls.packet.idempotency_key;
  let clock = Date.now() + 31000; adapter.now = () => clock; f.bridge.agentDispatch.now = () => clock;
  await f.bridge.agentDispatch.reconcile(); controls.response = { accepted: true }; assert.equal((await adapter.dispatch(b.run_id)).state, 'accepted'); assert.equal(controls.packet.idempotency_key, key);
  assert.equal((await adapter.dispatch(b.run_id)).state, 'existing_dispatch'); assert.equal(calls.launch, 2);
  assert.equal(JSON.stringify(f.bridge.agentDispatch.get(b.run_id)).includes('credential diagnostic'), false);
});
test('timeout preserves unknown writer ownership; cancellation acknowledgement cannot release a writer without correlated observed termination', async t => {
  const { f, adapter, input, controls, calls } = await setup(t, { hang: true, state: 'running', cancelError: 'crsr_fixtureDoNotPersist12345' });
  const clock = Date.now(); adapter.now = () => clock;
  const b = adapter.prepare({ ...input, timeout_ms: 20 }); assert.equal((await adapter.dispatch(b.run_id)).state, 'running_unknown');
  await adapter.cancel(b.run_id); assert.equal(calls.launch, 1); assert.equal(f.bridge.controlStore.run(b.run_id).termination_verified, 0);
  assert(f.bridge.controlStore.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state IN ('held','quarantined')").get(b.run_id));
  controls.cancelError = null; controls.confirmCancel = true; await adapter.cancel(b.run_id);
  assert.equal(f.bridge.controlStore.run(b.run_id).termination_verified, 1); assert.equal(f.bridge.controlStore.run(b.run_id).state, 'cancelled'); assert.equal(count(f, 'cp_acceptances'), 0);
});
test('cross-workspace change or lifecycle spoof cannot collect, terminate, or accept', async t => {
  const { f, adapter, surface, input, controls } = await setup(t); const b = adapter.prepare(input); await adapter.dispatch(b.run_id);
  const resolver = surface.resolveWorkspace; surface.resolveWorkspace = args => ({ ...resolver(args), local_root: f.root }); await assert.rejects(adapter.collect(b.run_id), /workspace/); surface.resolveWorkspace = resolver;
  surface.observe = async () => ({ runtime_id: 'work', run_id: b.run_id, workspace_handle: 'different-workspace', surface_id: 'work-test-surface', state: 'exited', receipt: 'claim' });
  await assert.rejects(adapter.collect(b.run_id), /origin/); assert.equal(f.bridge.controlStore.run(b.run_id).termination_verified, 0); assert.equal(count(f, 'cp_acceptances'), 0);
});
test('artifact mutation after return blocks canonical Acceptance; duplicate collection is immutable and restart keeps binding', async t => {
  const { f, m, adapter, surface, input, controls, calls } = await setup(t); const b = adapter.prepare(input); await adapter.dispatch(b.run_id); await adapter.collect(b.run_id); const ready = await f.settle(m.id);
  await adapter.collect(b.run_id); assert.equal(count(f, 'cp_result_inbox'), 1); assert.equal(count(f, 'cp_artifacts'), 1);
  controls.returnValue = returned(controls.packet); controls.returnValue.result.summary = 'conflict'; seal(controls.returnValue); await assert.rejects(adapter.collect(b.run_id), /conflict/);
  const row = f.bridge.controlStore.db.prepare('SELECT id,metadata FROM cp_artifacts').get(), metadata = JSON.parse(row.metadata); metadata.content = 'changed'; f.bridge.controlStore.db.prepare('UPDATE cp_artifacts SET metadata=? WHERE id=?').run(JSON.stringify(metadata), row.id);
  assert.throws(() => f.bridge.missions.accept(m.id, { request_id: 'tampered-accept', verification_id: ready.verifications[0].id, decision: 'accept', rationale: 'Must reject changed artifact' }), /hash/);
  assert.equal(count(f, 'cp_acceptances'), 0);
  await f.reopen(); const reopened = new WorkExecutionAdapter(f.bridge, { surface }); assert.equal(reopened.binding(b.run_id).packet.context_hash, b.packet.context_hash); assert.equal(reopened.capabilities().live_qualification_complete, false); assert.equal(calls.launch, 1);
});
test('untrusted content-derived Work artifact IDs never determine canonical artifact identity',async t=>{
  const {f,adapter,input,controls}=await setup(t),binding=adapter.prepare(input);await adapter.dispatch(binding.run_id);
  const value=returned(controls.packet);value.artifacts[0].id=hash(value.artifacts[0].content);controls.returnValue=seal(value);
  await adapter.collect(binding.run_id);const row=f.bridge.controlStore.db.prepare('SELECT * FROM cp_artifacts').get();
  assert.match(row.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(row.id,fingerprint([binding.run_id,value.artifacts[0].id]));
  assert.equal(JSON.parse(row.metadata).external_label,value.artifacts[0].id);assert.equal(Object.hasOwn(JSON.parse(row.metadata),'id'),false);
  await adapter.collect(binding.run_id);assert.equal(count(f,'cp_artifacts'),1);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT id FROM cp_artifacts').get().id,row.id);
});
test('Work artifact dedupe preserves an existing opaque identity by run and path',async t=>{
  const {f,adapter,input,controls}=await setup(t),binding=adapter.prepare(input);await adapter.dispatch(binding.run_id);
  const value=returned(controls.packet),artifact=value.artifacts[0],id=require('node:crypto').randomUUID();
  const {id:external_label,...payload}=artifact;
  f.bridge.controlStore.db.prepare('INSERT INTO cp_artifacts VALUES(?,?,?,?,?,?,?)').run(id,binding.mission_id,binding.run_id,artifact.type,'work-artifact:'+artifact.id,JSON.stringify({...payload,external_label,workspace:binding.packet.workspace,untrusted:true}),1);
  await adapter.collect(binding.run_id);assert.equal(count(f,'cp_artifacts'),1);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT id FROM cp_artifacts').get().id,id);
});
test('Work provider lifecycle labels cannot determine canonical receipt identity',async t=>{
  const label=hash('Fixture content-derived lifecycle label'),{f,adapter,input}=await setup(t,{lifecycleReceipt:label}),binding=adapter.prepare(input);
  await adapter.dispatch(binding.run_id);await adapter.collect(binding.run_id);
  const receipt=f.bridge.controlStore.db.prepare('SELECT * FROM cp_work_receipts WHERE run_id=?').get(binding.run_id);
  assert.match(receipt.lifecycle_ref,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(receipt).includes(label),false);
  await adapter.observe(binding.run_id);assert.equal(f.bridge.controlStore.db.prepare('SELECT lifecycle_ref FROM cp_work_receipts WHERE run_id=?').get(binding.run_id).lifecycle_ref,receipt.lifecycle_ref);
});
test('Work binding reads fail closed while identity migration is incomplete',async t=>{
  const {f,adapter,input}=await setup(t),binding=adapter.prepare(input),db=f.bridge.controlStore.db;
  require('../src/memory-identity').install(db);db.prepare("UPDATE memory_identity_progress SET state='failed',safe_error_class='identity_migration_failed' WHERE id=1").run();
  assert.throws(()=>adapter.binding(binding.run_id),/identity|migration/i);
});
test('Work external hash labels stay erasable payload after identity migration and disappear on scoped erasure',async t=>{
  const {f,m,adapter,input,controls}=await setup(t),binding=adapter.prepare(input);await adapter.dispatch(binding.run_id);
  const value=returned(controls.packet),label=hash(value.artifacts[0].content);value.artifacts[0].id=label;controls.returnValue=seal(value);
  await adapter.collect(binding.run_id);await f.settle(m.id);
  const memory=f.bridge.personalMemory.remember({domain:'session',taskId:binding.packet.task_id,type:'fact',subject:'artifact erasure owner',content:'Fixture task ownership',source:'user_explicit'});
  assert.equal(require('../src/memory-identity').migrate(f.bridge.controlStore.db).state,'complete');adapter.assertEvidence(m.id);
  f.bridge.personalMemory.erase(memory.memoryId);
  const retained=JSON.stringify(f.bridge.controlStore.db.prepare('SELECT * FROM cp_artifacts').all());
  assert.equal(retained.includes(label),false);assert.equal(retained.includes('external_label'),false);assert.equal(retained.includes(value.artifacts[0].content),false);
  const consumed=fs.readFileSync(path.join(f.bridge.dataDir,'codex-results',binding.run_id,'consumed.json'),'utf8');
  for(const payload of [label,value.content_hash,value.artifacts[0].content,value.result.summary])assert.equal(consumed.includes(payload),false);
  assert.equal(JSON.parse(consumed).content_state,'erased');assert.equal(JSON.parse(consumed).run_id,binding.run_id);
  assert.equal(adapter.binding(binding.run_id).packet.content_state,'erased');
});
