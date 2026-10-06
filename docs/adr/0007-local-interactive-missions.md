# ADR 0007 — Local interactive bootstrap and reasoning Missions

Historical decision: runtime references are superseded by [ADR 0008](0008-remove-worker-runtime.md). Pi is removed and historical identities cannot execute.

Status: Proposed; pre-release implementation and isolated qualification only.

A no-argument local CLI starts or attaches to a private per-user service, with
OpenCode as the default. Bootstrap pins the actual installed Node, Seatbelt and
qualified OpenCode artifacts through the existing executable verifier. The
installed OpenCode version, model and digest must match the qualification record;
a real disposable synthetic adapter probe must pass before pins are saved.
Artifacts are validated before version probes and again immediately before
runtime launch. Changed artifacts fail closed. Bootstrap enables no external
provider or web tool.

Authenticated operator input registers a fresh signed conversation Mission in
the existing control-plane store. Its fixed contract admits one local inference
turn, no runtime tools, no filesystem reads or writes, no shell, MCP or subagents,
zero external inference calls and at most one relevant canonical Memory V2 record
within 2,000 bytes. Its lifetime is at most two minutes. The task gets an isolated
workspace and a durable read lease. Frozen identity, signature, permissions,
workspace, erasure state and expiry are rechecked before dispatch and on return.
The execution adapter receives fresh disposable state and minimum current context.
An expiry abort timer covers dispatch, and the launch timeout is clamped to the
remaining absolute authority lifetime. Browser cancellation uses the canonical
Mission stop path; legacy pause/resume cannot mutate this profile.

The host verifies confinement, provenance and termination independently. Factual
accuracy remains operator review. `/accept` requires canonical verification and
records existing Acceptance then local Settlement. A runtime cannot accept itself.
Coding stays on the existing declared-files Mission path with registered tests,
verification, Acceptance and Settlement. Plain text never infers a write scope.
Pi rollback retains typed Missions; unavailable general Pi inference fails closed
without selecting another runtime. Cloud and Cursor execution are not introduced.

Browser OpenCode prompts use the same registered conversation path. Submission
errors are returned synchronously rather than hidden behind an accepted response.
Shared memories saved for new OpenCode browser tasks use Personal Memory V2;
legacy task scratch memory is not silently imported as personal truth. Correction
and forget invalidate delivered context. Answer delivery and Acceptance recheck
current canonical context, including expiry. Runtime caches cannot become a
memory source. Untrusted terminal answers, memory and errors cannot emit terminal
control sequences. Existing private instances and their data remain separate.
Read projections suppress stale conversation payloads in current task, inbox,
Mission, timeline and authority views without rewriting immutable history.
Accepted episode timestamps, verification digests and opaque episode identities
stay in audit records and are omitted from runtime reference text; semantic
content retains secret guards. A validated canonical pack UUID is lookup metadata,
and cannot trigger a payment-card alarm or exempt any free-text content.

This is a compatible new admission profile; Development Manifest semantics stay
intact. Validation includes deterministic boundary tests, real synthetic local
OpenCode CLI roundtrips, lifecycle races, the declared repository checks and
exact-revision hosted gates. Distribution stays pre-release, with no publication,
deployment or production activation.
