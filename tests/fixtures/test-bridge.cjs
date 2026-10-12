// Synthetic lifecycle/policy driver only; never distributed or used by the service.
'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const Bridge=require('../../src/bridge-controller');
const FixtureTransport=require('./fixture-transport.cjs');
const {PHASES}=require('../../src/execution-lease');
const {LOCAL_OLLAMA}=require('../../src/config');
const {LOCAL_OLLAMA:LOCAL_OLLAMA_ENDPOINT}=require('../../src/local-ollama-broker');
const {LEVEL1_PROFILE_ID}=require('../../src/level1-profile');
const {DESCRIPTION:ACTIVE_CHAT_DESCRIPTION,OBJECTIVE:ACTIVE_CHAT_OBJECTIVE,ACCEPTANCE_CRITERIA:ACTIVE_CHAT_ACCEPTANCE_CRITERIA,prepareFixtures:prepareActiveChatFixtures,missionFields:activeChatMissionFields,ACTIVE_CHAT_PROFILE_ID,LOCAL_OLLAMA:ACTIVE_CHAT_OLLAMA}=require('../../src/active-chat-mission');

// Explicit synthetic classification. Never treat as independently verified worker exit.
const SYNTHETIC_FIXTURE_DISPOSE='synthetic_fixture_dispose';

function fixtureEnvironment(bridge,task,token){
 const expected=fs.realpathSync(path.join(__dirname,'host-worker.cjs'));
 if(fs.realpathSync(bridge.executable)!==expected)throw Error('Only the fixed synthetic worker is allowed');
 const workerHome=path.join(task.sessionDir,'home'),tempDir=path.join(task.sessionDir,'tmp');
 fs.mkdirSync(workerHome,{recursive:true,mode:0o700});fs.mkdirSync(tempDir,{recursive:true,mode:0o700});
 return{cwd:task.workspace,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('BRIDGE_REVIEW_'))),HOME:workerHome,TMPDIR:tempDir,PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C',TERM:'dumb',BRIDGE_POLICY_SOCKET:bridge.socketPath,BRIDGE_TASK_TOKEN:token}};
}

class TestBridge extends Bridge {
 constructor(options={}){
  super({...options,defaultRuntime:options.defaultRuntime==='opencode'?'opencode':undefined});
  this.defaultRuntime=options.defaultRuntime||'host';
  this.executable=options.executable||path.join(__dirname,'host-worker.cjs');
  this.fixtureSynthetic=true;
 }
 // Synthetic fixtures need open admission after recovery. Production retains
 // managed closed-startup until authenticated operator resume (ADR 0026/0030).
 async initialize(){
  const self=await super.initialize();
  if(self.startClosed!==true&&self.lifecycle?.state()==='booting'&&self.lifecycle.status().idle){
   self.lifecycle.resume(self.lifecycle.epoch);
   self.missions?.schedule();
  }
  // Settle the first autonomous/Mission tick so fixture resume sees durable idle.
  if(self.lifecycle?.state()==='open'){
   try{await self.missions?.tick();}catch{/* fixture settle */}
   try{await self.autonomousExecution?.tick();}catch{/* fixture settle */}
   if(self.autonomousExecution)self.autonomousExecution.busy=false;
   if(self.missions)self.missions.busy=false;
  }
  return self;
 }

 /**
  * Test-only synthetic ownership clear for disposable fixture DBs.
  * Classification: SYNTHETIC FIXTURE DISPOSAL — not real worker termination.
  * Must never grant Acceptance, reopen production admission authority, or be
  * invoked from BridgeController / service entrypoints.
  */
 disposeFixtureOwnership(){
  if(this.fixtureSynthetic!==true)throw Error('Synthetic fixture disposal requires TestBridge');
  if(process.env.NODE_ENV!=='test'&&this.options.allowFixtureWorker!==true){
   throw Error('Synthetic fixture disposal is restricted to test fixtures');
  }
  const db=this.controlStore?.db;if(!db)return {classification:'synthetic_fixture_disposal',mutated:false};
  const table=name=>{try{return!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}catch{return false;}};
  const erasureDenied=error=>/Erased retained|assertReadable|erasure|query_only|readonly/i.test(String(error&&error.message||error));
  const run=(sql)=>{try{db.prepare(sql).run();return true;}catch(error){if(!erasureDenied(error))throw error;return false;}};
  let mutated=false;
  try{
   if(table('cp_leases')&&run("UPDATE cp_leases SET state='released' WHERE state IS NULL OR state<>'released'"))mutated=true;
   if(table('cp_runs')){
    const now=Date.now();
    const update=db.prepare("UPDATE cp_runs SET state=?,process_state=?,termination_verified=1,liveness_state='settled',resolution=?,updated_at=?,ended_at=COALESCE(ended_at,?),pid=NULL WHERE id=?");
    for(const row of db.prepare("SELECT id,state,process_state,termination_verified,resolution FROM cp_runs").all()){
     // Already classified synthetic dispose stays untouched.
     if(row.resolution===SYNTHETIC_FIXTURE_DISPOSE&&row.termination_verified===1)continue;
     const terminal=['completed','failed','cancelled','interrupted'].includes(row.state);
     const processState=['alive','starting','terminating','unknown'].includes(row.process_state)?'exited':(row.process_state||'not_started');
     if(!terminal||row.termination_verified!==1||!['exited','not_started','idle'].includes(row.process_state)){
      try{
       // Cancelled + synthetic resolution: durable idle for fixture teardown only.
       // This is not independent worker-exit proof and must not drive Acceptance.
       update.run(terminal?row.state:'cancelled',processState==='idle'?'not_started':processState,SYNTHETIC_FIXTURE_DISPOSE,now,now,row.id);
       mutated=true;
      }catch(error){if(!erasureDenied(error))throw error;}
     }
    }
   }
   if(table('cp_invocations')&&run("UPDATE cp_invocations SET state='settled' WHERE state IN ('running','unknown')"))mutated=true;
   if(table('cp_dispatches')&&run("UPDATE cp_dispatches SET state='cancelled' WHERE state IN ('dispatching','running','unknown','queued')"))mutated=true;
   if(table('cp_continuations')&&run("UPDATE cp_continuations SET state='cancelled' WHERE state IN ('dispatching','unknown')"))mutated=true;
   // Use schema-legal terminal statuses only. These clear admission blockers without
   // inventing successful delivery or Acceptance.
   if(table('cp_slack_outbox')&&run("UPDATE cp_slack_outbox SET state='failed' WHERE state IN ('sending','delivery_unknown')"))mutated=true;
   if(table('cp_effect_outbox')&&run("UPDATE cp_effect_outbox SET status='dead_letter',error_class='synthetic_fixture_dispose' WHERE status IN ('dispatching','delivery_unknown','pending')"))mutated=true;
   if(table('chatgpt_events')&&run("UPDATE chatgpt_events SET delivery='rejected' WHERE delivery IN ('pending','needs_review')"))mutated=true;
  }catch(error){
   if(!erasureDenied(error))throw error;
  }
  // In-memory ownership clear is not verified worker termination.
  if(this.leases?.leases){for(const lease of [...this.leases.leases.values()])try{this.leases.releaseIfOwner(lease,{verified:false});}catch{/* lease already gone */}}
  if(this.capabilityHost?.jobs?.jobs){for(const job of this.capabilityHost.jobs.jobs.values()){if(!['completed','failed','cancelled'].includes(job.status)){job.status='cancelled';try{job.done?.resolve?.();}catch{/* ignore */}}}}
  this.controlServer?.conversationEngine?.active?.clear?.();
  if(this.chatgptEvents)this.chatgptEvents.running=false;
  if(this.supervisor)this.supervisor.busy=false;
  if(this.missions)this.missions.busy=false;
  if(this.autonomousExecution)this.autonomousExecution.busy=false;
  if(this.agentDispatch)this.agentDispatch.busy=false;
  if(this.boundedNextActions){this.boundedNextActions.busy=false;this.boundedNextActions.reconciling=false;}
  if(this.controlStore?.outbox)this.controlStore.outbox.busy=false;
  return {classification:'synthetic_fixture_disposal',resolution:SYNTHETIC_FIXTURE_DISPOSE,mutated,real_termination_verified:false};
 }

 // Default fixture teardown: synthetic dispose, then release the process writer
 // without claiming a production idle/verified shutdown. Use productionShutdown()
 // when a test must exercise BridgeController.shutdownOnce invariants.
 // fixtureRestart: simulate process death while preserving durable quarantine.
 shutdown(options={}){
  if(!this.shutdownPromise){
   if(options.productionShutdown===true){
    this.shutdownPromise=this.shutdownOnce();
   }else if(options.fixtureRestart===true){
    this.shutdownPromise=this.shutdownForFixtureRestart();
   }else{
    this.shutdownPromise=(async()=>{
     try{this.disposeFixtureOwnership();}
     catch(error){
      const message=String(error&&error.message||error);
      if(!/Erased retained|assertReadable|erasure|query_only|readonly/i.test(message))throw error;
     }
     return this.shutdownForFixtureRestart();
    })();
   }
  }
  return this.shutdownPromise;
 }

 /** Explicit production shutdown path (no synthetic dispose). Fail-closed. */
 productionShutdown(){return this.shutdown({productionShutdown:true});}

 async shutdownForFixtureRestart(){
  this.closed=true;
  try{await this.workers?.shutdown();}catch{/* fixture restart must still release the writer */}
  try{this.codexRelay?.close();}catch{}
  try{this.supervisor?.close();}catch{}
  clearInterval(this.monitor);
  try{await this.missions?.close();}catch{}
  try{await this.slackRuntime?.stop();}catch{}
  try{this.capabilityHost?.shutdown();}catch{}
  this.leases?.abortAll?.('Fixture restart');
  for(const lease of [...(this.leases?.leases?.values?.()||[])])try{this.leases.releaseIfOwner(lease,{verified:false});}catch{}
  await Promise.allSettled([...(this.runtimes?.entries?.()||[])].map(([taskId,runtime])=>{
   const task=this.tasks?.get(taskId);
   return runtime.restrictedWorker||!task?runtime.rpc.shutdown():this.agentRouter.shutdown(task,{runtime});
  }));
  if(this.server?.listening)await new Promise(resolve=>this.server.close(resolve));
  try{await this.chatgptEvents?.stop();}catch{}
  try{await this.controlStore?.outbox.stop();}catch{}
  try{this.memory?.close();}catch{}
  if(this.lockFd!=null){try{fs.closeSync(this.lockFd);}catch{}this.lockFd=null;try{fs.unlinkSync(this.lockFile);}catch{}}
 }

  async _ensureHostRuntime(id) {
    require('../../src/removed-runtime').assertExecutable(this.tasks.get(id));
    const task = this.tasks.get(id);
    const lease = this.leases.get(id);
    const cancelled = () =>
      this.closed ||
      task.cancelRequested === true ||
      task.status === 'cancelled' ||
      task.mission?.status === 'cancelled' ||
      lease?.aborted === true;
    const assertActive = () => {
      if (cancelled()) throw new Error('Task cancelled before runtime startup completed');
    };

    assertActive();

    const existing = this.runtimes.get(id);
    if (existing) {
      this.leases.setPhase(lease, PHASES.worker_starting);
      await this.leases.awaitLease(lease, existing.starting, PHASES.worker_starting);
      assertActive();
      existing.runId = lease.runId;
      this.leases.bindRuntime(lease, id);
      this.leases.setPhase(lease, PHASES.ready);
      return existing;
    }

    for (const [otherId] of this.runtimes) {
      if (!this.inFlight.has(otherId) && this.runtimes.size >= (this.options.maxConcurrent || 1)) {
        this.leases.markPriorRuntime(lease, otherId);
        this.leases.setPhase(lease, PHASES.retiring_previous_runtime);
        // Runtime handoff is first-class: bounded, abortable, and never spawns
        // a worker for a cancelled waiter.
        await this.leases.awaitLease(lease, this.stopTask(otherId), PHASES.retiring_previous_runtime);
        assertActive();
      }
    }

    // Close the final race between handoff completion and worker creation.
    assertActive();
    this.leases.setPhase(lease, PHASES.worker_spawning);

    const token = randomBytes(32).toString('hex');
    this.policy.registerTask(task);
    if (task.safetyStop?.latched) this.policy.latchSafetyStop(task.id, task.safetyStop.reason, task.safetyStop.evidence);
    if (task.mission?.capabilityProfile === LEVEL1_PROFILE_ID) throw new Error('Level 1 restricted worker must not be started through HostWorkerAdapter');
    if (task.mission?.level === 1) throw new Error('Level 1 worker has an invalid trusted capability profile');
    const activeChat = task.mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID;
    if (activeChat) {
      this._activeChatTask(task);
      if (this.config.provider !== ACTIVE_CHAT_OLLAMA.provider || this.config.model !== ACTIVE_CHAT_OLLAMA.model) throw new Error('Active Chat requires configured ollama/qwen3-coder:30b');
    }
    const localOllamaTransport = this.config.provider === LOCAL_OLLAMA.provider && this.config.model === LOCAL_OLLAMA.model;
    const workerSandbox = fixtureEnvironment(this, task, token);
    const rpc = new FixtureTransport({ executable: process.execPath,
      args: [this.executable, '--session-id', task.sessionId], cwd: workerSandbox.cwd,
      env: workerSandbox.env, allowUnsandboxedTestFixture: true });
    let readyResolve, readyReject; const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    ready.catch(() => {});
    const runtime = {
      rpc, token, readyResolve, readyReject, taskId: task.id, sessionId: task.sessionId, runId: lease.runId,
      localOllamaTransport, provider: this.config.provider, model: this.config.model,
      endpoint: localOllamaTransport ? LOCAL_OLLAMA_ENDPOINT.baseUrl : null
    }; this.runtimes.set(id, runtime); this.tokens.set(token, id);
    this.leases.bindRuntime(lease, id);
    rpc.on('event', event => this.onWorkerEvent(task, this.agentRouter.normalizeEvent(task, event)));
    rpc.on('fault', error => { readyReject(error); task.failureKind = 'transport_error'; task.error = error.message; task.status = 'failed'; this.tasks.save(task); this.emit('change'); });
    rpc.on('exit', () => {
      readyReject(new Error('Fixture worker exited before safety readiness'));
      task.connected = false; task.safetyLoaded = false;
      if (this.inFlight.has(id)) { task.status = 'interrupted'; task.failureKind = 'worker_exit'; }
      for (const controller of runtime.webRequests || []) controller.abort();
      for (const controller of runtime.inferenceRequests || []) controller.abort();
      this.tokens.delete(token); this.policy.revokeTask(id); this.runtimes.delete(id); this.tasks.save(task); this.emit('change');
    });
    runtime.starting = (async () => {
      task.status = 'starting'; this.tasks.save(task);
      let timer;
      try {
        this.leases.setPhase(lease, PHASES.worker_starting);
        const state = await this.leases.awaitLease(lease, rpc.start(), PHASES.worker_starting);
        assertActive();
        this.leases.setPhase(lease, PHASES.waiting_ready);
        await this.leases.awaitLease(lease, Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Safety extension did not acknowledge startup')), 10000); })]), PHASES.waiting_ready);
        assertActive();
        if (state.sessionId !== task.sessionId) throw new Error('Fixture worker returned a different task session');
        Object.assign(task, { connected: true, sessionFile: state.sessionFile, model: state.model?.id || this.config.model, status: 'idle' });
        this.leases.setPhase(lease, PHASES.ready);
        this.tasks.save(task); return runtime;
      } catch (e) { await rpc.shutdown(); task.status = 'failed'; task.error = e.message; this.tasks.save(task); throw e; }
      finally { clearTimeout(timer); }
    })();
    return runtime.starting;
  }
  createActiveChatTask() {
    if (this.closed) throw new Error('Bridge closed');
    // This deliberately starts as grant-pending. The task text and MCP caller
    // create no executable authority and cannot cause worker to start.
    const created = this.createTask(ACTIVE_CHAT_DESCRIPTION, {
      missionObjective: ACTIVE_CHAT_OBJECTIVE,
      executionAgent: 'host',
      acceptanceCriteria: ACTIVE_CHAT_ACCEPTANCE_CRITERIA,
      requireMissionGrant: true
    });
    const task = this.tasks.get(created.id);
    const fixtures = prepareActiveChatFixtures(task.workspace);
    task.mission = activeChatMissionFields({ id: task.mission.id, workspace: task.workspace, fixtures });
    task.activeChat = {
      profile: ACTIVE_CHAT_PROFILE_ID,
      phase: 'awaiting_operator_grant',
      taskAResultHash: null,
      taskAResultEvidence: null,
      taskBResultEvidence: null,
      readEvidence: {},
      continuationRequestId: null,
      createdAt: Date.now()
    };
    task.status = 'awaiting_operator_grant';
    this._normalizeMission(task);
    this.tasks.save(task); this.policy.registerTask(task); this.emit('change');
    return this.snapshotTask(task);
  }
}
module.exports=TestBridge;
module.exports.SYNTHETIC_FIXTURE_DISPOSE=SYNTHETIC_FIXTURE_DISPOSE;
