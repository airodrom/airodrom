'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const project = path.resolve(__dirname, '..');
const Rpc = require(path.join(project, 'src/rpc-supervisor'));
const fixture = path.join(__dirname, 'fixtures/fake-pi.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = (promise, ms = 2500) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('review test deadline exceeded')), ms); timer.unref(); })]);

async function bridge(t, env = {}) {
  const Controller = require(path.join(project, 'src/bridge-controller'));
  const root = fs.mkdtempSync('/private/tmp/br-review-');
  const profile = path.join(root, 'source'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const controller = new Controller({ defaultRuntime: 'pi', dataDir: path.join(root, 'data'), sourceProfile: profile, executable: fixture, allowFixtureWorker: true });
  t.after(async () => {
    await deadline(controller.shutdown(), 5000);
    for (const [k, v] of Object.entries(previous)) v === undefined ? delete process.env[k] : process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await controller.initialize();
  return controller;
}

test('missing executable rejects and shutdown completes without an exit event', async () => {
  const rpc = new Rpc({ executable: '/no-such-pi-for-review', args: [], requestTimeoutMs: 500, allowUnsandboxedTestFixture: true });
  rpc.on('fault', () => {});
  await assert.rejects(rpc.start(), /ENOENT/);
  await deadline(rpc.shutdown());
  assert.equal(rpc.running, false);
});

for (const kind of ['malformed', 'null']) test(`protocol ${kind} fails through fault without crashing the bridge host`, async () => {
  const harness = `
    const Rpc = require(${JSON.stringify(path.join(project, 'src/rpc-supervisor'))});
    const rpc = new Rpc({executable:process.execPath,args:[${JSON.stringify(fixture)},'--review-protocol',${JSON.stringify(kind)}], requestTimeoutMs:500,allowUnsandboxedTestFixture:true});
    let fault = false; rpc.on('fault',()=>fault=true);
    (async()=>{ try { await rpc.start(); throw new Error('accepted bad protocol'); } catch(e) { if(!fault) throw e; } await rpc.shutdown(); })().catch(e=>{console.error(e.message); process.exitCode=1;});
  `;
  await run(process.execPath, ['-e', harness], { timeout: 5000 });
});

test('cancellation during startup never dispatches the queued prompt', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '180' });
  const task = controller.createTask('Review startup cancellation');
  const prompting = controller.prompt(task.id, 'must not dispatch');
  const rejected = assert.rejects(prompting, /cancelled/);
  await wait(20);
  await controller.cancel(task.id);
  await deadline(rejected);
  assert.equal(fs.existsSync(path.join(task.workspace, 'wire.log')), false);
  assert.equal(controller.snapshot().tasks[0].status, 'cancelled');
  assert.equal(controller.snapshot().tasks[0].busy, false);
});

test('deadline retains concurrency slot until old process closes, then retry uses a fresh process', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_CLOSE_MS: '200' });
  const task = controller.createTask('Review deadline isolation');
  const prompt = controller.prompt(task.id, 'never settle', { timeoutMs: 60 });
  const rejected = assert.rejects(prompt, /deadline exceeded/);
  while (!fs.existsSync(path.join(task.workspace, 'wire.log'))) await wait(10);
  await wait(90);
  await assert.rejects(controller.prompt(task.id, 'too early'), /already running/);
  await deadline(rejected);
  assert.equal(controller.runtimes.size, 0);
  const result = await controller.prompt(task.id, 'retry after deadline');
  assert.equal(result.text, 'FIXTURE_OK');
  const records = fs.readFileSync(path.join(task.workspace, 'wire.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].pid, records[1].pid);
});

test('operator memory reaches only its task as bounded provenance-bearing reference', async t => {
  const controller = await bridge(t);
  const task = controller.createTask('Memory injection fixture');
  const another = controller.createTask('Separate memory fixture');
  const entry = controller.saveMemory({ taskId: task.id, content: 'Violet deployment uses port 54321.', kind: 'fact' });
  await controller.prompt(task.id, 'What is the Violet deployment port?');
  const ownWire = JSON.parse(fs.readFileSync(path.join(task.workspace, 'wire.log'), 'utf8').trim());
  assert(ownWire.message.includes('54321')); assert(ownWire.message.includes(entry.id));
  assert(controller.tasks.get(task.id).retrievalBudget.usedChars <= 4000);
  await controller.prompt(another.id, 'What is the Violet deployment port?');
  const otherWire = JSON.parse(fs.readFileSync(path.join(another.workspace, 'wire.log'), 'utf8').trim());
  assert(!otherWire.message.includes('54321'));
  assert.equal(controller.runtimes.size, 1, 'idle task process was retired');
});

test('stall detection remains separate from a healthy heartbeat, and failed compactions do not count', async t => {
  const controller = await bridge(t); const created = controller.createTask('Telemetry fixture');
  const task = controller.tasks.get(created.id);
  task.connected = true; task.lastHeartbeatAt = Date.now(); task.lastActivityAt = Date.now() - 70000;
  const lease = controller.leases.acquire(task.id);
  const stalled = controller.snapshotTask(task); assert.equal(stalled.stalled, true); assert.equal(stalled.heartbeatHealthy, true);
  controller.onPiEvent(task, { type:'compaction_end', errorMessage:'fixture failure' }); assert.equal(task.compactions,0); assert.equal(task.lastCompaction.error,'fixture failure');
  controller.onPiEvent(task, { type:'compaction_end', result:{tokensBefore:12000,estimatedTokensAfter:3000} }); assert.equal(task.compactions,1); assert.equal(task.lastCompaction.tokensBefore,12000);
  assert.equal(controller.snapshotTask(task).stalled,false);
  const copy=controller.snapshotTask(task); copy.events.length=0; assert(task.events.length>0);
  controller.leases.releaseIfOwner(lease, { verified: true });
});

test('active data directory lock is exclusive, interrupted runs recover honestly, and cancel permits a fresh runtime',async t=>{
  const controller = await bridge(t); const created=controller.createTask('Recovery fixture');
  const second=new (require('../src/bridge-controller'))({dataDir:controller.dataDir,sourceProfile:controller.options.sourceProfile});
  await assert.rejects(second.initialize(),/already in use/);
  await controller.prompt(created.id,'first pass'); await controller.cancel(created.id);
  assert.equal(controller.runtimes.size,0);
  await assert.rejects(controller.prompt(created.id,'second pass'),/Cancelled missions/);
  const fresh=controller.createTask('Fresh task after cancellation');
  await controller.prompt(fresh.id,'fresh pass');
  assert.equal(controller.policy.check(fresh.id,{toolName:'read',input:{path:'wire.log'}}).allow,true);
  await controller.stopTask(fresh.id); const task=controller.tasks.get(fresh.id); task.status='thinking'; controller.tasks.save(task);
  const Manager=require('../src/task-session-model'); const reloaded=new Manager(controller.dataDir);
  assert.equal(reloaded.get(task.id).status,'interrupted'); assert.equal(reloaded.get(task.id).connected,false);
});

test('context pressure rotates the session and restores durable checkpoint without promoting narrative',async t=>{
  const controller=await bridge(t),created=controller.createTask('Checkpoint continuation fixture');
  require('./fixtures/git-baseline.cjs')(created.workspace);
  await controller.prompt(created.id,'first checkpoint turn');
  const task=controller.tasks.get(created.id),oldSession=task.sessionId;
  const cp=controller.memory.latestCheckpoint(task.id); assert(cp);
  assert(JSON.parse(cp.content).hypotheses.some(s=>s.includes('FIXTURE_OK')));
  assert(!JSON.parse(cp.content).verifiedFacts.some(s=>s.fact.includes('FIXTURE_OK')));
  controller.observeContext(task,{tokens:750,contextWindow:1000});controller.tasks.save(task);
  await controller.prompt(task.id,'continue from checkpoint');
  assert.notEqual(task.sessionId,oldSession);assert.equal(task.previousSessionId,oldSession);
  const wire=fs.readFileSync(path.join(task.workspace,'wire.log'),'utf8').trim().split('\n').map(JSON.parse);
  assert(wire[1].message.includes(cp.id));assert(wire[1].message.includes('Mission checkpoint'));
  assert(task.lastContinuationAt && task.lastCheckpointAt && task.lastSettledAt && task.contextMeasuredAt);
  assert.equal(controller.config.model,'fixture');
});
