# Cursor Execution Decision V1

Authoritative boundary between **technical Cursor readiness** and **Mission execution
authority**. Complements [READY-SCHEDULER-DISPATCH-V1](READY-SCHEDULER-DISPATCH-V1.md),
[SPECIALIST-GATEWAY-V1](SPECIALIST-GATEWAY-V1.md), and
[STANDING-CURSOR-DEVELOPMENT-V1](STANDING-CURSOR-DEVELOPMENT-V1.md).

## Root cause (Mission `63385742-6877-4320-9dc4-956b3af05c87`)

ChatGPT request `chatgpt_post224_scheduler_e2e_20261023_a` sealed, auto-admitted, and
queued the first Cursor assignment (`read_recovery_proof`). Launch called
`specialist-gateway.select`, which treated `!observation.available` as
`cognitive_worker_unqualified:cursor` and permanently blocked the Mission with an
empty dispatch route and zero worker runs.

At the same time the product agent registry could show Cursor installed /
authenticated / qualified / available from a different readiness snapshot (menu
`cachedReadiness` / last known). The select path:

1. Collapsed **runtime unreadiness** into a **cognitive planning** error code.
2. Did not record the underlying readiness reason.
3. Did not requeue the existing dispatch after a fresh probe.
4. Was unregistered in the Limits & Blockers registry (`unknown_blocker` → owner
   consolidate).

Authorization (approval, disclosure, standing grants) was present. The failure was
a contradictory qualification decision at specialist select — not missing grants.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Readiness / available | Governed CLI installed, pinned, credentialed, sandbox present; probe currently ready |
| Technical qualification | Pin + `execution_qualified` + sandbox policy from host qualification evidence |
| Mission execution authority | Sealed contract, disclosure, approval/standing grant, scopes, deadline |
| `cognitive_worker_unqualified` | Worker id not eligible in the sealed plan/envelope (suffixes like `:cursor` normalized) |
| `cursor_runtime_not_ready` | Authority intact; runtime probe not ready (often transient) |

Never equate registry “available” with permission to spend Cursor.

## Authoritative decision

`src/cursor-execution-decision.js` evaluates seven dimensions:

1. Runtime installed and operational  
2. Worker technically qualified  
3. Mission worker allowed by sealed scope / specialist graph  
4. Repository/workspace authorization (contract intact)  
5. External disclosure covered  
6. Standing or Mission grant covers the Mission  
7. Budget / deadline sufficient  

`specialist-gateway.select` uses a **fresh** readiness probe and this decision for
Cursor. Failures preserve specific codes. Transient runtime codes requeue the same
dispatch (bounded retries) instead of terminal `BLOCKED`.

## Recovery

Registry entries:

- `cognitive_worker_unqualified` — diagnose; `refresh_cursor_execution_decision`
- `cursor_runtime_not_ready` (+ version/busy/sandbox variants) — same refresh/requeue

Recovery never enrolls, approves, qualifies, or invents spend. If authority is
missing after refresh, the owner gate remains.

## Scheduler interaction

READY admission (PR #224) is unchanged. After admit, launch must pass the
authoritative Cursor decision before a worker run starts. Historical Mission
`63385742…` stays blocked as durable evidence; fresh acceptance uses a new Mission.
