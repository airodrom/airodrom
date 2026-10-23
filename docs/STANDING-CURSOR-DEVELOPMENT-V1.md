# Standing Cursor development authorization V1

## Purpose

Eliminate repeated `scoped_external_disclosure_required` and
`BLOCKED_SPEND_AUTHORIZATION` prompts for **routine, already-authorized** Cursor
development on a specific enrolled repository, without inventing a second
approval architecture.

Developer Autonomy (DA) listing Cursor on the worker allowlist is **not** a
spend or disclosure grant. Standing Cursor development is the separate,
owner-enrolled, finite, revocable grant that cognitive admission reuses.

## Architecture (unchanged)

```text
USER → ChatGPT → AIRODROM → OPENCODE (planner) → CURSOR (implementation)
  → OPENCODE (evaluator) → AIRODROM (independent verifier) → ChatGPT → USER
```

Airodrom remains the sole authorization and independent verification authority.
OpenCode remains planner and evaluator. Cursor remains the default implementation
specialist when selected and covered. ChatGPT text never enrolls or renews a grant.

## Initial owner enrollment

Authenticated local owner only:

`POST /api/assistant/host-execution-policy/enroll-standing-cursor-development`

Required body fields:

| Field | Meaning |
|---|---|
| `confirmed: true` | Explicit owner confirmation (Control Center / Terminal) |
| `request_id` | Opaque idempotency / audit id |
| `repository` | Exact registered repository root (realpath) |
| `policy_id` | Active DA policy for that repository (recommended; binds the grant) |
| `acknowledge_unknown_cost: true` | Cursor billing is external; no invented dollar ceiling |
| `max_invocations_per_mission` | Finite Cursor invocations per Mission (1–6) |
| `max_runtime_ms` | Finite runtime ceiling (1s–120s) |
| `max_missions` | Finite total Missions on this grant (1–100) |
| `path_allowlist` | 1–16 relative public paths (use the DA cognitive discovery set) |
| `ttl_ms` or `expires_at` | Finite expiry (max 90 days) |

Host Cursor execution must already be enabled. The DA policy must be active,
must match the repository root, and must include `cursor` on workers.

Duplicate active grants for the same repository return the existing grant
(`duplicate: true`) without rewriting history.

Revoke with
`POST /api/assistant/host-execution-policy/revoke-standing-cursor-development`
(`grant_id` or `repository`, `confirmed: true`).

## Automatic grant reuse

When cognitive planning selects Cursor:

1. Match an active standing grant for the Mission repository, proposed files,
   invocation/runtime bounds, public data class, and (when set) DA `policy_id`.
2. Prefer a grant bound to the Mission’s `policy_id`, then an unbound same-repo
   grant. Never use another repository’s grant. Never use a fixture grant as
   Airodrom Source or Arecibo Core fallback.
3. On match: auto-issue the existing MissionApproval spend shape
   (`acknowledge_unknown_cost`, finite invocations/runtime) and consume one
   Mission from the grant. No second per-Mission owner prompt.
4. On mismatch: fail closed with an exact code and actionable reason
   (`STANDING_CURSOR_GRANT_MISSING`, `_EXPIRED`, `_REVOKED`, `_EXHAUSTED`,
   `_POLICY_MISMATCH`, `_PATH_MISMATCH`, `_INVOCATION_LIMIT`, `_RUNTIME_LIMIT`,
   plus the legacy spend/disclosure blockers).

## Project switching

Catalog routing ([MULTI-PROJECT-DEVELOPMENT-V1.md](MULTI-PROJECT-DEVELOPMENT-V1.md))
binds Airodrom Source vs Arecibo Core before planning. Each project needs its
own standing grant bound to its DA policy and repository root. Explicit project
selection wins over conversation history. Negated names never select. Ambiguous
asks fail closed. Grants never transfer across projects.

## Cost uncertainty

Cursor billing is externally managed and may not expose exact per-Mission cost.
Standing grants reuse `acknowledge_unknown_cost`. They do **not** claim Cursor
is free and do **not** invent a monetary spending ceiling. Accounting remains
`UNKNOWN_SUBSCRIPTION`. Exhausted, expired, or oversized Missions fail closed.

## Recovery

| Condition | Action |
|---|---|
| Missing grant | Owner enroll once for that repository + DA policy |
| Expired / revoked / exhausted | Owner re-enroll with fresh finite limits |
| Path mismatch | Re-enroll with the cognitive discovery paths, or narrow the plan |
| Invocation / runtime too high | Narrow the Mission or re-enroll within host maxima |
| Wrong project | Fix routing / instruction; do not reuse the other project’s grant |

## Why repeated per-Mission approval should stop

After a covering standing grant is enrolled, eligible ChatGPT-origin cognitive
Cursor Missions on that repository reuse the grant automatically. Recurring
disclosure/spend WAIT for those Missions means the grant is missing, exhausted,
expired, revoked, path/policy mismatched, or host Cursor is disabled — not that
a second standing subscription architecture is required.

## Always separately authorized

Standing routine development never automatically permits:

- Production deployments
- Plaid LIVE activation
- Credentials or secrets disclosure
- Merchant financial-data disclosure
- Privileged infrastructure mutations
- Cross-repository access
- Destructive operations
- Protected-branch merge bypasses
- Unbounded paid Cursor execution

## Related

- [ADR 0060 — Host Execution Policy](adr/0060-host-execution-policy.md)
- [Cognitive Mission Router](COGNITIVE-MISSION-ROUTER-V1.md)
- [Multi-project development](MULTI-PROJECT-DEVELOPMENT-V1.md)
- [Current state](CURRENT-STATE.md)
- [Known limitations](KNOWN-LIMITATIONS.md)
