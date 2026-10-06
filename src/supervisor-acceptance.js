'use strict';
// Opt-in deterministic fixture. No model, commands, tools, or workspace writes.
const CRITERION = 'runtime:fresh-session-continuation';
function validate(mode, criteria, customWorkspace) {
  if (mode === undefined && !criteria.includes(CRITERION)) return;
  if (mode !== 'incomplete_once' || customWorkspace || criteria.length !== 1 || criteria[0] !== CRITERION) {
    throw new Error('incomplete_once requires isolated workspace and acceptance_criterion runtime:fresh-session-continuation');
  }
}
function satisfied(task) {
  const evidence = task.mission.runtimeEvidence;
  return task.mission.acceptanceMode === 'incomplete_once' && task.mission.attempts >= 1 &&
    evidence?.initial?.outcome === 'incomplete' && evidence?.continuation?.outcome === 'satisfied' &&
    evidence.initial.sessionId !== evidence.continuation.sessionId &&
    evidence.initial.sessionId === task.previousSessionId && evidence.continuation.sessionId === task.sessionId;
}
async function settle(bridge, task, { recovery }) {
  // Yield so cancellation/shutdown can win before recording any outcome.
  await new Promise(resolve => setImmediate(resolve));
  if (task.cancelRequested || bridge.closed) throw new Error('Acceptance fixture cancelled');
  const evidence = task.mission.runtimeEvidence ||= {};
  if (!recovery && !evidence.initial) evidence.initial = { sessionId: task.sessionId, outcome: 'incomplete' };
  if (recovery && evidence.initial && task.previousSessionId === evidence.initial.sessionId && task.sessionId !== evidence.initial.sessionId) {
    evidence.continuation = { sessionId: task.sessionId, outcome: 'satisfied' };
  }
  task.lastResult = recovery ? 'Deterministic fixture continuation settled.' : 'Deterministic fixture intentionally incomplete.';
  task.lastSettledAt = Date.now(); task.status = 'completed';
  const checkpoint = bridge.memory.saveCheckpoint(task.id, {
    objective: task.description, verifiedFacts: [{ fact: task.lastResult, evidence: JSON.stringify(evidence) }],
    hypotheses: [], decisions: [], completedGates: satisfied(task) ? [CRITERION] : [],
    failedApproaches: [], gitReferences: [], nextStep: satisfied(task) ? 'Fixture accepted.' : 'Await automatic fresh-session recovery.'
  }, { sessionId: task.sessionId, runtime: true });
  task.checkpointId = checkpoint.id; task.lastCheckpointAt = Date.now(); bridge.tasks.save(task);
  return { text: task.lastResult, sessionId: task.sessionId };
}
module.exports = { CRITERION, validate, satisfied, settle };