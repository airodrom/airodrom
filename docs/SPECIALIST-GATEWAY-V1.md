# Specialist Gateway V1

OpenCode plans and evaluates; Airodrom authenticates, dispatches, verifies and
completes. See [ADR 0059](adr/0059-specialist-gateway.md). Source implementation and
fixture evidence do not by themselves qualify an installed release.

Canonical path: `USER → ChatGPT → AIRODROM → OPENCODE → CURSOR → OPENCODE → AIRODROM → ChatGPT → USER`.
The gateway transports host-observed specialist results back to OpenCode; it is not a
second cognitive planner. See [Milestone B](MILESTONE-B-CURSOR-SPECIALIST-READINESS.md).

## Enrollment and intake

Use the existing authenticated Developer Autonomy enrollment with exact repository,
project/goal, permitted workers, registered checks and finite budgets. The cognitive
field for this gateway is:

```json
{
  "version": 3,
  "files": ["src/example.js"],
  "delegated_callers": [],
  "planning_attempts": 2,
  "planning_ms": 120000,
  "execution_ms": 120000,
  "max_assignments": 3,
  "repair_attempts": 2,
  "acceptance": "automatic"
}
```

Enable the existing Routine Auto or Expanded Auto policy for automatic completion.
Empty delegated_callers admits only the authenticated local owner. Caller references
are exact authenticated MCP identities, not arbitrary names. Repair must be included
in enrolled workflows and within its budget. Ordinary `ask_airodrom` and
`prepare_mission` requests select the enrolled repository and create a disposable
workspace; they do not alter the enrolled checkout.

OpenCode proposes up to three tasks, each containing id, worker, role, operation,
paths, description, depends_on and verification. Roles are implementation, review
and analysis; the latter two are read-only. Verification contains only enrolled
labels. All mandatory final checks run regardless of suggested stage checks.
Current qualified adapters are OpenCode and Cursor. Naming an unqualified worker
returns a blocker without substitution. A Cursor-only request stays Cursor-only.

Local delegation never authorizes external disclosure or subscription use. Cursor
requires the existing authenticated owner grant for the exact parent contract,
explicit unknown-cost acknowledgement, finite invocations and per-invocation time.
One grant covers the parent graph's authorized Cursor attempts; OpenCode stages do
not consume Cursor reservations. Repeated attempts consume their original limits.
There is no repeated approval for an already-authorized assignment.

## READY → first assignment

After OpenCode planning seals the parent Mission `ready`, the specialist program
remains `prepared` until the first `queue()` succeeds. The primary control-service
`MissionService` tick owns scheduling: it runs `admitPreparedReady` then
`mission-program.tick` (which includes `prepared` specialist graphs). Lost
`cognitive-dispatch` wakes are recovered without a second scheduler and without
duplicate Cursor spend. A Mission must not remain indefinitely READY without a
queued/active dispatch, a bounded retry with deadline, an actionable blocker, or
a verified terminal state. See [READY-SCHEDULER-DISPATCH-V1](READY-SCHEDULER-DISPATCH-V1.md)
and [ADR 0061](adr/0061-ready-scheduler-dispatch.md).

## Execution and automatic completion

The existing scheduler dispatches one assignment at a time. Each returned result is
bound to its task, dispatch, worker run, preimage, parent seal and evaluation receipt.
Only a ready evaluation plus passed host checks releases successors. Evaluation is
**stage-scoped**: OpenCode receives an `assignment_contract` for the active
assignment. Read assignments must not require file mutations and must not be judged
against later dependent edit objectives; edit assignments require host-verified
mutations (exact bytes when specified). Host verification remains independent
evidence—never unconditional evaluator approval. A stage-confused `blocked` on a
host-verified read fails closed as `opencode_evaluation_stage_mismatch` and may
retry local evaluation of the same verified worker packet without Cursor redispatch;
genuine scope/evidence `blocked` never unlocks dependents and is never rewritten to
`ready`. The evaluator may request repair of an existing editor by
`repair_assignment`; the host repeats that editor and already-executed later
assignments only when all repeats fit the remaining shared repair budget. No new
tasks or scope are admitted during repair.

Final host verification uses the original Mission baseline. Automatic completion
checks all assignment receipts, current authority and workspace, pending decisions
and protected approvals, termination, accounting and lease release. It records
canonical Acceptance and Settlement. Cancellation, STOP, expired authority, failed
checks, unavailable evaluation or exhausted limits produce a durable terminal or
blocked result. No manual success confirmation is required for eligible work.

Control Center shows the real worker, role, state, attempts, checks, return to
OpenCode and shared repair count. Existing evidence tools return detailed durable
references after a client disconnect. Sanitized UI projections omit private paths,
worker prose and credentials.

## Recovery and release

The result inbox remains unprocessed until evaluation/advancement is durable. A
completed evaluation can be consumed after restart; an interrupted evaluator cannot
be blindly repeated. A queued dispatch retains its identity. A run whose termination
is uncertain is never replaced automatically. Parent cancellation blocks evaluation,
successor dispatch and Acceptance. Original baselines are never recaptured to excuse
unexplained file changes.

Use the documented managed drain/checkpoint/install procedure only after exact-head
checks and independent review. Preserve the live database and accounting. A rollback
source must understand tagged graphs or reject their execution and display them
read-only. The former array-only graph implementation cannot serve as an unguarded
rollback after version 3 records have been written. Keep admission closed if safe
compatibility cannot be established.
## Failure-injected qualification and recovery observations

On 2026-10-23 a governed run against installed revision `faa204d` passed this
procedure: exactly two Cursor assignments, one injected evaluator interruption,
one automatic local evaluation retry, two READY evaluations, 17/17 final host
checks, canonical automatic Acceptance and Settlement, and four released leases.
Only the explicitly bound proof file changed. The installed source fingerprint
was unchanged throughout. Private host receipts and independent database/file
verification remain in the operator evidence bundle; this observation alone does
not qualify the later release candidate or claim its CI gates passed.

A live recovery qualification must distinguish an interrupted evaluator from a
repeated implementation assignment. Bind the test to one enrolled request and
the exact read-only evaluator process after the first worker's host verification.
Keep the dependent edit pending. Inject at most one process interruption; do not
change grants, budgets, file contents, evaluator results, or canonical database
rows. The host must independently establish termination before retrying.

Verify the complete durable sequence: one completed read, one failed and
reconciled evaluation, one READY retry bound to the same read receipt, one
dependent edit, and one final READY evaluation. Independently check requested,
planned and changed paths; exact final bytes; all registered and security checks;
current acceptance and settlement records; and zero held or quarantined leases.
Two Cursor tasks plus three evaluator attempts (two READY and one failed) prove
evaluation recovery without spending an implementation repair. They do not prove
an edit-repair cycle, every failure class, or filesystem-level read tracing.

During a bounded evaluator retry the canonical parent remains BLOCKED until the
receipt passes validation. The evidence API derives RECOVERING / EVALUATION_RETRY
only when a durable starting or running evaluator belongs to the exact verified
assignment. A stale unavailable node or an exhausted/terminated attempt does not
justify that projection. This changes reporting only, not admission or authority.

Candidate qualification also exercises standalone identity read validation.
Connection-local validation probes are registered without creating migration
tables or granting migration authority. Read-only stores keep rejecting legacy
references, malformed opaque origins and unsafe correlations.

Bound each explicitly authorized hosted qualification run with a 45-minute
monitor that cancels unfinished work at its deadline. Restore the prior CI
disabled state after the bounded attempt. A timeout or failed gate keeps release
on HOLD; it is not an authorized skip. Workflow edits may require additional
repository credential scope and are not necessary for this bounded procedure.
