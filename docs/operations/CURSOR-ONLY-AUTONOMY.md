# Cursor-only routine autonomy

Source contract: [ADR 0065](../adr/0065-cursor-only-routine-autonomy.md). This document describes the candidate behavior, not proof that an installed service has activated it.

One ordinary authorized request follows: OpenCode planning → host contract validation → Cursor implementation → independent host verification → OpenCode evaluation → bounded Cursor correction when required → current verification and receipt validation → automatic Acceptance and Settlement. Automatic completion requires an existing version 3 cognitive policy with automatic acceptance and the host's current automatic-acceptance mode. Earlier owner-review policies are not silently migrated.

## Admission prerequisites

The host deterministically resolves an active project, goal, enrolled source repository and eligible disposable workspace. It preserves exact requested paths and operations, checks registered verification and the repair/invocation ceilings, and uses existing grants for that source repository and policy. Historical expired templates do not override a matching current cognitive enrollment. Ambiguous exact repositories are never guessed. Disposable-alias capacity handling follows [preventive diagnostics](PREVENTIVE-DIAGNOSTICS-V1.md).

Cursor remains the selected implementation worker when readiness is transiently unavailable. The existing bounded readiness reconciliation can retry a never-started dispatch; it must not change worker identity. If Cursor is disabled, unqualified or outside enrollment, admission states that exact prerequisite. No routine subscription-plan, billing-account or included-usage inspection is performed. Standing authorization is consumed once per request before any dispatch and is never inferred from conversational approval text.

## Evidence and recovery

A correction proof must contain two distinct Cursor run IDs, observed incorrect first bytes, an actual failed host check, corrected bytes, OpenCode evaluator run IDs, successful host verification, one Acceptance, settled dispatches, verified termination and zero held/quarantined leases. A clean first attempt does not prove correction. Synthetic transports establish isolated control-plane behavior only, not live provider qualification.

A failed local evaluator can retry against the same recorded worker result and current workspace hash. Recovery cannot modify the saved contract, broaden paths, issue authorization or replay Cursor. The latest corrective attempt is eligible under the same evaluator ceiling as the initial attempt. Every previous receipt remains in history. Malformed output may retry; mismatched bindings, changed workspaces, revoked authority and unverified termination cannot be treated as syntax failures.

The existing fixture Cursor CLI can intentionally write `gamma` plus LF on its first invocation and `beta` plus LF on its correction, starting from `alpha` plus LF. The production host verifier must discover the failure. No production filesystem mutation hook is required to manufacture this proof.

## Diagnostics

- `CURSOR_IMPLEMENTATION_REQUIRED`: a coding route requests another implementation worker or a fallback. Correct the request/plan; do not select another worker.
- `CURSOR_PLANNING_REQUIRED`: a legacy direct coding route lacks a sealed OpenCode planning contract. Submit through cognitive intake with current enrollment.
- `STANDING_CURSOR_GRANT_MISSING` and scoped-disclosure/spend gates: reuse a matching current grant when present. A grant for a different repository or policy cannot be transferred.
- `cognitive_explicit_worker_syntax_required`: retained for historical diagnostics; ordinary implementation requests no longer require special worker-selection syntax.
- `requested_file_operation_required`: clarify an unresolved literal operation. `ONLY` before a path is an adverb; bare `READY` and `BLOCKED` are not implicit filenames. Quoted extensionless paths remain explicit and require enrollment.
- Runtime, evaluator, lease and capacity diagnostics retain the existing fail-closed registry and bounded recovery rules.

## Rollout and rollback

Run the declared policy/parser, specialist lifecycle, Cursor admission/runtime, evaluator/restart, scope/integrity, termination, capacity and diagnostics regressions, typechecks, package verification and candidate secret scan. Inspect the dependency audit gate separately. Review the source diff and its evidence before publication or installation. Installation and restart require applicable release authorization. Requalify the installed source; isolated evidence cannot substitute for that check.

Rollback restores the preceding reviewed installation without erasing SQLite state, grants, reservations, attempts or receipts. Preserve completed work and uncertain leases. Do not rewrite old contracts to bypass the worker policy or automatically replay previously dispatched Missions.
