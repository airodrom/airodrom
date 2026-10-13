'use strict';
// ADR 0051. Operational component states for the autonomous development platform.
// Vocabulary: READY | DEGRADED | UNAVAILABLE | BLOCKED | RECOVERING. A component is
// never READY merely because something is installed; each state is derived from a
// host observation. Worker tiers separate installed / authenticated / qualified /
// available / executing / verified. Nothing here grants authority.
const STATES = Object.freeze(['READY', 'DEGRADED', 'UNAVAILABLE', 'BLOCKED', 'RECOVERING']);

function count(db, sql, ...args) { try { return db.prepare(sql).get(...args)?.n ?? 0; } catch { return null; } }

async function componentStatus(bridge, { probeWorkers = true } = {}) {
  const db = bridge.controlStore.db;
  const out = { schema_version: 1, vocabulary: STATES, components: {}, workers: {}, audit_events: null, authority: false, observed_at: Date.now() };
  // Airodrom service
  const lifecycle = bridge.lifecycle?.state?.() || 'unknown';
  out.components.airodrom_service = { state: bridge.closed ? 'UNAVAILABLE' : lifecycle === 'open' ? 'READY' : lifecycle === 'booting' ? 'RECOVERING' : 'DEGRADED', detail: 'admission ' + lifecycle };
  // Goal planner / CAE scheduler
  const plans = count(db, "SELECT count(*) n FROM cp_mission_programs WHERE goal_plan IS NOT NULL AND state='goal_observing'");
  const quarantined = count(db, "SELECT count(*) n FROM cp_leases WHERE state='quarantined'");
  const unknownDispatch = count(db, "SELECT count(*) n FROM cp_dispatches WHERE state='unknown'");
  let recovering = 0, blocked = 0;
  try { for (const p of bridge.autonomousExecution?.list(50) || []) { if (p.autonomous?.lifecycle === 'recovering') recovering += 1; if (['failed', 'quarantined'].includes(p.autonomous?.lifecycle)) blocked += 1; } } catch { /* planner unavailable */ }
  out.components.goal_planner = { state: bridge.missions?.goalPlanner ? 'READY' : 'UNAVAILABLE', detail: plans + ' observing plan(s)' };
  out.components.cae_scheduler = { state: !bridge.autonomousExecution ? 'UNAVAILABLE' : quarantined || unknownDispatch ? 'BLOCKED' : recovering ? 'RECOVERING' : bridge.autonomousExecution.busy ? 'DEGRADED' : 'READY', detail: 'recovering ' + recovering + ', failed/quarantined ' + blocked + ', quarantined leases ' + quarantined + ', unknown dispatches ' + unknownDispatch };
  // Workers
  const tiers = (r, extra = {}) => ({ installed: !!r.installed, authenticated: r.tiers?.authenticated ?? (r.auth_state ? !/required|unavailable/.test(String(r.auth_state)) : null), qualified: r.tiers?.qualified ?? r.ready === true, available: r.ready === true && r.availability === 'available', executing: r.availability === 'busy' || r.tiers?.executing === true, verified: null, ...extra });
  if (probeWorkers) {
    try {
      const r = await bridge.opencodeAdapter.readiness();
      const verified = count(db, "SELECT count(*) n FROM cp_verifications v JOIN cp_runs r ON r.id=v.run_id WHERE r.agent_id='opencode' AND v.result='passed'");
      out.workers.opencode = { state: r.ready ? (r.availability === 'busy' ? 'DEGRADED' : 'READY') : 'UNAVAILABLE', version: r.version, reason: r.reason, tiers: tiers(r, { verified: verified > 0 }), verified_runs: verified, sandbox: 'sandbox-exec (loopback only; external network denied)', cost: 'LOCAL_NO_SPEND' };
    } catch (error) { out.workers.opencode = { state: 'UNAVAILABLE', reason: 'readiness_probe_failed', tiers: null }; }
    try {
      const r = bridge.cursorWorker ? await bridge.cursorWorker.readiness() : null;
      const verified = count(db, "SELECT count(*) n FROM cp_verifications v JOIN cp_runs r ON r.id=v.run_id WHERE r.agent_id='cursor' AND v.result='passed'");
      out.workers.cursor = r ? { state: r.ready ? (r.availability === 'busy' ? 'DEGRADED' : 'READY') : r.installed ? 'BLOCKED' : 'UNAVAILABLE', version: r.version, reason: r.reason, owner_step: r.owner_step || null, tiers: tiers(r, { verified: verified > 0 }), verified_runs: verified, credential_source: r.credential_source, isolation: r.isolation, cost: 'UNKNOWN_SUBSCRIPTION' } : { state: 'UNAVAILABLE', reason: 'governed_worker_absent', tiers: null };
    } catch (error) { out.workers.cursor = { state: 'UNAVAILABLE', reason: 'readiness_probe_failed', tiers: null }; }
    out.workers.claude_code = { state: 'UNAVAILABLE', reason: 'optional_worker_not_qualified_for_autonomous_execution', tiers: { installed: null, authenticated: null, qualified: false, available: false, executing: false, verified: null } };
  }
  // Ollama (local provider) from the OpenCode readiness detail
  out.components.ollama = { state: out.workers.opencode?.state === 'READY' ? 'READY' : out.workers.opencode?.reason === 'opencode_local_provider_unavailable' ? 'UNAVAILABLE' : 'DEGRADED', detail: out.workers.opencode?.reason || 'observed through OpenCode readiness' };
  // MCP
  const mcpReady = bridge.mcpReady === true || bridge.mcp?.ready === true || typeof bridge.lastMcpCallAt === 'number';
  out.components.mcp = { state: bridge.closed ? 'UNAVAILABLE' : mcpReady ? 'READY' : 'DEGRADED', detail: mcpReady ? 'tool catalog served' : 'no MCP call observed in this process' };
  // Verifier
  out.components.verifier = { state: bridge.missions?.verifier ? (quarantined ? 'BLOCKED' : 'READY') : 'UNAVAILABLE', detail: 'airodrom:host-verifier; trusted baseline + security scans' };
  // Sandbox
  let sandbox = { state: 'UNAVAILABLE', detail: 'sandbox-exec not present' };
  if (process.platform === 'darwin' && require('node:fs').existsSync('/usr/bin/sandbox-exec')) {
    const q = bridge.cursorWorker?.qualification?.() || {};
    sandbox = { state: q.sandbox_containment === 'PROVEN' ? 'READY' : 'DEGRADED', detail: q.sandbox_containment === 'PROVEN' ? 'containment PROVEN ' + new Date(q.sandbox_containment_observed_at || 0).toISOString().slice(0, 10) : 'containment not yet proven on this install' };
  }
  out.components.sandbox = sandbox;
  // Mission store
  try { db.prepare('SELECT count(*) n FROM cp_missions').get(); out.components.mission_store = { state: 'READY', detail: 'SQLite reachable' }; } catch { out.components.mission_store = { state: 'UNAVAILABLE', detail: 'SQLite unreachable' }; }
  // Slack
  const slack = bridge.slackRuntime?.status?.() || null;
  out.components.slack_notifications = { state: !slack ? 'UNAVAILABLE' : slack.enabled && slack.connected ? 'READY' : slack.enabled ? 'DEGRADED' : 'UNAVAILABLE', detail: slack ? (slack.enabled ? (slack.connected ? 'connected' : 'enabled but not connected') : 'not configured; Mission start/completion alerts are recorded as a limitation') : 'runtime absent' };
  // Audit event summary (append-only ledger counts for the key lifecycle events)
  const types = ['mission.approval.issued', 'mission.approval.bound', 'mission.approval.revoked', 'goal.autonomous.dispatched', 'runtime.execution.started', 'worker.terminated', 'mission.needs_rework', 'goal.autonomous.repair_created', 'goal.autonomous.repair_pending', 'goal.autonomous.repair_blocked', 'mission.awaiting_acceptance', 'mission.accepted', 'mission.completed', 'mission.blocked', 'worker.trace'];
  try { out.audit_events = Object.fromEntries(types.map(t => [t, db.prepare('SELECT count(*) n FROM event_ledger_events WHERE event_type=?').get(t)?.n ?? 0])); } catch { out.audit_events = null; }
  return out;
}

module.exports = { componentStatus, STATES };
