'use strict';
// ADR 0047: metadata-only view of the canonical ledger, not a second trace store.
const { STAGES, id } = require('./product-observability');
const EXTRA = {
 'mission.started': ['Mission', 'Mission started'], 'task.created': ['Mission', 'Task registered'],
 'task.completed': ['Worker', 'Worker completed'], 'agent.dispatch.requested': ['Runtime', 'Dispatch requested'],
 'mission.resumed': ['Recovery', 'Mission resumed'], 'mission.resumed_after_decision': ['Recovery', 'Operator continuation'],
 'goal.plan.created': ['Goal', 'Goal plan proposed'], 'goal.plan.continued': ['Goal', 'Goal continuation inspected'],
 'goal.checkpoint.confirmed': ['Approval', 'Planning checkpoint confirmed'],
 'provider.request.failed': ['Provider', 'Provider request failed'], 'provider.request.completed': ['Provider', 'Model invocation completed'],
 'provider.request.started': ['Provider', 'Model invocation started'], 'policy.denied': ['Policy', 'Policy denied operation']
};
const safeEnum = (value, values) => values.includes(value) ? value : null;
const ERRORS = ['provider_unavailable', 'opencode_local_provider_unavailable', 'opencode_timeout', 'opencode_process_failed', 'opencode_cancelled', 'authority_revoked', 'budget_exhausted', 'verification_failed', 'termination_unverified', 'unknown_delivery', 'agent_run_failed'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function eventView(event) {
 const label = STAGES[event.event_type] || EXTRA[event.event_type]; if (!label) return null;
 const meta = event.metadata || {};
 return { event_id: id(event.event_id), timestamp: count(event.timestamp_ms), sequence: count(event.sequence),
  mission_id: id(event.mission_id), run_id: id(event.run_id), trace_id: id(event.trace_id), span_id: id(event.span_id),
  event_type: event.event_type, category: label[0], label: label[1], duration_ms: count(event.duration_ms),
  span_kind: ['Capability','Worker','Command'].includes(label[0])?'TOOL':label[0]==='Provider'?'LLM':label[0]==='Memory'?'RETRIEVER':'CHAIN',
  policy_outcome: safeEnum(meta.decision || meta.policy_outcome, ['allow', 'deny', 'approval_required']),
  verification_state: safeEnum(meta.result || meta.status, ['passed', 'failed', 'operator_review', 'unavailable']),
  error_class: safeEnum(meta.error_class || meta.safe_error_class, ERRORS),
  evidence_refs: ['verification_id', 'review_id', 'context_pack_id'].map(key => id(meta[key])).filter(Boolean),
  authority: false };
}
function explain(mission, events, runError = null) {
 const error = [...events].reverse().find(e => e.error_class)?.error_class;
 const next = {
  completed: ['Verified work completed', 'Review settlement; deployment is separate'],
  awaiting_acceptance: ['Independent verification finished; Acceptance is required', 'Review the current verification in Control Center'],
  waiting_for_operator: ['Mission is waiting for an operator decision', 'Answer the registered decision'],
  blocked: ['Execution is blocked by the current authority or runtime boundary', 'Inspect runtime availability and current grants; reconcile uncertain effects before retry'],
  needs_rework: ['Verification requires rework', 'Repair the bounded result and request fresh verification'],
  cancelled: ['Cancellation requested', 'Confirm worker termination and lease release'],
  ready: ['Mission is registered and has not started', 'Inspect authority before bounded dispatch']
 }[mission.state] || ['Mission is in progress', 'Observe canonical events'];
 return { state: mission.state, explanation: next[0], next_safe_action: next[1], error_class: error || runError || null };
}
function flightRecorder(bridge, { missionId, after = 0, limit = 100 } = {}) {
 if (!id(missionId) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('Invalid flight recorder query');
 const mission = bridge.controlStore.requireMission(missionId);
 const page = bridge.ledger.list({ missionId, afterSequence: after, limit, order: 'asc' });
 const events = page.events.map(eventView).filter(Boolean);
 const run=bridge.controlStore.db.prepare('SELECT id FROM cp_runs WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(missionId);
 const runError=run?safeEnum(bridge.controlStore.run(run.id)?.result?.error_class,ERRORS):null;
 return { ...explain(mission, events, runError), mission_id: missionId, events, cursor: page.events.at(-1)?.sequence || after, has_more: page.has_more,
  correlation: 'canonical_mission_run', content: 'metadata_only', authority: false };
}
module.exports = { flightRecorder, eventView, ERRORS };
