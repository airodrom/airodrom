'use strict';
const path = require('node:path');
const NATIVE_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'find', 'grep', 'run_job']);
function requiredKind(task) {
  if (task.requiredExecutionKind === 'native') return 'native';
  // Legacy repository tasks fail closed; an isolated reasoning task is distinct.
  if (task.workspace && task.sessionDir && path.resolve(task.workspace) !== path.resolve(task.sessionDir, '../workspace')) return 'native';
  return task.requiredExecutionKind || 'reasoning';
}
function begin(task, runId) {
  task.nativeExecutionEvidence = { run_id: runId, required_execution_kind: requiredKind(task), completed_invocations: 0 };
}
function record(task, toolName, request) {
  const evidence = task.nativeExecutionEvidence;
  if (!evidence || !task.activeRunId || evidence.run_id !== task.activeRunId) return;
  const name = toolName === 'capability' ? request?.input?.name : toolName;
  if (!NATIVE_TOOLS.has(name) && !(toolName === 'capability' && typeof name === 'string' && !['capability_list', 'capability_inventory'].includes(name))) return;
  evidence.completed_invocations++;
}
function satisfied(task, runId = task.nativeExecutionEvidence?.run_id) {
  if (requiredKind(task) !== 'native') return true;
  const e = task.nativeExecutionEvidence;
  return !!e && e.run_id === runId && e.required_execution_kind === 'native' && Number.isSafeInteger(e.completed_invocations) && e.completed_invocations > 0;
}
function runSatisfied(run) {
  if (!run || run.state !== 'completed') return false;
  if (run.agent_id !== 'pi') return true;
  let result = run.result; if (typeof result === 'string') { try { result = JSON.parse(result); } catch { return false; } }
  const e = result?.native_execution_evidence;
  return e?.run_id === run.id && e.required_execution_kind === 'native' && Number.isSafeInteger(e.completed_invocations) && e.completed_invocations > 0;
}
module.exports = { requiredKind, begin, record, satisfied, runSatisfied };
