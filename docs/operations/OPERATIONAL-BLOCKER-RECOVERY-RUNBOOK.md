# Operational Blocker Recovery Runbook V1

Host-owned, registry-driven recovery for Limits & Blockers. Dispatcher:
[`src/limits-blockers-recovery.js`](../../src/limits-blockers-recovery.js).

**Automatic recovery operates inside existing authorization — it never creates new authorization.**

## Default multi-agent chain

```text
ChatGPT → Airodrom → OpenCode (planner) → Cursor (implementation)
  → host verification → OpenCode (evaluator) → dependent tasks → completion
```

Locks for evaluation/recovery are claimed **before** asynchronous readiness awaits.
No duplicate paid Cursor dispatch for evaluation recovery. Progress and receipts
survive service restart (durable `cp_*` tables + standing grants).

## Canonical 27 operational blockers

| ID | Auto diagnosis | Executable host recovery | Owner fallback if still blocked |
|---|---|---|---|
| `da_filesystem_capacity_exhausted` | yes | diagnose capacity evidence | Free volume space |
| `concurrent_mission_budget_exhausted` | yes | await/retry when slots free | Wait for settlement |
| `da_repair_budget` | yes | diagnose remaining repairs | Wait or owner raise `max_repairs` |
| `source_repository_not_enrolled` | yes | prepare enrollment action package | Enroll DA for repository |
| `arecibo_repository_not_enrolled` | yes | prepare enrollment action package | Enroll Arecibo DA |
| `enrolled_repository_ambiguous` | yes | select if exactly one enrolled | Clarify project |
| `enrolled_workspace_required` | yes | prepare enrollment action package | Bind enrolled workspace |
| `blocked_spend_authorization` | yes | match standing Cursor grant | Enroll/renew standing grant |
| `scoped_external_disclosure_required` | yes | match standing Cursor grant | Enroll standing disclosure |
| `standing_cursor_grant_missing` | yes | match / re-enrollment path | Enroll standing grant |
| `standing_cursor_grant_expired` | yes | match / re-enrollment path | Re-enroll (never silent renew) |
| `standing_cursor_grant_revoked` | yes | match / re-enrollment path | Owner re-enroll after revoke |
| `standing_cursor_grant_exhausted` | yes | match / re-enrollment path | New finite grant |
| `standing_cursor_grant_invocation_limit` | yes | match / re-enrollment path | Raise invocations on new enroll |
| `standing_cursor_grant_runtime_limit` | yes | ensure cognitive 120s floor | Raise standing `max_runtime_ms` (raise-only API) |
| `cursor_execution_disabled` | yes | diagnose disable vs grant | Enable Cursor via authenticated API |
| `cognitive_explicit_worker_syntax_required` | yes | normalize guidance for next plan | Re-ask with sealed worker |
| `cognitive_ambiguous_worker` | yes | normalize guidance for next plan | Single worker in instruction |
| `cognitive_delegation_expired_or_revoked` | yes | consolidated owner gate | Reauthorize delegation |
| `cognitive_assignment_limit` | yes | consolidated owner gate | Wait / raise budget |
| `cognitive_envelope_expired` | yes | consolidated owner gate | Fresh cognitive envelope |
| `worker_execution_unqualified` | yes | reuse local evaluation authority | Qualify Cursor or local-only path |
| `evaluation_unavailable` | yes | reconcile + local eval retry | Inspect OpenCode readiness |
| `gateway_assignment_budget_exhausted` | yes | consolidated owner gate | Wait / owner budget |
| `runtime_removed` | yes | consolidated owner gate | Restore qualified runtime |
| `repair_blocked` | yes | consolidated owner gate | Inspect repair blockers |
| `owner_action_required` | yes | consolidated owner gate | Exact remaining owner action |

Coverage API: MCP `get_blocker_recovery_coverage` /
`GET /api/assistant/limits-blockers/recovery-coverage` → `canonical_operational_owner`.

## Standing Cursor grant persistence

Grants live in durable host SQLite (`cp_standing_cursor_development`) under
`~/.airodrom/data/`. They survive application restart and managed source upgrades
(install swaps code; data directory is preserved). ChatGPT text never enrolls or
renews. See [STANDING-CURSOR-DEVELOPMENT-V1.md](../STANDING-CURSOR-DEVELOPMENT-V1.md).

## Security-critical (fail closed)

All security-critical registry entries keep `security_investigate_fail_closed`.
Automatic recovery never overrides authentication, repository authority, grant
revocation, disclosure, spending, credentials, or Production mutation boundaries.

## Bounded retries

Max **2** recovery attempts per Mission/request lineage per registry id
(`cp_limits_blocker_recovery_attempts`). Exhaustion consolidates to one owner gate.
