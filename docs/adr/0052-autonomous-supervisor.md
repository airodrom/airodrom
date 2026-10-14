# ADR 0052 — Autonomous Supervisor V1

Status: Proposed.

## Context

Issue #108 asks for end-to-end autonomous development visibility and cleanup without a second scheduler: Live Activity monitoring, AUTO worker honesty, continuous repair surfacing, standing workspace authorization, and Mission/session cleanup. Unified Autonomous Development V1 (ADR 0051), Live Activity V2, Mission V2 / CAE repair, work templates, and the model/worker router already implement authority and repair.

## Decision

Add a thin host projection module (`src/autonomous-supervisor.js`) that:

1. Maps Mission views to explicit execution states and Run honesty rules.
2. Filters Live Activity **Now** to live work / authorized recovery only.
3. Exposes `execution-sessions`, obsolete-rework archive previews, standing WORK-template status, and AUTO admission via the existing router.
4. Provides `airodrom logs follow` as a redacted client of existing live-events APIs.

No new Mission authority, approval, or scheduler is introduced. Repair, verification, and worker selection remain CAE / Mission V2 / router owned.

## Consequences

- Control Center and CLI can show repair budget, active Runs, and obsolete rework without inventing authorship or Cursor Agent qualification.
- Obsolete `needs_rework` can leave Now via presentation archive while evidence is retained.
- Disposable live OpenCode demos still require owner WORK-template enrollment; fixtures never imply live qualification.
- Revert by removing the supervisor module, Live Activity enrichment, CLI `logs` route, and ADR/docs entries; existing CAE/Mission paths remain intact.
