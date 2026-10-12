# ADR 0049 — Outcome-first autonomous experience

Status: Accepted for Control Center presentation. Compatible with ADRs 0009 and continuous autonomous execution.

## Decision

Operators interact primarily with authorized goals, current progress, genuine owner decisions and concise verified results. Airodrom plans, dispatches, monitors, repairs, retries and verifies inside previously authorized boundaries. Execution diagnostics, stage rails and Flight Recorder remain available but secondary.

## Rules

1. Do not require routine Continue, Retry, Verify or Next Mission actions when continuous autonomous execution is already authorized for the goal.
2. Never report verified success without current independent verification; Acceptance and Settlement remain separate owner gates.
3. Historical Mission organization is presentation-only archiving. Canonical identity, evidence, verification, Acceptance, Settlement, audit and erasure requirements are preserved. Active execution and unresolved Acceptance are never auto-archived.
4. Control Center Overview, Missions, Autonomous Goals and Mission detail share the same outcome vocabulary.

## Consequences

List and detail projections expose `outcome` and optional `next_action` (null when no owner action is required). Autonomous-managed Missions suppress dispatch CTAs. Organize-history APIs preview exact affected records and require explicit confirmation.
