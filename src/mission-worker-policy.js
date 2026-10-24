'use strict';
// Host dispatch invariant, independent of intake wording and model suggestions.
// Read-only review and host verification remain available. Legacy coding routes
// cannot bypass the current implementation policy or silently change workers.
function assertImplementation(envelope) {
  if (envelope?.kind !== 'coding') return;
  const proposal = envelope.cognitive?.proposal;
  const tasks = proposal?.tasks || [];
  const native = envelope.dispatch_policy?.native_actions || [];
  const readonly = tasks.length ? tasks.every(t => t.operation === 'read')
    : native.length && native.every(a => a.name === 'file_read');
  if (readonly) return;
  if (envelope.preferred_agent !== 'cursor' || (envelope.fallback_agents || []).length
      || tasks.some(t => t.operation !== 'read' && t.worker && t.worker !== 'cursor')) {
    const error = Error('CURSOR_IMPLEMENTATION_REQUIRED'); error.code = error.message; throw error;
  }
  if (!proposal || !envelope.cognitive?.sealed) {
    const error = Error('CURSOR_PLANNING_REQUIRED'); error.code = error.message; throw error;
  }
}
module.exports = { assertImplementation };
