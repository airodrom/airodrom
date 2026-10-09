'use strict';
// Canonical "run is settled" contract for admission and maintenance gates.
//
// control-execution writes process_state='idle' for verified host turns: the
// reusable host session may outlive the turn, but nothing executes for that run.
// 'idle' therefore settles a run only for the host agent, and only with every
// other proof present. Anything missing, NULL or unrecognised stays unresolved.
// Global gates (dispatches, effects, invocations, in-memory leases) still apply.
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

const SETTLED_RUN = `(r.state IN ('${TERMINAL.join("','")}') AND r.termination_verified IS 1 AND (
  r.process_state IN ('exited','not_started')
  OR (r.process_state = 'idle' AND r.agent_id = 'host' AND r.liveness_state = 'settled'
      AND r.pid IS NULL AND r.ended_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cp_leases l WHERE l.run_id = r.id AND (l.state IS NULL OR l.state <> 'released')))))`;

// COALESCE turns any NULL comparison into "unresolved" rather than silently passing.
const UNRESOLVED_RUNS_SQL = `SELECT count(*) n FROM cp_runs r WHERE COALESCE(${SETTLED_RUN}, 0) = 0`;

function unresolvedRuns(db) { return db.prepare(UNRESOLVED_RUNS_SQL).get().n; }

// Fixed reason codes for diagnostics; never includes result payloads.
function unresolvedReasons(db, limit = 20) {
  return db.prepare(`SELECT r.id run_id, r.agent_id, r.state, r.process_state, r.termination_verified, r.liveness_state FROM cp_runs r WHERE COALESCE(${SETTLED_RUN}, 0) = 0 ORDER BY r.updated_at DESC LIMIT ?`).all(limit)
    .map(r => ({ run_id: r.run_id, agent_id: r.agent_id, state: r.state, process_state: r.process_state,
      reason: !TERMINAL.includes(r.state) ? 'not_terminal' : r.termination_verified !== 1 ? 'termination_unverified'
        : r.process_state === 'idle' ? (r.agent_id !== 'host' ? 'idle_outside_host' : 'idle_without_settlement_proof') : 'process_state_unresolved' }));
}

// Durable admission blockers, identical in meaning to the lifecycle and maintenance gates.
// A table that does not exist yet holds no work; any other failure throws (fail closed).
const DURABLE = {
  leases: "SELECT count(*) n FROM cp_leases WHERE state IS NULL OR state <> 'released'",
  invocations: "SELECT count(*) n FROM cp_invocations WHERE state IN ('running','unknown')",
  dispatches: "SELECT count(*) n FROM cp_dispatches WHERE state IN ('dispatching','running','unknown')",
  continuations: "SELECT count(*) n FROM cp_continuations WHERE state IN ('dispatching','unknown')",
  slack_effects: "SELECT count(*) n FROM cp_slack_outbox WHERE state IN ('sending','delivery_unknown')",
  effects: "SELECT count(*) n FROM cp_effect_outbox WHERE status IN ('dispatching','delivery_unknown')"
};
function durableBlockers(db) {
  const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const out = { runs: unresolvedRuns(db) };
  for (const [key, sql] of Object.entries(DURABLE)) out[key] = exists(sql.match(/FROM (\w+)/)[1]) ? db.prepare(sql).get().n : 0;
  return out;
}

module.exports = { TERMINAL, SETTLED_RUN, UNRESOLVED_RUNS_SQL, DURABLE, unresolvedRuns, unresolvedReasons, durableBlockers };
