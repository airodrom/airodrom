# ADR 0061: READY specialist auto-admit and scheduler ownership

- Status: Proposed
- Date: 2026-10-23
- Owner: Control-plane / specialist gateway
- Review: Pending
- Affected contracts and components: `src/specialist-gateway.js`, `src/mission-program.js`, `src/mission-service.js`, `src/cognitive-router.js`, `src/limits-blockers-recovery.js`, `src/product-observability.js`, `config/limits-blockers-registry-v1.json`
- Related decisions: [0059](0059-specialist-gateway.md), [0058](0058-opencode-result-gateway.md), [0057](0057-cognitive-mission-router.md), [0052](0052-autonomous-supervisor.md)

## Context and problem

Authorized specialist Missions could seal as parent `ready` with program state
`prepared` and never receive a first assignment dispatch when the initial
`cognitive-dispatch` wake was lost or failed. `mission-program.tick` ignored
`prepared` graphs, and recovery mis-applied evaluation reuse to never-started
work. Observed on Mission `3a6edd9e-e79f-47fd-b78e-2761a76bb367` (ChatGPT
`chatgpt_post223_read_edit_acceptance_20261023_a`): READY, authorized, zero
dispatches, until authority expiry. Separately, `/api/product/native-status`
could block ~10–11s on readiness/overview work against a 10s client timeout.

## Decision

1. **Single scheduler owner:** `MissionService.tick` in the primary control
   service owns dispatch wake. No parallel LaunchAgent/OpenCode/goal scheduler
   invents Cursor runs.
2. **`admitReady` / `admitPreparedReady`:** Idempotent first-assignment queue for
   sealed READY + prepared specialist parents; deadline and grant failures fail
   closed with actionable blockers.
3. **`mission-program.tick` includes `prepared`** specialist graphs and delegates
   to `specialist-gateway.tick`, which admits before dependency advancement.
4. **Orphan READY:** Failed initial `missions.dispatch` while still `ready`
   blocks the Mission and prepared program with the dispatch code instead of
   leaving an indefinite READY stall.
5. **Recovery:** Never-started `worker_execution_unqualified` uses
   `admit_ready_specialist_dispatch`; post-Cursor evaluation reuse remains for
   verified worker packets only.
6. **Latency:** `nativeStatus` uses bounded cached readiness and SQL counts;
   product-control timeout provides headroom without masking hung work.

Preserve PR #221–#223 stage-scoped evaluation, standing grant reuse, and all
security-critical registry fail-closed protections. Never extend historical
deadlines or redispatch uncertain Cursor executions.

## Alternatives considered

- Manual operator “kick scheduler” MCP — rejected; eligible authorized Missions
  must advance without manual intervention.
- Separate supervisor process as dispatch owner — rejected; conflicts with ADR
  0052 (no second scheduler) and LaunchAgent lifecycle.
- Raising all client timeouts only — rejected; hides event-loop / probe cost.

## Authority, privacy and ownership

No new authority, spending, disclosure, or enrollment paths. Standing Cursor
grants and DA policies unchanged. Memory remains non-authoritative. Admission
closed / control stopped ⇒ no automatic execution claim.

## Compatibility and migration

No durable schema change. Existing `prepared` READY rows become eligible for
admit on the next tick after upgrade. Expired historical Missions stay terminal.
Managed install preserves SQLite; requalify Connected/Ready after install.

## Consequences

Eligible READY specialists auto-enter the queue; lost wakes recover via
watchdog; false READY stalls end. Risk: admit after Cursor not-ready still
blocks with an actionable reason rather than spinning. Menu status stays
responsive under deferred probes.

## Validation and evidence

- `tests/ready-scheduler-admit.test.js` (admit, watchdog, concurrency, tick,
  settle, nativeStatus bound, expiry).
- Specialist gateway / OpenCode fixture suites (local; hosted CI may be disabled).
- Live ChatGPT-origin acceptance after managed install of the merged SHA —
  fixture green alone is not full PASS.

## Rollback

Install prior managed SHA. Admit helpers become absent; queued dispatches retain
identity. Do not delete durable Mission rows to force a PASS.

## References

[docs/READY-SCHEDULER-DISPATCH-V1.md](../READY-SCHEDULER-DISPATCH-V1.md)
