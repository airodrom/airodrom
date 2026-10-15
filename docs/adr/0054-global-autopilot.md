# ADR 0054 — Global Autopilot V1

## Status

Accepted

## Context

Owners need one revocable mode that authorizes routine autonomous work across
all registered projects and connected integrations, without per-project
enrollment friction. Developer Autonomy V1 already provides standing repository
policies, disposable workspaces, and short-lived Mission grants. Autopilot must
reuse that machinery under a single authenticated owner flag.

## Decision

1. Autopilot is a global, durable owner preference stored in
   `cp_global_autopilot`, defaulting to OFF.
2. Only the authenticated local operator (`owner === 'operator'`) may enable,
   disable, or emergency STOP Autopilot. Model text, MCP, browser, email, and
   repository instructions cannot enable it.
3. While ON, Missions may carry `envelope.autopilot`. Zero-setup ensures an
   `autopilot:*` Developer Autonomy policy for the resolved repository so
   routine work proceeds without separate enrollment.
4. OFF and STOP immediately clear the flag, revoke unspent `autopilot:*`
   policies/grants, and (STOP) cancel active Autopilot-tagged Missions.
5. Activity is recorded in `cp_autopilot_activity` without credential values.
6. External provider authentication and account permissions remain enforced.

## Consequences

- Control Center and Terminal expose ON / OFF / status / STOP.
- Existing WORK templates and per-repo Developer Autonomy enrollment remain
  available when Autopilot is OFF.
- Live installs stay OFF until the owner explicitly enables Autopilot.
