'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { intro, help, interactive } = require('../src/interactive-cli');
const local = require('../src/local-bootstrap');
const ControlServer = require('../src/control-server');
const { PassThrough, Readable } = require('node:stream');
async function conversationFixture(t) {
  const r = runtime(t), f = await fixture(t, { opencode: r.options });
  const home = path.join(f.root, 'cli'); local.privateDirectory(home, true);
  // Reuse fixture data with a canonical private home; no real operator data.
  const b = f.bridge, old = b.dataDir; b.dataDir = local.privateDirectory(path.join(home, 'data'), true);
  const server = new ControlServer(b, { port: 0, conversationOptions: require('./fixtures/direct-conversation-fixture.cjs').conversationOptions() }); const address = await server.start();
  local.writePrivate(path.join(b.dataDir, 'ui.json'), { ...address, pid: process.pid });
  fs.writeFileSync(path.join(b.dataDir, 'bridge.lock'), String(process.pid), { mode: 0o600 });
  t.after(async () => { await server.close(); b.dataDir = old; });
  return { ...f, home, server, b, ask: async (message = 'What is my test codename?', options = {}) => {
    const m = b.missions.createConversation({ request_id: require('node:crypto').randomUUID(), message, include_memory: true, ...options });
    b.missions.dispatch(m.mission_id, { request_id: 'ask:' + m.mission_id });
    const done = await f.settle(m.mission_id); return { m, done, task: b.tasks.get(m.task_id) };
  } };
}
test('compact brand, no-color and command help are available without bootstrap', () => {
  assert.match(intro(), /AIRODROM/);
  assert.doesNotMatch(intro({ color: false, unicode: false }), /\x1b|◈/);
  assert.match(intro({ color: true }), /\x1b/);
  for (const command of ['status', 'start', 'stop', 'restart', 'open', 'memory', '/remember', '/forget', '/runtime', '/quit']) assert.ok(help().includes(command));
  const r = spawnSync(process.execPath, ['scripts/airodrom.cjs', '--help'], { cwd: local.ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, NO_COLOR: '1' } });
  assert.equal(r.status, 0); assert.match(r.stdout, /Interactive terminal/); assert.doesNotMatch(r.stdout, /#token=|Bearer /);
});
test('private directories/config reject public modes, symlinks and credential mismatches', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-private-'))); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(home, 0o700); local.privateDirectory(home);
  const file = path.join(home, 'config.json'); local.writePrivate(file, { synthetic: true }); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644); assert.throws(() => local.ownedJSON(file), /private JSON/); assert.throws(() => local.writePrivate(file, {}));
  fs.chmodSync(home, 0o755); assert.throws(() => local.privateDirectory(home), /private/); fs.chmodSync(home, 0o700);
  fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file); assert.throws(() => local.ownedJSON(file));
});
test('runtime qualification fails closed for missing runtime, wrong model and modified pins', async () => {
  await assert.rejects(local.qualify({ executable: '/missing-opencode' }), /not ready/);
  await assert.rejects(local.qualify({ adapter: { readiness: async () => ({ ready: true, version: '2.0.25' }), executable: () => process.execPath }, model: 'ollama/unqualified' }), /qualified local runtime/);
  assert.throws(() => local.validatePins({ version: 1, executables: [] }), /pins are invalid/);
});
test('stopped lifecycle is idempotent and missing discovery never hides a live writer', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-stopped-'))); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(home, 0o700); local.privateDirectory(path.join(home, 'data'), true);
  assert.equal(local.isStopped(home), true); assert.deepEqual(await local.stop(home), { stopped: true });
  const result = spawnSync(process.execPath, ['scripts/airodrom.cjs', 'status'], { cwd: local.ROOT, env: { PATH: process.env.PATH, AIRODROM_HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /stopped/);
  fs.writeFileSync(path.join(home, 'data/bridge.lock'), String(process.pid), { mode: 0o600 });
  assert.equal(local.isStopped(home), false); await assert.rejects(local.stop(home));
  assert.equal(fs.readFileSync(path.join(home, 'data/bridge.lock'), 'utf8'), String(process.pid));
});
test('bounded default OpenCode Mission has no tools, exact budget, signed authority and independent review', async t => {
  const f = await conversationFixture(t), { m, done, task } = await f.ask();
  const e = done.envelope;
  assert.equal(e.preferred_agent, 'opencode'); assert.deepEqual(e.allowed_files, []); assert.deepEqual(e.capability_scopes, []); assert.deepEqual(e.authority.filesystem, { read: [], write: [] });
  assert.deepEqual(e.authority.permissions.network, ['localhost']); assert.deepEqual(e.authority.permissions.secrets, []);
  assert.equal(e.manifest.budget.max_prompt_turns, 1); assert.equal(e.manifest.budget.max_memory_injections, 1); assert.equal(done.program_contract.signed, true);
  assert.equal(done.verifications[0].result, 'operator_review'); assert.equal(done.acceptance.length, 0); assert.equal(done.runs.find(r => r.agent_id === 'opencode').termination_verified, 1);
  assert.equal(task.lastResult, 'unavailable'); assert.equal(f.calls(), 0);
  assert.throws(() => f.b.missions.dispatch(m.mission_id, { request_id: 'again' }), /cannot dispatch|one turn/);
  assert.throws(() => f.b.missions.createConversation({ request_id: 'model', message: 'work', runtime: 'cloud' }), /Invalid default/);
  assert.throws(() => f.b.missions.createConversation({ request_id: 'model', message: 'work' }, 'mcp'), /operator/);
  assert.throws(() => f.b.missions.program.settle(m.mission_id, 'accept'), /requires canonical Acceptance/);
  f.b.missions.accept(m.mission_id, { request_id: 'operator-review', verification_id: done.verifications[0].id, decision: 'accept', rationale: 'Synthetic answer reviewed', evidence: 'Unavailable is correct for an empty canonical memory store.' });
  assert.equal(f.b.missions.detail(m.mission_id).program_contract.settlement.state, 'settled');
  const denied = await f.b.invokeCapability(task.id, { name: 'file_write', input: { path: path.join(task.workspace, 'escape.txt'), content: 'no' }, requestId: 'no-write' }); assert.notEqual(denied.status, 'completed');
});
test('canonical remember, minimum delivery, correction, erased non-delivery and removed runtimes cannot receive memory', async t => {
  const f = await conversationFixture(t), remember = content => local.request(f.home, '/api/interactive/remember', { content });
  const old = await remember('My test codename is Silver Falcon.'); await remember('My unrelated preference is purple.');
  const first = await f.ask(); assert.equal(first.task.lastResult, 'My test codename is Silver Falcon.');
  assert.equal(f.b.controlContext.inspect(first.task.contextPackId).refs.length, 1);
  const current = await remember('My test codename is Golden Finch.'); assert.notEqual(current.memoryId, old.memoryId);
  assert.throws(() => f.b.opencodeAdapter.authorizedContext({ id: first.task.contextPackId, records: [{ subject: 'test codename', content: 'Silver Falcon' }] }), /erased|unavailable|context/i);
  assert.doesNotMatch((await local.request(f.home, '/api/interactive/task?mission_id='+first.m.mission_id)).summary, /Silver Falcon/);
  assert.doesNotMatch(f.b.snapshotTask(first.task).lastResult,/Silver Falcon/);
  assert.throws(()=>f.b.missions.accept(first.m.mission_id,{request_id:'stale-answer',verification_id:first.done.verifications[0].id,decision:'accept',rationale:'Synthetic stale answer',evidence:'Old response'}),/context|memory/i);
  const second = await f.ask(); assert.equal(second.task.lastResult, 'My test codename is Golden Finch.');
  await local.request(f.home, '/api/interactive/forget', { selection: current.memoryId });
  const third = await f.ask(); assert.equal(third.task.lastResult, 'unavailable'); assert.equal(f.b.controlContext.inspect(third.task.contextPackId).refs.length, 0);
  await assert.rejects(local.request(f.home, '/api/interactive/remember', { content: 'api_key=syntheticSensitiveToken' }), /Secret|sensitive/);
  await assert.rejects(local.request(f.home, '/api/interactive/forget', { selection: 'missing' }), /one current/);
  assert.throws(() => f.b.missions.createConversation({ request_id: 'removed-runtime', message: 'What is my test codename?', include_memory: true, runtime: 'pi' }), /Invalid default/);
  assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_runs WHERE agent_id = 'pi'").get().n, 0);
});
test('memory opt-out is enforced and browser prompt uses the same canonical Mission path', async t => {
  const f = await conversationFixture(t); await local.request(f.home, '/api/interactive/remember', { content: 'My test codename is Silver Falcon.' });
  const empty = await f.ask(undefined, { include_memory: false }); assert.equal(empty.task.lastResult, 'unavailable');
  const task = await local.request(f.home, '/api/tasks', { description: 'Synthetic browser question', includeSharedMemory: true });
  await local.request(f.home, '/api/memory', { taskId: task.id, shared: true, content: 'My test codename is Golden Finch.', kind: 'fact' });
  const receipt = await local.request(f.home, '/api/tasks/' + task.id + '/prompt', { message: 'What is my test codename?' });
  assert.equal(receipt.taskId, task.id); assert.ok(receipt.missionId); const done = await f.settle(receipt.missionId);
  assert.equal(done.envelope.kind, 'conversation'); assert.equal(f.b.tasks.get(task.id).lastResult, 'My test codename is Golden Finch.');
  assert.equal((await local.request(f.home, '/api/memory?taskId=' + task.id)).items[0].content, 'My test codename is Golden Finch.');
  const native = await local.request(f.home, '/api/tasks', { description: 'Scoped coding', workspace: f.repo });
  await assert.rejects(local.request(f.home, '/api/tasks/' + native.id + '/prompt', { message: 'Change code' }), /registered scoped Mission/);
});
test('no-argument terminal attaches without another writer and exposes only private current memory', async t => {
  const f = await conversationFixture(t), output = new PassThrough(); let text = ''; output.on('data', c => text += c);
  const before = f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_runs').get().n;
  const [first, second] = await Promise.all([local.start(f.home), local.start(f.home)]); assert.equal(first.pid, second.pid); assert.equal(first.pid, process.pid);
  await interactive(f.home, { input: Readable.from(['/remember My test codename is Silver Falcon.\n/memory test codename\nWhat is my test codename?\n/forget test codename\nWhat is my test codename?\n/quit\n']), output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  assert.match(text, /AIRODROM/); assert.match(text, /Silver Falcon/); assert.match(text, /unavailable/); assert.doesNotMatch(text, /\x1b|#token=|Bearer /);
  assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_runs').get().n, before);
  assert.equal(f.b.controlStore.db.prepare('SELECT count(*) n FROM cp_conversation_turns').get().n, 2);
  assert.equal(fs.existsSync(path.join(f.home, 'launch.lock')), false);
  await assert.rejects(local.stop(f.home), /not owned/);
});
test('active authority Memory V2 preserves bounded conversation selection and erasure', async t => {
  const f = await conversationFixture(t); qualifyCanonical(f.b);
  await local.request(f.home, '/api/interactive/remember', { content: 'My test codename is Silver Falcon.' });
  const result = await f.ask(); assert.equal(result.task.lastResult, 'My test codename is Silver Falcon.');
  assert.equal(f.b.opencodeAdapter.authorizedContext({ id: result.task.contextPackId }).records.length, 1);
  await local.request(f.home, '/api/interactive/remember', { content: 'My test codename is Golden Finch.' });
  assert.doesNotMatch((await local.request(f.home,'/api/interactive/task?mission_id='+result.m.mission_id)).summary,/Silver Falcon/);
  assert.doesNotMatch(f.b.snapshotTask(result.task).lastResult,/Silver Falcon/);
  assert.throws(()=>f.b.missions.accept(result.m.mission_id,{request_id:'stale-governed-answer',verification_id:result.done.verifications[0].id,decision:'accept',rationale:'Synthetic stale answer',evidence:'Old response'}),/context|memory/i);
  const optout = await f.ask(undefined, { include_memory: false }); assert.equal(f.b.opencodeAdapter.authorizedContext({ id: optout.task.contextPackId }).records.length, 0);
  await local.request(f.home, '/api/interactive/forget', { selection: 'test codename' });
  const gone = await f.ask(); assert.equal(gone.task.lastResult, 'unavailable');
  assert.equal(f.b.opencodeAdapter.authorizedContext({ id: gone.task.contextPackId }).records.length, 0);
});
test('managed graceful stop authenticates its owner even after a source update and preserves memory', async t => {
  const f = await conversationFixture(t);
  await local.request(f.home, '/api/interactive/remember', { content: 'My test codename is Silver Falcon.' });
  f.b.runtimeFingerprint.source_sha256 = '0'.repeat(64);
  await assert.rejects(local.status(f.home), /another source revision/);
  f.server.localShutdown = async () => { await f.server.close(); fs.unlinkSync(path.join(f.home, 'data/bridge.lock')); };
  assert.deepEqual(await local.stop(f.home), { stopped: true });
  assert.equal(f.b.personalMemory.search('test codename', { domain: 'personal' }).items.length, 1);
});
test('unsafe discovery and launch locks are preserved without sending requests to another endpoint', async t => {
  const f = await conversationFixture(t), file = path.join(f.home, 'data/ui.json'), original = local.ownedJSON(file);
  local.writePrivate(file, { ...original, url: original.url.replace('127.0.0.1', 'evil.invalid') });
  assert.throws(() => local.discovery(f.home), /invalid/);
  await assert.rejects(local.start(f.home), /live or unverified/); assert.match(local.ownedJSON(file).url, /evil.invalid/);
  local.writePrivate(file, original);
  local.writePrivate(path.join(f.home, 'data/control-credential.json'), { token: 'f'.repeat(64) });
  assert.throws(() => local.discovery(f.home), /invalid/);
});
test('registration rejects unbounded inputs, secrets and mutated task authority before inference', async t => {
  const f = await conversationFixture(t);
  assert.throws(() => f.b.missions.createConversation({ request_id: 'overbroad', message: 'test', shell: true }), /Unexpected|Invalid|Unknown/);
  assert.throws(() => f.b.missions.createConversation({ request_id: 'secret', message: 'api_key=syntheticSensitiveToken' }), /sensitive|secret/);
  const m = f.b.missions.createConversation({ request_id: 'mutated', message: 'test' }), task = f.b.tasks.get(m.task_id);
  task.mission.manifest.budget.max_memory_injections = 20;
  // Durable signed contract, not the task's transient manifest, is authoritative.
  assert.throws(() => f.b.missions.program.guardTask(task, { toolName: 'read', input: { path: '.' } }), /binding|scope|mismatch/i);
});
test('unqualified executable never runs for readiness or first-use qualification', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-untrusted-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const marker=path.join(root,'executed'),executable=path.join(root,'runtime');
  fs.writeFileSync(executable,'#!'+process.execPath+'\nrequire("node:fs").writeFileSync('+JSON.stringify(marker)+',"executed"); console.log("opencode v2.0.25");\n',{mode:0o700});
  const {OpenCodeAdapter}=require('../src/opencode-adapter');
  for(const pinsFile of [undefined,path.join(root,'missing-pins.json')]){const a=new OpenCodeAdapter(null,{enabled:true,executable,model:'ollama/qwen3-coder:30b',pinsFile});assert.equal((await a.readiness()).ready,false);assert.equal(fs.existsSync(marker),false);}
  await assert.rejects(local.qualify({executable}),/qualified local runtime/);assert.equal(fs.existsSync(marker),false);
  const changed=new OpenCodeAdapter(null,{enabled:true,executable,model:'ollama/qwen3-coder:30b'});changed.readiness=async()=>({ready:true});
  await assert.rejects(changed.execute({workspace:root,files:[],objective:'synthetic artifact replacement'}),/opencode_runtime_pins_changed/);assert.equal(fs.existsSync(marker),false);
});
test('terminal answers and memory cannot emit clipboard/display control sequences', async t => {
  const f=await conversationFixture(t),output=new PassThrough();let text='';output.on('data',c=>text+=c);
  await local.request(f.home,'/api/interactive/remember',{content:'My test codename is Silver Falcon.\u001b]52;c;c3ludGhldGlj\u0007\u001b[31m\u009b2J'});
  await interactive(f.home,{input:Readable.from(['/memory test codename\nWhat is my test codename?\n/quit\n']),output,env:{NO_COLOR:'1',TERM:'dumb'}});
  assert.match(text,/Silver Falcon/);assert.doesNotMatch(text,/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|c3ludGhldGlj/);
});
test('browser cancel aborts the registered active runtime; legacy pause/resume cannot alter its state', async t => {
  const f=await conversationFixture(t),task=await local.request(f.home,'/api/tasks',{description:'Synthetic cancellation'});
  const receipt=await local.request(f.home,'/api/tasks/'+task.id+'/prompt',{message:'conversation-timeout'});
  for(let i=0;i<200&&!f.b.opencodeAdapter.active.has(task.id);i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(f.b.opencodeAdapter.active.has(task.id),true);
  for(const action of ['pause','resume'])await assert.rejects(local.request(f.home,'/api/tasks/'+task.id+'/'+action,{}),/legacy pause\/resume/);
  assert.equal(f.b.missions.detail(receipt.missionId).state,'running');
  await local.request(f.home,'/api/tasks/'+task.id+'/cancel',{});
  for(let i=0;i<200&&f.b.opencodeAdapter.active.has(task.id);i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(f.b.opencodeAdapter.active.has(task.id),false);
  const done=f.b.missions.detail(receipt.missionId),run=done.runs.find(r=>r.agent_id==='opencode');
  assert.equal(done.state,'cancelled');assert.equal(run.termination_verified,1);assert.equal(run.process_state,'exited');assert.equal(done.acceptance.length,0);
  assert.equal(f.b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE run_id=? AND state IN ('held','quarantined')").get(run.id).n,0);
});
test('signed near-expiry conversation terminates inference at its absolute authority deadline', async t => {
  const f=await conversationFixture(t),realNow=Date.now;let m;
  try{Date.now=()=>realNow()-115000;m=f.b.missions.createConversation({request_id:'expiry-fixture',message:'conversation-timeout'});}finally{Date.now=realNow;}
  const expiry=f.b.missions.detail(m.mission_id).envelope.manifest.expires_at;
  f.b.missions.dispatch(m.mission_id,{request_id:'expiry-dispatch'});
  for(let i=0;i<200&&!f.b.opencodeAdapter.active.has(m.task_id);i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(f.b.opencodeAdapter.active.has(m.task_id),true);
  while(Date.now()<expiry+700)await new Promise(r=>setTimeout(r,25));
  assert.equal(f.b.opencodeAdapter.active.has(m.task_id),false);
  const done=f.b.missions.detail(m.mission_id),run=done.runs.find(r=>r.agent_id==='opencode');
  assert.equal(run.termination_verified,1);assert.equal(run.process_state,'exited');assert.equal(done.acceptance.length,0);assert.notEqual(done.state,'awaiting_acceptance');
});
test('local installer preserves an unrelated dangling command', t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-install-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'airodrom'),other=path.join(root,'absent-other-command');fs.symlinkSync(other,target);
  assert.throws(()=>require('../scripts/install-local.cjs').assertExistingCommand(target),/unrelated or invalid/);assert.equal(fs.readlinkSync(target),other);
});
test('expired canonical memory invalidates answer delivery and Acceptance without replaying its value', async t => {
  const f=await conversationFixture(t);
  f.b.rememberPersonalMemory({domain:'personal',type:'fact',subject:'test codename',content:'My test codename is Silver Falcon.',source:'user_explicit',sensitivity:'normal',expiresAt:Date.now()+3600000});
  const result=await f.ask();assert.match(result.task.lastResult,/Silver Falcon/);
  const clock=f.b.personalMemory.now;
  try {
    f.b.personalMemory.now=()=>Date.now()+3600001;
    assert.doesNotMatch((await local.request(f.home,'/api/interactive/task?mission_id='+result.m.mission_id)).summary,/Silver Falcon/);
    assert.doesNotMatch(f.b.snapshotTask(result.task).lastResult,/Silver Falcon/);
    assert.throws(()=>f.b.missions.accept(result.m.mission_id,{request_id:'expired-answer',verification_id:result.done.verifications[0].id,decision:'accept',rationale:'Synthetic expired answer',evidence:'Old response'}),/context|memory|erased/i);
  } finally {f.b.personalMemory.now=clock;}
});
test('corrected conversation values are suppressed across current browser, inbox, MCP and authority read projections', async t => {
  for(const governed of [false,true]){
    const f=await conversationFixture(t);if(governed)qualifyCanonical(f.b);
    await local.request(f.home,'/api/interactive/remember',{content:'My test codename is Silver Falcon.'});
    const result=await f.ask(),run=result.done.runs.find(r=>r.agent_id==='opencode');
    assert.match(JSON.stringify(f.b.resultInbox.list({run:run.id})),/Silver Falcon/);
    await local.request(f.home,'/api/interactive/remember',{content:'My test codename is Golden Finch.'});
    for(const route of ['/api/control-v2/mission?id='+result.m.mission_id,'/api/control-v2/result-inbox?run_id='+run.id,'/api/control-v2/events?taskId='+result.task.id])assert.doesNotMatch(JSON.stringify(await local.request(f.home,route)),/Silver Falcon/);
    assert.doesNotMatch(JSON.stringify(f.b.resultInbox.list({run:run.id})),/Silver Falcon/);
    assert.doesNotMatch(JSON.stringify(f.b.snapshotTask(result.task)),/Silver Falcon/);
    if(governed)for(const route of ['/api/control-v2/authority-result?id='+run.id,'/api/control-v2/authority-context?id='+result.task.contextPackId])assert.doesNotMatch(JSON.stringify(await local.request(f.home,route)),/Silver Falcon/);
    // Projection does not rewrite immutable result identity or retained audit history.
    assert.match(f.b.controlStore.db.prepare('SELECT result FROM cp_result_inbox WHERE run_id=?').get(run.id).result,/Silver Falcon/);
  }
});
test('accepted episode audit timestamps cannot become false secret alarms or runtime reference data', async t => {
  const f=await conversationFixture(t),a=qualifyCanonical(f.b),{manifest}=require('./fixtures/opencode-fixture.cjs');
  let stamp=Date.now();for(let i=0;i<20&&!require('../src/personal-memory').containsSecret(JSON.stringify({accepted_at:stamp}));i++)stamp++;
  assert.equal(require('../src/personal-memory').containsSecret(JSON.stringify({accepted_at:stamp})),true);
  const m=f.create({preferred_agent:'host',task_type:'local_files',manifest:manifest(f.repo),capability_scopes:['repo'],dispatch_policy:{task_category:'deterministic_files',privacy:'local_only',providers:['local'],billing_classes:['local'],native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]}});
  f.b.missions.dispatch(m.id,{request_id:'episode-source'});const done=await f.settle(m.id),clock=a.store.now;
  try{a.store.now=()=>stamp;f.b.missions.accept(m.id,{request_id:'episode-acceptance',verification_id:done.verifications[0].id,decision:'accept',rationale:'Synthetic exact-file evidence passed'});}finally{a.store.now=clock;}
  fs.writeFileSync(path.join(f.repo,'fixture.txt'),'alpha\n');
  const next=f.create({preferred_agent:undefined,objective:'Read current accepted synthetic mission history.',manifest:manifest(f.repo),target_domains:['mission_history']});
  const pack=f.b.controlContext.build(next),current=f.b.opencodeAdapter.authorizedContext({id:pack.id});
  const episode=current.records.find(r=>r.subject==='Accepted mission episode');assert.ok(episode);assert.doesNotMatch(episode.content,/accepted_at|evidence_hash/);
  assert.match(episode.content,/objective/);assert.doesNotMatch(JSON.stringify(pack.reference_data),/accepted_at|evidence_hash/);
  const raw=a.memory.items(pack.id).find(m=>m.kind==='mission_episodic');assert.equal(raw.value.accepted_at,stamp);assert.ok(raw.value.evidence_hash);
  assert.equal(require('../src/personal-memory').containsSecret(require('../src/authority-memory').referenceContent({kind:'project_operational',value:{accepted_at:stamp}})),true);
});
test('canonical pack UUIDs do not trip payment-card detection while free text remains guarded', async t => {
  const f=await conversationFixture(t),id='40c22624-3664-4912-be10-c91c408c9709';
  assert.equal(require('../src/personal-memory').containsSecret(id),true);
  const {safe}=require('../src/authority-store');
  assert.doesNotThrow(()=>safe({kind:'mission_episodic',subject_key:'episode.'+id,value:'Synthetic accepted episode'}));
  assert.throws(()=>safe({kind:'project_operational',subject_key:'episode.'+id,value:'Synthetic content'}),/Sensitive/);
  assert.throws(()=>safe({kind:'mission_episodic',subject_key:'episode.'+id,value:id}),/Sensitive/);
  const forgedMetadata={kind:'mission_episodic',subject_key:'episode.'+id};
  assert.throws(()=>safe({kind:'mission_episodic',subject_key:'episode.00000000-0000-4000-8000-000000000000',value:forgedMetadata}),/Sensitive/);
  assert.throws(()=>safe({kind:'personal_preference',value:[{nested:forgedMetadata}]}),/Sensitive/);
  const m=f.b.missions.createConversation({request_id:'typed-pack-uuid',message:'What is my test codename?'});
  const original=f.b.controlContext.build(f.b.controlStore.requireMission(m.mission_id));
  f.b.controlStore.db.prepare('INSERT INTO cp_context_packs SELECT ?,mission_id,run_id,refs,selection,content_hash,created_at FROM cp_context_packs WHERE id=?').run(id,original.id);
  assert.deepEqual(f.b.opencodeAdapter.authorizedContext({id}),{records:[],authority:false});
  assert.throws(()=>f.b.opencodeAdapter.authorizedContext({id,records:[{content:id}]}),/sensitive_context/);
  assert.throws(()=>f.b.opencodeAdapter.authorizedContext({id:'missing-canonical-pack'}),/not found/);
});
