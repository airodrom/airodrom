# Limits & Blockers Registry V1

Canonical, source-grounded registry of Airodrom operational limits, execution blockers, authorization gates, and recovery procedures.

**Config:** [`config/limits-blockers-registry-v1.json`](../../config/limits-blockers-registry-v1.json)  
**Runtime:** [`src/limits-blockers-registry.js`](../../src/limits-blockers-registry.js)  
**Recovery dispatcher:** [`src/limits-blockers-recovery.js`](../../src/limits-blockers-recovery.js)

## Autonomous Blocker Resolution V1

Every registered blocker triggers automatic diagnosis. Executable recovery runs only through the allowlisted host operations in `limits-blockers-recovery.js` (max 2 attempts per Mission/request lineage). Security-critical entries investigate and fail closed. Unknown codes are diagnosed and reported — never executed from their text.

| Capability | Entry point |
|---|---|
| Coverage matrix | MCP `get_blocker_recovery_coverage` / `GET /api/assistant/limits-blockers/recovery-coverage` |
| Dispatch on block | Cognitive router + zero-setup blocked paths via `attemptAuthorizedRecovery` |
| Receipts | `cp_limits_blocker_recovery_attempts` + engineering-report `blocker_recovery` |
| Events | `limits_blockers.recovery` (durable; terminal notifications reuse Mission notification path) |

## What it answers

| Question | Source |
|---|---|
| What limits exist? | Registry `entries[]` |
| Where enforced? | `source.file` + `source.symbol` |
| Configured values? | `configured_limit` + live policy budgets |
| Currently exhausted? | Live diagnostics (`diagnostics()`) |
| Why blocked? | `resolve` / `annotateBlockers` / `reportForBlock` |
| Automatic recovery? | `automatic_recovery_allowed` + host-authorized ops only |
| Owner required? | `owner_approval_required` / `security_critical` |

## Categories

1. **operational_auto** — Host may run an *existing* authorized recovery (for example reclaim clean idle ready worktrees) when evidence gates pass.
2. **operational_owner** — Needs authenticated owner action (enrollment, standing grant renewal, free disk, disclosure).
3. **security_critical** — Always fail closed. Error text never authorizes bypass, grant creation, cross-project access, or deletion of protected work.

## Discovery method

Entries are curated from enforcement sites in Developer Autonomy, host execution policy, cognitive router/contracts, project resolution, Cursor/OpenCode gateways, Mission verification, and terminal notifications. `validateAgainstSource()` checks that registered code tokens still appear in the declared source file (except `historical_status: fixed_defect`).

Unknown runtime codes resolve as **`unknown_blocker`** — never invent a security classification.

## Live diagnostics

| Entry point | Notes |
|---|---|
| MCP `get_limits_blockers` | Read-only; filters by category/severity/recoverability/policy/project |
| MCP `inspect_blocker` | Resolve one code/message |
| `GET /api/assistant/limits-blockers` | Control Center / System Health |
| `GET /api/assistant/limits-blockers/inspect?code=` | Single lookup |

Live counters come only from authoritative host state (DA capacity inventory, filesystem capacity, grant rows, Cursor readiness/standing status, Mission state counts, zero-setup/Mission blocked rows). Missing sources are reported **Unavailable**, never fabricated.

## Mission / request reporting

When a request or Mission blocks:

1. Exact code is recorded on the row.
2. `limits_blockers` annotation attaches `registry_id`, enforcement location, classification, and `next_safe_action`.
3. Engineering report / evidence package include the annotation when state is `blocked` / `needs_rework`.
4. Durable terminal notifications continue via `mission-terminal-notifications` keyed by `mission_id` or `request_id`.
5. Unsolicited ChatGPT push is **not** claimed unless a trigger is configured.

## Safe recovery rules

- Automatic recovery runs **only** through existing host operations with required evidence (example: `reclaimIdleReadyWorkspaces` for disposable idle ready clones).
- No blanket retry, automatic grant creation, permission expansion, security bypass, or deletion of dirty/unique/protected workspaces (`~/code/airodrom` stays protected).
- Projects keep independent DA policies, grants, and workspace accounting.

## Common blockers

| Code / id | Class | Typical next action |
|---|---|---|
| `WORKTREE_BUDGET_EXHAUSTED` | operational_auto (idle leftovers) / owner if genuinely active | Reclaim idle ready or wait for settlement |
| Filesystem capacity exhausted | operational_owner | Free volume space |
| Legacy disk budget string | fixed_defect | Use filesystem diagnostics (PR #214) |
| `SOURCE_REPOSITORY_NOT_ENROLLED` | operational_owner | Enroll DA for that repository |
| `BLOCKED_SPEND_AUTHORIZATION` / `scoped_external_disclosure_required` | operational_owner | Standing Cursor grant + disclosure |
| `STANDING_CURSOR_GRANT_*` mismatch | security or owner | Fail closed or renew matching grant |
| `cognitive_plan_files_mismatch` | operational_auto | Retry planning (normalized files) |
| `worker_execution_unqualified` | operational_owner | Qualify worker / correct route |
| `EVALUATION_UNAVAILABLE` | operational_owner | Inspect gateway diagnostics |

## Adding or modifying entries

1. Locate the real enforcement site (throw / `C.fail` / `error.code`).
2. Add an entry to `config/limits-blockers-registry-v1.json` with stable `id`, `codes`, category, severity, `source`, recovery fields, and docs link.
3. Prefer exact code tokens that appear in source so `validateAgainstSource` passes.
4. Mark retired behaviors `historical_status: fixed_defect` — do not delete history that operators still search for.
5. Wire any new live counter only from authoritative state.
6. Update this document’s common-blockers table when the entry is operator-facing.
7. Never lower a security_critical control to operational_auto for convenience.

## Troubleshooting

1. Call `get_limits_blockers` or open **System Health → Limits & Blockers**.
2. Note `registry_id`, category, and `next_safe_action`.
3. If `unknown_blocker`, inspect the raw code and register it — do not guess.
4. If security_critical, stop and fail closed.
5. If operational_auto and host recovery already exists, retry after the authorized operation; otherwise escalate to owner.

## Security boundaries

ChatGPT text never enrolls repositories, creates standing grants, expands NEVER_AUTO, or authorizes Production / secrets / financial disclosure. Registry diagnostics grant **no authority**.

## Cursor proxy / DNS boundary (2026-10-22)

`worker.proxy_denied` reasons are now distinct:

| reason | Meaning |
|---|---|
| `dns_boundary` | Authorized host resolved to a non-public address (rebinding/private). Fail closed. |
| `dns_unavailable` | Resolver error or empty answer for an allowlisted host. |
| `aborted` | Subscription/grant abort signal — **not** a DNS failure. |
| `endpoint` | Hostname not on `KNOWN_PROVIDER_HOSTS.cursor`. |
| `upstream` | Transient TCP failure to a public provider address (often non-fatal). |

Events include disclosure-safe `host` (allowlisted only), `authorized_provider`, `fatal`, and `next_safe_action`.

`cursor_subscription_deadline` replaces generic `cursor_cancelled` when the reserved subscription deadline elapsed. Raise standing `max_runtime_ms` (≤120s) and ensure DA cognitive `execution_ms` is 120000 for multi-task Cursor work.
