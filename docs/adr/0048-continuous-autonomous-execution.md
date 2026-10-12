# ADR 0048 — Continuous Autonomous Execution V1

Status: Proposed (source implementation). Does not authorize live installation, service restart, production cutover, credential changes or automatic Acceptance. Extends ADR 0047 Goal Planner and accepted Mission authority ADRs 0004, 0005 and 0008.

## Decision

Airodrom owns authorized goal continuation. ChatGPT, Cursor and other clients are interaction surfaces, not execution owners. OpenCode, host and other supported adapters remain replaceable workers under explicit allowlists.

Extend Goal Planner records with a versioned `autonomous` block and a durable `cp_autonomous_claims` table. A scheduler (`AutonomousExecution`) runs inside the existing always-on Mission tick and bridge monitor. It may dispatch only through `MissionService.dispatch` after admission is open, dependencies are independently verified, budgets remain, writer leases are clear and no uncertain external execution exists. It never grants Acceptance, Production mutation authority, new worker permissions or self-escalating budgets.

Worker switches require operator confirmation, an authorized replacement, and absence of active/quarantined leases and uncertain dispatches. Restart recovery reloads enabled goals, settles verified claims and never invents termination or idle clearance.

When host verification fails with verified termination and known effects, the scheduler may spawn **at most one** corrective Mission per stage within the original authorized scope (`repair_of`, same workspace and allowed files). It rebinds the Goal Plan stage and dispatches through `MissionService.dispatch`. It never expands permissions, never retries uncertain execution, and never grants Acceptance or Settlement.

## Alternatives rejected

A second orchestration platform, infinite model loop, browser timer, Cursor-specific background agent or ChatGPT “continue” relay would relocate ownership outside Airodrom and weaken durability. Rejected.

Bypassing Mission admission or Goal Planner dependency gates for “autonomous speed” was rejected. Fail-closed lifecycle remains mandatory.

## Compatibility

Legacy Goal Plans without an `autonomous` block migrate on read to the V1 default (`enabled:false`). Existing Mission Programs and observing planner behavior remain. Roll back source only after draining through existing lifecycle controls; preserve durable records. Live activation remains owner-gated and separate from this source PR.
