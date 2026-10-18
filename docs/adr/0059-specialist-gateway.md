# ADR 0059: Bounded specialist assignments and automatic completion

Status: implemented candidate. Release qualification is recorded separately.

OpenCode plans, receives each worker's result, evaluates it and consolidates the
outcome. Airodrom remains the authenticated control plane. Cognitive enrollment
version 3 adds a typed sequential assignment graph to the existing Mission Program;
versions 1 and 2 retain their existing contracts.

A single parent Mission owns all assignments. Each assignment binds the immutable
parent seal, repository/workspace, exact paths, operation, worker, role,
dependencies, registered checks, runtime and replay identity. The host derives
these fields from the validated proposal. It never accepts authority from model
output. Qualified OpenCode and Cursor adapters implement this contract. Codex and
Claude Code remain unavailable until their actual bounded transports qualify.
Explicit worker selection cannot fall back to another worker.

The current workspace lease permits one worker at a time. The feature ceiling of
three concurrent workers does not authorize overlapping writes or fabricate
parallelism. Up to three initial assignments, two planning attempts and two repeated
assignment executions for repair are allowed. Every repeated editor or reviewer
consumes the shared repair and invocation budget. The model can request repair of
an existing edit assignment; the host repeats the affected suffix, within the
original scope. Review and analysis adapters receive no writable paths.

No scheduler, conversation database, authority store, transport protocol or ledger
is added. `cp_mission_programs` carries a tagged `cognitive_specialists_v1` graph;
`cp_mission_program_nodes` holds assignment attempt records. Existing Mission tasks,
dispatches, runs, results, verifier leases, subscription reservations and events
carry execution. Original verifier inputs and the parent baseline remain immutable.
Per-attempt baselines link the previous verified workspace to the next launch.

Every completed worker result returns to a read-only OpenCode evaluator. The return
includes actual worker/run identity, termination, host changes and check digests,
untrusted worker claims, accounting and durable references. The evaluation binds
the original seal, result, verification, workspace and ordered assignment history.
Host checks remain decisive. Evaluation cannot grant authority or accept work.

Eligible version 3 Missions automatically record canonical Acceptance and Settlement
when all assignments have returned, the final independent checks pass, authority is
current, all runs are terminated and leases released. Routine/Expanded Auto, STOP,
revocation and pending protected actions remain authoritative. There is no routine
manual Acceptance step. A missing enrollment or finite paid-worker grant produces
a specific blocker, not an invented grant. UNKNOWN_SUBSCRIPTION remains explicit.

Cancellation stops the parent and all queued work. Results remain durable until
evaluation and advancement are committed. Recovery consumes an already-completed
receipt without relaunching the worker. Interrupted or uncertain execution and
unverified evaluator termination block further dispatch and retain quarantine.
A fresh client retrieves the same evidence through existing Mission tools.

Rollback must understand the tagged graph or remain stopped under admission hold.
Old array-only Mission Program code is incompatible with version 3 records. Never
remove graph/history rows or restore an older database to make rollback appear safe;
subscription accounting, erasure dispositions and completed work must survive.
