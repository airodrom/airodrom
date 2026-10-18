# Cognitive Mission Router V1

Source implementation; not merged, installed or accepted on the running host.
Architecture decision: [ADR 0057](adr/0057-cognitive-mission-router.md).

## Lifecycle and existing components

`prepare_mission` and `ask_airodrom` use the same ZeroSetupWork entry. A matching,
active enrolled repository and delegated authenticated caller select cognitive
admission. Other requests retain the existing exact-file/template path. Neither
repository names in text nor model output create access.

1. Resolve the authenticated caller and a unique owner-enrolled project/repository.
2. Prepare a disposable Developer Autonomy workspace; keep the source checkout intact.
3. Capture Git HEAD, filesystem identity and content integrity into RequestEnvelope.
4. Execute OpenCode/Qwen in its existing read-only, loopback-only staging sandbox.
5. Parse PlanningProposal strictly and intersect files, operations and verification
   labels with host scope. Validate the dependency DAG; ignore complexity as authority.
6. Select the worker and obtain only existing host authorization. Bind the proposal,
   envelope and canonical Mission scope into SealedMissionContract.
7. Dispatch through Mission Service. Check freshness before queueing, before launch
   and before applying changes. The broker applies measured changes; registered host
   tasks verify independently of worker claims.
8. Retrieve durable status and MissionEvidence through existing MCP interfaces.

The request row is reserved before the first await. Identical replay returns its
existing result; changed instructions or callers fail. Planner runs and read leases
use existing control-plane tables. The Mission contains the full envelope, proposal
and seal; the authority revision commits to their canonical hash.

## Four strict version 1 contracts

The executable schema/validator is `src/cognitive-contracts.js`; all four reject
additional fields and unsupported versions. JSON parsing rejects duplicate keys.

| Contract | Bound data |
| --- | --- |
| RequestEnvelope | Caller and signed delegation policy/hash; request; enrolled repository/workspace identities; Git anchor; content-integrity hash/counts/exclusion policy; exact permitted paths and denied patterns; operations; eligible workers; registered verification labels; finite limits; explicit worker selection; instruction hash; expiry; canonical hash |
| PlanningProposal | Request ID and envelope hash; exact proposed files; tasks with ID, read/edit operation, paths, description and dependencies; verification labels; advisory complexity |
| SealedMissionContract | Envelope/proposal hashes; repository/workspace/Git/content anchors; canonical paths; selected worker; mandatory verification; host policy and grant references; limits; existing Mission scope fingerprint; immutable canonical hash |
| MissionEvidence | Mission and worker run IDs; envelope/contract hashes; worker; host-measured changes; verifier reference/result; termination; leases; accounting class; Acceptance; state/errors; durable references; planning/execution/repair counts |

Plans cannot introduce shell commands, tools, permission grants, network authority,
verification commands, new files outside enrollment, or new workers. Tasks must use
all and only the proposal's files; dependencies must refer to existing tasks without
cycles. Suggested verification cannot remove any owner-required check.

## Integrity

The existing streaming repository inventory covers tracked and nonignored untracked
files, with its 10,000-entry/8 GiB bounds and explicit Git-ignore exclusion policy.
The hash includes canonical relative paths, entry types, SHA-256 content digests,
relevant permission bits, parent directory modes, root mode and index state. It does
not use timestamps as content. Git HEAD and root device/inode identity are separate
anchors. Existing repository verification rejects traversal and case collisions;
symlink escapes are rejected, safe unowned symlink targets are hashed, and discovery
files must be inventoried, regular, non-hardlinked files of at most 256 KiB. Ignored
paths cannot enter discovery. No entire operator repository is passed to a worker.

Any drift blocks the old request with `cognitive_workspace_drift_revalidation_required`.
An owner must reconcile the workspace and submit a new request for a fresh plan.
No silent rebase, recapture or retry of an old sealed plan occurs.

## Enrollment and operator controls

Use the authenticated local Developer Autonomy enrollment API or Control Center's
Developer Autonomy form. Existing fields still require exact repository, project,
goal, allowed workflows, registered diff-check/test labels, worker eligibility,
duration and budgets. The optional `cognitive` field has this shape:

```json
{
  "version": 1,
  "files": ["src/example.js", "tests/example.test.js"],
  "delegated_callers": ["mcp:380c1915-b24c-40c5-9f7a-8e87c2da61f0"],
  "planning_attempts": 2,
  "planning_ms": 120000,
  "execution_ms": 120000
}
```

The example caller is synthetic. Obtain the actual authenticated `caller_reference`
from `list_authorized_scopes`; only the owner may delegate it. Empty caller lists
permit local operator use only. MCP connection identity may change after restart;
new identities require deliberate owner delegation. Repository mappings are never
accepted from ChatGPT/model text. Policies retain their signed hash and 1–90 day
expiry. The UI displays exact files, caller references and finite limits before
enrollment and supports revocation. Omitting the cognitive section leaves ordinary
Developer Autonomy unchanged. The UI enrolls OpenCode; the authenticated API can
explicitly include Cursor eligibility.

Routine Auto, Expanded Auto and Autopilot do not implicitly opt existing policies
into this feature. Goal Plans keep their existing scheduler and authorization.
Standing local delegation permits one bounded execution without another approval.
No auto-merge or deployment is included. Existing owner review remains distinct.

## Routing and Cursor authorization

| Request after plan validation | Selection |
| --- | --- |
| Explicit `use/using/via/with Cursor`, `Cursor only` | Cursor; missing qualification/grant blocks, no fallback |
| Explicit OpenCode or host | Preserve selection; host requires read-only operations |
| All tasks read-only | Existing host file-read capabilities |
| More than 4 files or 6 tasks | Cursor, subject to qualification and authorization |
| Other bounded edits | OpenCode |

A named Cursor/OpenCode worker in unrecognized prose blocks with
`cognitive_explicit_worker_syntax_required`; use an explicit `use Cursor` or
`use OpenCode` phrase to disambiguate. It never silently becomes an auto route.

V1 permits at most eight existing scoped files, twelve tasks, one worker execution
and zero automatic repairs. Each planning/execution attempt is bounded to 120 seconds;
only schema-invalid plans can use the second planning attempt. Uncertain termination
does not retry. External discovery and web continuation are not part of this scope.

Cursor reaches WAIT with `scoped_external_disclosure_required` and
`BLOCKED_SPEND_AUTHORIZATION`. Use the existing authenticated local ZeroSetupWork
approval endpoint with the request ID, explicit confirmation, `terminal` or
`control_center` channel, and `subscription_execution` containing provider `cursor`,
`acknowledge_unknown_cost: true`, `max_invocations: 1`, and `max_runtime_ms` no greater
than the envelope execution limit. This binds existing MissionApprovals to the exact
contract. Ordinary MCP text cannot issue it. The existing subscription admission
reserves the invocation immediately before real launch. No enforceable dollar limit
or exact cost is invented; accounting remains `UNKNOWN_SUBSCRIPTION`.

## States, cancellation and recovery

Requests expose PLANNING, WAIT, SEALED/DISPATCHED, RUNNING, BLOCKED, NEEDS_REWORK,
AWAITING_ACCEPTANCE, ACCEPTED or CANCELLED as supported by actual host records.
Evidence supports VERIFIED as a distinct vocabulary value but V1 ordinarily retains
owner-review criteria and reaches AWAITING_ACCEPTANCE after passing automated checks.
`operator_review` is not a claim of human Acceptance. Changes, verification receipts,
worker termination and released/quarantined leases come from host records.

Owner rejection cancels the request/Mission through existing APIs. Revocation or
expiry aborts planning and invalidates execution authority; the OpenCode/Cursor
monitors stop active work and the broker rechecks before application. Emergency STOP
also revokes cognitive standing policies and cancels their Missions even when global
Autopilot was off. Existing lifecycle drain and adapter shutdown remain authoritative.

After a disconnect, replay retrieves durable evidence and never launches a second
planner. An interrupted PLANNING row is retained for inspection; its run records
determine actual termination. A quarantined lease blocks cleanup/retry until existing
reconciliation proves the process stopped. Use a new request only after reconciliation.
Approval or dispatch failures retain a blocked request and any existing Mission ID;
they do not automatically issue a replacement spend grant.

## Validation and release status

Focused tests cover schemas, path boundaries, caller delegation, replay, content
drift, revocation, cancellation, routing, scoped Cursor approval, independent
verification, restart retrieval and uncertain termination. The opt-in
`tests/cognitive-router-live.cjs` uses a disposable repository/database and real
qualified local OpenCode/Qwen. It does not alter installed host policy. Browser
coverage exercises enrollment/revocation and the existing Live Logs poll/SSE path.

One real isolated OpenCode planning/execution run reached AWAITING_ACCEPTANCE with
verified termination and released leases. Cursor execution is fixture-only; no
matching installed-host subscription grant was available. Required regression,
security, packaging and independent-review gates must pass before normal merge.
Pristine main has reproduced regression failures; these are release blockers, not
passing tests. See the task's private release report for exact heads, commands and
sanitized receipts. Do not publish local operator paths or session artifacts here.

Install only the reviewed merged main SHA using the canonical
[managed recovery procedure](WORKER-EXECUTION-RECOVERY-V1.md): checkpoint, drain,
stop, align source and CLI, start, verify actual running source/health/MCP/workers,
then inspect durable recovery. Keep the prior installation as rollback, preserving
subscription accounting and compatible data. No installation is authorized by a
model proposal or this document.
