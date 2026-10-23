# READY Scheduler Dispatch V1

Authoritative contract for automatic advancement of sealed specialist Missions
from `READY` into first-assignment dispatch. Complements
[SPECIALIST-GATEWAY-V1](SPECIALIST-GATEWAY-V1.md) and [ADR 0061](adr/0061-ready-scheduler-dispatch.md).

## Root cause (Mission `3a6edd9e-e79f-47fd-b78e-2761a76bb367`)

An authorized ChatGPT-origin specialist Mission sealed as parent `ready` with a
`cognitive_specialists_v1` program in state `prepared`, two pending assignments,
zero dispatches, zero runs, and no execution errors. OpenCode and Cursor were
qualified; standing authorization was present. The Mission never left READY until
wall-clock authority expired (`Mission authority expired`).

Exact defect chain:

1. Specialist `register()` writes the graph as `prepared`. First assignment enters
   the durable queue only when `queue()` succeeds (normally via
   `missions.dispatch` / `cognitive-dispatch:<request_id>`).
2. `mission-program.tick` previously selected only
   `running|waiting_acceptance` programs, so a `prepared` READY parent was
   invisible to the Mission Program scheduler after a lost or failed initial wake.
3. When initial dispatch failed or was never claimed, recovery for
   `worker_execution_unqualified` reused local evaluation authority — correct for
   post-Cursor evaluation, wrong for a never-started graph — leaving READY with
   no schedule, no blocker, and no retry deadline.
4. No watchdog rehydrated prepared READY parents on MissionService.tick.

Authorization, Cursor availability, and OpenCode evaluation were not the stall
cause for that Mission. READY is never proof of execution.

## Scheduler ownership (single authority)

| Role | Owner |
| --- | --- |
| Dispatch authority | `MissionService` inside the primary Airodrom control service |
| First-assignment admit | `specialist-gateway.admitReady` / `admitPreparedReady` |
| Dependency advancement | `specialist-gateway.tick` via `MissionProgram.tick` |
| Wake / rehydrate | `MissionService.tick` → `admitPreparedReady` then `program.tick` |
| OpenCode planning / evaluation | OpenCode adapter + result gateway (not a second scheduler) |
| Cursor execution | Governed Cursor worker under standing/Mission grant |
| Independent verification | Host verifier |
| Settlement | Mission acceptance / settlement engines |

There is exactly one authoritative scheduler per execution scope: the control
service Mission tick. LaunchAgents, menu helpers, OpenCode, and autonomous-goal
workers must not invent a parallel dispatch owner. If the control service is
stopped or admission is closed, automatic execution is unavailable — product
status must not claim otherwise.

## Automatic wake and queueing

1. Cognitive seal creates the Mission (`ready`) and registers the specialist
   program (`prepared`).
2. `missions.dispatch` / `queue()` claims the first dependency-free pending
   assignment, writes a durable `cp_dispatches` row (`queued`), and moves the
   program to `running` / Mission toward `dispatching`.
3. If step 2 is lost (restart, failed wake, race), the next `MissionService.tick`
   runs `admitPreparedReady` (bounded scan) and `program.tick` now includes
   `prepared` specialist graphs, both calling idempotent `admitReady`.
4. Dependent assignments remain `pending` until predecessor host verification and
   a valid OpenCode evaluation receipt say `ready`. Stage-scoped read evaluation
   (PR #223) remains required; host verification alone is not evaluator approval.

## Idempotency and concurrency

`admitReady` is a no-op when:

- Mission is not a ready specialist, or program is not `prepared`
- Deadline / program expiry has elapsed → fail closed to `blocked`
- Any dispatch already exists or is active for the Mission
- No dependency-free pending root remains

Concurrent ticks therefore create at most one first dispatch. Uncertain worker
termination never triggers redispatch; quarantine and host evidence rules from
ADR 0059 still apply.

## Watchdog

`admitPreparedReady({ limit })` scans up to a small number of oldest
`prepared`+`ready` specialist parents per Mission tick. It does not poll Cursor
or OpenCode in a loop, does not invent subscription spend, and does not extend
deadlines. Lost wake-ups are recovered on the ordinary tick cadence.

## Recovery and fail-closed paths

| Condition | Result |
| --- | --- |
| Missing / revoked / exhausted standing grant | Actionable blocker; no fabricated grant |
| Unqualified Cursor for a Cursor assignment | Blocker; recovery may refresh readiness and re-admit only while wall-clock remains |
| Expired Mission / program | `blocked` with deadline reason; no dispatch |
| Initial dispatch failure leaving READY+prepared | Orphan READY blocked with the dispatch code; recovery may `admit_ready_specialist_dispatch` |
| Never-started READY+prepared | `admitReady` queues first assignment |
| Post-Cursor evaluation unavailable with verified packet | Local evaluation reuse (unchanged #221/#223 path) |

Registry recovery for never-started `worker_execution_unqualified` uses
`admit_ready_specialist_dispatch`, not evaluation reuse.

## Control-plane latency

`/api/product/native-status` must stay bounded for menu/MCP clients:

- Prefer `cachedReadiness` with TTL and a short await race (do not block on full
  OpenCode/Cursor probes for tens of seconds).
- Use SQL counts for active/review/failed Missions — never full `missionIndex`
  / uncapped `overview()` on the hot path.
- Cache installation compatibility briefly.
- Product-control client timeout provides headroom; do not “fix” hangs by
  raising timeouts alone.

## Restart and managed install

On control-service restart, `recover()` plus the next Mission tick rehydrate
prepared READY parents. Managed install must preserve the durable SQLite store;
do not replay uncertain Cursor dispatches. Historical expired Missions (including
`3a6edd9e…`) remain unchanged — create a fresh authorized acceptance Mission.

## Troubleshooting

1. Mission `ready`, program `prepared`, zero `cp_dispatches` → expect
   `gateway.assignment.auto_admitted` after the next tick, or an
   `admit_failed` / blocked reason.
2. Program `running` with a `queued` dispatch but no run → check worker
   readiness and lease state; do not manually forge a second dispatch.
3. Menu timeouts (~10s) → verify native-status uses cached readiness; inspect
   event-loop blockers separately from client timeout headroom.
4. Rollback: restore prior managed SHA; prepared READY admit paths become
   inert; existing queued dispatches retain identity.

## Tests

`tests/ready-scheduler-admit.test.js` covers automatic admit, watchdog,
idempotent concurrent admit, program.tick prepared path, full read→edit settle,
bounded nativeStatus, and expired fail-closed. Specialist gateway and OpenCode
fixture suites remain separate; hosted CI may be disabled — local green is not
hosted CI.
