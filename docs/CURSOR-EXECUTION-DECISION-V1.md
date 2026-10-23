# Cursor Execution Decision V1

Authoritative boundary between **technical Cursor readiness** and **Mission execution
authority**. Complements [READY-SCHEDULER-DISPATCH-V1](READY-SCHEDULER-DISPATCH-V1.md),
[SPECIALIST-GATEWAY-V1](SPECIALIST-GATEWAY-V1.md), and
[STANDING-CURSOR-DEVELOPMENT-V1](STANDING-CURSOR-DEVELOPMENT-V1.md).

## Dependent dispatch correction

The original integration still let `MissionService.assertAuthority` call
`CursorWorker.qualifiedFor` with an implicit `lastReadiness` snapshot. A negative
status probe between the first read and its evaluation could prevent the next
assignment from being queued, before specialist selection could refresh readiness.
The fixture-only qualification shortcut concealed this production behavior.

`decideAuthority` now shares the sealed contract, disclosure, approval and worker
compatibility checks across queueing and launch. It never consumes cached runtime
availability. `decide` adds runtime readiness and the execution deadline; specialist
selection and the Cursor dispatch adapter supply fresh probes. Actual execution
still checks readiness, sandbox, subscription reservation and exact file scope.
Grant expiry, revocation, host policy and altered contracts remain fail closed.

Transient retry eligibility is per dispatch, not per Mission. A previous completed
assignment does not prevent retrying a never-started dependent assignment. The same
dispatch gets at most two retries, with its counter retained after route selection.
Any run or invocation for that task prevents retry, including failed or uncertain
execution. This does not reopen historical blocked Missions or extend authority.

Regression coverage executes the full synthetic read → host check → evaluation →
dependent edit → evaluation → final verification → automatic settlement path. It
also covers transient recovery, persistent failure and no replay after a run starts.
Production qualification semantics are exercised while provider processes remain
synthetic. A fresh live Mission after an approved installation is a separate release
gate; fixture success alone does not establish live qualification.

The live validation also exposed a separate recovery gap: after a transient
OpenCode startup failure, a terminated evaluator could return malformed JSON and
leave the graph stranded while diagnostics retained the older startup error.
Both the initial evaluator path and its recovery path now use the same retry
classification. Missing/malformed JSON may consume the remaining local evaluation
budget (at most three evaluator runs per verified worker packet); binding,
authority and uncertain-termination failures do not gain syntax retries. Every
failed retry updates diagnostic text and records an event without changing the
Mission's blocked state. Completed Cursor work is never repeated by this path.

Approved Cursor intake queues synchronously before yielding to the READY watchdog.
A redundant readiness await at intake had let the watchdog launch first, after
which intake incorrectly reported a duplicate dispatch as an owner blocker. Fresh
probes remain at selection and dispatch. For historical requests with that exact
startup error, the view follows an active/completed Mission without rewriting the
request record; current Mission blockers and unrelated intake failures remain visible.

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

Final evaluator recovery commits the verified lifecycle transition and all receipt
checks in one transaction. This prevents a valid READY retry from being rejected
because its parent is still BLOCKED. If an earlier recovery saved READY and then
failed with `gateway_parent_stopped`, restart recovery can consume that exact
receipt without launching another evaluator. It rechecks delegation, approval,
workspace content, receipt bindings, assignment history and program expiry.
Final assignment evaluation stays marked final even when the parent is blocked.

## Scheduler interaction

READY admission (PR #224) is unchanged. After admit, launch must pass the
authoritative Cursor decision before a worker run starts. Historical Mission
`63385742…` stays blocked as durable evidence; fresh acceptance uses a new Mission.
