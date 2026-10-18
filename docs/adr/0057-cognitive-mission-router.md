# ADR 0057: Cognitive Mission Router V1

Status: proposed; source implementation, review and release gates pending.

## Context

Exact-file intake cannot translate ordinary coding instructions into a grounded
plan. Allowing a model to choose its own workspace, permissions or checks would
cross the host authority boundary established in ADRs 0005, 0051 and 0053.

## Decision

Add an opt-in admission layer inside ZeroSetupWork. A signed Developer Autonomy
policy enrolls exact discovery files and authenticated MCP caller references.
The host creates a disposable workspace and a canonical RequestEnvelope. Existing
OpenCode/Qwen runs with a read-only staging scope and returns an untrusted
PlanningProposal. The host validates it, checks repository content and identity,
selects a qualified worker deterministically, and binds a SealedMissionContract
to the existing immutable Mission contract. Existing Mission Service, adapters,
broker, verifier, leases, ledger and evidence retrieval execute the work.

The four contracts are versioned together in `src/cognitive-contracts.js`. Unknown
fields, duplicate JSON keys, cyclic dependencies and authority fields fail closed.
Hashes use the existing canonical serialization. A hash is evidence, not permission.

Read-only tasks route to host file reads; bounded local edits to OpenCode; more
than four files or six tasks to Cursor. Explicit selection is preserved. Complexity
labels are advisory. Cursor still requires the existing authenticated local
disclosure approval and Mission-scoped subscription grant. No dollar ceiling is
claimed. No new scheduler, worker runtime, approval store or event ledger is added.

## Consequences

- Scope is deliberately small: up to eight existing regular files, two planning
  attempts, one execution attempt, zero automatic repairs, at most 120 seconds
  per planning/execution attempt, and owner-registered verification tasks.
- Existing Autopilot, Routine Auto, Expanded Auto, Goal Plans and projectless
  intake retain their own authorization. Enabling them alone does not delegate
  an MCP identity. Cognitive requests use the signed opt-in policy; external
  execution is a separate exact local approval.
- Interrupted planning is never automatically resumed. Its existing run and
  lease records must establish termination before workspace cleanup or retry.
- Human Acceptance remains distinct from verification. Model claims cannot
  establish tests, termination, prices or Acceptance.
- This is a source change until exact-head review and required gates pass.
  Installation follows the existing managed checkpoint/drain/stop procedure.

See [operator and contract documentation](../COGNITIVE-MISSION-ROUTER-V1.md).
