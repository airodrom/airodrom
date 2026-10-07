'use strict';
// Historical provenance only (ADR 0008). Never an executable identity or alias.
const REMOVED_RUNTIME = 'pi';
function removed(value) {
  if (typeof value === 'string') return value === REMOVED_RUNTIME;
  if (value?.runtimeRemoved === true) return true;
  for (const key of ['executionAgent','assignedAgent','agent_id','runtime_id']) if (value?.[key] === REMOVED_RUNTIME) return true;
  return value?.envelope?.preferred_agent === REMOVED_RUNTIME;
}
function assertExecutable(value) {
  if (removed(value)) {
    const error = new Error('Historical runtime removed. Create a fresh bounded OpenCode Mission; historical tasks cannot resume or receive context.');
    error.code = 'RUNTIME_REMOVED'; throw error;
  }
}
module.exports = { REMOVED_RUNTIME, removed, assertExecutable };
