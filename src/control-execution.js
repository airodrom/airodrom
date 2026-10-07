'use strict';
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { transaction } = require('./control-transaction');
const { workspaceSnapshot } = require('./control-context');

function repositoryRoot(directory) {
  const root = fs.realpathSync(directory);
  const result = spawnSync('/usr/bin/git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' }
  });
  return result.status === 0 ? fs.realpathSync(result.stdout.trim()) : root;
}

// Wraps admission and settlement of the existing runner; never spawns a worker.
class ControlExecution {
  constructor(bridge, store) { this.bridge = bridge; this.store = store; }
  admit(lease, agentId = 'host') {
    const task = this.bridge.tasks.get(lease.taskId);
    transaction(this.store.db, () => {
      this.store.startRun({ id: lease.runId, taskId: task.id, generation: lease.generation,
        agentId, nativeSessionId: task.sessionId, missionId: this.store.missionForTask(task.id)?.id });
      if (agentId === 'host') this.store.acquireLease({ resource: repositoryRoot(task.workspace), runId: lease.runId });
    });
  }
  release(lease, verified) {
    const run = this.store.run(lease.runId); if (!run) return;
    if (run.agent_id === 'reasoning_provider') {
      const task = this.bridge.tasks.get(run.task_id);
      this.store.updateRun(run.id, { state: task.cancelRequested ? 'cancelled' : task.status === 'idle' ? 'completed' : 'failed',
        processState: 'not_started', liveness: 'settled', verified,
        result: { inference_only: true, task_state: task.status, failure_kind: task.failureKind || null, accepted: false } });
      return;
    }
    // Airodrom host sessions can remain idle between turns. Settlement proves the turn,
    // not destruction of the reusable session process.
    const task = this.bridge.tasks.get(run.task_id);
    if(run.agent_id==='bridge'&&task.mission?.capabilityProfile==='governed-browser-research-v1'){
      // The invocation lease and browser worker are distinct canonical Runs.
      // Correlate this settled action without copying the worker's evidence.
      const invocation=task.capabilityInvocations?.[task.latestMcpRequestId];
      const completed=invocation?.state==='settled'&&invocation.outcome?.status==='completed';
      this.store.updateRun(run.id,{state:verified?(lease.cancelRequested?'cancelled':completed?'completed':'failed'):'termination_unverified',processState:verified?'not_started':'unknown',liveness:verified?'settled':'unknown',verified,result:{invocation_only:true,completed,accepted:false},deferAudit:true});return;
    }
    const success = task.status === 'completed' && require('./execution-evidence').satisfied(task, lease.runId);
    this.store.updateRun(lease.runId, {
      state: verified ? (lease.cancelRequested ? 'cancelled' : success ? 'completed' : 'failed') : 'termination_unverified',
      result: { native_execution_evidence: task.nativeExecutionEvidence || null, task_state: task.status, failure_kind: task.failureKind || null },
      processState: verified ? (run.agent_id === 'host' ? 'idle' : 'not_started') : 'unknown',
      liveness: verified ? 'settled' : 'unknown', verified,
      resolution: verified ? null : 'reconcile_process', deferAudit: true
    });
    if(verified&&run.agent_id==='host'&&this.bridge.resultInbox){const task=this.bridge.tasks.get(run.task_id);this.bridge.resultInbox.publish({run_id:run.id,mission_id:run.mission_id,task_id:run.task_id,agent_id:'host',request_id:`host:${run.id}`,result:{status:task.cancelRequested?'cancelled':success?'completed':'failed',summary:String(task.lastResult||'Airodrom host turn settled; inspect correlated task evidence').slice(0,8000),changed_files:[],tests:[],artifacts:[],limitations:['Turn settlement is distinct from Mission acceptance']}});}
  }
  beginExternal(task, repo, jobId) {
    if(task.mission?.authority)throw Error('Mission authority requires a qualified bounded native adapter');
    const mission=this.store.missionForTask(task.id);
    if(mission?.state==='cancelled')throw Error('Mission is cancelled');
    const resource = repositoryRoot(repo), baseline = workspaceSnapshot(resource);
    const runId = randomUUID();
    transaction(this.store.db, () => {
      if (this.store.db.prepare("SELECT 1 FROM cp_runs WHERE agent_id='claude_code' AND (state NOT IN ('completed','failed','cancelled','interrupted') OR termination_verified=0) LIMIT 1").get()) throw new Error('Claude has an active or unreconciled run');
      this.store.startRun({ id: runId, taskId: task.id, generation: task.controlPlaneOrdinal || 1, agentId: 'claude_code', missionId: this.store.missionForTask(task.id)?.id });
      this.store.acquireLease({ resource, runId, baseline });
      this.store.updateRun(runId, { state: 'starting', processState: 'not_started', jobId });
    });
    return runId;
  }
  started(runId, pid) { transaction(this.store.db,()=>{this.store.updateRun(runId, { state: 'running', processState: 'alive', liveness: 'observed', pid });this.bridge.missions?.runStarted(runId);}); }
  failedToSpawn(runId) { this.store.updateRun(runId, { state: 'failed', processState: 'not_started', verified: true }); }
  settled(runId, job) {
    transaction(this.store.db, () => {
    this.store.updateRun(runId, { state: job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'failed',
      processState: 'exited', liveness: 'closed', verified: true, deferAudit: true, result: { job_id: job.id, status: job.status, output: job.result, changed_file_claims: job.touched, claims_untrusted: true } });
    this.bridge.missions?.captureResult(runId, job);
    });
  }
}
module.exports = { ControlExecution, repositoryRoot };
