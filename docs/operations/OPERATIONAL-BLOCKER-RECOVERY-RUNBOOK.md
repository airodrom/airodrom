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

Truthful classes: **diagnosis** (evidence only), **executable recovery** (allowlisted host op),
**verified completed repair** (`verification.completed_repair`). Diagnosis and enrollment
prep never count as completed repair.

| ID | Diagnosis | Executable | Verified repair when | Owner fallback |
|---|---|---|---|---|
| `da_filesystem_capacity_exhausted` | yes | no | — | Free volume space |
| `concurrent_mission_budget_exhausted` | yes | yes | capacity free | Wait for settlement |
| `da_repair_budget` | yes | no | — | Wait or raise `max_repairs` |
| `source_repository_not_enrolled` | yes | no (prep only) | — | Enroll DA |
| `arecibo_repository_not_enrolled` | yes | no (prep only) | — | Enroll Arecibo DA |
| `enrolled_repository_ambiguous` | yes | yes | sealed repo root matches one DA | Clarify project |
| `enrolled_workspace_required` | yes | no (prep only) | — | Bind enrolled workspace |
| `blocked_spend_authorization` | yes | yes | standing grant matched | Enroll/renew grant |
| `scoped_external_disclosure_required` | yes | yes | standing grant matched | Enroll disclosure |
| `standing_cursor_grant_missing` | yes | yes | standing grant matched | Enroll grant |
| `standing_cursor_grant_expired` | yes | yes | match only if active | Re-enroll (never silent) |
| `standing_cursor_grant_revoked` | yes | yes | match only if active | Owner re-enroll |
| `standing_cursor_grant_exhausted` | yes | yes | match only if remaining | New finite grant |
| `standing_cursor_grant_invocation_limit` | yes | yes | match within ceiling | Raise on new enroll |
| `standing_cursor_grant_runtime_limit` | yes | yes | cognitive 120s floor | Raise standing runtime |
| `cursor_execution_disabled` | yes | yes | grant match if enabled | Enable Cursor API |
| `cognitive_explicit_worker_syntax_required` | yes | no (router roles) | — | Clear specialist syntax |
| `cognitive_ambiguous_worker` | yes | no (router roles) | — | Single specialist |
| `cognitive_delegation_expired_or_revoked` | yes | no | — | Reauthorize |
| `cognitive_assignment_limit` | yes | no | — | Wait / raise budget |
| `cognitive_envelope_expired` | yes | no | — | Fresh envelope |
| `worker_execution_unqualified` | yes | yes | local eval authority reused | Qualify Cursor |
| `evaluation_unavailable` | yes | yes | reconcile / scheduled retry | Inspect OpenCode |
| `gateway_assignment_budget_exhausted` | yes | no | — | Wait / owner budget |
| `runtime_removed` | yes | no | — | Restore runtime |
| `repair_blocked` | yes | no | — | Inspect repair blockers |
| `owner_action_required` | yes | no | — | Exact owner action |

**Repository identity:** never select “the only enrolled repository” without a sealed
request/Mission repository root that realpath-matches that enrollment.

**Data classification:** standing grant probes require authoritative Mission `data_class`;
never invent `public`.

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
