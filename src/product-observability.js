'use strict';
// ADR 0009: display projections are metadata, never authority or runtime context.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const id = value => typeof value === 'string' && UUID.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const enumValue = (value, values, fallback = 'unavailable') => values.includes(value) ? value : fallback;
const STATES = ['draft','ready','dispatching','running','verifying','awaiting_acceptance','waiting_for_operator','paused','blocked','needs_rework','completed','cancelled'];
const ACTIVE = ['dispatching','running','verifying'];
const STAGES = Object.freeze({
 'memory.write':['Memory','Canonical Memory recorded'], 'memory.superseded':['Memory','Previous Memory superseded'], 'memory.forget':['Memory','Memory forgotten'], 'memory.expired':['Memory','Memory expired'], 'memory.content_redacted':['Memory','Memory content erased'], 'product.memory.recorded':['Memory','Canonical Memory recorded'], 'product.memory.corrected':['Memory','Canonical Memory corrected'], 'product.memory.forgotten':['Memory','Canonical Memory forgotten'],
 'research.browser_started':['Capability','Owned browser opened'], 'research.browser_closed':['Capability','Browser closure checked'], 'research.network_denied':['Capability','Browser request blocked by scoped policy'], 'research.network_stopped':['Capability','Browser transport budget stopped'], 'research.permission_granted':['Approval','Temporary browser permission granted'], 'research.permission_revoked':['Approval','Temporary browser permission revoked'], 'mission.web.granted':['Approval','Public web permission granted'], 'mission.web.revoked':['Approval','Public web permission revoked'], 'mission.web.evidence':['Capability','Public web evidence recorded'],
 'mission.request_received':['Mission','Request received'], 'mission.authority_registered':['Mission','Bounded authority registered'],
 'mission.created':['Mission','Mission registered'], 'manifest.registered':['Mission','Scope registered'],
 'context_pack.created':['Memory','Memory context selected'], 'runtime.qualification.checked':['Runtime','Runtime qualification checked'],
 'agent.route.selected':['Runtime','Runtime selected'], 'mission.dispatching':['Mission','Queued / dispatching'],
 'run.started':['Mission','Worker starting'], 'runtime.execution.started':['Runtime','OpenCode executing'],
 'runtime.context.delivered':['Memory','Context delivered this turn'], 'mission.running':['Mission','Execution active'],
 'orchestrator.capability.requested':['Capability','Capability requested'], 'capability.failed':['Capability','Capability failed'], 'capability.denied':['Capability','Capability denied'], 'capability.requested':['Capability','Capability requested'], 'capability.completed':['Capability','Capability completed'],
 'approval.requested':['Approval','Protected approval required'], 'approval.revoked':['Approval','Protected approval revoked'], 'approval.required':['Approval','Protected approval required'], 'approval.approved':['Approval','Protected approval granted'],
 'approval.rejected':['Approval','Protected approval rejected'], 'approval.expired':['Approval','Protected approval expired'],
 'agent.completed':['Mission','Worker result received'], 'agent.failed':['Mission','Worker failed'], 'agent.started':['Worker','Worker started'],
 'gateway.result_received':['Runtime','Worker result returned to OpenCode'],
 'gateway.evaluated':['Runtime','OpenCode evaluation recorded'],
 'gateway.unavailable':['Runtime','OpenCode evaluation unavailable'],
 'worker.started':['Worker','Worker started'], 'worker.tool_requested':['Worker','Tool requested'], 'worker.tool_permitted':['Worker','Tool permitted'],
 'worker.tool_denied':['Worker','Tool denied'], 'worker.tool_completed':['Worker','Tool completed'], 'worker.waiting':['Worker','Worker waiting'],
 'worker.failed':['Worker','Worker failed'], 'worker.terminated':['Worker','Worker terminated'],
 'worker.execution_started':['Worker','Worker execution started'], 'worker.output_observed':['Worker','Worker output observed'],
 'worker.proxy':['Worker','Worker network proxy observed'], 'worker.proxy_denied':['Worker','Worker network proxy denied'],
 'fs.file_read':['File','File read'], 'fs.file_created':['File','File created'], 'fs.file_modified':['File','File modified'], 'fs.file_deleted':['File','File deleted'],
 'git.diff_observed':['Git','Git diff observed'], 'git.diff.observed':['Git','Git diff observed'], 'git.branch.observed':['Git','Git branch observed'], 'git.baseline.observed':['Git','Git baseline observed'],
 'shell.command.requested':['Command','Command started'], 'shell.command.completed':['Command','Command completed'],
 'test.started':['Test','Test started'], 'test.completed':['Test','Test completed'], 'test.observed':['Test','Test result observed'],
 'observatory.heartbeat':['System','Live observatory heartbeat'],
 'verification.started':['Verification','Independent verification running'], 'verification.completed':['Verification','Independent verification finished'],
 'verification.failed':['Verification','Independent verification failed'], 'acceptance.started':['Verification','Acceptance evaluation started'],
 'acceptance.passed':['Verification','Acceptance evaluation passed; decision still required'],
 'acceptance.operator_review':['Verification','Operator review required'], 'acceptance.failed':['Verification','Acceptance evaluation failed'],
 'mission.awaiting_acceptance':['Mission','Waiting for Acceptance'], 'mission.waiting_for_operator':['Mission','Waiting for operator Decision'],
 'mission.paused':['Mission','Mission paused'], 'mission.blocked':['Mission','Mission blocked'], 'mission.needs_rework':['Mission','Rework required'],
 'mission.cancelled':['Mission','Cancellation recorded; termination checked separately'], 'mission.completed':['Mission','Mission completed'],
 'mission.accepted':['Settlement','Acceptance recorded'], 'mission.settled':['Settlement','Local Settlement recorded'],
 'whatsapp.inbound.received':['System','WhatsApp webhook received'], 'whatsapp.inbound.verified':['System','WhatsApp signature verified'],
 'whatsapp.inbound.stored':['System','WhatsApp message stored'], 'whatsapp.inbound.available':['System','WhatsApp message available in inbox'],
 'whatsapp.inbound.rejected':['System','WhatsApp webhook rejected'], 'whatsapp.inbound.duplicate':['System','WhatsApp duplicate ignored'],
 'whatsapp.inbound.unauthorized_sender':['System','WhatsApp sender not allowlisted'], 'whatsapp.inbound.status':['System','WhatsApp delivery status observed'],
 'whatsapp.inbound.challenge_ok':['System','WhatsApp verify challenge accepted'], 'whatsapp.inbound.enabled':['System','WhatsApp inbound enabled'],
 'whatsapp.inbound.disabled':['System','WhatsApp inbound disabled'],
 'whatsapp.inbound.discovery_recorded':['System','WhatsApp Meta discovery recorded'], 'whatsapp.inbound.callback_prepared':['System','WhatsApp HTTPS callback prepared'],
 'whatsapp.inbound.webhook_subscribed':['System','WhatsApp webhook subscription recorded']
});
const DISPLAY_STAGE = Object.freeze({
 'research.browser_started':'execution','research.browser_closed':'execution','research.network_denied':'execution','research.network_stopped':'execution','research.permission_granted':'execution','research.permission_revoked':'execution','mission.web.granted':'execution','mission.web.revoked':'execution','mission.web.evidence':'execution',
 'mission.request_received':'request','mission.created':'request','mission.authority_registered':'request','manifest.registered':'request',
 'context_pack.created':'context','runtime.context.delivered':'context',
 'runtime.qualification.checked':'runtime','agent.route.selected':'runtime',
 'gateway.result_received':'verification','gateway.evaluated':'verification','gateway.unavailable':'verification',
 'mission.dispatching':'execution','run.started':'execution','runtime.execution.started':'execution','mission.running':'execution','agent.completed':'execution','agent.failed':'execution',
 'agent.started':'execution','worker.started':'execution','worker.tool_requested':'execution','worker.tool_permitted':'execution','worker.tool_denied':'execution','worker.tool_completed':'execution','worker.waiting':'execution','worker.failed':'execution','worker.terminated':'execution','worker.execution_started':'execution','worker.output_observed':'execution','worker.proxy':'execution','worker.proxy_denied':'execution',
 'fs.file_read':'execution','fs.file_created':'execution','fs.file_modified':'execution','fs.file_deleted':'execution','git.diff_observed':'execution','git.diff.observed':'execution','git.branch.observed':'execution','git.baseline.observed':'execution',
 'shell.command.requested':'execution','shell.command.completed':'execution','test.started':'execution','test.completed':'execution','test.observed':'execution',
 'verification.started':'verification','verification.completed':'verification','verification.failed':'verification','acceptance.started':'verification','acceptance.passed':'verification','acceptance.operator_review':'acceptance',
 'mission.awaiting_acceptance':'acceptance','mission.waiting_for_operator':'acceptance','mission.accepted':'acceptance','mission.settled':'settlement'
});
function eventView(event) {
 const mapping = STAGES[event.event_type]; if (!mapping) return null;
 const tool=typeof event.metadata?.tool==='string'?event.metadata.tool:null;
 const job=typeof event.metadata?.job_name==='string'?event.metadata.job_name:null;
 const file=typeof event.metadata?.path==='string'?event.metadata.path:null;
 const label=event.event_type==='run.started'&&event.metadata?.execution_role==='verifier'?'Independent verifier starting':event.event_type==='run.started'&&event.metadata?.agent_id==='host'&&event.metadata?.execution_role!=='worker'?'Host run starting; purpose unobserved':event.event_type==='mission.accepted'&&event.metadata?.decision==='rework'?'Rework decision recorded':event.event_type==='mission.settled'&&event.metadata?.state!=='settled'?'Settlement requires rework':event.event_type==='worker.tool_requested'&&tool?`Tool requested · ${tool}`:event.event_type==='shell.command.requested'&&job?`Command started · ${job}`:event.event_type==='shell.command.completed'&&job?`Command completed · ${job}`:event.event_type==='test.completed'&&job?`Test completed · ${job}`:event.event_type.startsWith('fs.file_')&&file?`${mapping[1]} · ${file}`:mapping[1];
 // Policy denials (research.network_denied, worker.tool_denied) are observed host
 // enforcement, not Mission attention/failure branches.
 const attention=/(failed|blocked|rework|rejected|expired|cancelled)$/.test(event.event_type)||/\.(failed|blocked)$/.test(event.event_type);
 return {event_id:id(event.event_id),event_type:event.event_type,sequence:count(event.sequence),timestamp_ms:time(event.timestamp_ms),mission_id:id(event.mission_id),mission_revision:count(event.metadata?.mission_revision),run_id:id(event.run_id),category:mapping[0],stage:event.event_type==='run.started'&&event.metadata?.execution_role==='verifier'?'verification':DISPLAY_STAGE[event.event_type]||null,label,branch:attention?'attention':'observed',
  outcome:enumValue(event.metadata?.status,['passed','failed','operator_review','unavailable','completed'],null),
  runtime:enumValue(event.metadata?.agent_id,['opencode','host','claude_code','codex','cursor'],null)};
}
function timeline(events) {
 const seen = new Set(); return events.filter(e => id(e.event_id) && !seen.has(e.event_id) && seen.add(e.event_id)).sort((a,b)=>a.sequence-b.sequence).map(eventView).filter(Boolean);
}
function progress({state, checks = [], declaredChecks = null} = {}) {
 if (count(declaredChecks) && declaredChecks > 0 && checks.length <= declaredChecks) return {mode:'determinate',label:'Declared verification checks',value:checks.filter(c=>['passed','failed','operator_review','unavailable'].includes(c.status)).length,maximum:declaredChecks};
 return {mode:ACTIVE.includes(state)?'indeterminate':'paused',label:ACTIVE.includes(state)?'Observed activity; completion denominator unavailable':'No advancing activity observed'};
}
const checkLabel = (key, index) => ({read_only_boundary:'Read-only confinement and termination',response:'Response factual accuracy',runtime_provenance:'Runtime provenance',repository_v2:'Repository boundary',creation_repository_v2:'Original scope',workspace:'Workspace available',protected_files:'Protected files',expected_changes:'Expected changes',git_status:'Repository status',task_owned_diff:'Task-owned diff',verification_workspace_stable:'Verification workspace stability',verification_available:'Verification available',native_execution:'Native execution'})[key] || 'Declared check '+(index+1);
function displayStatus(state, { started = false, settled = false, archived = false, kind = null } = {}) {
  if (archived) return { key: 'archived', label: 'Archived', tone: 'muted' };
  if (settled && state === 'completed') return { key: 'settled', label: 'Settled', tone: 'ready' };
  if (state === 'draft' || (state === 'ready' && !started)) return { key: 'registered', label: 'Registered — execution not started', tone: 'waiting' };
  if (state === 'awaiting_acceptance' && kind === 'conversation') {
    return { key: 'unread_result', label: 'Unread result', tone: 'muted' };
  }
  return {
    key: state,
    label: ({
      ready: 'Ready to execute',
      dispatching: 'Queued',
      running: 'Running',
      verifying: 'Independent verification',
      awaiting_acceptance: 'Waiting for approval',
      waiting_for_operator: 'Waiting for operator',
      paused: 'Paused',
      blocked: 'Blocked',
      needs_rework: 'Needs rework',
      completed: 'Completed',
      cancelled: 'Cancelled'
    })[state] || 'Not observed',
    tone: ({ dispatching: 'ready', running: 'ready', verifying: 'ready', awaiting_acceptance: 'waiting', waiting_for_operator: 'waiting', needs_rework: 'degraded', blocked: 'degraded', completed: 'ready', cancelled: 'muted', paused: 'waiting', ready: 'waiting', draft: 'waiting' })[state] || 'muted'
  };
}
/** Plan row for a Mission bound to a stage now, or a failed parent whose stage was rebound to a corrective Mission. */
function autonomousPlanLink(bridge, missionId) {
  const db = bridge.controlStore.db;
  const direct = db.prepare('SELECT p.id AS plan_id, p.goal_plan, n.node_id AS stage_id FROM cp_mission_programs p JOIN cp_mission_program_nodes n ON n.program_id=p.id WHERE n.mission_id=?').get(missionId);
  if (direct) return direct;
  for (const row of db.prepare("SELECT id AS plan_id, goal_plan FROM cp_mission_programs WHERE goal_plan IS NOT NULL AND goal_plan LIKE ?").all('%' + missionId + '%')) {
    let plan; try { plan = JSON.parse(row.goal_plan); } catch { continue; }
    const lineage = plan.autonomous?.repair_lineage || {};
    const stage = Object.keys(lineage).find(s => lineage[s]?.parent_mission_id === missionId)
      || (plan.autonomous?.repair_history || []).find(h => h.parent_mission_id === missionId || h.repair_mission_id === missionId)?.stage_id;
    if (stage) return { plan_id: row.plan_id, goal_plan: row.goal_plan, stage_id: stage };
  }
  return null;
}
function autonomousManaged(bridge, missionId) {
  try {
    const row = autonomousPlanLink(bridge, missionId);
    if (!row?.goal_plan) return false;
    const plan = JSON.parse(row.goal_plan);
    return plan.autonomous?.enabled === true && plan.autonomous?.paused !== true;
  } catch { return false; }
}
/** Derive recovery presentation from canonical scheduler evidence — never from the enabled flag alone. */
function recoveryStatus(bridge, mission, view = {}) {
  const managed = view.autonomous_managed === true || autonomousManaged(bridge, mission.id);
  const db = bridge.controlStore.db;
  if (ACTIVE.includes(mission.state) && managed) {
    return { kind: 'recovering', headline: 'In progress', detail: 'Authorized autonomous execution is underway.', suppress_manual: true };
  }
  if (!['blocked', 'needs_rework', 'ready', 'paused'].includes(mission.state)) {
    return { kind: 'none', headline: null, detail: null, suppress_manual: false };
  }
  if (db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND (process_state='unknown' OR (termination_verified=0 AND state NOT IN ('completed','failed','cancelled'))) LIMIT 1").get(mission.id)) {
    return { kind: 'uncertain', headline: 'Uncertain execution', detail: 'Prior effects or termination cannot be safely established. Automatic retry is unavailable.', suppress_manual: false };
  }
  if (db.prepare("SELECT 1 FROM cp_leases WHERE state='quarantined' AND run_id IN (SELECT id FROM cp_runs WHERE mission_id=?) LIMIT 1").get(mission.id)) {
    return { kind: 'uncertain', headline: 'Uncertain execution', detail: 'A quarantined lease blocks safe automatic recovery.', suppress_manual: false };
  }
  if (!managed) {
    return { kind: 'needs_owner', headline: view.display?.label || 'Needs attention', detail: 'Autonomous execution is not authorized for this Mission.', suppress_manual: false };
  }
  try {
    const link = autonomousPlanLink(bridge, mission.id);
    if (!link?.plan_id || !bridge.missions?.autonomous) {
      return { kind: 'waiting', headline: 'Waiting', detail: 'Autonomous goal linkage is incomplete; no automatic retry is promised.', suppress_manual: false };
    }
    const inspect = bridge.missions.autonomous.inspect(link.plan_id, 'operator');
    const autonomous = inspect.autonomous || {};
    // ADR 0051: the derived recovery phase explains needs_rework precisely instead of a bare "Blocked".
    const phase = Object.values(autonomous.phases || {}).find(p => p.mission_id === mission.id || p.parent_mission_id === mission.id) || null;
    if (phase) {
      const explained = phase.message || ('Reason: ' + String(phase.reason || 'unknown').replaceAll('_', ' ') + '.');
      switch (phase.phase) {
        case 'QUARANTINED': return { kind: 'uncertain', headline: 'Uncertain execution', detail: explained, suppress_manual: false };
        case 'REPAIR_BLOCKED':
        case 'FAILED_TERMINAL': return { kind: 'failed', headline: 'Automatic repair stopped', detail: explained, suppress_manual: false };
        case 'WAITING_OWNER': return { kind: 'needs_owner', headline: 'Needs owner decision', detail: explained, suppress_manual: false };
        case 'REPAIR_PENDING': return { kind: 'recovering', headline: 'Repair waiting', detail: explained, suppress_manual: true };
        case 'REPAIR_ELIGIBILITY_CHECK':
        case 'VERIFICATION_FAILED':
        case 'REPAIR_CREATING':
        case 'REPAIR_DISPATCHED':
        case 'REPAIR_RUNNING':
        case 'REPAIR_VERIFYING':
          return { kind: 'recovering', headline: 'Recovering', detail: 'Verification failed; a bounded corrective attempt (' + (phase.repair_attempt || 0) + '/' + (phase.max_repairs || '?') + ') is ' + (phase.phase === 'REPAIR_VERIFYING' ? 'being verified' : 'in progress') + ' under the original approval.', suppress_manual: true };
        case 'REPAIR_VERIFIED':
        case 'AWAITING_ACCEPTANCE':
          if (mission.state === 'needs_rework' && phase.mission_id !== mission.id) return { kind: 'recovering', headline: 'Repaired', detail: 'The corrective attempt passed independent verification and awaits owner Acceptance.', suppress_manual: true };
          break;
        default: break;
      }
    }
    if (autonomous.lifecycle === 'quarantined') {
      return { kind: 'uncertain', headline: 'Uncertain execution', detail: 'Goal plan is quarantined until execution ownership is reconciled.', suppress_manual: false };
    }
    if (autonomous.lifecycle === 'waiting_approval' || autonomous.paused) {
      return { kind: 'needs_owner', headline: 'Needs owner decision', detail: 'Autonomous execution is paused or waiting for approval.', suppress_manual: false };
    }
    if (autonomous.lifecycle === 'waiting_dependency') {
      return { kind: 'waiting', headline: 'Waiting', detail: 'Airodrom is waiting for a verified dependency before continuing.', suppress_manual: true };
    }
    if (autonomous.lifecycle === 'recovering') {
      return { kind: 'recovering', headline: 'Recovering', detail: 'Bounded autonomous recovery is underway under the authorized goal budget.', suppress_manual: true };
    }
    if (inspect.expires_at != null && bridge.controlStore.now() >= inspect.expires_at) {
      return { kind: 'failed', headline: 'Failed', detail: 'Goal budget expired. Automatic retry is unavailable.', suppress_manual: false };
    }
    if ((autonomous.dispatch_count || 0) >= (autonomous.max_dispatches || 0)) {
      return { kind: 'failed', headline: 'Failed', detail: 'Dispatch budget exhausted. Automatic retry is unavailable.', suppress_manual: false };
    }
    const stage = (inspect.stages || []).find(s => s.mission_id === mission.id);
    const repairs = stage ? (autonomous.repair_counts?.[stage.id] || 0) : 0;
    if (stage && repairs >= (autonomous.max_repairs || 0)) {
      return { kind: 'failed', headline: 'Failed', detail: 'Repair budget exhausted. Automatic retry is unavailable.', suppress_manual: false };
    }
    if (mission.state === 'ready' && stage) {
      const gate = bridge.missions.autonomous.eligibleStage(inspect, autonomous, stage);
      if (gate.ok) {
        return { kind: 'eligible', headline: 'Eligible for recovery', detail: 'Airodrom can safely retry under existing authorization.', suppress_manual: true };
      }
      return { kind: 'blocked', headline: 'Blocked', detail: 'Continuation unavailable: ' + String(gate.reason || 'not eligible').replaceAll('_', ' ') + '.', suppress_manual: false };
    }
    if (['blocked', 'needs_rework'].includes(mission.state)) {
      // Scheduler records a repair and may re-admit a ready stage later — only promise retry when a ready/eligible stage exists.
      if ((inspect.ready || []).length && autonomous.lifecycle === 'running') {
        return { kind: 'eligible', headline: 'Eligible for recovery', detail: 'Airodrom can safely continue another authorized stage under the goal budget.', suppress_manual: true };
      }
      return { kind: 'blocked', headline: 'Blocked', detail: 'No safe autonomous retry is currently eligible for this Mission.', suppress_manual: false };
    }
  } catch {
    return { kind: 'uncertain', headline: 'Uncertain execution', detail: 'Autonomous recovery eligibility could not be established.', suppress_manual: false };
  }
  return { kind: 'waiting', headline: 'Waiting', detail: 'Airodrom is waiting for a known condition before continuing.', suppress_manual: true };
}
function outcomeSummary(view) {
  const verified = view.verification?.status === 'passed' && view.verification?.current === true;
  const failedVerify = view.verification?.status === 'failed';
  const recovery = view.recovery || { kind: 'none' };
  if (view.archived) return { kind: 'archived', headline: 'Archived', detail: 'Hidden from the primary list; canonical evidence retained.', success: false };
  if (view.kind === 'conversation' && view.state === 'awaiting_acceptance') {
    return { kind: 'result', headline: 'Unread conversation result', detail: 'Historical chat result — not an urgent owner decision. Review in History or archive when finished.', success: false };
  }
  if (view.actions?.accept) return { kind: 'decision', headline: 'Owner decision required', detail: verified ? 'Independent verification passed — Acceptance is still required.' : 'Review verification evidence before Acceptance.', success: false };
  if (view.state === 'waiting_for_operator') return { kind: 'decision', headline: 'Owner decision required', detail: 'Autonomous execution cannot proceed past this gate.', success: false };
  if (ACTIVE.includes(view.state)) return { kind: 'progress', headline: view.display?.label || 'In progress', detail: view.latest_activity || 'Airodrom is executing within authorized bounds.', success: false };
  if (view.state === 'needs_rework' || view.state === 'blocked' || (view.state === 'ready' && view.autonomous_managed)) {
    if (recovery.kind === 'recovering') return { kind: 'progress', headline: 'Recovering', detail: recovery.detail, success: false };
    if (recovery.kind === 'eligible') return { kind: 'progress', headline: 'Eligible for recovery', detail: recovery.detail, success: false };
    if (recovery.kind === 'waiting') return { kind: 'progress', headline: 'Waiting', detail: recovery.detail, success: false };
    if (recovery.kind === 'uncertain') return { kind: 'attention', headline: 'Uncertain execution', detail: recovery.detail, success: false };
    if (recovery.kind === 'failed') return { kind: 'attention', headline: 'Failed', detail: recovery.detail, success: false };
    if (recovery.kind === 'blocked') return { kind: 'attention', headline: 'Blocked', detail: recovery.detail, success: false };
    if (recovery.kind === 'needs_owner') return { kind: 'decision', headline: 'Needs owner decision', detail: recovery.detail, success: false };
    return { kind: 'attention', headline: view.display?.label || 'Needs attention', detail: view.latest_activity || 'Owner or template action required before progress continues.', success: false };
  }
  if (view.state === 'completed' && view.settlement?.status === 'settled' && verified) return { kind: 'result', headline: 'Verified result settled', detail: 'Independent verification and Acceptance are recorded.', success: true };
  if (view.state === 'completed' && verified) return { kind: 'result', headline: 'Verified — awaiting Settlement', detail: 'Do not treat worker completion alone as success.', success: false };
  if (view.state === 'completed') return { kind: 'result', headline: 'Completed — verification incomplete', detail: failedVerify ? 'Independent verification failed.' : 'No current independent verification — not a verified success.', success: false };
  if (view.state === 'cancelled') return { kind: 'result', headline: 'Cancelled', detail: 'No verified outcome.', success: false };
  if (view.state === 'draft' || view.state === 'ready') return { kind: 'registered', headline: 'Registered — execution not started', detail: 'Not running work.', success: false };
  return { kind: 'observed', headline: view.display?.label || 'Status observed', detail: view.latest_activity || null, success: false };
}
function nextActionFor(mission, view) {
  if (view.archived) return 'Restore from archive only if you need this Mission in the primary list again.';
  if (view.actions?.accept) return 'Owner decision required: review Acceptance, then accept or request rework.';
  if (view.state === 'waiting_for_operator') return 'Owner decision required before autonomous work can continue.';
  if (view.recovery?.suppress_manual) return null;
  if (view.state === 'draft' || (view.state === 'ready' && !view.started_at && !view.autonomous_managed)) return 'Register a bounded workspace template, or cancel if this draft is no longer needed.';
  if (view.state === 'needs_rework') return 'Owner action: inspect evidence, then authorize rework if autonomous recovery is not eligible.';
  if (view.state === 'blocked') return view.recovery?.detail || 'Owner action: resolve the blocker. Automatic retry is not available.';
  if (view.actions?.dispatch) return 'Run only when you intentionally start this Mission outside autonomous execution.';
  if (ACTIVE.includes(view.state)) return null;
  if (view.state === 'completed' && view.verification?.status === 'passed' && view.settlement?.status !== 'settled' && view.actions?.accept) return 'Owner decision required: Acceptance.';
  if (view.state === 'completed' && view.settlement?.status !== 'settled' && view.acceptance?.status === 'accept') return null;
  if (view.state === 'completed' || view.state === 'cancelled') return null;
  return null;
}
function ownerAttentionRequired(mission, view) {
  if (mission.state === 'waiting_for_operator') return true;
  if (mission.state === 'awaiting_acceptance') {
    // Conversation turns awaiting Acceptance are unread historical results, not Needs Attention.
    if ((mission.envelope?.kind || view.kind) === 'conversation') return false;
    return true;
  }
  if (view.actions?.accept && view.kind !== 'conversation') return true;
  if (!['blocked', 'needs_rework'].includes(mission.state)) return false;
  // Historical non-autonomous failures stay in Failed/History — not the primary attention queue.
  if (!view.autonomous_managed) return false;
  const kind = view.recovery?.kind;
  if (kind === 'recovering' || kind === 'eligible' || kind === 'waiting') return false;
  return ['needs_owner', 'blocked', 'failed', 'uncertain'].includes(kind);
}
function autonomouslyCurrent(mission, view) {
  if (ACTIVE.includes(mission.state)) return true;
  return view.autonomous_managed && ['recovering', 'eligible', 'waiting'].includes(view.recovery?.kind);
}
function missionView(bridge, mission) {
 const visibility = require('./mission-visibility');
 visibility.ensure(bridge.controlStore.db);
 const archived = visibility.isArchived(bridge.controlStore.db, mission.id);
 if(mission.envelope.kind==='work_request'){
  const base={id:id(mission.id),kind:'work_request',task_id:null,state:enumValue(mission.state,STATES),revision:count(mission.revision),label:'Work Mission draft',workspace:'Scope required',runtime:null,worker_assigned:false,created_at:time(mission.created_at),started_at:null,finished_at:null,observed_at:Date.now(),authority:{status:'none; scope and registered checks required'},budget:{},memory:{selected_count:0,delivery:'not requested'},verification:{current:false,status:'not_observed',checks:[]},acceptance:{status:'not_applicable'},settlement:{status:'not_applicable'},termination:{verified:true,process_state:'not_started'},attempts:0,progress:progress({state:mission.state}),timeline:[],latest_activity:'Registered — execution not started',archived,actions:{cancel:mission.state!=='cancelled',dispatch:false,accept:false,archive:visibility.archiveEligible(mission,bridge),restore:archived}};
  base.autonomous_managed=false;base.display=displayStatus(base.state,{archived,kind:base.kind});base.recovery=recoveryStatus(bridge,mission,base);base.outcome=outcomeSummary(base);base.next_action=nextActionFor(mission,base);base.actions.dispatch=false;return base;
 }
 const db=bridge.controlStore.db, runs=db.prepare('SELECT id,agent_id,state,created_at,updated_at,termination_verified,process_state FROM cp_runs WHERE mission_id=? ORDER BY created_at DESC LIMIT 200').all(mission.id);
 const worker=db.prepare('SELECT r.id,r.agent_id,r.state,r.created_at,r.updated_at,r.termination_verified,r.process_state FROM cp_runs r JOIN cp_dispatches d ON d.run_id=r.id WHERE d.mission_id=? ORDER BY r.created_at DESC LIMIT 1').get(mission.id), task=bridge.tasks.get(mission.task_id);
 const verification=db.prepare('SELECT id,run_id,revision,result,evidence,created_at FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
 const acceptedBinding=verification?db.prepare("SELECT 1 FROM cp_acceptances WHERE mission_id=? AND verification_id=? AND decision='accept'").get(mission.id,verification.id):null;
 const verificationCurrent=!!verification&&verification.run_id===worker?.id&&(verification.revision===mission.revision||mission.state==='completed'&&!!acceptedBinding);
 const checks=verification?JSON.parse(verification.evidence).slice(0,100).map((c,i)=>({label:checkLabel(c.id,i),status:enumValue(c.status,['passed','failed','operator_review','unavailable']),evidence:'Host-measured outcome; raw evidence withheld'})):[];
 const acceptance=verification?db.prepare('SELECT decision,created_at FROM cp_acceptances WHERE mission_id=? AND verification_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id,verification.id):null;
 const settlement=db.prepare('SELECT state,updated_at FROM cp_mission_settlements WHERE mission_id=?').get(mission.id);
 const context=db.prepare('SELECT id,refs,created_at FROM cp_context_packs WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
 let selected=null,contextCurrent=false;
 if(context){try{require('./memory-content-erasure').assertContext(db,context.id);if(mission.envelope.worker_contract){if(JSON.parse(context.refs).length)throw Error('External context denied');}else bridge.opencodeAdapter.authorizedContext({id:context.id});selected=JSON.parse(context.refs).length;contextCurrent=true;}catch{}}
 const ev=bridge.ledger.list({missionId:mission.id,limit:200,order:'desc'}), history=timeline(ev.events);
 const delivered=contextCurrent&&ev.events.some(e=>e.event_type==='runtime.context.delivered' && e.metadata?.context_pack_id===context?.id && e.run_id===worker?.id);
 const workerProvenance=worker?.id?bridge.controlStore.run(worker.id).result?.worker_provenance:null;
 const state=enumValue(mission.state,STATES),budget=task.mission?.budget,used=task.mission?.used;
 const workerAssigned=!!worker?.agent_id;
 // Prefer an observed worker run; preferred_agent alone is not an assignment error on drafts.
 const runtime=workerAssigned?enumValue(worker.agent_id,['opencode','host','claude_code','codex','cursor']):(['draft','ready'].includes(state)?null:enumValue(mission.envelope.preferred_agent,['opencode','host','claude_code','codex','cursor'],null));
 const view={id:id(mission.id),kind:enumValue(mission.envelope.kind,['conversation','coding','browser_research','work_request'],mission.envelope.kind||null),task_id:id(mission.task_id),state,revision:count(mission.revision),label:mission.envelope.kind==='conversation'?'Bounded local conversation':mission.envelope.kind==='browser_research'?'Arecibo product research':'Scoped Mission',workspace:mission.envelope.kind==='conversation'?'Isolated workspace':'Registered workspace',runtime,worker_assigned:workerAssigned,created_at:time(mission.created_at),started_at:time(worker?.created_at),finished_at:worker?.termination_verified===1&&['completed','failed','cancelled','blocked'].includes(worker.state)?time(worker.updated_at):null,observed_at:Date.now(),
  model:mission.envelope.worker_contract?{id:mission.envelope.model,provider:mission.envelope.model_provider,locality:'external',mode:mission.envelope.model_route_mode,declared_context_limit:null,effective_context_limit:null,context_usage:null,tokens:workerProvenance?.usage||null,cost:null,requested:mission.envelope.worker_contract.model,observed:workerProvenance?.observed_model||null}:mission.envelope.preferred_agent==='opencode'&&mission.envelope.model===require('./model-worker-router').MODEL?{id:mission.envelope.model,provider:'ollama',locality:'local',mode:mission.envelope.model_route_mode||'AUTO',declared_context_limit:null,effective_context_limit:null,context_usage:null,tokens:null,cost:null}:null,
  attempts:db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=? AND run_id IS NOT NULL').get(mission.id).n,authority:{status:task.mission?.authorityRevoked?'revoked':'registered; current admission checked by host',expires_at:time(mission.envelope.manifest?.expires_at)},
  ...(['coding','browser_research'].includes(mission.envelope.kind)&&bridge.missions._web?{web:bridge.missions.web.status(mission.id)}:{}),
  ...(mission.envelope.kind==='browser_research'?{research:bridge.missions.research.progress(mission)}:{}),
  budget:{actions_used:count(used?.actions),actions_limit:count(budget?.maxActions),retries_used:count(used?.retries),retries_limit:count(budget?.maxRetries),runtime_limit_ms:count(budget?.maxRuntimeMs)},
  memory:{selected_count:selected,delivery:delivered?'delivered this turn':contextCurrent?'selected; delivery not observed':'unavailable or invalidated',used_this_turn:'Model use is not observable',provenance:contextCurrent?'Current authorized canonical context':'Unavailable'},
  verification:{current:verificationCurrent,id:id(verification?.id),status:enumValue(verification?.result,['passed','failed','operator_review','unavailable'],'not_observed'),checks,run_id:id(verification?.run_id)},
  acceptance:(()=>{
    const auto=!!(acceptance?.decision==='accept'&&(mission.envelope.risk_auto_acceptance?.authorized||mission.envelope.fixture_auto_acceptance?.authorized||mission.envelope.automatic_acceptance));
    const reviewReason=state==='awaiting_acceptance'?(bridge.missions.riskAcceptance?.reviewReason(mission.id)||null):null;
    return{
      status:enumValue(acceptance?.decision,['accept','rework'], state==='draft'?'not_applicable':'pending'),
      at:time(acceptance?.created_at),
      mode:enumValue(auto?'automatically_verified':state==='awaiting_acceptance'||state==='waiting_for_operator'?'needs_operator_review':'not_applicable',['automatically_verified','needs_operator_review','not_applicable']),
      review_reason:typeof reviewReason==='string'&&reviewReason.length<=120?reviewReason:null
    };
  })(),
  settlement:{status:enumValue(settlement?.state,['waiting_acceptance','needs_rework','settled'],'not_observed'),at:time(settlement?.updated_at)},
  termination:{verified:worker?.termination_verified===1,process_state:enumValue(worker?.process_state,['starting','alive','exited','unknown','not_started'],'not_started')},
  progress:progress({state}),timeline:history,history_truncated:ev.has_more,latest_activity:history.at(-1)?.label||(state==='draft'||state==='ready'?'Registered — execution not started':null),
  archived,actions:{cancel:!['completed','cancelled'].includes(state),dispatch:['ready','blocked','needs_rework'].includes(state)&&!task.mission?.authorityRevoked&&(!mission.envelope.manifest?.expires_at||mission.envelope.manifest.expires_at>Date.now())&&!(mission.envelope.kind==='conversation'&&db.prepare('SELECT 1 FROM cp_dispatches WHERE mission_id=?').get(mission.id))&&!runs.some(r=>r.process_state==='unknown')&&!require('./removed-runtime').removed(mission),accept:state==='awaiting_acceptance'&&verificationCurrent,archive:visibility.archiveEligible(mission,bridge)&&!archived,restore:archived}};
 view.autonomous_managed=autonomousManaged(bridge,mission.id);
 view.display=displayStatus(state,{started:!!view.started_at,settled:view.settlement.status==='settled',archived,kind:view.kind});
 view.recovery=recoveryStatus(bridge,mission,view);
 view.outcome=outcomeSummary(view);
 view.next_action=nextActionFor(mission,view);
 if(view.recovery?.suppress_manual||view.autonomous_managed&&['recovering','eligible','waiting'].includes(view.recovery?.kind))view.actions.dispatch=false;
 return view;
}
function runtimeView(ready) {
 const reason=enumValue(ready?.reason,['opencode_runtime_pins_changed','opencode_unavailable','opencode_version_unqualified','opencode_local_provider_unavailable','opencode_local_provider_not_configured','opencode_local_provider_timeout','model_digest_changed','template_hash_changed'],ready?.ready===true?null:'opencode_unavailable');
 return {state:ready?.ready===true?'Ready':reason==='opencode_runtime_pins_changed'?'Degraded':'Unavailable',ready:ready?.ready===true,role:'Primary',version:ready?.version==='2.0.25'?'2.0.25':null,reason,requalification:reason==='opencode_runtime_pins_changed'?'Required':'Not running'};
}
// Soft reference capacities for Control Center meters only — not hard enforcement quotas.
const LAYER_REF={personal:500,project:128,architecture:200,context_pack:20,developer:500};
function layer(id,label,state,{used=null,capacity=null,percent=null,detail=null,authority=false,capacity_kind='reference_soft'}={}){
 let pct=percent;
 if(pct==null){
  if(used!=null&&capacity)pct=Math.min(100,Math.round((used/Math.max(1,capacity))*100));
  else pct=0;
 }
 return {id,label,state,used,capacity,capacity_kind,percent:pct,detail,authority:authority===true};
}
function memoryLayers(bridge,personal){
 const db=bridge.controlStore.db;
 let projectUsed=null,projectState='Unavailable';try{
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_memory_v2_missions'").get()){
   projectUsed=db.prepare('SELECT count(*) n FROM project_memory_v2_missions').get().n;projectState='Ready';
  }else projectState='Configured';
 }catch{projectState='Unavailable';}
 let archUsed=null,archState='Unavailable';try{
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='architecture_memory_versions'").get()){
   archUsed=db.prepare('SELECT count(*) n FROM architecture_memory_versions').get().n;archState='Ready';
  }else archState='Configured';
 }catch{archState='Unavailable';}
 let packUsed=null,packState='Unavailable';try{
  packUsed=db.prepare("SELECT count(*) n FROM cp_context_packs WHERE created_at>? ").get(Date.now()-3_600_000).n;packState='Ready';
 }catch{packState='Unavailable';}
 const personalUsed=count(personal?.active_records)||0;
 const personalState=personal?.state==='Ready'?'Ready':personal?.state==='Unavailable'?'Unavailable':'Configured';
 let developer=null;try{developer=bridge.developerMemory?.stats?.()||null;}catch{developer=null;}
 const developerState=developer?developer.state:(bridge.developerMemory?'Unavailable':'Unavailable');
 const refDetail=kind=>kind==='reference_soft'?' · reference soft capacity (observability)':'';
 return [
  layer('personal','Personal Memory V2',personalState,{used:personalUsed,capacity:LAYER_REF.personal,detail:(personal?.backend||'Personal canonical')+' · ordinary sensitivity'+refDetail('reference_soft')}),
  layer('project','Project Memory V2',projectState,{used:projectUsed,capacity:LAYER_REF.project,detail:'Mission checkpoints · host SQLite'+refDetail('reference_soft')}),
  layer('architecture','Architecture / canonical',archState,{used:archUsed,capacity:LAYER_REF.architecture,detail:'Pinned public source facts'+refDetail('reference_soft')}),
  layer('context_pack','ContextPack (1h)',packState,{used:packUsed,capacity:LAYER_REF.context_pack,detail:'Recent authorized packs · 8 KB selection budget'+refDetail('reference_soft')}),
  layer('developer','Developer Memory V1',developerState,{
   used:developer?.used??0,capacity:developer?.capacity??LAYER_REF.developer,percent:developer?.percent??0,
   capacity_kind:developer?.capacity_kind||'reference_soft',
   detail:developer
    ?(developer.enabled?((developer.allow_retrieval?'retrieval on':'retrieval off')+' · '+(developer.allow_ingest?'ingest on':'ingest off')+' · cache '+developer.prefetch_cache_entries+refDetail('reference_soft')):('disabled by default · provider '+(developer.provider||'none')+refDetail('reference_soft')))
    :'Feature module unavailable',
   authority:false
  })
 ];
}
function memoryStatus(bridge){
 const db=bridge.controlStore.db;
 let memoryReady=false,memoryStats=null,memoryGeneration=null;try{
  if(bridge.authorityRuntime?.active){
   const operator=bridge.authorityRuntime.store.operatorId,now=bridge.authorityRuntime.store.now();
   const rows=db.prepare("SELECT CASE WHEN status='active' AND (expires_at<=? OR last_verified_at+ttl_ms<=?) THEN 'expired' ELSE status END status,count(*) count,sum(revision) revisions FROM authority_memories WHERE operator_id=? AND scope='global' AND kind='personal_preference' AND privacy IN ('public','internal') GROUP BY 1").all(now,now,operator);
   memoryStats={byStatus:Object.fromEntries(rows.map(r=>[r.status,r.count]))};memoryGeneration=JSON.stringify(rows.map(r=>[r.status,r.count,r.revisions]));
  }else{memoryStats=bridge.personalMemory.stats();const rows=db.prepare("SELECT status,count(*) count,max(updated_at) updated FROM personal_memories WHERE domain='personal' AND sensitivity='normal' GROUP BY status ORDER BY status").all();memoryGeneration=JSON.stringify(rows.map(r=>[r.status,r.count,r.updated]));memoryStats={byStatus:Object.fromEntries(rows.map(r=>[r.status,r.count]))};}
  memoryGeneration+=':'+db.prepare('SELECT coalesce(max(generation),0) n FROM memory_erasure_markers').get().n;memoryReady=true;
 }catch{}
 const base={state:memoryReady?'Ready':'Unavailable',local:true,backend:bridge.authorityRuntime?.active?'Governed canonical':'Personal canonical',generation:memoryGeneration,active_records:memoryReady?(count(memoryStats?.byStatus?.active)||0):null,expired_records:memoryReady?(count(memoryStats?.byStatus?.expired)||0):null,superseded_records:memoryReady?(count(memoryStats?.byStatus?.superseded)||0):null};
 try{base.layers=memoryLayers(bridge,base);}catch{base.layers=[];}
 return base;
}
// Operator-only title projection. Aggregate/native surfaces never receive objectives.
function operatorTitle(bridge, mission) {
 if(mission.envelope.kind==='conversation')return 'Bounded local conversation';
 try {
  const projected=mission.task_id?require('./conversation-mission').projectRead(bridge,mission.task_id,mission.envelope.objective,mission.id):mission.envelope.kind==='work_request'?mission.envelope.objective:null;
  if(typeof projected!=='string')return 'Scoped Mission';
  return require('./event-ledger').redactPayload(projected).value.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180)||'Scoped Mission';
 }catch{return 'Title unavailable';}
}
const FILTERS=['All','Active','Needs Attention','Recent','History','Archived','Awaiting Review','Unread Results','Completed','Failed','Settled'];
const PAGE_SIZES=[10,15,25,50];
const RECENT_MS=14*24*60*60*1000;
function missionIndex(bridge){return bridge.controlStore.db.prepare('SELECT id FROM cp_missions ORDER BY created_at DESC,id DESC').all().map(row=>bridge.missions.require(row.id,'operator'));}
function settledIds(bridge){return new Set(bridge.controlStore.db.prepare("SELECT mission_id FROM cp_mission_settlements WHERE state='settled'").all().map(r=>r.mission_id));}
function filterView(bridge,m){
 const managed=autonomousManaged(bridge,m.id);
 const kind=m.envelope?.kind||null;
 const recovery=recoveryStatus(bridge,m,{autonomous_managed:managed,display:displayStatus(m.state,{kind}),state:m.state,kind});
 return {autonomous_managed:managed,recovery,actions:{accept:m.state==='awaiting_acceptance'},state:m.state,display:displayStatus(m.state,{kind}),kind};
}
function matchesFilter(bridge,m,filter,settled,archived){
 const isArchived=archived.has(m.id);
 if(filter==='Archived')return isArchived;
 if(isArchived)return false;
 if(filter==='All')return true;
 const view=filterView(bridge,m);
 const conversationUnread=m.envelope?.kind==='conversation'&&m.state==='awaiting_acceptance';
 if(filter==='Active')return autonomouslyCurrent(m,view);
 if(filter==='Needs Attention')return ownerAttentionRequired(m,view);
 if(filter==='Awaiting Review')return m.state==='waiting_for_operator'||(m.state==='awaiting_acceptance'&&!conversationUnread);
 if(filter==='Unread Results')return conversationUnread;
 if(filter==='Failed')return ['blocked','needs_rework'].includes(m.state)&&!autonomouslyCurrent(m,view)&&!ownerAttentionRequired(m,view);
 if(filter==='Completed')return m.state==='completed';
 if(filter==='Settled')return settled.has(m.id);
 if(filter==='Recent')return !autonomouslyCurrent(m,view)&&!ownerAttentionRequired(m,view)&&(Date.now()-(m.created_at||0)<=RECENT_MS||['completed','cancelled'].includes(m.state)||conversationUnread);
 if(filter==='History')return conversationUnread||(['completed','cancelled','draft','ready','paused','blocked','needs_rework'].includes(m.state)&&!ACTIVE.includes(m.state)&&!['awaiting_acceptance','waiting_for_operator'].includes(m.state));
 return false;
}
function missionCounts(bridge,missions=missionIndex(bridge)){
 // No process-global or cross-bridge cache: counts must follow canonical missions.require
 // reads (including test stubs) and must not leak between Bridge instances.
 // Menu/nativeStatus never calls this — it uses bounded SQL instead.
 const settled=settledIds(bridge),archived=require('./mission-visibility').archivedSet(bridge.controlStore.db);
 return Object.fromEntries(FILTERS.map(name=>[name,missions.filter(m=>matchesFilter(bridge,m,name,settled,archived)).length]));
}
function missionListItem(bridge,mission,{settled,archived}){
 const title=operatorTitle(bridge,mission);
 const full=missionView(bridge,mission);
 const isArchived=archived.has(mission.id);
 return {
  id:full.id,label:title,state:full.state,display:full.display,outcome:full.outcome,runtime:full.runtime,worker_assigned:full.worker_assigned,
  created_at:full.created_at,started_at:full.started_at,finished_at:full.finished_at,
  latest_activity:full.latest_activity,next_action:full.next_action,archived:isArchived,autonomous_managed:full.autonomous_managed,recovery:full.recovery,
  verification:{status:full.verification.status,current:full.verification.current},
  acceptance:{status:full.acceptance.status},settlement:{status:full.settlement.status},
  actions:{accept:full.actions.accept,archive:full.actions.archive,restore:full.actions.restore,cancel:full.actions.cancel,dispatch:full.actions.dispatch},
  task_id:full.task_id,model:full.model?{id:full.model.id}:null
 };
}
function missionHistory(bridge,url){
 require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
 require('./mission-visibility').ensure(bridge.controlStore.db);
 const filter=url.searchParams.get('filter')||'All',query=(url.searchParams.get('query')||'').trim().toLowerCase();
 const offset=Number(url.searchParams.get('offset')||0);
 const limitRaw=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):15;
 const worker=(url.searchParams.get('worker')||'').trim().toLowerCase();
 const sort=url.searchParams.get('sort')||'newest';
 if(!FILTERS.includes(filter)||query.length>180||!Number.isSafeInteger(offset)||offset<0||!PAGE_SIZES.includes(limitRaw)||(worker&&!['opencode','host','claude_code','codex','cursor','none'].includes(worker))||!['newest','oldest'].includes(sort))throw Error('Invalid Mission history query');
 const limit=limitRaw;
 const missions=missionIndex(bridge),settled=settledIds(bridge),archived=require('./mission-visibility').archivedSet(bridge.controlStore.db);
 const ranked=sort==='oldest'?[...missions].reverse():missions;
 const matches=[];let total=0;
 for(const mission of ranked){
  if(!matchesFilter(bridge,mission,filter,settled,archived))continue;
  const title=operatorTitle(bridge,mission);
  const preferred=(mission.envelope.preferred_agent||'').toLowerCase();
  const run=bridge.controlStore.db.prepare('SELECT r.agent_id FROM cp_runs r JOIN cp_dispatches d ON d.run_id=r.id WHERE d.mission_id=? ORDER BY r.created_at DESC LIMIT 1').get(mission.id);
  const assigned=(run?.agent_id||'').toLowerCase();
  if(worker==='none'?(assigned||preferred):worker&&assigned!==worker&&preferred!==worker)continue;
  if(query&&![mission.id,title,mission.state,preferred,assigned].join(' ').toLowerCase().includes(query))continue;
  if(total>=offset&&matches.length<limit)matches.push(missionListItem(bridge,mission,{settled,archived}));
  total++;
 }
 const page=Math.floor(offset/limit)+1,pages=total?Math.ceil(total/limit):1;
 return {missions:matches,total,offset,limit,page,pages,has_more:offset+matches.length<total,filter,query,worker:worker||null,sort,counts:missionCounts(bridge,missions),observed_at:Date.now(),scope:`Missions · ${filter} · newest first · ${limit} per page · stable id tie-break`};
}
function notificationEvents(bridge,after){
 const epoch=bridge.runtimeFingerprint?.captured_at||null,latest=bridge.controlStore.db.prepare('SELECT coalesce(max(seq),0) n FROM event_ledger_events').get().n;
 if(after===null||after>latest)return {epoch,cursor:latest,events:[],reset:true};
 if(!Number.isSafeInteger(after)||after<0)throw Error('Invalid notification cursor');
 const batch=bridge.ledger.list({afterSequence:after,limit:200});
 const kinds={'approval.requested':'review','approval.required':'review','mission.completed':'completed','mission.awaiting_acceptance':'review','mission.waiting_for_operator':'review','mission.needs_rework':'failed','mission.blocked':'failed'};
 return {epoch,cursor:batch.events.at(-1)?.sequence??after,has_more:batch.has_more,events:batch.events.filter(e=>kinds[e.event_type]&&id(e.mission_id)).map(e=>({id:e.event_id,mission_id:e.mission_id,kind:kinds[e.event_type]}))};
}
async function overview(bridge,{includeMissions=true,currentOffset=0}={}) {
 if(!Number.isSafeInteger(currentOffset)||currentOffset<0)throw Error('Invalid current Mission page');
 require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
 const db=bridge.controlStore.db, ready=await bridge.opencodeAdapter.readiness();
 const leases=db.prepare("SELECT state,count(*) count FROM cp_leases WHERE state IN ('held','quarantined') GROUP BY state").all();
 const memory=memoryStatus(bridge),memoryReady=memory.state==='Ready';
 const currentCount=db.prepare("SELECT count(*) n FROM cp_missions WHERE state NOT IN ('completed','cancelled')").get().n;
 const mission_counts=includeMissions?missionCounts(bridge):null;
 // Prefer canonical Mission reads for Active/Review/Failed so stale storage cannot overstate live work.
 const activeCount=mission_counts?mission_counts.Active:db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('dispatching','running','verifying')").get().n;
 // Needs Attention excludes historical conversation unread results.
 const reviewCount=mission_counts?mission_counts['Needs Attention']:db.prepare("SELECT count(*) n FROM cp_missions WHERE state='waiting_for_operator' OR (state='awaiting_acceptance' AND coalesce(json_extract(envelope,'$.kind'),'')!='conversation')").get().n;
 const failedCount=mission_counts?mission_counts.Failed:db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('blocked','needs_rework')").get().n;
 const current=(includeMissions?db.prepare("SELECT id FROM cp_missions WHERE state NOT IN ('completed','cancelled') ORDER BY CASE WHEN state IN ('dispatching','running','verifying') THEN 0 ELSE 1 END,created_at DESC,id LIMIT 50 OFFSET ?").all(currentOffset):[]).map(m=>missionView(bridge,bridge.controlStore.requireMission(m.id)));
 const recent=(includeMissions?bridge.controlStore.listMissions({limit:50}):[]).map(m=>missionView(bridge,m));
 const missions=[...new Map([...current,...recent].map(m=>[m.id,m])).values()];
 const approvalRecords=bridge.policy.list(),pending=approvalRecords.filter(a=>a.status==='pending'&&(!a.expiresAt||a.expiresAt>Date.now())).length;
 const approvals=approvalRecords.sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)).slice(0,50).map(a=>({id:id(a.id),task_id:id(a.taskId),label:'Protected operation',status:enumValue(a.status,['pending','approved','expired','rejected','revoked','used']),created_at:time(a.createdAt),expires_at:time(a.expiresAt)}));
 const runtime=runtimeView(ready),ledger=bridge.ledger.health();
 let cursor={agent_availability:'unqualified',agent_execution:false,agent_reason:'cursor_execution_unqualified',editor_available:false,last_ide_task:null};
 try{
  const governed=bridge.cursorWorker?await bridge.cursorWorker.readiness():null;
  if(governed&&bridge.cursorWorker)bridge.cursorWorker.lastReadiness=governed;
  const agents=await bridge.capabilityHost.agentStatus();
  const c=governed?{...agents?.cursor,availability:governed.availability,agent_availability:governed.ready?'available':governed.availability,agent_execution:governed.ready===true,agent_reason:governed.reason||(governed.ready?'governed_sandboxed_headless':'cursor_execution_unqualified'),installed:governed.installed}:agents?.cursor||{};
  cursor={
    agent_availability:enumValue(c.agent_availability||c.availability,['unqualified','unavailable','auth_required','quota_limited','available'],'unqualified'),
    agent_execution:c.agent_execution===true,
    agent_reason:typeof c.agent_reason==='string'?c.agent_reason.slice(0,120):(typeof c.runtime?.reason==='string'?c.runtime.reason.slice(0,120):'cursor_execution_unqualified'),
    editor_available:c.editor_available===true||c.installed===true,
    last_ide_task:c.last_ide_task&&typeof c.last_ide_task==='object'?{
      status:enumValue(c.last_ide_task.status,['running','completed','failed','timed_out','cancelled','not_observed'],'not_observed'),
      label:typeof c.last_ide_task.label==='string'?c.last_ide_task.label.slice(0,80):null,
      exit_code:Number.isInteger(c.last_ide_task.exit_code)?c.last_ide_task.exit_code:null,
      agent_execution:false
    }:null
  };
 }catch{/* Cursor projection is best-effort. */}
 const outcomesBoard=(()=>{
   const attention=[],progress=[],results=[];
   for(const m of missions){
    const o=m.outcome||outcomeSummary(m);
    let label=m.label;
    try{const titled=operatorTitle(bridge,bridge.missions.require(m.id,'operator'));if(titled&&titled!=='Scoped Mission')label=titled;}catch{}
    const row={id:m.id,label:label||'Mission',headline:o.headline,detail:o.detail,state:m.state};
    if(o.kind==='decision'||o.kind==='attention')attention.push(row);
    else if(o.kind==='progress')progress.push(row);
    else if(o.kind==='result'&&['completed','cancelled'].includes(m.state))results.push({...row,success:o.success===true});
   }
   return {progress:progress.slice(0,8),decisions:attention.slice(0,12),results:results.slice(0,8),authority:false};
  })();
 const overviewStatus=bridge.closed?'Unavailable':runtime.ready&&memoryReady&&ledger?.healthy===true&&!leases.some(l=>l.state==='quarantined')?'Ready':'Degraded';
 const connectivity=require('./connection-status').derive({authorized:true,reachable:true,overviewStatus,lastOkAt:Date.now(),maintenance:!!bridge.closed});
 const acceptanceConfig=(()=>{try{return bridge.missions.riskAcceptance.status();}catch{return{preference:{enabled:false},waits:require('./wait-presentation').status(bridge)};}})();
 const workspace_watch=(()=>{try{return bridge.workspaceActivityWatch?.status?.()||{continuous_filesystem_watch:false};}catch{return{continuous_filesystem_watch:false};}})();
 return {epoch:bridge.runtimeFingerprint?.captured_at||null,observed_at:Date.now(),version:require('../package.json').version,release_state:'PRE-RELEASE',status:overviewStatus,connectivity,
  control:{state:bridge.closed?'Unavailable':'Ready',reason:'Local operator endpoint observation'},connection:{state:'Unavailable',reason:'Authenticated external client / MCP not checked; does not imply service disconnect'},runtime,cursor,workspace_watch,acceptance_config:acceptanceConfig,memory,
  assistant:await require('./model-worker-router').inspect(bridge),connectors:require('./assistant-service').connectors(bridge).status(),whatsapp_inbound:(()=>{try{return bridge.whatsappInbound?.status()||null;}catch{return null;}})(),whatsapp_conversations:(()=>{try{return bridge.whatsappConversations?.status()||null;}catch{return null;}})(),whatsapp_outbound:(()=>{try{return bridge.whatsappOutbound?.status()||null;}catch{return null;}})(),whatsapp_production_connection:(()=>{try{return require('./whatsapp-production-connection').productionConnectionStatus(bridge);}catch{return null;}})(),development_sessions:(()=>{try{return bridge.developmentSessions?.status()||null;}catch{return null;}})(),sensitive:{disclosure:'Operator-only reveal; no worker context',encryption:'No field-level encryption claim'},vault:{backend:'macOS Keychain host port',values_displayed:false,worker_access:false},
  projects:includeMissions?bridge.projects.listProjects({limit:50}).map(p=>({id:id(p.projectId),status:enumValue(p.status,['active','paused','completed','archived']),label:'Registered project',updated_at:time(p.updatedAt)})):[],
  provider:{state:runtime.ready?'Ready':ready?.provider_ready===false?'Unavailable':'Unavailable',reason:runtime.ready?'Qualified local provider observed':'Readiness unavailable'},
  approvals:{waiting:pending,records:includeMissions?approvals:[],scope:'Up to 50 retained protected Approvals, pending first'},leases:{held:leases.find(l=>l.state==='held')?.count||0,quarantined:leases.find(l=>l.state==='quarantined')?.count||0},
  audit:{state:ledger?.healthy===true?'Ready':ledger?.state==='degraded'?'Degraded':'Unavailable',retained_events:count(db.prepare('SELECT count(*) n FROM event_ledger_events').get().n)},disk:{state:'Unavailable',reason:'Not checked'},
  missions,mission_counts,outcomes:outcomesBoard,current_mission_ids:current.map(m=>m.id),counts:{scope:'Recent 50 retained Missions plus a separate current Mission page',visible:missions.length,active:activeCount,review:reviewCount,failed:failedCount,current:currentCount,current_offset:currentOffset,current_page_size:current.length,current_has_more:currentOffset+current.length<currentCount},
  core_contracts:(()=>{try{return require('./core-contracts').manifest();}catch{return null;}})(),
  runtime_security:(()=>{try{return require('./runtime-security-conformance').evaluate(bridge);}catch{return null;}})(),
  installation_compatibility:(()=>{try{return require('./installation-compatibility').evaluate(bridge);}catch{return null;}})(),
  limitations:['Model reasoning and prompts are private.','Memory delivery does not prove model use.','Worker completion requires independent verification, Acceptance and Settlement.','Runtime security VERIFIED states require host evidence; worker self-reports are insufficient.']};
}
async function nativeStatus(bridge) {
 const s=await overview(bridge,{includeMissions:false}),db=bridge.controlStore.db;
 require('./mission-visibility').ensure(db);
 // Featured menu Mission is live execution only — awaiting_acceptance / waiting_for_operator are review, not active work.
 const live=db.prepare("SELECT id FROM cp_missions WHERE state IN ('dispatching','running','verifying') AND id NOT IN (SELECT mission_id FROM cp_mission_visibility WHERE archived=1) ORDER BY created_at DESC,id LIMIT 1").get();
 const m=live?missionView(bridge,bridge.controlStore.requireMission(live.id)):null;
 // Hot path: bounded SQL counts only. Never missionIndex/missionCounts — that loads every
 // retained Mission graph (runs, ledger pages, recovery inspect) on each menu poll.
 // Exclude presentation-archived rows so menu counts match filter semantics.
 const notArchived="id NOT IN (SELECT mission_id FROM cp_mission_visibility WHERE archived=1)";
 const activeCount=db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('dispatching','running','verifying') AND "+notArchived).get().n;
 const reviewCount=db.prepare("SELECT count(*) n FROM cp_missions WHERE ("+notArchived+") AND (state='waiting_for_operator' OR (state='awaiting_acceptance' AND coalesce(json_extract(envelope,'$.kind'),'')!='conversation'))").get().n;
 const unreadResults=db.prepare("SELECT count(*) n FROM cp_missions WHERE ("+notArchived+") AND state='awaiting_acceptance' AND coalesce(json_extract(envelope,'$.kind'),'')='conversation'").get().n;
 const failedCount=db.prepare("SELECT count(*) n FROM cp_missions WHERE state IN ('blocked','needs_rework') AND "+notArchived).get().n;
 const {derive,menuPresentation}=require('./connection-status');
 const connectivity=derive({authorized:true,reachable:true,overviewStatus:s.status,lastOkAt:Date.now(),maintenance:!!bridge.closed});
 const presentation=menuPresentation({bridgeState:bridge.closed?'Stopped':'Connected',productStatus:s.status,activeMissions:activeCount,approvals:s.approvals.waiting,reviewMissions:reviewCount,missionState:m?.state||null});
 const activity_status=presentation.tone==='working'?'CONNECTED · '+activeCount+' active':presentation.label;
 const elapsed_s=m?.started_at?Math.max(0,Math.floor((Date.now()-m.started_at)/1000)):null;
 const conversationNickname=(()=>{try{return bridge.conversationEngine?.nickname?.()||null;}catch{return null;}})();
 const conversationModel=s.runtime.ready?require('./model-worker-router').MODEL:null;
 return {status:s.status,control:s.control.state,runtime:s.runtime.state,runtimeReason:s.runtime.reason,memory:s.memory.state,provider:s.provider.state,approvals:s.approvals.waiting,active_missions:activeCount,quarantined_leases:s.leases.quarantined,
  activity_status,connection_state:connectivity.state,connection_label:presentation.label,menu_tone:presentation.tone,
  model:m?.model?.id||(s.runtime.ready?require('./model-worker-router').MODEL:'Unavailable'),routing:m?.model?.mode||(s.runtime.ready?'AUTO · local policy':'Unavailable'),connectors:s.connectors.items.map(c=>c.id+': '+c.state).join(' · '),
  workers:'OpenCode: '+s.runtime.state+' · Provider: '+s.provider.state+' · Cursor Agent: '+(s.cursor?.agent_availability||'unqualified'),
  cursor:s.cursor,
  acceptance_config:s.acceptance_config,
  conversation:{nickname:conversationNickname,model:conversationModel,worker:conversationModel?'local-ollama':null,channel:'browser',separated_from_missions:true},
  installation:s.installation_compatibility?{overall:s.installation_compatibility.overall,mutations_allowed:s.installation_compatibility.mutations_allowed,components:s.installation_compatibility.components.length}:null,
  mission:m?{id:m.id,label:m.label,state:m.state,phase:m.timeline.at(-1)?.label||'No transition observed',progress:m.progress.mode,worker:m.runtime||null,model:m.model?.id||null,elapsed_s,progress_value:m.progress.mode==='determinate'?m.progress.value:null,progress_maximum:m.progress.mode==='determinate'?m.progress.maximum:null}:null,
  review_missions:reviewCount,
  unread_results:unreadResults,
  failed_missions:failedCount,
  diagnostic:['AIRODROM · PRE-RELEASE','Control: '+s.control.state,'OpenCode: '+s.runtime.state+' · Primary','Memory V2: '+s.memory.state+' · Local','Provider: '+s.provider.state,'Conversation: '+(conversationNickname||'Airo')+' · '+(conversationModel||'Unavailable'),'Installation: '+(s.installation_compatibility?.overall||'Unavailable'),'Active Missions: '+activeCount,'Needs Attention: '+reviewCount,'Unread Results: '+unreadResults,'Waiting Approvals: '+s.approvals.waiting,'Menu: '+presentation.label,'No tokens, URLs, paths, memory, prompts or process arguments exported.'].join('\n')};
}
function events(bridge,url) {
 const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)throw Error('Invalid event cursor');
 const mission=url.searchParams.get('mission');if(mission&&!id(mission))throw Error('Invalid Mission ID');
 const category=url.searchParams.get('category');if(category&&!['Mission','Runtime','Memory','Capability','Verification','Approval','Settlement','System','Worker','File','Git','Command','Test'].includes(category))throw Error('Invalid category');
 const batch=bridge.ledger.list({afterSequence:after,limit:200,...(mission?{missionId:mission}:{})});
 return {events:timeline(batch.events).filter(e=>!category||e.category===category),cursor:batch.events.at(-1)?.sequence||after,has_more:batch.has_more,observed_at:Date.now()};
}
module.exports={id,state:value=>enumValue(value,STATES),STAGES,STATES,ACTIVE,FILTERS,PAGE_SIZES,displayStatus,outcomeSummary,autonomousManaged,recoveryStatus,ownerAttentionRequired,autonomouslyCurrent,eventView,timeline,progress,missionView,runtimeView,overview,nativeStatus,events,memoryStatus,operatorTitle,missionHistory,missionCounts,missionIndex,notificationEvents};
