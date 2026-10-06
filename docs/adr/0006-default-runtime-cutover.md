# ADR 0006 — OpenCode default execution runtime

- Status: Proposed
- Date: 2026-10-06
- Review: Pending maintainer review of the cutover PR
- Related decisions: [ADR 0005](0005-opencode-execution-boundary.md), [ADR 0004](0004-memory-erasure-retention.md)

Qualified OpenCode becomes the default for new bounded general Missions. Freeze the selected identity at creation and use the same route restrictions in both routing paths. Automatic old envelopes and explicit saved identities retain their prior meaning. Required Pi local control, typed plans and independent verification remain; the Pi execution runtime is compatibility/rollback.

Airodrom retains all policy, Memory V2, lifecycle, verification, Acceptance, Settlement and erasure authority. Missing OpenCode availability stops for review. There is no automatic vendor switch, stale context replay, native session reuse or scope expansion. Explicit Pi and supported Claude fallback continue under their existing allowed policy. Optional/external and experimental classifications do not change.

Keeping the previous default would postpone use of the qualified boundary. Mechanical replacement would break required typed capabilities and historical identities. This change centralizes new identities and preserves those dependencies instead.

Validation is `test:cutover`, OpenCode deterministic/live synthetic qualification, Pi compatibility, hardening, full repository checks, both type checks, source/package inspection and public hosted checks on exact revisions. The bounded legacy prompt limitation is documented in [cutover](../DEFAULT-RUNTIME-CUTOVER.md). Rollback changes host default configuration or reverses focused source changes; no durable schema/data migration, memory snapshot promotion or production activation is involved. Pi removal requires a separate readiness audit.
