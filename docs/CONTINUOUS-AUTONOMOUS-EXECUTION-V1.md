# Continuous Autonomous Execution V1

Airodrom accepts an authorized goal and continues permitted work without an open ChatGPT or Cursor session. See [ADR 0048](adr/0048-continuous-autonomous-execution.md). This extends the observing [Goal Planner](AUTONOMOUS-RELIABILITY-V1.md); it does not replace Mission Programs, Mission authority, verification or Acceptance.

## Ownership boundary

| Owner | Role |
| --- | --- |
| Airodrom durable service | Goals, plans, claims, admission, leases, verification, recovery |
| Operator | Goal authorization, worker allowlist, budgets, Acceptance, Production mutation |
| Workers (OpenCode, host, …) | Bounded execution only; no self-granted permissions |
| ChatGPT / Cursor / MCP clients | Optional surfaces; disconnect must not stop authorized work |

## Lifecycle

```
OWNER GOAL → validate → authority & budget → durable plan → authorize CAE
  → dependency-aware Missions → MissionService.dispatch → monitor
  → independent verification → Acceptance (when required)
  → next eligible Mission | one bounded corrective Mission | safe hold
  → goal completed | failed | cancelled | quarantined
```

### Autonomous self-repair (V1)

When an authorized Mission reaches `needs_rework` after independent host verification:

1. Confirm the process terminated safely, effects are known, and no uncertain dispatch/lease remains.
2. Confirm the original CAE authorization still permits a repair (`max_repairs`, worker allowlist, local-only privacy, budgets).
3. Create **one** corrective Mission in the same Project/Goal/workspace/`allowed_files` scope (`repair_of` parent).
4. Rebind the Goal Plan stage to that Mission and dispatch once through `MissionService.dispatch`.
5. Independently verify. Acceptance and Settlement remain owner decisions.

If diagnosis, permissions, budget or safety checks fail, CAE stops (`repair_blocked`) and does not retry uncertain execution.

Supported autonomous lifecycle labels: `created`, `validating`, `ready`, `running`, `waiting_dependency`, `waiting_approval`, `recovering`, `verifying`, `completed`, `failed`, `cancelled`, `quarantined`. Goal Planner stage states remain authoritative for dependency verification.

## Authorization contract

Operator supplies: goal/plan id, worker allowlist, concurrency and dispatch/repair budgets, and `confirmed:true`. Production mutation fields are rejected. Authorizing continuous execution never authorizes deployment, credential rotation, live restarts or Acceptance.

Control-plane actions (authenticated): `authorize-autonomous-goal`, `pause-autonomous-goal`, `resume-autonomous-goal`, `stop-autonomous-goal`, `switch-autonomous-worker`. Reads: `/api/control-v2/autonomous-goals`, `/api/control-v2/autonomous-goal?id=…`.

## Scheduler invariants

1. No dispatch without authorization and open admission.
2. No dispatch with unverified dependencies, expired budgets or closed admission.
3. No duplicate active claim for the same plan/stage/Mission.
4. No retry while dispatch/lease state is `unknown` or quarantined.
5. No Acceptance or Production mutation gate bypass.
6. Fairness: global active-claim ceiling; a blocked plan does not starve others.
7. Restart: reload goals, settle verified claims, hold uncertain work.

## Qualification claims (separate)

| Claim | Meaning |
| --- | --- |
| SOURCE IMPLEMENTED | Code and docs on the feature branch |
| LOCAL TESTS VERIFIED | Disposable fixture suite green |
| ISOLATED END-TO-END VERIFIED | Full local lifecycle with synthetic workers |
| ISOLATED REAL OPENCODE VERIFIED | Disposable CAE path with OpenCode 2.0.25 + local Ollama |
| LIVE INSTALLATION QUALIFIED | Owner-gated install against running service |
| PRODUCTION ACTIVATED | Owner-gated production mutation |

Fixture suites: `npm run test:cae`, `npm run test:cae:restart`. Isolated OpenCode: `npm run test:cae:opencode:live` (requires `AIRODROM_OPENCODE_LIVE=1`). Live installation and production remain separately authorized.

## Known limitations

- Automatic Acceptance is never granted by the scheduler.
- Live OpenCode/Ollama cutover and LaunchAgent changes are out of scope for this source PR.
- ChatGPT MCP client catalog mismatches (e.g. 25 vs 27) remain client-side; they must not block durable execution.
- Worker crash with uncertain side effects blocks automatic retry by design.
