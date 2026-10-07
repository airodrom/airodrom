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
