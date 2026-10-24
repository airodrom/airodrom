# ADR 0065 — Cursor-only routine implementation

Status: proposed source candidate; activation requires release authorization and qualification.

## Decision

OpenCode plans and independently evaluates. Cursor is the exclusive implementation and corrective worker. Airodrom owns authorization, workspace selection, scheduling, leases, verification, Acceptance and Settlement. ChatGPT submits instructions and reports host evidence. No automatic implementation fallback is permitted, including when Cursor is disabled or temporarily unavailable. This supersedes the implementation-worker choices in ADRs 0057 and 0060; their security boundaries remain.

Routine requests use existing active Developer Autonomy enrollment and matching finite standing Cursor authorization. Admission never inspects subscription plans or billing accounts, purchases credits, enables top-ups, changes billing, or adds a provider integration. Existing acknowledged subscription bounds are reused. A genuine missing grant remains a gate.

## Contracts and dispatch

The existing RequestEnvelope, PlanningProposal and SealedMissionContract bind source repository, disposable workspace, exact paths and operations, dependencies, workers, registered checks and finite repairs. Host validation assigns edits to Cursor and retains valid read-only worker assignments. The dispatch boundary rejects legacy coding paths without Cursor and a sealed planning proposal. No historical seals are rewritten. Read-only host primitives, planning, evaluation and noncoding capabilities remain available under their existing authority.

The standing-grant query uses the enrolled source repository and exact policy, not the disposable workspace path. Existing same-repository unbound grants retain their documented semantics. A request-bound durable reservation precedes Mission creation and dispatch; duplicate consumption is idempotent and conflicting grant identities are rejected. Failed or uncertain dispatch may retain the reserved slot. No automatic refund can create an extra execution budget.

Intake may not reseal enrollment to add files or workers. Repository ambiguity, missing enrolled paths, missing standing authorization, revocation, expiry, exhausted budgets, disabled Cursor and unresolved worker termination remain authoritative gates. A readiness probe cannot grant any of these permissions.

## Correction and recovery

The existing specialist graph records each attempt, host verification, evaluation binding and termination receipt before a successor is eligible. Corrections repeat only an enrolled edit assignment within the sealed budget. Only failed registered implementation checks or exact-file criteria permit correction; protected verifier, scope, provenance, unavailable and unknown check failures stop before another worker. Evaluator recovery uses the latest recorded attempt, retries only a classified local evaluator failure within its existing ceiling, and preserves Cursor results. Unknown termination, binding drift and authority failures remain closed. Duplicate ticks, status requests and restart reconciliation must not relaunch completed workers.

See [the operational contract](../operations/CURSOR-ONLY-AUTONOMY.md) for evidence requirements and rollout limitations.
