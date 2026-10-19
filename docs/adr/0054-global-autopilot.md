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
4. Owner-configured project default repositories persist in
   `cp_project_defaults` (durable data directory). Selection prefers an exact
   caller identity, an exact live workspace label, the configured default, then
   a single unambiguous live repository; otherwise fail closed. Cleaned
   non-Git disposable leftovers are ignored. Autopilot verification uses
   `.vscode/tasks.json` or an already-active Work template — never invented
   commands.
5. OFF and STOP immediately clear the flag, revoke unspent `autopilot:*`
   policies/grants, and (STOP) cancel active Autopilot-tagged Missions.
6. Activity is recorded in `cp_autopilot_activity` without credential values.
7. External provider authentication and account permissions remain enforced.
   Paid Cursor spend, production deploy, and related high-risk gates stay
   separately authorized.

## Consequences

- Control Center and Terminal expose ON / OFF / status / STOP.
- Existing WORK templates and per-repo Developer Autonomy enrollment remain
  available when Autopilot is OFF.
- Live installs stay OFF until the owner explicitly enables Autopilot.
