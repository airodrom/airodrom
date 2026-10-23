# ADR 0062: Authoritative Cursor execution decision

- Status: Proposed
- Date: 2026-10-23
- Owner: Control-plane / specialist gateway
- Review: Pending
- Affected contracts and components: `src/cursor-execution-decision.js`, `src/specialist-gateway.js`, `src/mission-service.js`, `src/cursor-worker.js`, `src/limits-blockers-recovery.js`, `config/limits-blockers-registry-v1.json`
- Related decisions: [0059](0059-specialist-gateway.md), [0060](0060-host-execution-policy.md), [0061](0061-ready-scheduler-dispatch.md)

## Context and problem

After READY auto-admit (ADR 0061), Mission `63385742…` queued a Cursor assignment then blocked with `cognitive_worker_unqualified:cursor` despite sealed approval/disclosure and a registry view that Cursor was available. Specialist select collapsed `!observation.available` into a cognitive planning error, lost readiness detail, and terminal-blocked without requeue.

## Decision

Introduce one authoritative Cursor decision module with explicit readiness vs authority dimensions. Specialist select must use a fresh readiness probe and that decision. Transient runtime failures requeue the same dispatch (bounded). Register `cognitive_worker_unqualified` (suffix-normalized) and `cursor_runtime_not_ready` with `refresh_cursor_execution_decision` recovery. Never auto-enroll or invent spend.

## Alternatives considered

- Treat menu “available” as dispatch authority — rejected; conflates observation with spend.
- Only widen timeouts — rejected; hides contradictory decisions.

## Authority, privacy and ownership

Unchanged ceilings. Standing grants and disclosure remain required for allow=true.

## Compatibility and migration

No schema change. Historical blocked Missions stay terminal.

## Validation and evidence

`tests/cursor-execution-decision.test.js`; post-install fresh Mission acceptance.

## Rollback

Prior managed SHA; select returns to availability conflation.

## References

[docs/CURSOR-EXECUTION-DECISION-V1.md](../CURSOR-EXECUTION-DECISION-V1.md)
