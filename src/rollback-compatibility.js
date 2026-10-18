'use strict';
// A guarded rollback can retain newer contracts without executing or accepting them.
// Cancellation and durable result intake remain available; forward source must
// interpret the newer graph before work can advance. No authority is inferred here.
function unsupported(mission) {
  const cognitive = mission?.envelope?.cognitive;
  return cognitive != null && ![1, 2].includes(cognitive.envelope?.version);
}
function assertSupported(mission) {
  if (unsupported(mission)) throw Error('unsupported_cognitive_source');
}
function projection() {
  return { supported: false, reason: 'unsupported_cognitive_source', read_only: true,
    next_safe_action: 'Restore compatible source to evaluate or advance this Mission. Cancellation remains available.', authority: false };
}
function evidence(bridge, mission) {
  const db = bridge.controlStore.db;
  const acceptance = db.prepare('SELECT decision FROM cp_acceptances WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(mission.id);
  const settlement = db.prepare('SELECT state FROM cp_mission_settlements WHERE mission_id=?').get(mission.id);
  const runs = db.prepare('SELECT id,agent_id,state,process_state,termination_verified FROM cp_runs WHERE mission_id=? ORDER BY created_at').all(mission.id);
  return { mission_id: mission.id, root_mission_id: mission.id, state: mission.state,
    status: 'UNSUPPORTED_SOURCE', phase: 'unsupported_source', compatibility: projection(),
    acceptance_status: acceptance?.decision || 'not_recorded', settlement_status: settlement?.state || null,
    runs, repair_attempts: null, approval_status: null, authority: false,
    known_limitations: ['Retained newer Mission evidence is not interpreted by this rollback source. Stored state and outcomes are preserved.'],
    next_safe_action: projection().next_safe_action };
}
module.exports = { unsupported, assertSupported, projection, evidence };
