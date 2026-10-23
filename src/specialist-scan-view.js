'use strict';
// Scan projection for host-assembled specialist packets only. Callers must first
// bind the exact serialized packet to current host state. Prose, paths, unknown
// fields and malformed coordinates remain unchanged; delivered bytes are intact.
const scanDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? '[host digest]' : value;
const scanUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value) ? '[host UUID]' : value;
function assignmentLabel() { return 'assignment'; }
function assignmentCoordinate(mission, id) { return [assignmentLabel(), mission, id].join(':'); }
function projectedAssignmentKey(record) {
  const current = record.idempotency_key;
  if (current !== assignmentCoordinate(record.parent_mission_id, record.id)) return current;
  return assignmentCoordinate(scanUuid(record.parent_mission_id), record.id);
}
function assignmentSafetyView(a) {
  return {...a,parent_mission_id:scanUuid(a.parent_mission_id),sealed_contract_hash:scanDigest(a.sealed_contract_hash),workspace_id:scanUuid(a.workspace_id),
    repository_id:typeof a.repository_id==='string'?a.repository_id.split(':').map(scanUuid).join(':'):a.repository_id,
    idempotency_key:projectedAssignmentKey(a)};
}
function feedbackSafetyView(r){return r?{...r,worker_run_id:scanUuid(r.worker_run_id),evaluation_run_id:scanUuid(r.evaluation_run_id),binding_hash:scanDigest(r.binding_hash)}:r;}
function specialistObjectiveSafetyView(input){return {...input,assignment:assignmentSafetyView(input.assignment),prior_evaluation:feedbackSafetyView(input.prior_evaluation),repair_context:feedbackSafetyView(input.repair_context)};}
module.exports = { scanDigest, scanUuid, assignmentSafetyView, specialistObjectiveSafetyView };
