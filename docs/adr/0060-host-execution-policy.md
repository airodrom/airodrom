# ADR 0060 — Host Execution Policy (Local-First Autopilot V3)

## Status

Accepted

## Context

Airodrom Autopilot could select paid Cursor as a specialist when enrolled and
spend-authorized. The owner decision for Local-First Autopilot V3 is that
**no paid Cursor execution may be initiated through Airodrom** while still
preserving Cursor adapter code, Milestone A/B evidence, and the ability to
reactivate later. An external Cursor subscription (if any) is not cancelled by
this host preference.

## Decision

1. Persist a single-row host preference in `cp_host_execution_policy`
   (`cursor_execution_disabled`, default `1`).
2. While disabled, Airodrom:
   - excludes Cursor from automatic worker selection and Autopilot enrollment;
   - rejects explicit Cursor requests with durable `CURSOR_EXECUTION_DISABLED`
     while preserving `requested_specialist=cursor` (never silently substitutes
     OpenCode for an explicit Cursor Mission);
   - allows implicit local OpenCode only when no specialist was named;
   - refuses subscription-execution grants and Cursor dispatch/select;
   - does not invent Cursor disclosure or spend grants.
3. Cursor adapter, qualification records, and historical Missions remain readable.
4. Re-enable requires authenticated local operator confirmation
   (`POST /api/assistant/host-execution-policy/enable-cursor` with
   `confirmed: true`). Model, MCP, browser, and repository text cannot flip it.
5. Local OpenCode remains the default planner, local coder (when suitable), and
   evaluator. Host verification and Acceptance stay authoritative.
6. This policy does **not** cancel or modify any external Cursor billing
   subscription; `external_subscription: unaffected` is recorded on status.

## Consequences

- Ordinary Arecibo local-only Autopilot work proceeds without Cursor spend.
- Reactivation restores prior Cursor gates (qualification, spend, disclosure);
  it does not bypass them.
- Compact schema-first OpenCode planning (bounded stream + recovery) remains
  independent of Cursor availability.
