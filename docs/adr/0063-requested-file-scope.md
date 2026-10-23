# ADR 0063 — Explicit requested file scope

Status: Accepted for implementation; release and installation remain separately gated.

## Context

A request named `recovery-proof.txt`, while enrollment supplied `AGENTS.md`,
`README.md`, and `docs/ARCHITECTURE.md`. A product name in the requested success
marker made a separate negated source mention appear positive to repository
routing. The planner selected `AGENTS.md` and described it as the requested file.
The host checked consistency with enrollment and the sealed proposal, but did
not compare either with an independent constraint extracted from the request.
Consequently, correct checks on the wrong file could lead to automatic acceptance.

## Decision

The host captures `requested_scope` version 1 inside each new hashed RequestEnvelope.
Its bindings contain exact repository-relative paths and operations. They narrow
existing enrollment and do not create authority. The host parses literal operation
clauses (`read`, `inspect`, `review`, `edit`, `modify`, `change`, `update`, `rewrite`,
`append to`, `write to`, or `create`, followed by a literal path). Quote paths with
spaces or without a dot or slash, or use `read file LICENSE` for an extensionless
path. An operation without a literal target requires clarification. Comma/and lists
retain every literal. Other bare
dotted file references require an explicit operation; no model extracts authority.
Negated operations do not grant scope. A leading `./` is normalized, while traversal,
absolute paths, backslashes, noncanonical Unicode, and ambiguous path components
are rejected. Case and directory components are preserved. No basename matching,
file aliases, enrollment-default substitution, or report coercion is permitted.

An explicit path must be enrolled and available as a regular admissible file before
planning. Cognitive enrollment currently supports existing files; a creation request
is rejected and requires an independently authorized creation workflow. There is no
fallback to another existing file when a requested file is missing or inadmissible.

Planning must retain every explicit operation/path binding. Read context is confined
to the explicitly requested set; edits require an explicit edit binding. An explicit
read before an edit remains a dependency. Coercion cannot remove offending task paths,
change these constraints, or convert an invalid worker into an allowed worker.

Binding and dispatch compare the constraints with the original instruction hash and
sealed tasks. Specialist assignment hashes and recovery lineage retain them. The
independent verifier adds `requested_file_scope` evidence using host repository
snapshots; read assignments must produce no changes, and each requested edit must
be present relative to the original baseline. Changes outside the requested edit
set fail even when the evaluator returns READY or worker prose claims success.
Acceptance independently repeats the comparison against the current snapshot.

Evidence exposes requested bindings, proposed assignments, authorized paths,
observed changes, and the host check. Read evidence consists of sealed assignment
and runtime receipts; it is not a claim that filesystem access tracing observed
all reads. Exact final bytes still require the enrolled exact-file verifier.

Repository matching now negates each matched target phrase independently. A marker
containing a product name cannot make another negated source phrase positive.

## Compatibility, recovery, and rollback

The optional versioned envelope extension is covered by the existing envelope hash
and sealed contract hash. Historical records and hashes are never rewritten. Old
stored evidence keeps its original shape. Attempts to resume or accept an old
explicitly mismatched proposal fail the comparison with its original request.
Ordinary requests without explicit file constraints retain the enrolled planning
contract. A clarification or corrected request does not expand an existing seal.

Bounded planning retries may return a corrected exact-scope proposal. Neither
specialist retries nor evaluator recovery can widen scope; budget, isolation,
termination, and acceptance gates remain mandatory. Rollback requires draining
active work and owner approval; an old runtime cannot interpret new envelopes and
must not resume their execution. No production restart or installation is implied
by this source change.
