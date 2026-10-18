# ADR 0058: OpenCode result gateway

Status: proposed; release validation pending.

## Decision

An explicitly enrolled cognitive V2 request uses OpenCode for planning and for
read-only evaluation of the actual execution worker result. Airodrom owns request
identity, scope, worker admission, dispatch, process termination, leases, budget,
independent verification, Acceptance and durable evidence. The existing adapter
transports, Mission Service scheduler, run records, result inbox and event ledger
remain canonical. No second scheduler, authority store or transport is introduced.

The evaluator receives the original objective, validated task descriptions,
current declared files, bounded untrusted worker summary and host check outcomes.
It cannot write or call host tools. A durable attempt is created before launch.
The receipt binds the Mission, immutable sealed contract, execution run, normalized
worker result, full host verification and workspace hashes. Only a completed,
terminated evaluator recommending `ready` can satisfy the additional Acceptance
gate. Its recommendation never substitutes for host verification or owner consent.

V1 enrollment keeps its one execution and zero repairs. V2 explicitly enrolls up
to two local repairs and requires the existing `repair` workflow and policy budget.
A repair requires both failed independent verification and OpenCode's `repair`
recommendation. Existing Developer Autonomy repair creates and dispatches a child
transactionally using deterministic request identifiers and the original grant.
The child retains the immutable root seal, scope, expiry and verifier baseline;
its new workspace baseline is bound to the parent's evaluation evidence. Root
cancellation invalidates descendant authority. Uncertain execution/evaluation is
quarantined and never automatically replayed.

## Supported scope and limits

The current gateway has one execution worker per Mission. Host reads, local
OpenCode execution and the existing governed Cursor transport are supported.
Cursor still requires exact authenticated local disclosure and subscription
approval. V2 automatic repairs currently apply only to local OpenCode execution;
external repair requests are rejected. Named Codex/Claude requests return an
explicit unavailable result instead of silently falling back. A bounded task
plan is supplied to the chosen worker, but separate task-to-specialist dispatch
within a single Mission is not implemented. Existing Mission Programs remain the
only multi-Mission scheduler; this change does not claim a new specialist graph.

## Recovery and rollback

Evaluation is stored in existing run results and gateway events. No database
migration is added. Host verification is retained even if evaluation is unavailable;
Acceptance stays blocked, and evidence retrieval remains available. Failed or
unavailable host verification retains the existing `needs_rework` lifecycle state.
Reverification
cannot pair a new host result with stale evaluator evidence. A restart never
reissues a reserved evaluator or uncertain worker invocation.

Before managed installation, complete release gates and take the existing managed
checkpoint with durable idle/drain verification. Keep the prior source. Downgrade
only while idle: older source does not enforce the new V2 Acceptance gate, so it
must not dispatch or accept pending V2 Missions. Do not rewind subscription
accounting or restore a database to create new execution authority.
